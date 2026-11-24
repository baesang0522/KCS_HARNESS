"""현재 요청에서만 사용하는 PDF 검토 조건 및 원문 읽기 도구."""
from copy import deepcopy
from typing import Literal

from langchain_core.tools import tool
from services.investigation.model_context import record_read


def build_pdf_lookup_tools(context, documents=None):
    investigation = context.get('investigation') or {}
    if investigation.get('scope') == 'different_workspace':
        return []
    known = {str(item['document_id']): item for item in investigation.get('documents', [])}
    conditions = investigation.get('conditions', [])

    @tool
    def read_review_conditions(document_id: str | None = None,
                               kind: Literal['supplier', 'item', 'other'] | None = None,
                               condition_ids: list[str] | None = None) -> dict:
        """반영된 검토 시트의 조건을 조회한다. PDF 조건 선별·설명에 사용한다.
        문서 ID·종류·조건 ID로 필요한 범위를 지정한다. 모두 생략하면 전체 조건을 반환한다.
        셀을 직접 읽는 도구가 아니며 서버에 반영된 검토값이다. candidate/needs_review는 선별 확정에 쓰지 않는다.
        원문·인용문은 반환하지 않는다. 회사명 매칭·모델 추출 계산만 요청했으면 기존 실행 도구를 바로 사용한다."""
        if document_id is not None and document_id not in known:
            raise ValueError('현재 조사에 연결된 문서 ID를 지정하세요.')
        selected = [item for item in conditions if
                    (document_id is None or str(item.get('source_document_id')) == document_id or
                     any(str(e.get('document_id')) == document_id for e in item.get('evidence', []))) and
                    (kind is None or (item.get('target') or {}).get('kind', 'other') == kind)]
        if condition_ids is not None:
            if not set(condition_ids) <= {str(item['condition_id']) for item in selected}:
                raise ValueError('지정한 문서·종류에 속하는 실제 조건 ID를 지정하세요.')
            selected = [item for item in selected if str(item['condition_id']) in condition_ids]
        rows = []
        for item in selected:
            row = {key: deepcopy(item[key]) for key in
                   ('condition_id', 'target', 'source_document_id', 'source_pages', 'status',
                    'edited', 'column_ids', 'review_reason') if key in item}
            if not item.get('target'):
                row['description'] = item.get('description', '')
            rows.append(row)
        record_read(context, {'kind': 'review_conditions', 'document_id': document_id,
                              'condition_kind': kind, 'condition_ids': condition_ids,
                              'condition_count': len(selected)})
        return {'source': '반영된 검토 시트', 'condition_count': len(rows), 'conditions': rows}

    @tool
    def read_pdf_source(document_id: str, pages: list[int] | None = None) -> dict:
        """사용자가 원문·근거·출처를 요청한 경우에만 첨부 PDF의 추출 원문을 읽는다.
        documents의 실제 문서 ID와 1부터 시작하는 페이지를 지정한다. pages 생략은 문서 전체다.
        반환 원문은 이번 답변에만 사용한다. 검토 시트의 수정값이 원문에 있다고 주장하지 않는다."""
        if document_id not in known or document_id not in (documents or {}):
            raise ValueError('현재 조사에 연결된 첨부 문서 ID를 지정하세요.')
        document = documents[document_id]
        available = {page.page_number: page for page in document.pages}
        if pages is not None and (not pages or any(type(page) is not int or page not in available for page in pages)):
            raise ValueError('문서에 존재하는 페이지 번호를 지정하세요.')
        selected = list(available) if pages is None else list(dict.fromkeys(pages))
        record_read(context, {'kind': 'pdf_source', 'document_id': document_id,
                              'pages': selected if pages is not None else None, 'page_count': len(selected)})
        return {'document_id': document_id, 'filename': document.filename,
                'pages': [available[number].model_dump(mode='json') for number in selected]}

    tools = [read_review_conditions] if known or conditions else []
    if known and documents:
        tools.append(read_pdf_source)
    return tools
