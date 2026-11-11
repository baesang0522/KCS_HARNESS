"""선택한 실제 모델로 공통 요청 그래프를 검증한다. Excel 셀은 읽거나 수정하지 않는다."""
import asyncio
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
    ('도움 카드', '어떻게 정제해야 할지 모르겠어. 다른 방식 있어?',
     lambda d: d.intent == 'cleaning_help'),
    ('AI 의견', '전체 작업표 데이터를 분석해서 AI 정제 의견을 줘',
     lambda d: d.intent == 'recommendation' and set(d.analysis_column_ids or []) == {'declared', 'trade', 'model', 'cleaned'}),
    ('명시한 결과 열', '모델규격명 정제 열의 AB를 CD로 바꿔줘',
     lambda d: d.intent == 'operation' and d.operation.kind == 'replace' and d.operation.column_ids == ['cleaned'] and d.operation.find == 'AB' and d.operation.replacement == 'CD'),
]


async def main():
    runtime = create_runtime()
    print(f'환경={runtime.settings.environment}, 모델={runtime.settings.llm.model}', flush=True)
    failed = 0
    for name, question, check in CASES:
        try:
            decision, _ = await route_request(runtime, [HumanMessage(content=question)], task_context=CONTEXT)
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
