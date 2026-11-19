import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from main import app
from prompts.loader import load_agent_prompt
from runtime import PROMPT_DIR


class PromptStartupTests(unittest.TestCase):
    def test_all_prompt_files_load_and_chat_settings_remain_in_system_text(self):
        for path in sorted(PROMPT_DIR.glob('*.yml')):
            with self.subTest(prompt=path.name):
                prompt = load_agent_prompt(path).render()
                self.assertTrue(prompt)
                if path.name == 'request_tools.yml':
                    self.assertIn('채팅 작업 설정:', prompt)
                    self.assertIn('workspace.pending_operation', prompt)
                    self.assertNotIn('묶음 검토 보류(2026-11-18)', prompt)

    def test_external_server_starts_with_real_runtime_and_prompts(self):
        with patch.dict(os.environ, {'KCS_ENV': 'external'}):
            with TestClient(app) as client:
                self.assertEqual(client.get('/health').json(), {'status': 'ok'})
                response = client.post('/conversations')
                self.assertEqual(response.status_code, 200)
                self.assertIn('conversation_id', response.json())
                self.assertIn('채팅 작업 설정:', app.state.runtime.tools_prompt)


if __name__ == '__main__':
    unittest.main()
