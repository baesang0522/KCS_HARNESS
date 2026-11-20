import json
import unittest
from types import SimpleNamespace
from uuid import uuid4

from langchain_core.messages import AIMessage

from repositories.conversation_repository import MemoryConversation
from services.documents.schemas import ReferenceDocument
from services.documents.chunks import flatten_sources
from services.errors import ConflictError, ModelProcessingError
from services.investigation.schemas import ExtractConditions
from services.investigation.extraction import evidence_sources, extract_conditions
from models.structured import INPUT_BYTES


class PDFChunkTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.conversation = MemoryConversation()
        self.did, self.rid = str(uuid4()), str(uuid4())
        self.document = ReferenceDocument(document_id=self.did, filename='large.pdf', pages=[
            dict(page_number=1, readable=True, text='그룹 1 공통 조건 HS 7208511000\n' + '\n'.join(
                f'대상 {i}: ' + '상세 원문 ' * 100 for i in range(40))),
            dict(page_number=2, readable=True, text='\n'.join(
                f'대상 {i}: ' + '상세 원문 ' * 100 for i in range(40, 80)))])
        self.conversation.documents[self.did] = self.document
        self.calls = []
        self.runtime = SimpleNamespace(advice_model=SimpleNamespace(ainvoke=self.reply),
                                       settings=SimpleNamespace(llm=SimpleNamespace(timeout_seconds=1)))
        self.common = dict(page_number=1, source_id=1)

    def candidate(self, item):
        key = {k: item[k] for k in ('page_number', 'source_id')}
        name = f"대상 {key['page_number']}-{key['source_id']}"
        return dict(title=name, description=name, target=dict(kind='item', group='1',
            hs_codes=['7208511000'], specification=name, requirements=''),
            evidence=[self.common, key])

    async def reply(self, messages):
        self.assertLessEqual(sum(len(m.content.encode()) for m in messages), INPUT_BYTES)
        payload = json.loads(messages[1].content)
        self.calls.append(payload)
        if len(self.calls) > 1:
            self.assertIn(self.common, [{k: i[k] for k in ('page_number', 'source_id')}
                                       for i in flatten_sources(payload['context_pages'])])
        entries = flatten_sources(payload['pages'])
        candidates = [self.candidate(item) for item in entries if item['text'].startswith('대상')]
        # Repeated boundary context must not create an extra review row.
        candidates += [self.candidate(item) for item in flatten_sources(payload['context_pages'])
                       if item['text'].startswith('대상')]
        return AIMessage(content=json.dumps(dict(conditions=candidates, warnings=['문서 안내'],
                                               continuation_sources=[self.common]), ensure_ascii=False))

    async def extract(self):
        return await extract_conditions(self.conversation, ExtractConditions(document_id=self.did, revision=0),
                                        self.runtime, self.rid)

    async def test_large_document_covers_every_source_and_carries_common_evidence_without_duplicates(self):
        self.assertGreater(sum(len(p.text.encode()) for p in self.document.pages), INPUT_BYTES)
        state = await self.extract()
        self.assertGreater(len(self.calls), 1)
        sent = [i for call in self.calls for i in flatten_sources(call['pages'])]
        original = flatten_sources(evidence_sources(self.document)[0])
        self.assertEqual(sent, original)
        self.assertEqual(len(state.conditions), 80)
        self.assertEqual(len({c.target.specification for c in state.conditions}), 80)
        self.assertEqual(state.conditions[-1].source_pages, [1, 2])
        self.assertTrue(all(c.target.hs_codes == ['7208511000'] for c in state.conditions))
        self.assertEqual(state.document_notes[self.did], ['문서 안내'])
        self.assertFalse(self.calls[-1]['has_more'])
        self.assertTrue(all(call['has_more'] for call in self.calls[:-1]))

    async def test_single_oversized_page_and_line_are_split_without_losing_text(self):
        self.document.pages = self.document.pages[:1]
        self.document.pages[0].text = '가나다' * 30000
        async def empty(messages):
            self.assertLessEqual(sum(len(m.content.encode()) for m in messages), INPUT_BYTES)
            self.calls.append(json.loads(messages[1].content))
            return AIMessage(content='{"conditions": [], "warnings": []}')
        self.runtime.advice_model.ainvoke = empty
        await self.extract()
        self.assertGreater(len(self.calls), 1)
        self.assertEqual(''.join(i['text'] for call in self.calls for i in flatten_sources(call['pages'])),
                         self.document.pages[0].text)

    async def test_late_failure_preserves_original_state_and_pdf(self):
        original = self.conversation.investigation.model_dump()
        async def fail(messages):
            if self.calls:
                raise RuntimeError('model offline')
            return await self.reply(messages)
        self.runtime.advice_model.ainvoke = fail
        with self.assertRaises(ModelProcessingError):
            await self.extract()
        self.assertEqual(self.conversation.investigation.model_dump(), original)
        self.assertIn(self.did, self.conversation.documents)

    async def test_cancel_between_chunks_sends_no_next_chunk_and_saves_nothing(self):
        async def cancel(messages):
            result = await self.reply(messages)
            self.conversation.cancelled_requests.add(self.rid)
            return result
        self.runtime.advice_model.ainvoke = cancel
        with self.assertRaises(ConflictError):
            await self.extract()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.conversation.investigation.conditions, [])

    async def test_evidence_from_not_yet_sent_source_is_rejected(self):
        async def invalid(messages):
            data = json.loads((await self.reply(messages)).content)
            data['conditions'][0]['evidence'] = [dict(page_number=2, source_id=40)]
            return AIMessage(content=json.dumps(data))
        self.runtime.advice_model.ainvoke = invalid
        with self.assertRaisesRegex(ModelProcessingError, '근거 위치'):
            await self.extract()
        self.assertEqual(self.conversation.investigation.conditions, [])

    async def test_invalid_continuation_reference_saves_nothing(self):
        async def invalid(messages):
            data = json.loads((await self.reply(messages)).content)
            data['continuation_sources'] = [dict(page_number=99, source_id=1)]
            return AIMessage(content=json.dumps(data))
        self.runtime.advice_model.ainvoke = invalid
        with self.assertRaisesRegex(ModelProcessingError, '이어 읽을 원문 근거'):
            await self.extract()
        self.assertEqual(self.conversation.investigation.conditions, [])

    async def test_many_short_pages_include_page_wrapper_cost(self):
        self.document.pages = ReferenceDocument(document_id=self.did, filename='pages.pdf', pages=[
            dict(page_number=n + 1, readable=True, text='본문') for n in range(1500)]).pages
        async def empty(messages):
            self.assertLessEqual(sum(len(m.content.encode()) for m in messages), INPUT_BYTES)
            self.calls.append(json.loads(messages[1].content))
            return AIMessage(content='{"conditions": [], "warnings": []}')
        self.runtime.advice_model.ainvoke = empty
        await self.extract()
        self.assertEqual([p['page_number'] for call in self.calls for p in call['pages']], list(range(1, 1501)))
