import unittest
from uuid import uuid4
from pydantic import ValidationError
from services.operations.schemas import RowFilter, ScopeRequest, WorkspaceContext
from services.investigation.bindings import bind_scope
from agents.request_tools import build_request_tools


class ConditionWorkflowTests(unittest.TestCase):
    def test_numeric_boundaries_and_unknown_values(self):
        rule = RowFilter(column_id='thickness', operator='gte', value='0.5')
        for text, expected in [('0.5', True), ('0.499999999999999999', False), ('2', True), ('', None), ('1mm', None), ('NaN', None), ('1,000', None)]:
            self.assertIs(rule.matches(text), expected)
        self.assertTrue(RowFilter(column_id='x', operator='gt', value='2').matches('10'))
        for value in ['', 'NaN', 'Infinity', '0.5mm', '1e999']:
            with self.assertRaises(ValidationError): RowFilter(column_id='x', operator='gte', value=value)

    def test_composite_predicate_resolves_all_columns(self):
        request = ScopeRequest(mode='intersect', condition={'operator':'all','conditions':[
            {'operator':'any','conditions':[{'column_id':'hs','operator':'equals','value':'0010'}, {'column_id':'hs','operator':'equals','value':'0020'}]},
            {'column_id':'thickness','operator':'gte','value':'0.5'}, {'column_id':'thickness','operator':'lte','value':'1.0'}]})
        self.assertEqual(request.condition.column_ids, ['hs', 'thickness'])
        with self.assertRaises(ValidationError): ScopeRequest(mode='intersect', condition={'operator':'all','conditions':[]})

    def test_nested_intersection_and_revisited_ids_survive_workspace_api_validation(self):
        predicate = {'operator':'all','conditions':[{'column_id':'hs','operator':'equals','value':'0010'},
            {'column_id':'thickness','operator':'gte','value':'0.5'}]}
        scope = {'base':{'row_ids':[1,3]},'base_ids':[1,3], 'steps':[{'mode':'intersect','condition':predicate}]}
        workspace = WorkspaceContext(workspace_id=uuid4(), worksheet_id='sheet', table_id='table', sheet_name='조사',
            task_type='investigation', row_count=4, columns=[{'column_id':key,'header':key,'role':'reference'} for key in ['hs','thickness']], row_filter=scope)
        self.assertEqual(workspace.row_filter.column_ids, ['hs','thickness'])
        self.assertEqual(WorkspaceContext.model_validate_json(workspace.model_dump_json()).row_filter, workspace.row_filter)
        del scope['steps'][0]['condition']['conditions'][1]['column_id']
        with self.assertRaises(ValidationError): WorkspaceContext.model_validate({**workspace.model_dump(),'row_filter':scope})

    def test_model_scope_summary_does_not_copy_ids_or_mutate_execution_context(self):
        from services.workspace import summarize_row_scopes
        original = {'workspace':{'row_filter':{'base':{'row_ids':[1,3]},'base_ids':list(range(100000)),
            'steps':[{'mode':'intersect','condition':{'column_id':'hs','operator':'equals','value':'0010'}}]}}}
        compact = summarize_row_scopes(original)
        self.assertEqual(compact['workspace']['row_filter']['base'], {'row_ids_count':2})
        self.assertEqual(compact['workspace']['row_filter']['base_ids_count'],100000)
        self.assertEqual(len(original['workspace']['row_filter']['base_ids']),100000)
        self.assertLess(len(str(compact)),300)

    def test_pdf_binding_requires_current_confirmed_conditions_and_explicit_meaning(self):
        cid = str(uuid4())
        state = {'scope':'bound','conditions':[{'condition_id':cid,'status':'confirmed','description':'두께 범위'}]}
        request = ScopeRequest(mode='intersect', condition={'column_id':'thickness','operator':'gte','value':'0.5'}, condition_ids=[cid], note='두께 열은 mm, 사용자 확인')
        bind_scope(request,state); original = request.condition_versions.copy()
        state['conditions'][0]['description'] = '수정된 두께 범위'
        bind_scope(request,state); self.assertNotEqual(original,request.condition_versions)
        state['conditions'][0]['status'] = 'candidate'
        with self.assertRaises(ValueError): bind_scope(request,state)
        with self.assertRaises(ValueError): bind_scope(request,{'scope':'different_workspace'})

    def test_scope_tool_binds_group_without_guessing_missing_columns(self):
        wid=str(uuid4());cid=str(uuid4())
        context={'workspace':{'workspace_id':wid,'columns':[{'column_id':'hs','header':'HS','role':'reference'}]},
            'investigation':{'scope':'bound','conditions':[{'condition_id':cid,'status':'confirmed'}]}}
        tool=next(t for t in build_request_tools(context) if t.name=='change_scope')
        predicate={'operator':'any','conditions':[{'column_id':'hs','operator':'equals','value':'0010'}, {'column_id':'hs','operator':'equals','value':'0020'}]}
        result=tool.invoke({'mode':'intersect','predicate':predicate,'condition_ids':[cid],'note':'확인된 HS 코드 목록'})
        self.assertIn(cid,result['scope_change']['condition_versions'])
        predicate['conditions'][0]['column_id']='missing'
        with self.assertRaises(ValueError): tool.invoke({'mode':'intersect','predicate':predicate})
