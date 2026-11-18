import unittest
from pydantic import ValidationError
from services.similarity import SimilarityRequest, inspect_similarity
from agents.request_tools import build_request_tools
from agents.request_router import RequestDecision
from api.schemas import ChatResponse

class GroupReviewTests(unittest.TestCase):
    def test_anchor_comparison_uses_linear_pairs_without_transitive_grouping(self):
        rows = [{'excel_row': i+1, 'value': f'MODEL-{i:04}'} for i in range(400)]
        request = SimilarityRequest(settings={'column_id':'model','method':'levenshtein','base_value':'MODEL-0300'}, rows=rows)
        result = inspect_similarity(request)
        self.assertEqual(result['pair_count'],399)
        self.assertTrue(all(row['base']=='MODEL-0300' for row in result['rows']))
        request.settings.base_value = 'missing'
        with self.assertRaisesRegex(ValueError,'기준값'): inspect_similarity(request)

    def test_existing_all_pairs_behavior_is_unchanged(self):
        request = SimilarityRequest(settings={'column_id':'model','method':'sequence'},rows=[{'excel_row':i+1,'value':v} for i,v in enumerate(['A','B','C'])])
        self.assertEqual(inspect_similarity(request)['pair_count'],3)

    def test_review_tool_only_opens_card_and_validates_column(self):
        workspace={'columns':[{'column_id':'custom','role':'reference'}],'target_column_ids':['custom']}
        tools={tool.name:tool for tool in build_request_tools({'workspace':workspace})}
        card=tools['open_group_review'].invoke({'column_id':'custom'})
        decision=RequestDecision.model_validate(card)
        self.assertEqual(decision.intent,'group_review')
        self.assertIsNone(decision.operation)
        with self.assertRaises(ValueError): tools['open_group_review'].invoke({'column_id':'deleted'})
        ChatResponse(conversation_id='c',request_id='r',answer='확인',reasoning=[],ui_action={'type':'open_group_review','column_ids':['custom']})
        with self.assertRaises(ValidationError): RequestDecision(intent='group_review',answer='확인',analysis_column_ids=['a','b'])


class ConditionalMarkTests(unittest.TestCase):
    def test_even_set_value_cannot_bypass_row_selection(self):
        workspace={'columns':[{'column_id':'company','role':'company_name'}],'target_column_ids':['company']}
        tools={tool.name:tool for tool in build_request_tools({'workspace':workspace})}
        for name,args in [('set_value',{'value':'분석대상'}),('open_group_review',{'assigned_value':'분석대상'})]:
            card=tools[name].invoke(dict(column_id='company',match_text='JIANGSU SHAGANG INTL TRADE',output_name='분석대상',**args))
            decision=RequestDecision.model_validate(card)
            self.assertEqual(decision.intent,'group_review')
            self.assertIsNone(decision.operation)
            self.assertEqual(decision.group_review_request.match_text,'JIANGSU SHAGANG INTL TRADE')
            self.assertEqual(decision.group_review_request.output_name,'분석대상')
            self.assertEqual(decision.group_review_request.assigned_value,'분석대상')
        fallback=tools['set_value'].invoke({'value':'분석대상'})
        self.assertEqual(fallback['intent'],'group_review')
        self.assertNotIn('operation',fallback)
