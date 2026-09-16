"""해외거래처 상호의 결정론적 후보 생성."""
import re
from difflib import SequenceMatcher

from services.jobs.counterparty_cleanup.schemas import Job

SIMILARITY_THRESHOLD = 0.9


def normalize_company_name(value: str) -> str:
    return re.sub(r"[^\w]", "", value.casefold(), flags=re.UNICODE)


def candidate_groups(job: Job) -> list[dict]:
    source, mapping = job.source, job.source.mapping
    by_country: dict[str, list[dict]] = {}
    exact: dict[tuple[str, str], list[dict]] = {}

    for index, row in enumerate(source.rows):
        country = row.cells[mapping.country_code].strip().casefold()
        original = row.cells[mapping.company_name].strip()
        normalized = normalize_company_name(original)
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
        exact.setdefault((country, normalized), []).append(item)

    groups = []
    for (country, normalized), rows in exact.items():
        codes = sorted({row["party_code"].strip() for row in rows})
        if len(rows) > 1 and len(codes) > 1:
            groups.append({
                "group_id": f"{country.upper()}-{len(groups) + 1:04d}",
                "country_code": country.upper(),
                "normalized_name": normalized,
                "rows": rows,
                "existing_party_codes": codes,
                "reason": "같은 국가코드에서 정규화 상호가 같고 기존 부호가 여러 개입니다.",
                "decision": "REVIEW_REQUIRED",
            })

    # ponytail: 국가별 O(n²) 비교다. 실제 규모에서 느려질 때 접두어 블록을 추가한다.
    seen: set[tuple[str, ...]] = set()
    for country, rows in by_country.items():
        for index, left in enumerate(rows):
            for right in rows[index + 1:]:
                if left["party_code"].strip() == right["party_code"].strip():
                    continue
                if left["normalized_name"] == right["normalized_name"]:
                    continue
                score = SequenceMatcher(
                    None, left["normalized_name"], right["normalized_name"]
                ).ratio()
                if score < SIMILARITY_THRESHOLD:
                    continue
                key = (
                    country,
                    *sorted((left["normalized_name"], right["normalized_name"])),
                    *sorted((left["party_code"].strip(), right["party_code"].strip())),
                )
                if key in seen:
                    continue
                seen.add(key)
                groups.append({
                    "group_id": f"{country.upper()}-S{len(groups) + 1:04d}",
                    "country_code": country.upper(),
                    "normalized_name": None,
                    "rows": [left, right],
                    "existing_party_codes": sorted({
                        left["party_code"].strip(), right["party_code"].strip()
                    }),
                    "similarity": round(score, 3),
                    "reason": "같은 국가코드에서 정규화 상호의 문자열 유사도가 기준 이상입니다.",
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
