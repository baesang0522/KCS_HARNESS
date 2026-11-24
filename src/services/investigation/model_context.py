"""PDF 본문은 요청 안에서만 읽고, 다음 요청에는 위치 정보만 전달한다."""
import json
from collections import Counter
from copy import deepcopy


def overview(investigation):
    if not investigation:
        return investigation
    result = {key: deepcopy(investigation[key]) for key in
              ('scope', 'notice', 'active_condition_id', 'documents', 'review_targets')
              if key in investigation}
    conditions = investigation.get('conditions', [])
    result['condition_count'] = len(conditions)
    result['condition_status_counts'] = dict(Counter(item.get('status', 'unknown') for item in conditions))
    result['condition_kind_counts'] = dict(Counter((item.get('target') or {}).get('kind', 'other') for item in conditions))
    extracted = investigation.get('document_notes', {})
    for document in result.get('documents', []):
        document['extracted'] = str(document['document_id']) in extracted
    result['detail_access'] = '조건은 read_review_conditions, 원문·근거 요청은 read_pdf_source로 이번 요청에서만 조회'
    return result


def model_task_context(context):
    result = {key: value for key, value in context.items() if not key.startswith('_pdf_')}
    result['investigation'] = overview(context.get('investigation'))
    # 적용 완료 관측에도 계산용 PDF 목록을 통째로 다시 싣지 않는다.
    agent = context.get('agent_run')
    if agent and (agent.get('observation') or {}).get('kind') in {'operation', 'formula'}:
        result['agent_run'] = {**agent, 'observation': deepcopy(agent['observation'])}
        job = result['agent_run']['observation'].get('result', {})
        for key in ('supplier_references', 'model_references'):
            if key in job:
                items = job.pop(key)
                job[key + '_count'] = len(items) if items else 0
    return result


def record_read(context, reference):
    references = context.setdefault('_pdf_read_refs', [])
    if reference not in references:
        references.append(reference)


def history_summary(context):
    refs = context.get('_pdf_read_refs')
    if not refs:
        return None
    return ('PDF 조회 기록(내용은 다음 요청에 전달하지 않음; 필요하면 다시 조회): ' +
            json.dumps(refs, ensure_ascii=False))
