import unittest
from uuid import uuid4

from pydantic import ValidationError
from agents.request_tools import build_request_tools
from agents.execution_tools import execution_tools
from services.operations.dimensions import DimensionRules, DimensionParser
from services.operations.schemas import Operation, OperationRequest
from services.operations.service import execute
from services.operations.jobs import CreateOperationJob, JobPreview, OutputPlacement, JobUpdate, create_job, preview_job, begin_apply, update_job
from services.chat.service import build_task_context
from services.chat.state import WorkFlowState


class DimensionTests(unittest.TestCase):
    def parse(self, value, **settings):
        return DimensionParser(DimensionRules(product='철판', **settings)).parse(value)

    def test_default_tuples_and_explicit_labels(self):
        for text in ['SA516-70 134X2500X12000', '134 × 2,500 × 12,000 MM', '134*2500*12000',
                     '134MM X 2500MM X 12000MM', 'SIZE=134X2500X12000', '１３４Ｘ２５００Ｘ１２０００',
                     'THK:134 WIDTH:2500 LENGTH:12000', 'LENGTH=12000 WIDTH=2500 THICKNESS=134']:
            with self.subTest(text=text):
                values, evidence=self.parse(text)
                self.assertEqual(values[:3], ['134','2500','12000'])
                self.assertTrue(evidence);self.assertTrue(values[-1].startswith('추출'))
        self.assertIn('mm 가정',self.parse('134x2500x12000')[0][-1])
        self.assertNotIn('mm 가정',self.parse('134x2500x12000 mm')[0][-1])

    def test_units_decimals_and_thickness_only(self):
        for text in ['13.4cm X 2.5m X 12m', '134x2500x12000mm']:
            self.assertEqual(self.parse(text)[0][:3],['134','2500','12000'])
        self.assertEqual(self.parse('THK: .5 IN',fields=['thickness'])[0],['12.7','추출'])
        self.assertEqual(self.parse('13.4X250X1200',unit='cm')[0][:3],['134','2500','12000'])
        self.assertEqual(self.parse('THK:134',fields=['thickness'],unit='mm')[0],['134','추출'])
        self.assertEqual(self.parse('THK:134MM',fields=['thickness'],unit='cm')[0],['134','추출'])

    def test_explicit_order_delimiter_prefix_and_label(self):
        self.assertEqual(self.parse('2000/6000/134',order=['width','length','thickness'],fields=['thickness'],delimiter='/')[0][0],'134')
        self.assertEqual(self.parse('OTHER 1X2X3 SIZE:134X2500X12000',after='SIZE:')[0][:3],['134','2500','12000'])
        self.assertEqual(self.parse('THK:134MM',fields=['thickness'],labels={'thickness':'THK:'})[0],['134','추출'])
        self.assertEqual(self.parse('GAUGE=134mm',fields=['thickness'],labels={'thickness':'GAUGE='})[0],['134','추출'])
        self.assertEqual(self.parse('DIM: 134|2500|12000',delimiter='|',after='DIM:')[0][:3],['134','2500','12000'])

    def test_ambiguities_blank_every_numeric_field(self):
        for text in ['2000x6000x134','134x2500x12000;50x2000x6000','0x2500x12000',
                     '134x2500x12000x2','THK:134 THK:135 WIDTH:2500 LENGTH:12000',
                     'THK:130;134x2500x12000', 'THK:134-150MM WIDTH:2500 LENGTH:12000',
                     'THK:134 MM 이상 WIDTH:2500 LENGTH:12000', '1in x 20 x 40mm',
                     '134~150x2500x12000', '>=134x2500x12000', '134x2500x12000 ±2',
                     '134x2500x12000 ft', '134x2500x12000 (in)', '134x2500x12000 mm2']:
            with self.subTest(text=text):
                values,_=self.parse(text)
                self.assertEqual(values[:3],['','','']);self.assertTrue(values[-1].startswith('확인 필요'), values)
        self.assertIn('확인 필요',self.parse('SIZE:1x2x3 SIZE:2x3x4',after='SIZE:')[0][-1])

    def test_model_numbers_fractions_ranges_and_unknown_units_are_not_definitive_values(self):
        for text in ['AB134CD2500EF12000','AB134X2500X12000','SA516-70','1/2X2500X12000',
                     '-134x2500x12000','1e3x2500x12000','134x2500x12000kg','12,34x2500x12000']:
            with self.subTest(text=text):self.assertEqual(self.parse(text)[0][:3],['','',''])
        self.assertEqual(self.parse('THK:134KG',fields=['thickness'])[0][0],'')

    def test_other_products_and_unknown_profile_require_a_rule(self):
        self.assertEqual(DimensionParser(DimensionRules(product='강관')).parse('100x5x6000mm')[0][:3],['100','5','6000'])
        self.assertEqual(DimensionParser(DimensionRules(product='환봉')).parse('20x6000mm')[0][:2],['20','6000'])
        self.assertTrue(DimensionParser(DimensionRules(product='강관')).parse('100x60x6000mm')[0][-1].startswith('확인 필요'))
        with self.assertRaises(ValidationError):DimensionRules(product='곡물')
        rules=DimensionRules(product='상자',order=['width','depth','height'])
        self.assertEqual(DimensionParser(rules).parse('10x20x30cm')[0][:3],['100','200','300'])

    def test_schema_rejects_conflicting_rules_and_unrelated_operations(self):
        for settings in [dict(order=['width','width']),dict(fields=['depth']),dict(delimiter='.'),dict(labels={'thickness':''})]:
            with self.assertRaises(ValidationError):DimensionRules(product='철판',**settings)
        with self.assertRaises(ValueError):DimensionParser(DimensionRules(product='철판',labels={'thickness':'WIDTH'}))
        with self.assertRaises(ValidationError):Operation(kind='dimensions',column_ids=['model'])
        with self.assertRaises(ValidationError):Operation(kind='replace',column_ids=['model'],find='a',dimensions={'product':'철판'})
        with self.assertRaises(ValidationError):Operation(kind='dimensions',column_ids=['model'],dimensions={'product':'철판'},output={'mode':'existing','column_id':'old'})

    def test_excel_precision_is_not_silently_lost(self):
        values,_=self.parse('THK:0.1234567890123456mm',fields=['thickness'])
        self.assertEqual(values[0],'');self.assertIn('정밀도',values[-1])

    def test_service_preserves_rows_evidence_and_blank_vs_review(self):
        data=OperationRequest(operation=dict(kind='dimensions',column_ids=['model'],dimensions=dict(product='철판',fields=['thickness'])),
                              rows=[dict(excel_row=i+2,values=[v]) for i,v in enumerate(['134x2500x12000','unknown','2000x6000x134','134x2500x12000'])])
        result=execute(data)
        self.assertEqual(result.headers,['두께(mm)','규격 파싱 상태']);self.assertEqual(result.changed_count,2)
        self.assertEqual(result.extracted_texts,['134x2500x12000','','2000x6000x134','134x2500x12000'])
        self.assertEqual(result.rows[1].values,['','미검출']);self.assertIn('확인 필요',result.rows[2].values[-1])
        self.assertEqual([r.excel_row for r in result.rows],[2,3,4,5])

    def context(self):
        workspace=dict(workspace_id=str(uuid4()),worksheet_id='sheet',table_id='table',task_type='investigation',sheet_name='작업',
                       columns=[dict(column_id='model',header='모델규격명',role='model_spec')],target_column_ids=['model'])
        return {'workspace':workspace}

    def tool(self, context):
        tools=build_request_tools(context)
        self.assertIn('parse_dimensions',{t.name for t in execution_tools(context,tools)})
        return next(t for t in tools if t.name=='parse_dimensions')

    def test_missing_product_asks_then_defaults_and_explicit_requests_recompute(self):
        context=self.context();tool=self.tool(context)
        self.assertEqual(tool.invoke({})['intent'],'clarify')
        first=tool.invoke({'product':'철판'})
        self.assertEqual(first['operation']['kind'],'dimensions');self.assertIn('기본 순서',first['answer'])
        self.assertEqual(tool.invoke({'product':'곡물'})['intent'],'clarify')
        context['workspace']['pending_operation']=first['operation']
        changed=self.tool(context).invoke({'order':['width','length','thickness'],'unit':'cm','fields':['thickness']})
        self.assertEqual(changed['operation']['dimensions']['product'],'철판')
        self.assertEqual(changed['operation']['dimensions']['order'],['width','length','thickness'])
        self.assertEqual(changed['operation']['dimensions']['fields'],['thickness'])
        self.assertEqual(self.tool(context).invoke({'product':'강관'})['operation']['dimensions']['order'],None)
        with self.assertRaises(ValueError):tool.invoke({'product':'철판','column_id':'other'})

    def test_job_lifecycle_history_reuses_applied_rules_only_in_same_workspace(self):
        context=self.context();w=context['workspace'];cid=str(uuid4());jobs={}
        operation=self.tool(context).invoke({'product':'철판','unit':'cm','fields':['thickness']})['operation']
        source=CreateOperationJob(operation_job_id=uuid4(),conversation_id=cid,workspace_id=w['workspace_id'],worksheet_id='sheet',table_id='table',
            task_type='investigation',row_start=1,row_count=2,model_spec_column_id='model',operation=operation)
        job=create_job(source,jobs);preview_job(job,JobPreview(rows=[dict(excel_row=2,values=['13.4x250x1200'])],selected_count=2))
        update_job(job,JobUpdate(status='PREVIEW_READY'))
        with self.assertRaises(Exception):begin_apply(job,OutputPlacement(mode='existing',column_id='old'))
        begin_apply(job,OutputPlacement(mode='new',anchor='model',name='규격'))
        update_job(job,JobUpdate(status='APPLIED',result_column_ids=['thickness','status']))
        built=build_task_context(WorkFlowState(),{},operation_jobs=jobs,conversation_id=cid,workspace=w)
        reused=self.tool(built).invoke({})['operation']['dimensions']
        self.assertEqual(reused['unit'],'cm');self.assertEqual(reused['fields'],['thickness'])
        record=built['execution_history']['records'][0]
        self.assertEqual([c['purpose'] for c in record['result_columns']],['data','change_status'])
        wrong=build_task_context(WorkFlowState(),{},operation_jobs=jobs,conversation_id=cid,workspace={**w,'workspace_id':str(uuid4())})
        self.assertEqual(self.tool(wrong).invoke({})['intent'],'clarify')


class ConditionalDimensionTests(unittest.TestCase):
    parse = DimensionTests.parse
    tool = DimensionTests.tool
    def test_reported_label_layouts_extract_numbers_not_words(self):
        for raw, expected in [
            ("'MODEL: API 2W-50LS,PS: HOT ROLLED, MT: STEEL,SHAPE: PLATE, TS:448MPA,SIZE: T 38.1 W X 3228 X L 11816 MM 35 PC", '38.1'),
            ("'MODEL: API 2Y-50ZLS,PS: HOT ROLLED, MT: STEEL,SHAPE: PLATE, TS:448MPA,SIZE: T 120.00 X W 4040 X L 6507 MM 1 PC", '120'),
        ]:
            with self.subTest(raw=raw):
                values, evidence = self.parse(raw, fields=['thickness'], after='SIZE:')
                self.assertEqual(values[0], expected)
                self.assertTrue(values[-1].startswith('추출'))
                self.assertNotIn('448', evidence)
        self.assertEqual(self.parse('T 12XYZ W 200 L 300', fields=['thickness'])[0][0], '')
        self.assertEqual(self.parse('SIZE: T W X 3228 X L 11816 MM', fields=['thickness'], after='SIZE:')[0][0], '')

    def context(self):
        context = DimensionTests.context(self)
        context['workspace']['columns'] += [dict(column_id='flag',header='분석대상여부',role='reference'),
                                             dict(column_id='result',header='두께',role='result')]
        return context

    def test_conditional_extraction_checks_product_and_explicit_source_without_role(self):
        context=self.context()
        context['workspace']['columns'][0]['role']='reference'
        args=dict(column_id='model',fields=['thickness'],condition=dict(column_id='flag',operator='equals',value='분석대상'),
                  output=dict(mode='existing',column_id='result'))
        self.assertEqual(self.tool(context).invoke(args)['intent'],'clarify')
        op=self.tool(context).invoke({**args,'product':'철판'})['operation']
        self.assertEqual(op['condition_scope'],'all')
        self.assertEqual(Operation.model_validate(op).input_column_ids,['model','flag'])
        self.assertEqual(context['workspace']['columns'][0]['role'],'reference')
        result=execute(OperationRequest(operation=op,rows=[dict(excel_row=40,values=['T 38.1 W X 3228 X L 11816 MM','분석대상'])]))
        self.assertEqual(result.rows[0].values[0],'38.1')
        with self.assertRaisesRegex(ValidationError,'조건에 맞지'):
            OperationRequest(operation=op,rows=[dict(excel_row=41,values=['T 38.1','N'])])
        with self.assertRaisesRegex(ValueError,'원본·조건'):
            self.tool(context).invoke({**args,'product':'철판','output':dict(mode='existing',column_id='model')})

    def test_missing_workspace_does_not_crash_product_clarification(self):
        from agents.tools.operations import build_operations_tools
        tool=build_operations_tools({})['parse_dimensions']
        self.assertEqual(tool.invoke({})['intent'],'clarify')

    def test_conditional_job_overwrites_only_planned_existing_column(self):
        context=self.context();w=context['workspace'];jobs={}
        op=self.tool(context).invoke(dict(product='철판',fields=['thickness'],
            condition=dict(column_id='flag',operator='equals',value='Y'),output=dict(mode='existing',column_id='result')))['operation']
        source=CreateOperationJob(operation_job_id=uuid4(),conversation_id=uuid4(),workspace_id=w['workspace_id'],
            worksheet_id='sheet',table_id='table',task_type='investigation',row_start=1,row_count=50,operation=op)
        job=create_job(source,jobs)
        preview_job(job,JobPreview(rows=[dict(excel_row=40,values=['T 120.00 X W 4040 X L 6507 MM','Y'])],selected_count=1))
        update_job(job,JobUpdate(status='PREVIEW_READY'))
        with self.assertRaises(Exception):begin_apply(job,OutputPlacement(mode='existing',column_id='model'))
        begin_apply(job,OutputPlacement(mode='existing',column_id='result'))
        update_job(job,JobUpdate(status='APPLIED',result_column_ids=['result']))
        with self.assertRaisesRegex(ValidationError,'기존 행 필터'):
            CreateOperationJob.model_validate({**source.model_dump(), 'row_filter':dict(column_id='flag',operator='equals',value='N')})

    def test_formula_tool_cannot_bypass_dimension_checks_but_numeric_comparison_is_allowed(self):
        context=self.context()
        for request in ['분석대상인 행에서 두께만 뽑아줘','두께 규격을 추출해줘','규격 파싱해줘']:
            context['user_request']=request
            start=next(t for t in build_request_tools(context) if t.name=='start_task')
            with self.assertRaisesRegex(ValueError,'parse_dimensions'):
                start.invoke(dict(task_type='formula',input_column_ids=['model','flag']))
        for request in ['두께가 90 미만이면 분석대상여부에 N을 써줘', '문자열 길이를 뽑아줘']:
            context['user_request']=request
            start=next(t for t in build_request_tools(context) if t.name=='start_task')
            self.assertEqual(start.invoke(dict(task_type='formula',input_column_ids=['result']))['task_type'],'formula')

class DimensionRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_wrong_formula_route_recovers_through_product_check_before_any_excel_action(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock, patch
        from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
        from agents.request_router import route_request
        context=ConditionalDimensionTests.context(self)
        context['workspace']['columns'][0]['role']='reference'
        request='분석대상인 행에서 두께만 뽑아줘'
        context['user_request']=request
        for product in [None,'철판']:
            args=dict(column_id='model',fields=['thickness'],condition=dict(column_id='flag',operator='equals',value='분석대상'))
            if product: args['product']=product
            replies=[AIMessage(content='',tool_calls=[dict(name='start_task',args=dict(task_type='formula',input_column_ids=['model','flag']),id='wrong')]),
                     AIMessage(content='',tool_calls=[dict(name='parse_dimensions',args=args,id='correct')])]
            model=SimpleNamespace(ainvoke=AsyncMock(side_effect=replies))
            runtime=SimpleNamespace(model=SimpleNamespace(bind_tools=lambda *a,**kw:model),tools_prompt='test')
            with patch('builtins.print'):
                decision,_=await route_request(runtime,[HumanMessage(content=request)],task_context=context)
            self.assertIsNone(decision.task_type)
            self.assertEqual(decision.intent,'operation' if product else 'clarify')
            feedback=[m.content for m in model.ainvoke.call_args.args[0] if isinstance(m,ToolMessage)]
            self.assertIn('parse_dimensions',feedback[-1])
            if product:
                self.assertEqual(decision.operation.condition.column_id,'flag')
            else:
                self.assertIn('어떤 물품',decision.answer)

if __name__=='__main__':unittest.main()
