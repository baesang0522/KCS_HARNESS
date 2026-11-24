"""PDF 원문·표에서 근거를 검증하며 조사 조건을 추출한다."""
import logging
from pathlib import Path
from time import perf_counter
from openai import APITimeoutError
from prompts.loader import load_agent_prompt
from services.documents.chunks import flatten_sources, group_sources, next_source_chunk
from services.documents.service import find_document
from services.documents.tables import is_model_table, split_company_name
from services.errors import ConflictError, ModelProcessingError
from services.debug_log import log_event
from models.structured import OutputLengthError, ask
from services.investigation.schemas import CatalogExtraction, CatalogRule, Condition, Evidence, Extraction, ItemTarget, SupplierTarget
from services.investigation.catalog import split_catalog, apply_catalog_rules
from services.investigation.service import belongs_to_document, check_revision, same_workspace


logger = logging.getLogger(__name__)


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
    catalog, remainder = split_catalog(document)
    return ([cell[2] for cell in catalog], []) if catalog and not remainder.pages else None


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
    catalog, remainder = split_catalog(document)
    table_conditions = [cell[2] for cell in catalog]
    next_state.conditions.extend(table_conditions)
    table_rules = []
    schema = CatalogExtraction if catalog else Extraction
    ids = dict(document_id=document_id, request_id=request_id)
    log_event("pdf.extraction.route", **ids, mode="hybrid" if catalog and remainder.pages else "table" if catalog else "llm",
              direct_conditions=len(catalog),
              pages=[dict(page_number=page.page_number, readable=page.readable, tables=len(page.tables),
                          model_tables=sum(is_model_table(table) for table in page.tables)) for page in document.pages])
    warnings = []
    if remainder.pages:
        pages, sources = evidence_sources(remainder)
        prompt = load_agent_prompt(Path(__file__).resolve().parents[2] / "prompts/investigation.yml").render()
        entries = flatten_sources(pages)
        offset, context, warnings, seen = 0, [], [], set()
        chunk_size = None
        while offset < len(entries):
            if request_id in conversation.cancelled_requests:
                raise ConflictError("사용자가 조사 조건 읽기를 중지했습니다.")
            base = {"goal": state.goal, "filename": document.filename, "context_pages": group_sources(context),
                    "direct_conditions_count": len(table_conditions)}
            try:
                batch = next_source_chunk(entries, offset, prompt, base, schema)
            except ValueError as error:
                raise ModelProcessingError("이어 읽을 공통 근거를 AI 요청에 구성하지 못했습니다. 조건은 저장하지 않았습니다. 다시 읽어 주세요.") from error
            batch = batch[:chunk_size]
            while True:
                if request_id in conversation.cancelled_requests:
                    raise ConflictError("사용자가 조사 조건 읽기를 중지했습니다.")
                data = {**base, "pages": group_sources(batch), "has_more": offset + len(batch) < len(entries)}
                started = perf_counter()
                log_event("pdf.model.started", **ids, offset=offset, sources=len(batch),
                          context_sources=len(context), model_timeout=getattr(runtime.advice_model, "request_timeout",
                              getattr(runtime.advice_model, "timeout_seconds", None)))
                try:
                    # 모델 클라이언트의 시간 제한을 따른다. 일반 채팅 기준으로 먼저 끊지 않는다.
                    extracted = await ask(runtime.advice_model, prompt, "conditions", data, schema)
                    log_event("pdf.model.completed", **ids, offset=offset, conditions=len(extracted.conditions), table_rules=len(getattr(extracted, "table_rules", [])),
                              elapsed_ms=round((perf_counter() - started) * 1000))
                    break
                except OutputLengthError as error:
                    if request_id in conversation.cancelled_requests:
                        raise ConflictError("사용자가 조사 조건 읽기를 중지했습니다.") from error
                    if len(batch) == 1:
                        raise ModelProcessingError(
                            f"PDF {batch[0]['page_number']}쪽의 원문 구절 {batch[0]['source_id']} 하나로 줄여도 "
                            "생성이 토큰 한도로 중단됐습니다. 조건은 저장하지 않았습니다. "
                            "llm.advice_max_tokens와 내부 모델 서버의 생성·컨텍스트 한도를 확인해 주세요.") from error
                    chunk_size = len(batch) // 2
                    logger.warning("PDF 추출 재분할: document_id=%s offset=%s sources=%s next_sources=%s",
                                   document_id, offset, len(batch), chunk_size)
                    # 잘린 응답은 버리고 같은 위치부터 재시도한다. 나머지 원문도 다음 호출에서 처리한다.
                    batch = batch[:chunk_size]
                except (TimeoutError, APITimeoutError) as error:
                    raise ModelProcessingError(
                        "PDF 추출 중 모델 응답 대기가 시간 초과로 중단됐습니다. "
                        "조건은 저장하지 않았습니다. 내부 모델 서버의 응답 상태를 확인해 주세요.") from error
                except Exception as error:
                    raise ModelProcessingError("조사 조건 응답을 확인하지 못했습니다. 조건은 저장하지 않았습니다. 다시 읽어 주세요.") from error
            available = {(item["page_number"], item["source_id"]): item for item in [*context, *batch]}
            current = {(item["page_number"], item["source_id"]) for item in batch}
            for candidate in [*extracted.conditions, *getattr(extracted, "table_rules", [])]:
                if isinstance(candidate, CatalogRule) and not (candidate.hs_codes or candidate.requirements.strip() or candidate.uncertainty.strip()):
                    continue  # 표 위치만 반환한 빈 제안은 적용할 조건도 경고할 누락도 없다.
                if not isinstance(candidate, CatalogRule) and (not candidate.title.strip() or not candidate.description.strip()):
                    raise ModelProcessingError("빈 조사 조건이 반환되어 저장하지 않았습니다.")
                references = set()
                evidence = []
                for item in candidate.evidence:
                    quote = sources.get((item.page_number, item.source_id))
                    if (item.page_number, item.source_id) not in available:
                        log_event("pdf.evidence.rejected", level="WARNING", **ids, offset=offset,
                                  reason="unknown_source", candidate=candidate.model_dump(mode="json"),
                                  invalid_reference=item.model_dump(), available_references=sorted(available))
                        raise ModelProcessingError(
                            f"AI가 ‘{getattr(candidate, 'title', '공통 조건')}’의 근거 위치를 잘못 지정했습니다 "
                            f"({item.page_number}쪽, 구절 {item.source_id}). PDF는 유지했으며 조건은 저장하지 않았습니다. 추출 다시 시도를 눌러 주세요.")
                    if quote.startswith("[직접 추출 표]"):
                        continue  # 합성한 위치 안내는 원문 인용으로 저장하지 않는다.
                    references.add((item.page_number, item.source_id))
                    evidence.append(Evidence(page_number=item.page_number, quote=quote,
                                             document_id=document.document_id, filename=document.filename))
                if not evidence:
                    log_event("pdf.evidence.rejected", level="WARNING", **ids, offset=offset,
                              reason="table_marker_only", candidate=candidate.model_dump(mode="json"),
                              direct_conditions=len(table_conditions))
                    if not table_conditions:
                        raise ModelProcessingError("조건의 설명문 근거가 없습니다. 조건은 저장하지 않았습니다.")
                    if isinstance(candidate, CatalogRule):
                        details = "; ".join(filter(None, ["HS: " + ", ".join(candidate.hs_codes) if candidate.hs_codes else "",
                                                         candidate.requirements, candidate.uncertainty]))
                        scope = "; ".join(f"{label}: {', '.join(getattr(candidate, field))}" for field, label in
                            (("table_ids", "표"), ("row_numbers", "순번"), ("groups", "분류"), ("specifications", "규격"))
                            if getattr(candidate, field))
                        details = "; ".join(filter(None, [details, scope])) or "공통 조건"
                    else:
                        details = "; ".join(filter(None, [candidate.title, candidate.description, candidate.uncertainty]))
                    warning = ("표 항목은 추출했지만 AI가 표 위치 안내만 근거로 제안한 다음 내용은 "
                               f"원문 설명문 근거가 없어 반영하지 않았습니다: {details}")
                    if warning not in warnings:
                        warnings.append(warning)
                    continue
                # Context is repeated for interpretation, not for extracting the same rows again.
                if not references & current:
                    continue
                if isinstance(candidate, CatalogRule):
                    table_rules.append((candidate, evidence))
                    continue
                if isinstance(candidate.target, ItemTarget) and any(
                        candidate.target.specification == item.target.specification for item in table_conditions):
                    raise ModelProcessingError("AI가 직접 추출된 표 항목을 다시 작성했습니다. 공통 조건 연결 응답을 확인해 주세요.")
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
    warnings.extend(apply_catalog_rules(catalog, table_rules))
    next_state.extracted_conditions[document_id] = [item.model_copy(deep=True) for item in next_state.conditions
                                                   if belongs_to_document(item, document_id)]
    next_state.document_notes[document_id] = warnings + [
        f"{page.page_number}쪽은 읽을 수 있는 텍스트가 없습니다." for page in document.pages if not page.readable]
    next_state.revision += 1
    conversation.investigation = next_state
    return next_state
