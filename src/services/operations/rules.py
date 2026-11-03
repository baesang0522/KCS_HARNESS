"""LLM 없이 실행하는 결정론적 문자열 연산."""
import re

from services.operations.schemas import Rule

FULLWIDTH = {code: code - 0xFEE0 for code in range(0xFF01, 0xFF5F)}
FULLWIDTH[0x3000] = 0x20


def preprocess(value: str, rules: list[Rule]) -> str:
    for rule in rules:
        match rule.operation:
            case "trim":
                value = value.strip()
            case "collapse_whitespace":
                value = re.sub(r"\s+", " ", value)
            case "normalize_fullwidth_ascii":
                value = value.translate(FULLWIDTH)
            case "uppercase":
                value = value.upper()
            case "lowercase":
                value = value.lower()
            case "remove_words":
                # 정규식 입력은 받지 않는다. 대소문자를 구분해 온전한 단어/구절만 제거한다.
                for word in rule.words:
                    pattern = re.escape(word)
                    if re.search(r"\w", word):
                        pattern = r"(?<!\w)" + pattern + r"(?!\w)"
                    value = re.sub(pattern, "", value)
        if len(value) > 32767:
            raise ValueError("결과가 Excel 셀 길이 32,767자를 초과합니다.")
    return value


def split_value(value: str, delimiter: str | None) -> list[str]:
    # maxsplit으로 과도한 결과 할당을 막고 한 번에 100열까지만 허용한다.
    parts = value.split(delimiter, 100)
    if len(parts) > 100:
        raise ValueError("분리 결과는 최대 100열입니다. 구분자를 다시 확인하세요.")
    return parts or [""]


MODEL_LABEL = re.compile(r"(?<!\w)(?:MODEL|CODE|GRADE)\s*[:：]", re.IGNORECASE)


def model_candidates(value: str, mode: str) -> list[str]:
    if mode == "alphanumeric":
        found = [
            token for token in value.split()
            if token.isalnum()
            and any(char.isalpha() for char in token)
            and any(char.isdecimal() for char in token)
        ]
    elif mode == "labelled":
        found = []
        labels = list(MODEL_LABEL.finditer(value))
        for index, label in enumerate(labels):
            # 다음 표기 이름(CODE 등)이 앞 후보에 섞이지 않도록 먼저 범위를 나눈다.
            end = labels[index + 1].start() if index + 1 < len(labels) else len(value)
            candidate = re.split(r"[,，:：\r\n]", value[label.end():end], maxsplit=1)[0].strip()
            if candidate:
                found.append(candidate)
    else:
        raise ValueError("지원하지 않는 추출 방식입니다.")
    return list(dict.fromkeys(found))


def extraction_suggestions(values: list[str]) -> dict:
    suggestions = []
    for mode, label in [
        ("alphanumeric", "문자·숫자 조합 추출"),
        ("labelled", "MODEL·CODE·GRADE 뒤의 값 추출"),
    ]:
        count, multiple, examples = 0, 0, []
        for value in values:
            candidates = model_candidates(value, mode)
            if not candidates:
                continue
            count += 1
            multiple += len(candidates) > 1
            if len(examples) < 2:
                examples.append({
                    "before": value[:160],
                    "after": " | ".join(candidates)[:160],
                })
        if count:
            suggestions.append({
                "mode": mode, "label": label, "matched_rows": count,
                "multiple_rows": multiple, "examples": examples,
            })
    return {"sample_count": len(values), "suggestions": suggestions}
