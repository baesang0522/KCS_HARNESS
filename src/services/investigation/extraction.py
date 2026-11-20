"""PDF 원문·표에서 근거를 검증하며 조사 조건을 추출한다."""
import asyncio
from pathlib import Path
from prompts.loader import load_agent_prompt
from services.documents.chunks import flatten_sources, group_sources, next_source_chunk
from services.documents.service import find_document
from services.documents.tables import is_model_table, split_model_cell, split_company_name
from services.errors import ConflictError, ModelProcessingError
from models.structured import ask
from services.investigation.schemas import Condition, Evidence, Extraction, ItemTarget, SupplierTarget
from services.investigation.service import belongs_to_document, check_revision, same_workspace, target_description


def evidence_sources(document):
    pages, sources = [], {}
    for page in document.pages:
        if not page.readable:
            continue
        parts = [line[start:start + 2000] for line in page.text.splitlines() if line.strip()
                 for start in range(0, len(line), 2000) if line[start:start + 2000].strip()]
        entries = []
        for source_id, text in enumerate(parts, 1):
            sources[(page.page_number, source_id)] = text
            entries.append({"source_id": source_id, "text": text})
        pages.append({"page_number": page.page_number, "sources": entries})
    return pages, sources


def model_table_extraction(document):
    readable = [page for page in document.pages if page.readable]
    if not readable or any(not page.tables or not all(is_model_table(t) for t in page.tables) for page in readable):
        return None
    conditions, warnings = [], []
    for page in readable:
        for table in page.tables:
            for row in table.rows:
                for category, value in zip(table.headers[1:], row[1:]):
                    if not value.strip():
                        continue
                    model, note = split_model_cell(value)
                    if not model:
                        return None
                    target = ItemTarget(kind="item", group=category, hs_codes=[], specification=model, requirements=note)
                    title, description = target_description(target)
                    quote = f"{table.headers[0]} {row[0]} / {category}: {value}"
                    conditions.append(Condition(title=title, description=description, target=target,
                        source_document_id=document.document_id, source_pages=[page.page_number],
                        evidence=[Evidence(document_id=document.document_id, filename=document.filename,
                                           page_number=page.page_number, quote=quote)]))
        for line in page.text.splitlines():
            if not line.startswith('|') and any(word in line for word in ['판독 유의', '원본 확인', '원본 대조', '잘림', '가려짐']):
                if line not in warnings:
                    warnings.append(line)
    return conditions, warnings


async def extract_conditions(conversation, payload, runtime, request_id):
    state = conversation.investigation
    check_revision(state, payload.revision)
    document_id = str(payload.document_id)
    document = find_document(conversation, document_id)
    if document_id in state.document_notes:
        return state  # 사용자의 수정·삭제를 다시 추출한 내용으로 덮어쓰지 않는다.
    if document.link and document.link.workspace and state.workspace and not same_workspace(
            document.link.workspace.model_dump(), state.workspace.model_dump()):
        raise ConflictError("문서와 조사의 연결 작업표가 다릅니다. 연결을 확인하세요.")
    next_state = state.model_copy(deep=True)
    catalog = model_table_extraction(document)
    if catalog is not None:
        conditions, warnings = catalog
        next_state.conditions.extend(conditions)
    else:
        pages, sources = evidence_sources(document)
        prompt = load_agent_prompt(Path(__file__).resolve().parents[2] / "prompts/investigation.yml").render()
        entries = flatten_sources(pages)
        offset, context, warnings, seen = 0, [], [], set()
        while offset < len(entries):
            if request_id in conversation.cancelled_requests:
                raise ConflictError("사용자가 조사 조건 읽기를 중지했습니다.")
            base = {"goal": state.goal, "filename": document.filename, "context_pages": group_sources(context)}
            try:
                batch = next_source_chunk(entries, offset, prompt, base, Extraction)
            except ValueError as error:
                raise ModelProcessingError("이어 읽을 공통 근거를 AI 요청에 구성하지 못했습니다. 조건은 저장하지 않았습니다. 다시 읽어 주세요.") from error
            data = {**base, "pages": group_sources(batch), "has_more": offset + len(batch) < len(entries)}
            try:
                extracted = await asyncio.wait_for(
                    ask(runtime.advice_model, prompt, "conditions", data, Extraction),
                    timeout=runtime.settings.llm.timeout_seconds + 10)
            except Exception as error:
                raise ModelProcessingError("조사 조건 응답을 확인하지 못했습니다. 조건은 저장하지 않았습니다. 다시 읽어 주세요.") from error
            available = {(item["page_number"], item["source_id"]): item for item in [*context, *batch]}
            current = {(item["page_number"], item["source_id"]) for item in batch}
            for candidate in extracted.conditions:
                if not candidate.title.strip() or not candidate.description.strip():
                    raise ModelProcessingError("빈 조사 조건이 반환되어 저장하지 않았습니다.")
                references = {(item.page_number, item.source_id) for item in candidate.evidence}
                evidence = []
                for item in candidate.evidence:
                    quote = sources.get((item.page_number, item.source_id))
                    if (item.page_number, item.source_id) not in available:
                        raise ModelProcessingError(
                            f"AI가 ‘{candidate.title}’의 근거 위치를 잘못 지정했습니다 "
                            f"({item.page_number}쪽, 구절 {item.source_id}). PDF는 유지했으며 조건은 저장하지 않았습니다. 추출 다시 시도를 눌러 주세요.")
                    evidence.append(Evidence(page_number=item.page_number, quote=quote,
                                             document_id=document.document_id, filename=document.filename))
                # Context is repeated for interpretation, not for extracting the same rows again.
                if not references & current:
                    continue
                if isinstance(candidate.target, SupplierTarget):
                    names = split_company_name(candidate.target.company_name)
                    if names:
                        candidate.target.category, candidate.target.company_name = names
                key = (candidate.target.model_dump_json(), tuple(sorted(references)))
                if key in seen:
                    continue
                seen.add(key)
                next_state.conditions.append(Condition(**candidate.model_dump(exclude={"evidence"}), evidence=evidence,
                    source_document_id=document.document_id, source_pages=sorted({item.page_number for item in evidence})))
            carried = []
            for reference in extracted.continuation_sources:
                key = (reference.page_number, reference.source_id)
                if key not in available:
                    raise ModelProcessingError("AI가 이어 읽을 원문 근거를 잘못 지정했습니다. 조건은 저장하지 않았습니다. 다시 읽어 주세요.")
                if available[key] not in carried:
                    carried.append(available[key])
            # Keep the boundary source too, so a wrapped name or sentence can continue.
            if batch[-1] not in carried:
                carried.append(batch[-1])
            context = carried
            warnings.extend(warning for warning in extracted.warnings if warning not in warnings)
            offset += len(batch)
    if request_id in conversation.cancelled_requests:
        raise ConflictError("사용자가 조사 조건 읽기를 중지했습니다.")
    next_state.extracted_conditions[document_id] = [item.model_copy(deep=True) for item in next_state.conditions
                                                   if belongs_to_document(item, document_id)]
    next_state.document_notes[document_id] = warnings + [
        f"{page.page_number}쪽은 읽을 수 있는 텍스트가 없습니다." for page in document.pages if not page.readable]
    next_state.revision += 1
    conversation.investigation = next_state
    return next_state
