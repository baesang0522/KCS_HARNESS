import unittest
from uuid import uuid4
from pydantic import ValidationError, TypeAdapter
from agents.request_tools import build_request_tools
from agents.request_router import RequestDecision
from api.schemas import UIAction
from services.chat.service import decision_action
from services.operations.schemas import OperationOutput
from services.operations.jobs import CreateOperationJob, OperationJob, OutputPlacement, begin_apply
from services.errors import ConflictError

class ChatActionsTests(unittest.TestCase):
    def workspace(self, **extra):
        return dict(workspace_id=str(uuid4()), task_type='investigation', columns=[
            dict(column_id='source',header='공급자명',role='company_name'),
            dict(column_id='result',header='확정명',role='reference')],target_column_ids=['source'],**extra)

    def tools(self, workspace=None, **context):
        return {t.name:t for t in build_request_tools(dict(workspace=workspace or self.workspace(),**context))}

    def test_output_and_followup_preserve_operation_and_validate_current_ids(self):
        work=self.workspace();tools=self.tools(work)
        args=dict(column_id='source',rules=[dict(operation='collapse_whitespace')],output=dict(mode='new',name='공급자명 정제'))
        first=tools['preprocess'].invoke(args)
        decision=RequestDecision.model_validate(first)
        action,_=decision_action(decision,work)
        self.assertEqual(TypeAdapter(UIAction).validate_python(action).operation.output.name,'공급자명 정제')
        tools=self.tools(work|dict(pending_operation=first['operation']))
        changed=tools['change_output'].invoke(dict(output=dict(mode='existing',column_id='result')))
        self.assertEqual(changed['operation']['rules'],first['operation']['rules'])
        self.assertEqual(changed['operation']['output']['column_id'],'result')
        with self.assertRaises(ValueError): tools['change_output'].invoke(dict(output=dict(mode='existing',column_id='deleted')))
        with self.assertRaises(ValueError): tools['map_values'].invoke(dict(column_id='source',mappings=[]))
        self.assertNotIn('open_cleaning_help',tools)

    def test_invalid_or_contradictory_output_never_prepares_an_action(self):
        for payload in [dict(mode='existing'),dict(mode='new',column_id='result'),dict(name='  ')]:
            with self.assertRaises(ValidationError): OperationOutput(**payload)
        operation=dict(kind='set',column_ids=['source'],assigned_value='Y',condition=dict(column_id='source',operator='equals',value='A'),destination_column_id='result')
        with self.assertRaises(ValueError): self.tools(self.workspace(pending_operation=operation))['change_output'].invoke(dict(output=dict(mode='new')))

    def test_apply_is_bound_to_preview_destination_and_cannot_be_repeated(self):
        operation=dict(kind='preprocess',column_ids=['source'],rules=[dict(operation='trim')],output=dict(mode='existing',column_id='result'))
        job=OperationJob(source=CreateOperationJob(operation_job_id=uuid4(),conversation_id=uuid4(),workspace_id=uuid4(),worksheet_id='sheet',table_id='table',task_type='investigation',row_start=1,row_count=2,operation=operation),status='PREVIEW_READY')
        with self.assertRaises(ConflictError): begin_apply(job,OutputPlacement(mode='existing',column_id='source'))
        begin_apply(job,OutputPlacement(mode='existing',column_id='result'))
        with self.assertRaises(ConflictError): begin_apply(job,OutputPlacement(mode='existing',column_id='result'))

    def test_document_and_role_tools_have_typed_actions_and_real_ids(self):
        did=str(uuid4());tools=self.tools(investigation=dict(documents=[dict(document_id=did)]))
        for result in [tools['review_document'].invoke(dict(document_id=did,action='preprocess',rules=[dict(operation='remove_hangul')])),tools['set_column_role'].invoke(dict(column_id='source',role='reference'))]:
            action,_=decision_action(RequestDecision.model_validate(result),self.workspace())
            TypeAdapter(UIAction).validate_python(action)
        with self.assertRaises(ValueError): tools['review_document'].invoke(dict(document_id=str(uuid4()),action='apply'))
        with self.assertRaises(ValidationError): RequestDecision(intent='document',answer='ready')
        with self.assertRaises(ValidationError): RequestDecision(intent='general',answer='ready',workspace_action=dict(type='workspace_action',column_id='source',role='reference'))

    def test_formula_destination_can_be_changed_without_generating_an_approval(self):
        work=self.workspace();job_id=str(uuid4());tools=self.tools(work,active_formula_job=dict(formula_job_id=job_id,status='PREVIEW_READY'))
        action,_=decision_action(RequestDecision.model_validate(tools['change_output'].invoke(dict(output=dict(mode='existing',column_id='result')))),work)
        self.assertEqual(TypeAdapter(UIAction).validate_python(action).type,'formula_output')
        self.assertEqual(action['formula_job_id'],job_id)
        result=tools['start_task'].invoke(dict(task_type='formula',input_column_ids=['source'],output=dict(mode='new',name='계산값')))
        action,_=decision_action(RequestDecision.model_validate(result),work)
        self.assertEqual(TypeAdapter(UIAction).validate_python(action).output.name,'계산값')

    def test_similarity_includes_algorithm_and_optional_result_sheet(self):
        result=self.tools()['inspect_similarity'].invoke(dict(column_id='source',method='sequence',result_sheet=True))
        action,_=decision_action(RequestDecision.model_validate(result),self.workspace())
        settings=TypeAdapter(UIAction).validate_python(action).similarity
        self.assertEqual(settings.method,'sequence');self.assertTrue(settings.result_sheet)

    def test_agent_formula_keeps_the_requested_destination(self):
        import asyncio
        from agents.execution_tools import execution_tools
        context=dict(workspace=self.workspace())
        tools={t.name:t for t in execution_tools(context,build_request_tools(context))}
        decision=asyncio.run(tools['calculate_formula'].ainvoke(dict(instruction='공급자명 길이 계산',input_column_ids=['source'],output=dict(mode='existing',column_id='result'))))
        self.assertEqual(decision['formula_output']['column_id'],'result')
        self.assertEqual(decision['formula_instruction'],'공급자명 길이 계산')

    def test_formula_outputs_reject_unsupported_placement_before_creating_ui_actions(self):
        tools=self.tools(active_formula_job=dict(formula_job_id=str(uuid4()),status='PREVIEW_READY'))
        for output in [dict(mode='new',anchor='source'),dict(mode='new',side='before'),
                       dict(mode='existing',column_id='result',score_column_id='source')]:
            with self.assertRaises(ValidationError):
                tools['start_task'].invoke(dict(task_type='formula',input_column_ids=['source'],output=output))
            with self.assertRaises(ValidationError): tools['change_output'].invoke(dict(output=output))
        result=tools['start_task'].invoke(dict(task_type='formula',input_column_ids=['source'],
            reference_sheet_names=['거래처검토'],output=dict(mode='new',name='작업대상여부')))
        self.assertEqual(result['formula_output']['name'],'작업대상여부')
        self.assertIsNone(result['formula_output']['anchor'])
        schema=tools['start_task'].args_schema.model_json_schema()['$defs']['FormulaOutput']
        self.assertEqual(schema['properties']['anchor']['type'],'null')
        self.assertEqual(schema['properties']['side']['const'],'after')
        # Operation placement remains available for the existing preprocessing writer.
        operation=tools['preprocess'].invoke(dict(column_id='source',rules=[dict(operation='trim')],
            output=dict(mode='new',anchor='source',side='before')))
        self.assertEqual(operation['operation']['output']['anchor'],'source')
