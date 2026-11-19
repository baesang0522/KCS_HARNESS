"""실제 설정 모델의 목표 실행을 합성 Excel 응답으로 검증한다. 실제 파일은 읽거나 쓰지 않는다."""
import asyncio
from uuid import uuid4

from repositories.conversation_repository import MemoryConversationRepository
from runtime import create_runtime
from services.agent_runs import Advance, advance
from services.chat import process_chat


async def main():
    runtime = create_runtime()
    repository = MemoryConversationRepository()
    cid = await repository.create()
    workspace = dict(workspace_id=str(uuid4()), worksheet_id='synthetic-sheet', table_id='synthetic-table',
        task_type='investigation', sheet_name='합성 검사', row_start=1, row_count=3, target_column_ids=['name'],
        columns=[dict(column_id='name', header='상호', role='reference')])
    rows = [dict(identity=i, excel_row=i+1, values=[value]) for i, value in enumerate(['ACME LTD', 'ACME LIMITED', 'OTHER'], 1)]
    reply = await process_chat(runtime=runtime, repository=repository, formula_jobs={}, operation_jobs={},
        conversation_id=cid, request_id=str(uuid4()), workspace=workspace,
        message='상호 열을 확인해서 ACME LTD와 철자가 비슷한 값들의 점수와 건수를 보여줘. 필요한 조회·비교는 알아서 이어서 해줘. 비교는 레벤슈타인으로 하고 셀은 바꾸지 마.')
    assert reply['ui_action'] and reply['ui_action']['type'] == 'agent_run', reply
    rid = reply['ui_action']['run_id']
    conversation = repository._conversations[cid]
    receipt = None
    reads, comparisons = 0, 0
    for _ in range(10):
        state = await advance(conversation=conversation, conversation_id=cid, run_id=rid,
            payload=Advance(request_id=uuid4(),workspace=workspace,receipt=receipt), runtime=runtime,operation_jobs={},formula_jobs={})
        print(state['status'], state['answer'], flush=True)
        if state['status'] == 'COMPLETED':
            assert reads and comparisons, '실제 조회·비교 결과가 필요합니다.'
            print(f'PASS environment={runtime.settings.environment} model={runtime.settings.llm.model} reads={reads} comparisons={comparisons}', flush=True)
            return
        assert state['status'] == 'WAITING_EXCEL', state['answer']
        action = state['step']['action']
        assert action['type'] == 'agent_read', '합성 검증에서는 읽기·비교만 허용합니다.'
        assert action['read']['column_ids'] == ['name'] and action['read']['condition'] is None, action
        if action['read']['similarity']: comparisons += 1
        else: reads += 1
        receipt = dict(step_id=state['step']['step_id'],status='SUCCEEDED',rows=rows)
    raise AssertionError('목표 실행이 종료되지 않았습니다.')


if __name__ == '__main__':
    asyncio.run(main())
