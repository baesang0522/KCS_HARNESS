import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace
from uuid import uuid4
from agents.request_tools import build_request_tools
from services.recommendation.service import resolve_advice_subject
from services.chat.service import process_chat
from agents.request_router import RequestDecision
from repositories.conversation_repository import MemoryConversationRepository, StoredTurn


class AdviceSubjectTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.workspace={'workspace_id':str(uuid4()),'worksheet_id':'sheet','table_id':'table','task_type':'investigation',
            'advice_subject':'company','columns':[{'column_id':role,'role':role,'header':role} for role in
            ['company_name','country_code','declared_name','trade_name','model_spec','reference']], 'target_column_ids':['model_spec']}
    def test_explicit_request_wins_and_ambiguous_target_is_not_defaulted_to_company(self):
        w=self.workspace
        self.assertEqual(resolve_advice_subject(w),'model')
        self.assertEqual(resolve_advice_subject(w,['model_spec'],'company'),'company')
        self.assertEqual(resolve_advice_subject(w,['company_name']),'company')
        self.assertIsNone(resolve_advice_subject(w,['reference']))
        self.assertIsNone(resolve_advice_subject(w,['company_name','model_spec']))
        tool=next(t for t in build_request_tools({'workspace':w}) if t.name=='recommend_preprocessing')
        result=tool.invoke({'subject':'model','column_ids':['model_spec']})
        self.assertEqual(result['advice_subject'],'model')
        self.assertEqual(set(result['analysis_column_ids']),{'declared_name','trade_name','model_spec'})
        self.assertEqual(tool.invoke({'column_ids':['reference']})['intent'],'clarify')
    async def test_button_request_preserves_original_context_for_retry_and_model_topic_in_action(self):
        repo=MemoryConversationRepository();conversation=await repo.create()
        cid=conversation
        args=dict(runtime=None,repository=repo,formula_jobs={},operation_jobs={},conversation_id=cid,request_id=str(uuid4()),
                  message='AI 의견',workspace=self.workspace,advice_requested=True)
        result=await process_chat(**args)
        self.assertEqual(result['ui_action']['advice_subject'],'model')
        self.assertEqual(await process_chat(**args),result)
        self.assertEqual(self.workspace['advice_subject'],'company')

    async def test_plain_advice_skips_router_but_column_specific_request_keeps_history(self):
        repo = MemoryConversationRepository()
        cid = await repo.create()
        async with repo.edit(cid) as conversation:
            for i in range(10):
                await conversation.save_turn(StoredTurn(str(i), '이전 질문', '이전 답변', []))
        args = dict(runtime=None, repository=repo, formula_jobs={}, operation_jobs={},
                    conversation_id=cid, workspace=self.workspace)
        with patch('services.chat.service.route_request', new_callable=AsyncMock) as router:
            with patch.object(StoredTurn, 'model_history', side_effect=AssertionError):
                for message in ['LLM 의견 줘', 'AI 정제 의견을 주세요.', '정제 의견 줘']:
                    reply = await process_chat(**args, request_id=str(uuid4()), message=message)
                    self.assertEqual(reply['ui_action']['type'], 'analyze_data')
                    self.assertEqual(reply['ui_action']['advice_subject'], 'model')
            router.assert_not_awaited()
            router.return_value = (RequestDecision(intent='general', answer='확인'), [])
            message = '거래처명 열만 보고 AI 의견 줘'
            await process_chat(**args, request_id=str(uuid4()), message=message)
            messages = router.await_args.args[1]
            self.assertEqual(len(messages), 21)
            self.assertEqual(messages[-1].content, message)
