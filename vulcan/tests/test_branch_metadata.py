from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

TEST_DIR = Path(tempfile.mkdtemp(prefix='vulcan-branch-metadata-'))
os.environ['VULCAN_CONFIG_DIR'] = str(TEST_DIR)

from vulcan import chats


class BranchMetadataRoundTrip(unittest.TestCase):
    def test_branch_metadata_survives_canonical_chat_roundtrip(self):
        root_event = {
            'id': 'u1', 'type': 'user_message', 'content': 'root',
            'timestamp': '2026-09-13T21:00:00.000Z',
        }
        edit_event = {
            'id': 'u1-edit', 'type': 'user_message', 'content': 'edited root',
            'timestamp': '2026-09-13T21:01:00.000Z',
        }
        chat = {
            'schemaVersion': 2,
            'id': 'branch-chat',
            'title': 'Branch chat',
            'createdAt': '2026-09-13T21:00:00.000Z',
            'updatedAt': '2026-09-13T21:01:00.000Z',
            'events': [edit_event],
            'branching': {
                'version': 1,
                'currentBranchId': 'edit',
                'nodes': [
                    {'event': root_event, 'parentId': None},
                    {'event': edit_event, 'parentId': None},
                ],
                'branches': [
                    {'id': 'root', 'parentBranchId': None, 'origin': 'root', 'title': 'Main branch', 'titleSource': 'auto',
                     'createdAt': '2026-09-13T21:00:00.000Z', 'updatedAt': '2026-09-13T21:00:00.000Z', 'headEventId': 'u1'},
                    {'id': 'edit', 'parentBranchId': 'root', 'origin': 'edit', 'title': 'Edited root', 'titleSource': 'auto',
                     'createdAt': '2026-09-13T21:01:00.000Z', 'updatedAt': '2026-09-13T21:01:00.000Z', 'headEventId': 'u1-edit'},
                ],
            },
        }
        chats.save_chat(chat)
        loaded = chats.load_chat('branch-chat')
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded['branching']['currentBranchId'], 'edit')
        self.assertEqual([b['id'] for b in loaded['branching']['branches']], ['root', 'edit'])
        self.assertEqual(loaded['branching']['nodes'][0]['event']['content'], 'root')
        self.assertEqual(loaded['events'][0]['content'], 'edited root')

        # Server-owned run checkpoints only carry the live linear projection. Saving one
        # must merge newly produced events into the durable parent-only graph instead of
        # leaving branch metadata stale.
        assistant_event = {
            'id': 'a-edit', 'type': 'assistant_text', 'content': 'continued from edit',
            'status': 'complete', 'timestamp': '2026-09-13T21:02:00.000Z',
        }
        loaded['events'] = [edit_event, assistant_event]
        loaded['updatedAt'] = '2026-09-13T21:02:00.000Z'
        chats.save_chat(loaded)
        reloaded = chats.load_chat('branch-chat')
        self.assertIsNotNone(reloaded)
        node_by_id = {node['event']['id']: node for node in reloaded['branching']['nodes']}
        self.assertEqual(node_by_id['a-edit']['parentId'], 'u1-edit')
        self.assertEqual(sum(node['event']['id'] == 'a-edit' for node in reloaded['branching']['nodes']), 1)
        edit_branch = next(branch for branch in reloaded['branching']['branches'] if branch['id'] == 'edit')
        self.assertEqual(edit_branch['headEventId'], 'a-edit')
        self.assertEqual(edit_branch['updatedAt'], '2026-09-13T21:02:00.000Z')


if __name__ == '__main__':
    unittest.main()
