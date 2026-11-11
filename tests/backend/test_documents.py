import asyncio
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
import httpx
import pymupdf

from api.chat import router as chat_router
from api.documents import router as documents_router
from api.errors import request_validation_response, service_error_response
from repositories.conversation_repository import ConversationNotFound, MemoryConversationRepository
from services.documents.service import extract_in_process
from services.errors import DocumentError, ServiceError


def app_with_documents():
    app = FastAPI()
    app.include_router(chat_router)
    app.include_router(documents_router)
    app.add_exception_handler(ServiceError, service_error_response)
    app.add_exception_handler(ConversationNotFound, service_error_response)
    app.add_exception_handler(RequestValidationError, request_validation_response)
    app.state.conversations = MemoryConversationRepository()
    app.state.formula_jobs = {}
    app.state.document_slots = asyncio.Semaphore(2)
    return app


def pdf_bytes(pages=1, encrypted=False):
    with pymupdf.open() as doc:
        page = doc.new_page()
        page.insert_text((72, 72), '분석대상: 해외거래처 상호 ABC TRADING', fontname='korea')
        page.insert_text((72, 100), 'MODEL: ABC123, CODE: ZZ9')
        for x in (72, 250, 430):
            page.draw_line((x, 140), (x, 220))
        for y in (140, 180, 220):
            page.draw_line((72, y), (430, y))
        for x, y, text in [(82, 160, 'Company'), (260, 160, 'Code'),
                           (82, 200, 'ABC TRADING'), (260, 200, 'ZZ9')]:
            page.insert_text((x, y), text)
        for _ in range(pages - 1):
            doc.new_page()
        if encrypted:
            return doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='secret')
        return doc.tobytes()


class DocumentTests(unittest.TestCase):
    def setUp(self):
        self.app = app_with_documents()
        self.client = TestClient(self.app)
        self.cid = self.client.post('/conversations').json()['conversation_id']
        self.base = '/conversations/' + self.cid + '/documents'
        self.did = str(uuid4())
        self.path = self.base + '/' + self.did

    def upload(self, content=None, name='기준.pdf'):
        return self.client.post(self.path, params={'filename': name},
                                content=pdf_bytes() if content is None else content,
                                headers={'Content-Type': 'application/pdf'})

    def test_actual_extraction_keeps_korean_pages_and_has_no_ten_page_limit(self):
        response = self.upload(pdf_bytes(pages=12))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['page_count'], 12)
        self.assertEqual(response.json()['unreadable_pages'], list(range(2, 13)))
        page = self.client.get(self.path + '/pages/1').json()
        self.assertIn('해외거래처', page['text'])
        self.assertIn('ABC123', page['text'])
        self.assertIn('|Company|Code|', page['text'].replace(' ', ''))
        self.assertFalse(self.client.get(self.path + '/pages/12').json()['readable'])
        self.assertEqual(self.client.get(self.path + '/pages/13').status_code, 404)
        self.assertEqual(self.client.get(self.base).json()['documents'][0]['filename'], '기준.pdf')

    def test_link_pending_then_workspace_remove_and_isolate_conversations(self):
        with patch('api.documents.extract_in_process', new=AsyncMock(return_value=[
            {'page_number': 1, 'text': '기준 내용', 'readable': True}
        ])):
            self.assertEqual(self.upload().status_code, 200)
        pending = {'task_type': 'counterparty_cleanup', 'workspace': None}
        self.assertEqual(self.client.put(self.path + '/link', json=pending).json()['link'], pending)
        workspace = dict(workspace_id=str(uuid4()), worksheet_id='sheet', table_id='table',
                         sheet_name='해외거래처', task_type='counterparty_cleanup')
        linked = self.client.put(self.path + '/link', json={**pending, 'workspace': workspace})
        self.assertEqual(linked.json()['link']['workspace'], workspace)
        self.assertEqual(self.client.put(self.path + '/link', json={
            'task_type': 'model_normalization', 'workspace': workspace}).status_code, 422)
        other = self.client.post('/conversations').json()['conversation_id']
        other_path = '/conversations/' + other + '/documents/' + self.did
        self.assertEqual(self.client.get(other_path + '/pages/1').status_code, 404)
        self.assertEqual(self.client.put(other_path + '/link', json=pending).status_code, 404)
        self.client.delete(other_path)
        self.assertEqual(len(self.client.get(self.base).json()['documents']), 1)
        self.assertEqual(self.client.delete(self.path).status_code, 200)
        self.assertEqual(self.client.get(self.base).json()['documents'], [])
        self.assertEqual(self.upload().status_code, 409)

    def test_bad_encrypted_and_image_only_files_do_not_become_ready(self):
        for content, filename in [(b'not a pdf', 'fake.pdf'), (pdf_bytes(), 'file.txt'),
                                  (pdf_bytes(encrypted=True), 'locked.pdf')]:
            with self.subTest(filename=filename):
                self.assertEqual(self.upload(content, filename).status_code, 422)
        with pymupdf.open() as doc:
            doc.new_page()
            response = self.upload(doc.tobytes(), 'scanned.pdf')
        self.assertEqual(response.status_code, 422)
        self.assertIn('OCR', response.json()['detail'])
        self.assertEqual(self.client.get(self.base).json()['documents'], [])

    def test_upload_limit_uses_actual_bytes_and_cleanup_after_parser_error(self):
        with patch('api.documents.MAX_UPLOAD_BYTES', 5):
            self.assertEqual(self.upload(b'%PDF-123456').status_code, 422)
        paths = []
        async def fail(source, output, slots):
            paths.append(source.parent)
            raise DocumentError('파일 추출 실패')
        with patch('api.documents.extract_in_process', new=fail):
            self.assertEqual(self.upload().status_code, 422)
        self.assertFalse(paths[0].exists())
        self.assertEqual(self.client.get(self.base).json()['documents'], [])


class DocumentCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_server_cancel_stops_upload_and_never_commits_document(self):
        app = app_with_documents()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            cid = (await client.post('/conversations')).json()['conversation_id']
            did = str(uuid4())
            base = '/conversations/' + cid
            entered, stopped = asyncio.Event(), asyncio.Event()
            async def wait_for_cancel(*args):
                entered.set()
                try:
                    await asyncio.Future()
                finally:
                    stopped.set()
            with patch('api.documents.extract_in_process', new=wait_for_cancel):
                upload = asyncio.create_task(client.post(base + '/documents/' + did + '?filename=a.pdf', content=pdf_bytes()))
                await asyncio.wait_for(entered.wait(), 5)
                self.assertEqual((await client.post(base + '/requests/' + did + '/cancel')).status_code, 200)
                self.assertEqual((await upload).status_code, 409)
                self.assertTrue(stopped.is_set())
            self.assertEqual((await client.get(base + '/documents')).json()['documents'], [])

    async def test_late_cancel_removes_already_completed_upload(self):
        app = app_with_documents()
        cid = await app.state.conversations.create()
        app.state.conversations._conversations[cid].documents['upload-id'] = object()
        app.state.conversations.cancel_request(cid, 'upload-id')
        self.assertEqual(app.state.conversations._conversations[cid].documents, {})

    async def test_extraction_process_is_killed_on_cancel(self):
        entered = asyncio.Event()
        class Process:
            returncode = None
            killed = False
            async def wait(self):
                if self.killed:
                    self.returncode = -9
                    return -9
                entered.set()
                await asyncio.Future()
            def kill(self):
                self.killed = True
        process = Process()
        with patch('asyncio.create_subprocess_exec', new=AsyncMock(return_value=process)):
            task = asyncio.create_task(extract_in_process(Path('in.pdf'), Path('out.json'), asyncio.Semaphore(1)))
            await entered.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(process.killed)
        self.assertEqual(process.returncode, -9)
