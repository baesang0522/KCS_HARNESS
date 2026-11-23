"""모델명 표의 셀은 직접 보존하고 설명문의 조건만 연결한다."""
import json

from pydantic import ValidationError

from services.documents.tables import is_model_table, split_model_cell, table_markdown
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


def apply_catalog_rules(catalog, rules):
    seen = set()
    for rule, evidence in rules:
        key = rule.model_dump_json()
        if key in seen:
            continue
        seen.add(key)
        selected = catalog
        for field, values in ((0, rule.table_ids), (1, rule.row_numbers)):
            if values:
                if not set(values) <= {cell[field] for cell in selected}:
                    raise ModelProcessingError("AI가 공통 조건의 표·행 위치를 잘못 지정했습니다. 조건은 저장하지 않았습니다.")
                selected = [cell for cell in selected if cell[field] in values]
        for field, values in (("group", rule.groups), ("specification", rule.specifications)):
            if values:
                if not set(values) <= {getattr(cell[2].target, field) for cell in selected}:
                    raise ModelProcessingError("AI가 공통 조건의 분류·규격을 잘못 지정했습니다. 조건은 저장하지 않았습니다.")
                selected = [cell for cell in selected if getattr(cell[2].target, field) in values]
        if not selected:
            raise ModelProcessingError("공통 조건에 대응하는 표 항목을 찾지 못했습니다. 조건은 저장하지 않았습니다.")
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
