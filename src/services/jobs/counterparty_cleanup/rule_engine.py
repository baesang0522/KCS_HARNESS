"""해외거래처 상호의 결정론적 후보 생성."""
import re
from difflib import SequenceMatcher

from services.jobs.counterparty_cleanup.schemas import Job

def normalize_company_name(value: str, ignored_terms: tuple[str, ...] = ()) -> str:
    ignored = {
        token.casefold()
        for term in ignored_terms
        for token in re.findall(r"\w+", term, flags=re.UNICODE)
    }
    tokens = re.findall(r"\w+", value.casefold(), flags=re.UNICODE)
    return "".join(token for token in tokens if token not in ignored)


def _grams(value: str) -> set[str]:
    if len(value) < 3:
        return {value}
    return {value[index:index + 3] for index in range(len(value) - 2)}


def candidate_groups(job: Job) -> list[dict]:
    source, mapping = job.source, job.source.mapping
    by_country: dict[str, list[dict]] = {}

    for index, row in enumerate(source.rows):
        country = row.cells[mapping.country_code].strip().casefold()
        original = row.cells[mapping.company_name].strip()
        normalized = normalize_company_name(original, job.policy.ignored_terms)
        if not country or not normalized:
            continue
        item = {
            "excel_row": source.row_start + index + 2,
            "party_code": row.cells[mapping.party_code],
            "country_code": row.cells[mapping.country_code],
            "company_name": original,
            "normalized_name": normalized,
        }
        by_country.setdefault(country, []).append(item)

    groups = []
    for country, rows in by_country.items():
        parents = list(range(len(rows)))
        score_edges: list[tuple[int, int, float]] = []

        def find(index: int) -> int:
            while parents[index] != index:
                parents[index] = parents[parents[index]]
                index = parents[index]
            return index

        def union(left: int, right: int) -> None:
            left_root, right_root = find(left), find(right)
            if left_root != right_root:
                parents[right_root] = left_root

        by_name: dict[str, int] = {}
        gram_index: dict[str, set[int]] = {}
        for index, row in enumerate(rows):
            name = row["normalized_name"]
            if name in by_name:
                union(index, by_name[name])
            else:
                by_name[name] = index

            # ponytail: 희소한 삼중문자와 기존 그룹 표본만 비교한다. 실제 데이터에서 누락이
            # 측정되면 표본 수를 늘리고, 병목이면 이 색인만 교체한다.
            grams = sorted(_grams(name), key=lambda gram: len(gram_index.get(gram, ())))[:3]
            candidates = set().union(*(gram_index.get(gram, set()) for gram in grams))
            by_root: dict[int, list[int]] = {}
            for other_index in candidates:
                by_root.setdefault(find(other_index), []).append(other_index)
            samples = {
                sample
                for indexes in by_root.values()
                for sample in (min(indexes), max(indexes))
            }
            for other_index in samples:
                other = rows[other_index]["normalized_name"]
                if name == other:
                    continue
                if min(len(name), len(other)) / max(len(name), len(other)) < job.policy.similarity_threshold:
                    continue
                score = SequenceMatcher(None, name, other).ratio()
                if score >= job.policy.similarity_threshold:
                    union(index, other_index)
                    score_edges.append((index, other_index, score))
            for gram in _grams(name):
                gram_index.setdefault(gram, set()).add(index)

        components: dict[int, list[int]] = {}
        for index, row in enumerate(rows):
            components.setdefault(find(index), []).append(index)
        for indexes in components.values():
            component = [rows[index] for index in indexes]
            codes = sorted({row["party_code"].strip() for row in component if row["party_code"].strip()})
            if len(component) < 2 or len(codes) < 2:
                continue
            exact_match = len({row["normalized_name"] for row in component}) == 1
            groups.append({
                "group_id": f"{country.upper()}-{len(groups) + 1:04d}",
                "country_code": country.upper(),
                "normalized_name": component[0]["normalized_name"] if exact_match else None,
                "rows": component,
                "existing_party_codes": codes,
                "similarity": None if exact_match else round(min(
                    score for left, right, score in score_edges
                    if left in indexes and right in indexes
                ), 3),
                "reason": (
                    "같은 국가코드에서 정규화 상호가 같고 기존 부호가 여러 개입니다."
                    if exact_match else
                    "같은 국가코드에서 정규화 상호의 문자열 유사도가 기준 이상입니다."
                ),
                "decision": "REVIEW_REQUIRED",
            })
    return groups


def model_review_input(group: dict) -> dict:
    names = list(dict.fromkeys(row["company_name"] for row in group["rows"]))
    return {
        "group_id": group["group_id"],
        "country_code": group["country_code"],
        "company_name_samples": names[:20],
        "company_name_count": len(names),
        "row_count": len(group["rows"]),
        "existing_party_code_count": len(group["existing_party_codes"]),
        "similarity": group.get("similarity"),
        "candidate_reason": group["reason"],
    }
