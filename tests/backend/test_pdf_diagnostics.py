import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
from langchain_core.messages import AIMessage
from openai import APITimeoutError

from services.documents.schemas import ReferenceDocument
from services.errors import DocumentError
from test_investigation_conditions import make_app
from test_pdf_tables import table_pdf


class PDFDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.app = make_app()
        self.client = TestClient(self.app)
        self.cid = self.client.post('/conversations').json()['conversation_id']
        self.did = str(uuid4())
        self.model = SimpleNamespace(ainvoke=AsyncMock(side_effect=AssertionError('unexpected model call')))
        self.app.state.runtime = SimpleNamespace(advice_model=self.model,
            settings=SimpleNamespace(llm=SimpleNamespace(timeout_seconds=1)))

    def extract(self):
        return self.client.post(f'/conversations/{self.cid}/investigation/extractions/{uuid4()}',
                                json=dict(document_id=self.did, revision=0))

    def events(self, output):
        return [json.loads(call.args[0]) for call in output.call_args_list]

    def ordinary_document(self):
        conversation = self.app.state.conversations._conversations[self.cid]
        conversation.documents[self.did] = ReferenceDocument(document_id=self.did, filename='ordinary.pdf',
            pages=[dict(page_number=1, text='대상 회사 ACME', readable=True)])

    def test_upload_and_direct_table_route_show_progress_without_calling_model(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'models.pdf'
            table_pdf(path)
            with patch('builtins.print') as output:
                response = self.client.post(f'/conversations/{self.cid}/documents/{self.did}?filename=models.pdf',
                                            content=path.read_bytes())
                self.assertEqual(response.status_code, 200, response.text)
                result = self.extract()
        self.assertEqual(result.status_code, 200, result.text)
        events = self.events(output)
        self.assertEqual([item['event'] for item in events], [
            'pdf.upload.received', 'pdf.read.started', 'pdf.read.completed',
            'pdf.extraction.received', 'pdf.extraction.route', 'pdf.extraction.completed'])
        self.assertEqual(events[2]['table_counts'], [1, 1])
        self.assertEqual(events[4]['mode'], 'table')
        self.assertEqual(len(result.json()['conditions']), 7)
        self.model.ainvoke.assert_not_called()

    def test_model_timeout_is_logged_with_cause_and_readable_502_detail(self):
        self.ordinary_document()
        self.model.ainvoke.side_effect = TimeoutError()
        with patch('builtins.print') as output:
            response = self.extract()
        self.assertEqual(response.status_code, 502)
        self.assertIn('모델 응답 대기가 시간 초과', response.json()['detail'])
        events = self.events(output)
        self.assertEqual(events[1]['mode'], 'llm')
        self.assertEqual(events[1]['pages'][0]['tables'], 0)
        self.assertEqual(events[2]['event'], 'pdf.model.started')
        self.assertEqual(events[-1]['event'], 'pdf.extraction.failed')
        self.assertEqual(events[-1]['cause_type'], 'TimeoutError')
        self.assertGreaterEqual(events[-1]['elapsed_ms'], 0)
        self.assertNotIn('대상 회사 ACME', str(events))

    def test_model_connection_failure_keeps_original_cause_in_log(self):
        self.ordinary_document()
        self.model.ainvoke.side_effect = RuntimeError('upstream 502 Bad Gateway')
        with patch('builtins.print') as output:
            response = self.extract()
        self.assertEqual(response.status_code, 502)
        failed = self.events(output)[-1]
        self.assertEqual(failed['cause_type'], 'RuntimeError')
        self.assertEqual(failed['cause_message'], 'upstream 502 Bad Gateway')

    def test_slow_reply_uses_model_timeout_instead_of_130_second_outer_deadline(self):
        self.ordinary_document()
        self.app.state.runtime.settings.llm.timeout_seconds = 120
        self.model.request_timeout = 300
        original_wait = asyncio.wait_for
        async def scaled_wait(awaitable, timeout):
            # 실제로 130초를 기다리지 않고 기존 바깥 제한만 짧게 재현한다.
            return await original_wait(awaitable, 0.001 if timeout == 130 else timeout)
        async def reply(messages):
            await asyncio.sleep(0.02)
            return AIMessage(content='{"conditions": [], "warnings": []}')
        self.model.ainvoke.side_effect = reply
        with patch('asyncio.wait_for', side_effect=scaled_wait), patch('builtins.print') as output:
            response = self.extract()
        self.assertEqual(response.status_code, 200, response.text)
        started = next(e for e in self.events(output) if e['event'] == 'pdf.model.started')
        self.assertEqual(started['model_timeout'], 300)
        self.assertEqual(self.model.request_timeout, 300)

    def test_sdk_timeout_still_returns_clear_error_and_preserves_document(self):
        self.ordinary_document()
        self.model.ainvoke.side_effect = APITimeoutError(request=httpx.Request('POST', 'http://model.test/v1/chat/completions'))
        with patch('builtins.print') as output:
            response = self.extract()
        self.assertEqual(response.status_code, 502)
        self.assertIn('모델 응답 대기가 시간 초과', response.json()['detail'])
        self.assertEqual(self.events(output)[-1]['cause_type'], 'APITimeoutError')
        conversation = self.app.state.conversations._conversations[self.cid]
        self.assertIn(self.did, conversation.documents)
        self.assertEqual(conversation.investigation.revision, 0)

    def test_reader_failure_is_distinct_from_model_failure(self):
        with patch('api.documents.extract_in_process', new=AsyncMock(side_effect=DocumentError('PDF 읽기 실패'))), \
                patch('builtins.print') as output:
            response = self.client.post(f'/conversations/{self.cid}/documents/{self.did}?filename=models.pdf',
                                        content=b'%PDF-test')
        self.assertEqual(response.status_code, 422)
        events = self.events(output)
        self.assertEqual([item['event'] for item in events],
                         ['pdf.upload.received', 'pdf.read.started', 'pdf.read.failed'])
        self.assertEqual(events[-1]['error_type'], 'DocumentError')
