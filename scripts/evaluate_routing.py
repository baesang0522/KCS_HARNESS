"""선택한 실제 모델로 공통 요청 그래프를 검증한다. Excel 셀은 읽거나 수정하지 않는다."""
import asyncio
from copy import deepcopy
from langchain_core.messages import HumanMessage
from agents.request_router import route_request
from runtime import create_runtime


CONTEXT = {'workspace': {
    'workspace_id': 'synthetic-workspace', 'task_type': 'model_normalization',
    'sheet_name': '테스트', 'row_count': 100000,
    'target_column_ids': ['model'], 'last_result_column_ids': ['cleaned'],
    'columns': [dict(column_id=id, header=header, role=role) for id, header, role in [
        ('declared', '신고품명', 'declared_name'), ('trade', '거래품명', 'trade_name'),
        ('model', '모델규격명', 'model_spec'), ('cleaned', '모델규격명 정제', 'result')]],
}}
CASES = [
    ('조건부 추출', '거래품명의 마지막 단어가 모델규격명 정제 열 안에 있을 경우 추출해줘',
     lambda d: d.intent == 'start_task' and d.task_type == 'formula' and set(d.formula_column_ids or []) == {'trade', 'cleaned'}),
    ('단순 분리', '거래품명의 마지막 단어만 추출해줘',
     lambda d: d.intent == 'operation' and d.operation.kind == 'split' and d.operation.part == 'last' and d.operation.column_ids == ['trade']),
    ('모델 후보', '모델규격명에서 MODEL, CODE, GRADE 뒤 값을 추출해줘',
     lambda d: d.intent == 'operation' and d.operation.kind == 'extract' and d.operation.extraction_mode == 'labelled' and d.operation.column_ids == ['model']),
    ('방법 안내', '어떻게 정제해야 할지 모르겠어. 다른 방식 있어?',
     lambda d: d.intent == 'general'),
    ('AI 의견', '전체 작업표 데이터를 분석해서 AI 정제 의견을 줘',
     lambda d: d.intent == 'recommendation' and set(d.analysis_column_ids or []) == {'declared', 'trade', 'model', 'cleaned'}),
    ('명시한 결과 열', '모델규격명 정제 열의 AB를 CD로 바꿔줘',
     lambda d: d.intent == 'operation' and d.operation.kind == 'replace' and d.operation.column_ids == ['cleaned'] and d.operation.find == 'AB' and d.operation.replacement == 'CD'),
]

REVIEW = deepcopy(CONTEXT)
REVIEW['workspace']['columns'] += [dict(column_id=id, header=header, role=role) for id, header, role in [
    ('supplier', '해외공급자상호 정제', 'company_name'), ('flag', '작업대상', 'result'),
    ('group', '거래처 그룹', 'result'), ('score', '거래처 유사도', 'result'), ('spec', '모델규격명 검토', 'reference')]]
REVIEW['workspace']['row_scopes'] = [dict(mode='replace', condition=dict(column_id='flag', operator='equals', value='Y'))]
REVIEW['investigation'] = {'scope': 'bound',
    'documents': [{'document_id': '00000000-0000-4000-8000-000000000001', 'filename': '검토.pdf', 'status': 'READY'}],
    'conditions': [{'condition_id': 'supplier-condition', 'kind': 'supplier', 'status': 'confirmed',
        'target': {'kind': 'supplier', 'group': '1', 'company_name': 'ACME LTD', 'category': '대상 회사'}},
        {'condition_id': 'item-condition', 'kind': 'item', 'status': 'confirmed',
        'target': {'kind': 'item', 'group': '강판', 'hs_codes': [], 'specification': 'AB123', 'requirements': ''}}]}
EXACT_REQUEST = '해외공급자상호 정제와 거래처검토 시트의 회사명이 정확히 일치하면 Y, 아니면 N인 분석대상여부 새 열을 만들어줘'
MATCH_REQUEST = '거래처검토 회사명과 해외공급자상호 정제를 유사도 비교해 90점 이상이면 기존 작업대상 열을 Y로 바꿔줘'
GROUP_REQUEST = '해외공급자상호 정제와 회사명을 유사도 비교한 후 그룹명으로 묶어줘'
FAILED = deepcopy(REVIEW)
FAILED['execution_history'] = {'records': [dict(kind='formula', status='FAILED', error='수식 JSON 검증 실패',
    instruction=EXACT_REQUEST, input_columns=[dict(column_id='supplier', current_header='해외공급자상호 정제', exists=True)],
    output_name='분석대상여부', settings_excerpt='', settings_truncated=False, result_columns=[], executed_range=None)]}
PREVIOUS = deepcopy(REVIEW)
PREVIOUS['agent_run'] = dict(goal='100점 대표 부호로 그룹 연결', user_request='100점 대표 부호로 그룹 연결', status='COMPLETED')


def exact_formula(d):
    return (d.intent == 'start_task' and d.task_type == 'formula'
            and d.formula_column_ids == ['supplier'] and d.formula_reference_sheets == ['거래처검토']
            and d.formula_output is not None and d.formula_output.mode == 'new'
            and d.formula_output.name == '분석대상여부' and d.formula_output.anchor is None)


def execution_context(goal, applied=False):
    context = deepcopy(REVIEW)
    context['agent_execution'] = True
    context['agent_run'] = dict(user_request=goal, goal=goal, read_results=[], completed_jobs=[], observation=None)
    if applied:
        context['workspace']['columns'] += [dict(column_id='new-group', header='이번 매칭 그룹', role='result'),
                                            dict(column_id='new-score', header='이번 매칭 점수', role='result')]
        context['agent_run']['observation'] = dict(kind='operation', job_id='match-job', status='APPLIED',
            source={'operation': dict(kind='match_suppliers', column_ids=['supplier'], similarity_method='auto', output={'mode': 'new'})},
            result=dict(status='APPLIED', result_column_ids=['new-group', 'new-score'], row_count=3, changed_count=2))
        context['agent_run']['completed_jobs'] = [dict(kind='operation', job_id='match-job', status='APPLIED')]
    return context


CASES = [(name, question, check, CONTEXT) for name, question, check in CASES] + [
    ('다른 시트 정확 일치 Y/N', EXACT_REQUEST, exact_formula, REVIEW),
    ('실패한 수식 다시 준비', '방금 실패한 수식을 같은 조건과 이름으로 다시 만들어줘', exact_formula, FAILED),
    ('유사도 후 기존 Y 변경', MATCH_REQUEST,
     lambda d: d.intent == 'agent' and not d.resume_agent and d.code_grouping_request is None
     and all(value in d.goal for value in ['90', '작업대상', 'Y', '해외공급자상호']), REVIEW),
    ('역할 다른 명시 입력 추출', '품목검토시트의 그룹과 규격을 보고 모델규격명 검토 열에서 모델을 찾아 새 모델 열과 옆 그룹 열에 추출해줘',
     lambda d: d.intent == 'operation' and d.operation.kind == 'extract'
     and d.operation.column_ids == ['spec'] and d.operation.extraction_mode == 'pdf', REVIEW),
    ('결과 열 명시 추출', '품목검토시트 규격과 그룹으로 모델규격명 정제 열에서 모델과 그룹을 추출해줘',
     lambda d: d.intent == 'operation' and d.operation.kind == 'extract'
     and d.operation.column_ids == ['cleaned'] and d.operation.extraction_mode == 'pdf', REVIEW),
    ('역할 변경 자체 요청', '모델규격명 검토 열의 역할만 모델규격으로 바꿔줘. 추출은 하지 마',
     lambda d: d.intent == 'workspace_action' and d.workspace_action.column_id == 'spec'
     and d.workspace_action.role == 'model_spec', REVIEW),
    ('현재 후보 조건부 변경', '그중 해외공급자상호 정제에 ACME가 포함되면 기존 작업대상을 Y로 바꿔줘',
     lambda d: d.intent == 'operation' and d.operation.kind == 'set' and d.operation.condition_scope == 'current'
     and d.operation.condition.column_id == 'supplier' and d.operation.condition.operator == 'contains'
     and d.operation.condition.value == 'ACME' and d.operation.destination_column_id == 'flag' and d.operation.assigned_value == 'Y', REVIEW),
    ('전체 조건부 변경', '전체 작업표에서 해외공급자상호 정제에 ACME가 포함되면 기존 작업대상을 Y로 바꿔줘',
     lambda d: d.intent == 'operation' and d.operation.kind == 'set' and d.operation.condition_scope == 'all'
     and d.operation.destination_column_id == 'flag' and d.operation.assigned_value == 'Y', REVIEW),
    ('필터 뒤 추가 선별', '남은 행 중 거래품명에 STEEL이 포함된 행만 남겨줘',
     lambda d: d.intent == 'scope' and d.scope_change.mode == 'intersect'
     and d.scope_change.condition.column_id == 'trade' and d.scope_change.condition.value == 'STEEL', REVIEW),
    ('검토 시트 전처리', '검토.pdf 거래처검토 시트의 회사명 열에서 한글만 제거해줘',
     lambda d: d.intent == 'document' and d.document_action.action == 'preprocess'
     and str(d.document_action.document_id) == '00000000-0000-4000-8000-000000000001' and d.document_action.kind == 'supplier'
     and d.document_action.column == '회사명'
     and [r.operation for r in d.document_action.rules] == ['remove_hangul'], REVIEW),
    ('이전 대표 부호 목표 미승계', GROUP_REQUEST,
     lambda d: (d.intent == 'operation' and d.operation.kind == 'match_suppliers') or
     (d.intent == 'agent' and not d.resume_agent and d.code_grouping_request is None and '100' not in d.goal), PREVIOUS),
    ('실행 첫 단계 새 유사도 결과', MATCH_REQUEST,
     lambda d: d.intent == 'operation' and d.operation.kind == 'match_suppliers' and d.operation.column_ids == ['supplier']
     and d.operation.similarity_method == 'auto' and d.operation.output.mode == 'new', execution_context(MATCH_REQUEST)),
    ('매칭 적용 후 그룹 기준 Y', '적용 완료했어. 남은 목표를 진행해줘',
     lambda d: d.intent == 'operation' and d.operation.kind == 'set'
     and d.operation.condition.column_id == 'new-group' and d.operation.condition.operator == 'not_blank'
     and d.operation.destination_column_id == 'flag' and d.operation.assigned_value == 'Y'
     and d.operation.condition_scope == 'current', execution_context(MATCH_REQUEST, applied=True)),
    ('그룹만 요청하면 종료', '적용 완료했어. 결과를 알려줘',
     lambda d: d.intent == 'general', execution_context(GROUP_REQUEST, applied=True)),
    ('실행 중 정확 일치 수식', EXACT_REQUEST, exact_formula, execution_context(EXACT_REQUEST)),
]


async def main():
    runtime = create_runtime()
    print(f'환경={runtime.settings.environment}, 모델={runtime.settings.llm.model}', flush=True)
    failed = 0
    for name, question, check, context in CASES:
        try:
            decision, _ = await route_request(runtime, [HumanMessage(content=question)], task_context=deepcopy(context))
            ok = check(decision)
            detail = decision.model_dump_json(exclude_none=True)
        except Exception as error:
            ok, detail = False, f'{type(error).__name__}: {error}'
        failed += not ok
        print(f'{"PASS" if ok else "FAIL"} {name}: {detail}', flush=True)
    print(f'{len(CASES) - failed}/{len(CASES)} 통과', flush=True)
    return int(failed > 0)


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
