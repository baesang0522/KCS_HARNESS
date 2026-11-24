"""모델명 표의 셀은 직접 보존하고 설명문의 조건만 연결한다."""
import json

from pydantic import ValidationError

from services.documents.tables import is_model_table, split_model_cell, table_markdown
from services.debug_log import log_event
from services.errors import ModelProcessingError
from services.investigation.schemas import Condition, Evidence, ItemTarget
from services.investigation.service import target_description


def split_catalog(document):
    catalog, pages, has_prose = [], [], False
    for page in document.pages:
        text = page.text
        prose = page.text
        if page.readable:
            for index, table in enumerate(page.tables, 1):
                block = table_markdown(table.model_dump())
                if not is_model_table(table) or block not in text:
                    continue
                table_id = f"p{page.page_number}t{index}"
                cells = []
                for row in table.rows:
                    for group, value in zip(table.headers[1:], row[1:]):
                        if not value.strip():
                            continue
                        model, note = split_model_cell(value)
                        if not model:
                            break
                        target = ItemTarget(kind="item", group=group, hs_codes=[], specification=model, requirements=note)
                        title, description = target_description(target)
                        condition = Condition(title=title, description=description, target=target,
                            source_document_id=document.document_id, source_pages=[page.page_number],
                            evidence=[Evidence(document_id=document.document_id, filename=document.filename,
                                page_number=page.page_number, quote=f"{table.headers[0]} {row[0]} / {group}: {value}")])
                        cells.append((table_id, row[0], condition))
                    else:
                        continue
                    break
                else:
                    if not cells:
                        continue
                    catalog.extend(cells)
                    # 원래 표 대신 짧은 위치·열 정보만 보낸다. 셀 값은 모델에 재생성시키지 않는다.
                    marker = "[직접 추출 표] " + json.dumps(dict(table_id=table_id, groups=table.headers[1:],
                        row_count=len(table.rows), first_row=table.rows[0][0], last_row=table.rows[-1][0]), ensure_ascii=False)
                    text = text.replace(block, marker, 1)
                    prose = prose.replace(block, "", 1)
        has_prose = has_prose or (page.readable and bool(prose.strip()))
        pages.append(page.model_copy(update={"text": text}))
    remainder = document.model_copy(update={"pages": pages if has_prose else []})
    return catalog, remainder


def select_catalog_scope(catalog, rule):
    selected = catalog
    for field, value_of in (("table_ids", lambda cell: cell[0]), ("row_numbers", lambda cell: cell[1]),
                           ("groups", lambda cell: cell[2].target.group),
                           ("specifications", lambda cell: cell[2].target.specification)):
        values = getattr(rule, field)
        if values:
            available = {value_of(cell) for cell in selected}
            unknown = set(values) - available
            if unknown:
                return [], dict(field=field, unknown_values=sorted(unknown), available_values=sorted(available))
            selected = [cell for cell in selected if value_of(cell) in values]
    return selected, {} if selected else dict(field="scope", unknown_values=[], available_values=[])


def apply_catalog_rules(catalog, rules):
    seen, warnings = set(), []
    for rule, evidence in rules:
        key = rule.model_dump_json()
        if key in seen:
            continue
        seen.add(key)
        selected, issue = select_catalog_scope(catalog, rule)
        if issue:
            scope = {field: getattr(rule, field) for field in ("table_ids", "row_numbers", "groups", "specifications")}
            log_event("pdf.catalog_rule.unresolved", level="WARNING", **issue, requested_scope=scope,
                      document_id=evidence[0].document_id,
                      evidence=[ref.model_dump() for ref in rule.evidence])
            scope_text = "; ".join(f"{label}: {', '.join(scope[field])}" for field, label in
                (("table_ids", "표"), ("row_numbers", "순번"), ("groups", "분류"), ("specifications", "규격")) if scope[field])
            details = "; ".join(filter(None, ["HS: " + ", ".join(rule.hs_codes) if rule.hs_codes else "",
                                             rule.requirements, rule.uncertainty]))
            quotes = " / ".join(f"{item.page_number}페이지: {item.quote}" for item in evidence)
            warnings.append(f"표 항목은 추출했지만 다음 공통 조건은 적용 위치를 확인하지 못해 반영하지 않았습니다. "
                            f"조건: {details or '원문 근거 참조'}. 요청 범위: {scope_text or '전체 표'}. 근거: {quotes}")
            # 일부 위치만 맞더라도 이 규칙 전체를 보류해 적용 범위를 임의로 바꾸지 않는다.
            continue
        for _, _, condition in selected:
            target = condition.target.model_dump()
            if rule.hs_codes:
                if target["hs_codes"]:
                    narrowed = []
                    for existing in target["hs_codes"]:
                        for code in rule.hs_codes:
                            left, right = existing.replace('.', ''), code.replace('.', '')
                            if left.startswith(right):
                                narrowed.append(existing)
                            elif right.startswith(left):
                                narrowed.append(code)
                    target["hs_codes"] = list(dict.fromkeys(narrowed))
                    if not target["hs_codes"]:
                        raise ModelProcessingError("표에 연결된 공통 HS 조건이 서로 맞지 않습니다. 조건은 저장하지 않았습니다.")
                else:
                    target["hs_codes"] = list(dict.fromkeys(rule.hs_codes))
            if rule.requirements.strip() and rule.requirements.strip() not in target["requirements"].split('\n'):
                target["requirements"] = '\n'.join(filter(None, [target["requirements"], rule.requirements.strip()]))
            try:
                condition.target = ItemTarget.model_validate(target)
            except ValidationError as error:
                raise ModelProcessingError("표와 공통 조건을 합친 내용을 검증하지 못했습니다. 조건은 저장하지 않았습니다.") from error
            condition.title, condition.description = target_description(condition.target)
            condition.evidence.extend(item for item in evidence if item not in condition.evidence)
            condition.source_pages = sorted({item.page_number for item in condition.evidence})
            if rule.uncertainty.strip() and rule.uncertainty.strip() not in condition.uncertainty.split('\n'):
                condition.uncertainty = '\n'.join(filter(None, [condition.uncertainty, rule.uncertainty.strip()]))
    return warnings
