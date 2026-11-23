import asyncio
from collections import Counter
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock
from uuid import uuid4

import pymupdf

from services.documents.extractor import extract_pdf
from services.documents.schemas import DocumentTable, ReferenceDocument
from services.investigation.schemas import Extraction, ExtractConditions, SaveReview
from services.investigation.extraction import extract_conditions, model_table_extraction
from services.investigation.service import public_investigation, save_review
from services.documents.tables import split_company_name, table_markdown
from repositories.conversation_repository import MemoryConversationRepository


def table_pdf(path, last_number=4):
    doc = pymupdf.open()
    xs = [50, 95, 225, 365, 550]
    headers = ['순번', '일반재', 'TMCP 강종', '열처리 강종']
    pages = [[headers, ['1', 'A', 'API 2W GR50', 'AR400(NM400)'], ['2', 'AH32', '', 'SA516']],
             [['3', '', '', 'NM400'], [str(last_number), '', '', 'Q960E']]]
    for n, rows in enumerate(pages):
        page = doc.new_page()
        ys = [90 + i * 35 for i in range(len(rows) + 1)]
        # Omit the separator between two empty columns on the continuation page.
        for x in xs if n == 0 else [xs[0], xs[1], xs[3], xs[4]]:
            page.draw_line((x, ys[0]), (x, ys[-1]))
        for y in ys:
            page.draw_line((xs[0], y), (xs[-1], y))
        for i, row in enumerate(rows):
            for j, text in enumerate(row):
                if text:
                    page.insert_text((xs[j] + 4, ys[i] + 21), text, fontname='korea', fontsize=9)
    doc.save(path)
    doc.close()


class PDFTableTests(unittest.TestCase):
    def test_first_header_continues_with_no_repeat_and_merged_empty_columns(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'catalog.pdf'
            table_pdf(path)
            pages = extract_pdf(path)
        first, second = pages[0]['tables'][0], pages[1]['tables'][0]
        self.assertEqual(second['headers'], first['headers'])
        self.assertEqual(second['rows'], [['3', '', '', 'NM400'], ['4', '', '', 'Q960E']])
        self.assertIn('|3|||NM400|', pages[1]['text'])
        with self.assertRaisesRegex(ValueError, '빈 열도 유지'):
            DocumentTable(headers=first['headers'], rows=[['3', 'NM400']])
        doc = ReferenceDocument(document_id=uuid4(), filename='catalog.pdf', pages=pages)
        conditions, _ = model_table_extraction(doc)
        self.assertEqual(len(conditions), 7)
        self.assertEqual(conditions[-1].source_pages, [2])
        self.assertEqual(conditions[-1].target.group, '열처리 강종')
        self.assertEqual(conditions[2].target.specification, 'AR400(NM400)')
        self.assertEqual(conditions[2].target.requirements, '')

    def test_header_is_not_inherited_by_unrelated_numbered_table(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'tables.pdf'
            table_pdf(path)
            doc = pymupdf.open(path)
            page = doc[1]
            page.add_redact_annot(pymupdf.Rect(50, 90, 95, 125), fill=(1, 1, 1))
            page.apply_redactions(graphics=0)
            page.insert_text((54, 111), '1', fontname='korea', fontsize=9)
            other = Path(folder) / 'other.pdf';doc.save(other);doc.close()
            pages = extract_pdf(other)
        self.assertEqual(pages[1]['tables'], [])
        self.assertIn('NM400', pages[1]['text'])

    def test_more_than_100_items_and_64kb_save_and_edit_without_model_or_truncation(self):
        async def run():
            repo = MemoryConversationRepository();cid = await repo.create();conv = repo._conversations[cid]
            did = str(uuid4())
            note = '(시험 조건 ' + '상세 원문 ' * 30 + ')'
            rows = [[str(i + 1), 'MODEL-' + str(i) + '\n' + note] for i in range(236)]
            table = dict(headers=['순번', '열처리 강종'], rows=rows)
            conv.documents[did] = ReferenceDocument(document_id=did, filename='catalog.pdf', pages=[dict(
                page_number=1, text=table_markdown(table), readable=True, tables=[table])])
            model = SimpleNamespace(ainvoke=AsyncMock(side_effect=AssertionError('catalogue must not regenerate cells with LLM')))
            runtime = SimpleNamespace(advice_model=model)
            state = await extract_conditions(conv, ExtractConditions(document_id=did, revision=0), runtime, str(uuid4()))
            self.assertEqual(len(state.conditions), 236)
            self.assertGreater(len(state.model_dump_json().encode()), 64000)
            review = public_investigation(state)['reviews'][did]
            changed = json.loads(json.dumps(review));changed[-1]['target']['specification'] = 'EDITED'
            saved = save_review(conv, did, SaveReview(revision=state.revision, expected_rows=review, rows=changed))
            self.assertEqual(len(saved.conditions), 236)
            self.assertEqual(saved.conditions[-1].target.specification, 'EDITED')
            self.assertEqual(saved.conditions[0].target.specification, 'MODEL-0')
            model.ainvoke.assert_not_called()
        asyncio.run(run())

    def test_extraction_schema_accepts_over_50_and_company_split_keeps_english_alias(self):
        candidate = dict(title='A', description='A', target=dict(kind='item', group='규격', hs_codes=[],
            specification='A', requirements=''), evidence=[dict(page_number=1, source_id=1)], uncertainty='')
        self.assertEqual(len(Extraction(conditions=[candidate] * 236, warnings=[]).conditions), 236)
        for name, expected in [
            ('바오 스틸(Baoshan Iron & Steel Co., Ltd.)', ('바오 스틸', 'Baoshan Iron & Steel Co., Ltd.')),
            ('우한 스틸(Wuhan Iron &   Steel Co., Ltd.)', ('우한 스틸', 'Wuhan Iron & Steel Co., Ltd.')),
            ('기업(Company (Hong Kong) Ltd.)', ('기업', 'Company (Hong Kong) Ltd.')),
            ('English Only Co., Ltd.', None), ('한글만 있는 회사', None)]:
            self.assertEqual(split_company_name(name), expected)
