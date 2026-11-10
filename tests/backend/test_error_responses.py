import json
import re
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from pydantic import ValidationError

from main import app
from services.errors import SHARED_MESSAGES
from services.operations.jobs import CreateOperationJob
from services.operations.schemas import Operation
from repositories.conversation_repository import MemoryConversationRepository


class ErrorResponseTests(unittest.TestCase):
    def setUp(self):
        app.state.conversations = MemoryConversationRepository()
        app.state.operation_jobs = {}
        self.client = TestClient(app)
        self.payload = dict(operation_job_id=str(uuid4()), conversation_id=str(uuid4()), workspace_id=str(uuid4()),
                            worksheet_id='sheet', table_id='table', task_type='model_normalization',
                            model_spec_column_id='model', row_start=1, row_count=90000)

    def test_invalid_settings_fail_before_a_job_or_data_read_is_needed(self):
        cases = [
            ({'kind': 'replace', 'column_ids': ['model'], 'find': ''}, '찾을 문자열을 입력하세요.'),
            ({'kind': 'replace', 'column_ids': ['model']}, '찾을 문자열을 입력하세요.'),
            ({'kind': 'map', 'column_ids': ['model'], 'mappings': []}, '원본 값과 대표값을 지정하세요.'),
            ({'kind': 'extract', 'column_ids': ['model']}, '추천을 확인하고 추출 방식을 선택하세요.'),
            ({'kind': 'extract', 'column_ids': ['trade'], 'extraction_mode': 'labelled'}, SHARED_MESSAGES['MODEL_SPEC_REQUIRED']),
            ({'kind': 'group', 'column_ids': ['trade'], 'value_column_id': 'model'}, '대표값의 기준이 되는 행을 지정하세요.'),
            ({'kind': 'group', 'column_ids': ['model'], 'value_column_id': 'model'}, '같은 값 판단 기준과 값을 바꿀 열을 서로 다르게 지정하세요.'),
            ({'kind': 'preprocess', 'column_ids': ['model'], 'rules': [{'operation': 'remove_words', 'words': []}]}, '제거할 단어를 입력하세요.'),
        ]
        for operation, expected in cases:
            with self.subTest(operation=operation):
                response = self.client.post('/operation-jobs', json={**self.payload, 'operation': operation})
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(response.json(), {'detail': expected})
                self.assertEqual(app.state.operation_jobs, {})

    def test_router_can_still_build_draft_settings_but_execution_requires_ready_settings(self):
        operation = Operation(kind='extract', column_ids=['model'])
        self.assertIsNone(operation.extraction_mode)
        with self.assertRaises(ValidationError):
            CreateOperationJob(**self.payload, operation=operation)
        operation.extraction_mode = 'labelled'
        job = CreateOperationJob(**self.payload, operation=operation)
        self.assertEqual(job.row_count, 90000)

    def test_standard_validation_is_readable_deduplicated_and_does_not_echo_input(self):
        operation = {'kind': 'group', 'column_ids': [''], 'source_row': -100, 'value_column_id': ''}
        response = self.client.post('/operation-jobs', json={**self.payload, 'operation': operation})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()['detail'], '입력값의 형식과 허용 범위를 확인하세요.')
        self.assertNotIn('pydantic', response.text)
        malformed = self.client.post('/operation-jobs', content='{broken', headers={'content-type': 'application/json'})
        self.assertEqual(malformed.status_code, 422)
        self.assertEqual(malformed.json()['detail'], '요청 내용을 읽지 못했습니다. 다시 시도하세요.')

    def test_preview_validation_uses_the_same_server_message(self):
        response = self.client.post('/operations/preview', json={
            'operation': {'kind': 'extract', 'column_ids': ['model']}, 'rows': [{'excel_row': 2, 'values': ['AB12']}]})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()['detail'], '추천을 확인하고 추출 방식을 선택하세요.')

    def test_catalog_is_delivered_as_inert_json_and_changes_page_version(self):
        original = self.client.get('/static/excel/taskpane-current.html').text
        value = '</script><script>alert(1)</script>한글'
        with patch.dict(SHARED_MESSAGES, WORKSPACE_REQUIRED=value):
            rendered = self.client.get('/static/excel/taskpane-current.html').text
        def catalog(html):
            return json.loads(re.search(r'<script id="server-error-messages" type="application/json">(.*?)</script>', html).group(1))
        self.assertEqual(catalog(original), SHARED_MESSAGES)
        self.assertEqual(catalog(rendered)['WORKSPACE_REQUIRED'], value)
        self.assertNotIn(value, rendered)
        self.assertNotEqual(re.search(r'name="kcs-ui-version" content="(.*?)"', original)[1],
                            re.search(r'name="kcs-ui-version" content="(.*?)"', rendered)[1])
