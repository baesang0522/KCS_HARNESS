"""폴더 이동 후 실제 페이지의 자산 경로와 캐시 버전을 검사한다."""
import hashlib
from html.parser import HTMLParser
from pathlib import Path
import unittest
from urllib.parse import urlsplit, parse_qs

from fastapi.testclient import TestClient
from main import app


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        value = attrs.get('src') if tag == 'script' else attrs.get('href') if tag == 'link' else None
        if value:
            self.urls.append(value)


class TaskpaneAssetsTests(unittest.TestCase):
    def test_entrypoints_serve_all_versioned_assets_from_feature_folders(self):
        client = TestClient(app)
        page = client.get('/static/excel/taskpane-current.html')
        self.assertEqual(page.status_code, 200)
        self.assertEqual(page.headers['cache-control'], 'no-store')
        self.assertEqual(page.text, client.get('/static/excel/taskpane.html').text)
        parser = Assets()
        parser.feed(page.text)
        paths = [urlsplit(url).path for url in parser.urls]
        self.assertEqual(len(paths), len(set(paths)))
        for url in parser.urls:
            with self.subTest(url=url):
                asset = client.get('/static/excel/' + url)
                self.assertEqual(asset.status_code, 200)
                self.assertEqual(parse_qs(urlsplit(url).query)['v'][0], hashlib.sha256(asset.content).hexdigest()[:12])
        for dependency, consumer in (
            ('workspace/table_reader.js', 'operations/operations_sheet.js'),
            ('workspace/table_reader.js', 'recommendation/recommendation_sheet.js'),
            ('formula/workspace_formula.js', 'workspace/workspace.js'),
            ('operations/extraction_suggestions.js', 'operations/operations.js'),
            ('chat/chat.js', 'taskpane.js'),
            ('documents/documents.js', 'taskpane.js'),
            ('cleaning_help/cleaning_help.js', 'taskpane.js'),
        ):
            self.assertLess(paths.index(dependency), paths.index(consumer))
        base = Path(__file__).resolve().parents[2] / 'src/static/excel'
        for file in base.rglob('*.js'):
            if 'vendor' not in file.parts:
                self.assertIn(file.relative_to(base).as_posix(), paths)
