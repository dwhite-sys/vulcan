from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

TEST_DIR = Path(tempfile.mkdtemp(prefix='vulcan-transcript-fts-'))
os.environ['VULCAN_CONFIG_DIR'] = str(TEST_DIR)

from vulcan import chats


class TranscriptFTSRegression(unittest.TestCase):
    def test_universal_search_uses_only_current_branch_but_branch_search_keeps_shared_ancestry(self):
        root = {'id': 'u-root', 'type': 'user_message', 'content': 'shared ancestry aardvark', 'timestamp': '2026-09-14T00:00:00Z'}
        old = {'id': 'a-old', 'type': 'assistant_text', 'content': 'historical-only platypus', 'status': 'complete', 'timestamp': '2026-09-14T00:01:00Z'}
        current = {'id': 'a-current', 'type': 'assistant_text', 'content': 'current-only playwright', 'status': 'complete', 'timestamp': '2026-09-14T00:02:00Z'}
        chat = {
            'schemaVersion': 2, 'id': 'fts-branch-chat', 'title': 'FTS branch chat',
            'createdAt': '2026-09-14T00:00:00Z', 'updatedAt': '2026-09-14T00:02:00Z',
            'events': [root, current],
            'branching': {
                'version': 1, 'currentBranchId': 'current',
                'nodes': [
                    {'event': root, 'parentId': None},
                    {'event': old, 'parentId': 'u-root'},
                    {'event': current, 'parentId': 'u-root'},
                ],
                'branches': [
                    {'id': 'old', 'parentBranchId': None, 'origin': 'root', 'title': 'Old', 'titleSource': 'auto', 'createdAt': '2026-09-14T00:00:00Z', 'updatedAt': '2026-09-14T00:01:00Z', 'headEventId': 'a-old'},
                    {'id': 'current', 'parentBranchId': 'old', 'origin': 'edit', 'title': 'Current', 'titleSource': 'auto', 'createdAt': '2026-09-14T00:02:00Z', 'updatedAt': '2026-09-14T00:02:00Z', 'headEventId': 'a-current'},
                ],
            },
        }
        chats.save_chat(chat)

        self.assertEqual(chats.search_current_transcripts('platypus')['chat_ids'], [])
        current_result = chats.search_current_transcripts('playwright')
        self.assertIn('fts-branch-chat', current_result['chat_ids'])
        self.assertEqual(current_result['hits_by_chat']['fts-branch-chat'][0]['event_id'], 'a-current')

        inherited = chats.search_branches('fts-branch-chat', 'aardvark')
        self.assertEqual(set(inherited['branch_ids']), {'old', 'current'})
        self.assertEqual(inherited['hits_by_branch']['old'][0]['event_id'], 'u-root')
        self.assertEqual(inherited['hits_by_branch']['current'][0]['event_id'], 'u-root')

        old_only = chats.search_branches('fts-branch-chat', 'platypus')
        self.assertEqual(old_only['branch_ids'], ['old'])
        self.assertEqual(old_only['hits_by_branch']['old'][0]['event_id'], 'a-old')

    def test_search_returns_direct_matched_message_rows(self):
        tool = {
            'id': 'tool-1', 'type': 'tool', 'tool': 'browser_screenshot',
            'arguments': {'path': 'playwright-test.png'},
            'result': {'status': 'saved'}, 'status': 'complete', 'timestamp': '2026-09-14T00:00:00Z',
        }
        chat = {
            'schemaVersion': 2, 'id': 'fts-tool-chat', 'title': 'tool search',
            'createdAt': '2026-09-14T00:00:00Z', 'updatedAt': '2026-09-14T00:00:00Z',
            'events': [tool],
        }
        chats.save_chat(chat)
        result = chats.search_current_transcripts('playwright-test.png')
        self.assertEqual(result['chat_ids'], ['fts-tool-chat'])
        hit = result['hits_by_chat']['fts-tool-chat'][0]
        self.assertEqual(hit['event_id'], 'tool-1')
        self.assertIn('playwright-test.png', hit['message'].lower())
        self.assertNotIn('start', hit)
        self.assertNotIn('end', hit)


if __name__ == '__main__':
    unittest.main()
