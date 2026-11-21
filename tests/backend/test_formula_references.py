import json
import unittest
from types import SimpleNamespace
from uuid import uuid4

from agents.request_tools import build_request_tools
from agents.request_router import RequestDecision
from services.chat.service import decision_action
from api.schemas import ConfirmSelectionAction
from services.formula.schemas import CreateFormulaJobRequest, FormulaPlan
from services.formula.planner import generate_formula_plan, validate_reference_sheets


def source():
    return CreateFormulaJobRequest(task_type='formula', conversation_id=uuid4(), formula_job_id=uuid4(),
        instruction='거래처검토 시트의 회사명 목록을 조회해서 같으면 Y, 아니면 N', worksheet_id='source', sheet_name='작업',
        address='작업!A2:A4', row_start=1, column_start=0, row_count=3, column_count=1,
        samples=[{'cells':['ACME']}], reference_sheets=[dict(worksheet_id='reference', sheet_name='거래처검토_ref',
            address='거래처검토_ref!A1:C102', row_start=0, column_start=0, row_count=102, column_count=3,
            samples=[{'cells':['그룹명','회사명','근거 페이지']}], tables=[dict(table_id='t', address='거래처검토_ref!A2:C102',
                data_address='거래처검토_ref!A3:C102', headers=['그룹명','회사명','근거 페이지'])])])


def plan(formula):
    return FormulaPlan(version=1, summary='참조 목록과 비교', actions=[dict(target_range='B2:B4', anchor_cell='B2', formula=formula,
        mode='fill_down',output_label='분석대상여부')])


class FormulaReferenceTests(unittest.IsolatedAsyncioTestCase):
    def test_chat_routes_reference_names_without_requesting_reference_column_ids(self):
        workspace={'workspace_id':str(uuid4()),'columns':[{'column_id':'supplier','header':'해외공급자 상호','role':'company_name'}]}
        tools=build_request_tools({'workspace':workspace})
        start=next(tool for tool in tools if tool.name=='start_task')
        decision=RequestDecision.model_validate(start.invoke({'task_type':'formula','input_column_ids':['supplier'],
            'reference_sheet_names':['거래처검토'],'output':{'mode':'new','name':'분석대상여부'}}))
        action,_=decision_action(decision,workspace)
        checked=ConfirmSelectionAction.model_validate(action)
        self.assertEqual(checked.reference_sheet_names,['거래처검토'])
        self.assertEqual(checked.column_ids,['supplier'])
        with self.assertRaises(ValueError): start.invoke({'task_type':'investigation','reference_sheet_names':['거래처검토']})

    async def test_planner_receives_real_reference_headers_and_full_data_bounds(self):
        seen=[]
        formula='=IF(COUNTIF(\'거래처검토_ref\'!$B$3:$B$102,A2)>0,"Y","N")'
        async def respond(prompt,data):
            seen.append(data)
            return SimpleNamespace(content=plan(formula).model_dump_json())
        runtime=SimpleNamespace(respond=respond,formula_prompt='test',settings=SimpleNamespace(llm=SimpleNamespace(timeout_seconds=1)))
        result=await generate_formula_plan(source(),None,runtime)
        self.assertEqual(result.actions[0].formula,formula)
        reference=seen[0]['reference_sheets'][0]
        self.assertEqual(reference['tables'][0]['data_address'],'거래처검토_ref!A3:C102')
        self.assertEqual(reference['tables'][0]['headers'][1],'회사명')
        self.assertEqual(reference['row_count'],102)

    def test_invented_reference_names_rejected_but_literals_are_not_sheet_references(self):
        with self.assertRaisesRegex(ValueError,'참조 시트'):
            validate_reference_sheets(plan("='없는시트'!B3&A2"),source())
        validate_reference_sheets(plan('=A2&"없는시트!B3"'),source())
        renamed=source().model_copy(update={'reference_sheets':(source().reference_sheets[0].model_copy(update={'sheet_name':"거래처'목록"}),)})
        validate_reference_sheets(plan("='거래처''목록'!B3&A2"),renamed)
