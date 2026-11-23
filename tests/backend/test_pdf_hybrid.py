import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from uuid import uuid4

from langchain_core.messages import AIMessage
import pymupdf

from repositories.conversation_repository import MemoryConversation
from services.documents.extractor import extract_pdf
from services.documents.schemas import ReferenceDocument
from services.documents.tables import table_markdown
from services.errors import ModelProcessingError
from services.investigation.catalog import split_catalog
from services.investigation.extraction import extract_conditions
from services.investigation.schemas import ExtractConditions
from test_pdf_tables import table_pdf


class PDFHybridTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.did, self.rid = str(uuid4()), str(uuid4())
        self.conversation = MemoryConversation()
        self.calls = []
        self.result = dict(conditions=[], table_rules=[], warnings=[])
        self.runtime = SimpleNamespace(advice_model=SimpleNamespace(ainvoke=self.reply))

    def document(self, pages):
        document = ReferenceDocument(document_id=self.did, filename='mixed.pdf', pages=pages)
        self.conversation.documents[self.did] = document
        return document

    def table_page(self, number, rows=None, prose=''):
        table = dict(headers=['순번', '일반재', '열처리 강종'], rows=rows or [
            ['1', 'A', 'AR400(NM400)'], ['2', '', 'SA516(두께 10mm 이상)']])
        return dict(page_number=number, text=prose + table_markdown(table), readable=True, tables=[table])

    def rule(self, **kwargs):
        return dict(evidence=[dict(page_number=1, source_id=1)], **kwargs)

    async def reply(self, messages):
        self.calls.append(json.loads(messages[1].content))
        return AIMessage(content=json.dumps(self.result, ensure_ascii=False))

    async def extract(self):
        return await extract_conditions(self.conversation, ExtractConditions(document_id=self.did, revision=0),
                                        self.runtime, self.rid)

    async def test_large_table_is_not_sent_to_model_and_common_rules_join_all_236_items(self):
        rows = [[str(i + 1), f'GENERAL-{i}', f'MODEL-{i}'] for i in range(118)]
        document = self.document([dict(page_number=1, text='전체 표의 HS는 7208.51.1000이다.\n열처리 강종은 두께 134mm 이상이다.', readable=True),
                                  self.table_page(2, rows)])
        original = document.model_dump()
        self.result['table_rules'] = [self.rule(hs_codes=['7208511000']),
            dict(groups=['열처리 강종'], requirements='두께 134mm 이상', evidence=[dict(page_number=1, source_id=2)])]
        state = await self.extract()
        self.assertEqual(len(self.calls), 1)
        sent = json.dumps(self.calls[0]['pages'], ensure_ascii=False)
        self.assertNotIn('MODEL-117', sent)
        self.assertNotIn('GENERAL-0', sent)
        self.assertIn('p2t1', sent)
        self.assertEqual(len(state.conditions), 236)
        self.assertEqual([c.target.specification for c in state.conditions],
                         [name for i in range(118) for name in (f'GENERAL-{i}', f'MODEL-{i}')])
        self.assertTrue(all(c.target.hs_codes == ['7208511000'] for c in state.conditions))
        self.assertTrue(all(c.source_pages == [1, 2] for c in state.conditions))
        self.assertEqual(state.conditions[0].target.requirements, '')
        self.assertEqual(state.conditions[1].target.requirements, '두께 134mm 이상')
        self.assertEqual(document.model_dump(), original)

    async def test_real_pdf_cover_page_and_same_page_notes_keep_header_continuation_and_cells(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'table.pdf'; table_pdf(source)
            doc = pymupdf.open(source)
            page = doc.new_page(pno=0)
            page.insert_text((50, 80), '전체 표의 HS는 7208511000이다.', fontname='korea', fontsize=10)
            doc[1].insert_text((50, 60), '열처리 강종은 두께 20mm 이상이다.', fontname='korea', fontsize=10)
            mixed = Path(folder) / 'mixed.pdf'; doc.save(mixed); doc.close()
            self.document(extract_pdf(mixed))
        self.result['table_rules'] = [self.rule(hs_codes=['7208511000']),
            dict(groups=['열처리 강종'], requirements='두께 20mm 이상', evidence=[dict(page_number=2, source_id=1)])]
        state = await self.extract()
        self.assertEqual(len(state.conditions), 7)
        self.assertEqual(state.conditions[-1].target.specification, 'Q960E')
        self.assertEqual(state.conditions[-1].target.requirements, '두께 20mm 이상')
        self.assertEqual(state.conditions[-1].source_pages, [1, 2, 3])
        self.assertEqual(state.conditions[2].target.specification, 'AR400(NM400)')
        self.assertTrue(all(c.target.hs_codes == ['7208511000'] for c in state.conditions))
        sent = json.dumps(self.calls[0]['pages'], ensure_ascii=False)
        self.assertNotIn('Q960E', sent)
        self.assertIn('두께 20mm', sent)

    async def test_table_group_model_and_row_selectors_preserve_local_notes_and_other_tables(self):
        self.document([dict(page_number=1, text='표별 추가 조건', readable=True), self.table_page(2), self.table_page(3)])
        rule = self.rule(table_ids=['p2t1'], groups=['열처리 강종'], specifications=['SA516'],
                         row_numbers=['2'], requirements='폭 2000mm 이하')
        self.result['table_rules'] = [rule, rule]
        state = await self.extract()
        self.assertEqual(state.conditions[2].target.requirements, '(두께 10mm 이상)\n폭 2000mm 이하')
        self.assertEqual(state.conditions[5].target.requirements, '(두께 10mm 이상)')
        self.assertEqual(state.conditions[0].source_pages, [2])
        self.assertEqual(state.conditions[2].source_pages, [1, 2])

    async def test_other_tables_and_standalone_prose_use_existing_extraction(self):
        other = dict(headers=['순번', '회사'], rows=[['1', 'OTHER CO']])
        self.document([self.table_page(1), dict(page_number=2, text=table_markdown(other), readable=True, tables=[other])])
        self.result['conditions'] = [dict(title='OTHER CO', description='원문 회사',
            target=dict(kind='supplier', group='1', category='', company_name='OTHER CO'),
            evidence=[dict(page_number=2, source_id=3)])]
        state = await self.extract()
        self.assertEqual(len(state.conditions), 4)
        self.assertEqual(state.conditions[-1].target.company_name, 'OTHER CO')
        self.assertIn('OTHER CO', json.dumps(self.calls[0]['pages']))
        self.assertNotIn('AR400', json.dumps(self.calls[0]['pages']))

    async def test_invalid_scope_or_evidence_never_saves_partial_direct_rows(self):
        for rule in [self.rule(table_ids=['p99t1'], requirements='조건'),
                     self.rule(groups=['없는 열'], requirements='조건'),
                     self.rule(specifications=['없는 모델'], requirements='조건'),
                     self.rule(row_numbers=['999'], requirements='조건'),
                     dict(requirements='조건', evidence=[dict(page_number=99, source_id=1)]),
                     dict(requirements='조건', evidence=[dict(page_number=2, source_id=1)])]:
            with self.subTest(rule=rule):
                self.document([dict(page_number=1, text='원문 조건', readable=True), self.table_page(2)])
                self.result['table_rules'] = [rule]
                with self.assertRaises(ModelProcessingError):
                    await self.extract()
                self.assertEqual(self.conversation.investigation.revision, 0)
                self.assertEqual(self.conversation.investigation.conditions, [])

    async def test_incompatible_hs_rules_fail_without_overwriting_original_state(self):
        self.document([dict(page_number=1, text='원문 조건', readable=True), self.table_page(2)])
        self.result['table_rules'] = [self.rule(hs_codes=['7208511000']), self.rule(hs_codes=['7208521000'])]
        with self.assertRaisesRegex(ModelProcessingError, 'HS 조건이 서로'):
            await self.extract()
        self.assertEqual(self.conversation.investigation.conditions, [])

    async def test_synthetic_table_marker_is_not_saved_as_original_evidence(self):
        self.document([dict(page_number=1, text='HS 7208511000', readable=True), self.table_page(2)])
        self.result['table_rules'] = [dict(hs_codes=['7208511000'], evidence=[
            dict(page_number=1, source_id=1), dict(page_number=2, source_id=1)])]
        state = await self.extract()
        self.assertTrue(all(len(c.evidence) == 2 for c in state.conditions))
        self.assertTrue(all(not e.quote.startswith('[직접 추출 표]') for c in state.conditions for e in c.evidence))

    async def test_common_hs_prefix_and_specific_subheading_are_combined_without_false_conflict(self):
        self.document([dict(page_number=1, text='공통 HS와 개별 세번', readable=True), self.table_page(2)])
        self.result['table_rules'] = [self.rule(hs_codes=['7208', '7209']),
            self.rule(groups=['열처리 강종'], hs_codes=['7208.51']),
            self.rule(specifications=['SA516'], hs_codes=['7208511000'])]
        state = await self.extract()
        self.assertEqual([c.target.hs_codes for c in state.conditions],
                         [['7208', '7209'], ['7208.51'], ['7208511000']])

    async def test_length_retry_keeps_direct_rows_and_carries_common_evidence(self):
        self.document([dict(page_number=1, text='전체 HS 7208511000\n' + '\n'.join('설명 '+str(i) for i in range(12)), readable=True),
                       self.table_page(2)])
        successful = []
        async def reply(messages):
            data = json.loads(messages[1].content)
            entries = [(p['page_number'], s['source_id']) for p in data['pages'] for s in p['sources']]
            self.calls.append(data)
            if len(entries) > 4:
                return AIMessage(content='', response_metadata={'finish_reason': 'length'})
            successful.extend(entries)
            result = dict(conditions=[], table_rules=[self.rule(hs_codes=['7208511000'])] if (1, 1) in entries else [],
                          continuation_sources=[dict(page_number=1, source_id=1)], warnings=[])
            return AIMessage(content=json.dumps(result))
        self.runtime.advice_model.ainvoke = reply
        state = await self.extract()
        self.assertEqual(len(state.conditions), 3)
        self.assertTrue(all(c.target.hs_codes == ['7208511000'] for c in state.conditions))
        self.assertEqual(successful, [(1, i) for i in range(1, 14)] + [(2, 1)])

    def test_inconsistent_table_metadata_falls_back_without_removing_text(self):
        page = self.table_page(1); page['text'] = '표 인식이 불완전한 원문'
        document = self.document([page])
        catalog, remainder = split_catalog(document)
        self.assertEqual(catalog, [])
        self.assertEqual(remainder.pages[0].text, page['text'])
