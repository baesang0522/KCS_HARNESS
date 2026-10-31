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


# shortcut: 후보는 공백 없는 토큰이다. 공백이 포함된 모델명이 확인되면 경계 규칙을 확장한다.
MODEL_TOKEN = re.compile(r"[^\W_]+(?:[-_/.][^\W_]+)*", re.UNICODE)
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
        for label in MODEL_LABEL.finditer(value):
            start = label.end()
            # 줄을 넘겨 다음 항목을 모델명으로 가져오지 않는다.
            while start < len(value) and value[start] in " \t":
                start += 1
            if MODEL_LABEL.match(value, start):
                continue
            match = MODEL_TOKEN.match(value, start)
            if match:
                found.append(match.group())
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
