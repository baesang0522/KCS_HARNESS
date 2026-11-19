import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.operations import router
from services.operations.rules import preprocess
from services.operations.schemas import Rule


class PreprocessRulesTests(unittest.TestCase):
    def test_remove_phrase_uses_word_boundaries_only_at_word_character_edges(self):
        cases = [
            ('PTE. LTD.', '. LTD.', 'PTE'),
            ('PTE. LTD.', 'LTD.', 'PTE. '),
            ('LTD LTDX XLTD LTD.', 'LTD', ' LTDX XLTD .'),
            ('ALTD. LTD.X', 'LTD.', 'ALTD. X'),
            ('PTE. LTDX PTE. LTD', '. LTD', 'PTE. LTDX PTE'),
            ('ACME(LTD)TRADING', '(LTD)', 'ACMETRADING'),
            ('ACME.*LTD', '.*', 'ACMELTD'),
            ('PTE. Ltd.', '. LTD.', 'PTE. Ltd.'),
            ('PTE.  LTD.', '. LTD.', 'PTE.  LTD.'),
        ]
        for text, word, expected in cases:
            with self.subTest(text=text, word=word):
                self.assertEqual(preprocess(text, [Rule(operation='remove_words', words=[word])]), expected)

    def test_supplier_review_preview_removes_dotted_ltd_from_three_of_sixteen_names(self):
        names = [
            'BAOSHAN IRON & STEEL', 'WUHAN IRON & STEEL', 'SHANGHAI MEISHAN IRON & STEEL',
            'BAOSTEEL ZHANJIANG IRON   & STEEL', 'SHANDONG IRON AND STEEL GROUP RIZHAO',
            'HOWA TRADING', 'JIANGSU SHAGANG STEEL', 'JIANGSU SHAGANG   INTERNATIONAL TRADE',
            'SHAGANG INTERNATIONAL (SINGAPORE) PTE. LTD.',
            'KWAN TAK INTERNATIONAL   (SINGAPORE) PTE. LTD.',
            'HUNAN VALIN XIANGTAN IRON AND STEEL', 'XISC (SINGAPORE) PTE. LTD.',
            'ANGANG STEEL', 'ANGANG GROUP HONG KONG', 'JIANGYIN XINGCHENG SPECIAL STEEL WORKS',
            'NANJING IRON AND STEEL',
        ]
        app = FastAPI(); app.include_router(router); client = TestClient(app)
        response = client.post('/operations/preview', json=dict(
            operation=dict(kind='preprocess', column_ids=['review-column'],
                           rules=[dict(operation='remove_words', words=['. LTD.'])]),
            rows=[dict(excel_row=i+2, values=[name]) for i, name in enumerate(names)]))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['changed_count'], 3)
        for index, row in enumerate(response.json()['rows']):
            self.assertEqual(row['excel_row'], index+2)
            self.assertEqual(row['values'], [names[index][:-6] if index in (8, 9, 11) else names[index]])

    def test_hangul_only_keeps_brackets_english_numbers_and_spaces(self):
        text = '바오 스틸(Baoshan 123) [중국] 한글'
        self.assertEqual(preprocess(text, [Rule(operation='remove_hangul')]), ' (Baoshan 123) [] ')
        self.assertEqual(preprocess('한한ㅎㅏㄴﾡＡ中文123', [Rule(operation='remove_hangul')]), 'Ａ中文123')

    def test_brackets_only_preserves_hangul_and_contents_including_nested_brackets(self):
        text = '【회사（ACME[HK]{Ltd}<A>）】 「한글」 ［영문］'
        self.assertEqual(preprocess(text, [Rule(operation='remove_brackets')]), '회사ACMEHKLtdA 한글 영문')
        self.assertEqual(preprocess('"회사" & Co., Ltd. - 123', [Rule(operation='remove_brackets')]), '"회사" & Co., Ltd. - 123')

    def test_rule_order_is_explicit_and_does_not_implicitly_trim(self):
        text = '한글 ACME '
        self.assertEqual(preprocess(text, [Rule(operation='trim'), Rule(operation='remove_hangul')]), ' ACME')
        self.assertEqual(preprocess(text, [Rule(operation='remove_hangul'), Rule(operation='trim')]), 'ACME')
        self.assertEqual(preprocess('바오 스틸(Baoshan)', [Rule(operation='remove_hangul'), Rule(operation='remove_brackets')]), ' Baoshan')

    def test_common_preview_api_accepts_each_rule_independently_and_rejects_non_rules(self):
        app = FastAPI(); app.include_router(router); client = TestClient(app)
        for name, expected in [('remove_hangul', '(ACME)'), ('remove_brackets', '회사ACME')]:
            response = client.post('/operations/preview', json=dict(
                operation=dict(kind='preprocess', column_ids=['company'], rules=[dict(operation=name)]),
                rows=[dict(excel_row=5, values=['회사(ACME)'])]))
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()['rows'], [dict(excel_row=5, values=[expected])])
            self.assertEqual(response.json()['changed_count'], 1)
        response = client.post('/operations/preview', json=dict(
            operation=dict(kind='preprocess', column_ids=['company'], rules=[dict(operation='remove_brackets_and_contents')]),
            rows=[dict(excel_row=5, values=['회사(ACME)'])]))
        self.assertEqual(response.status_code, 422)
