"""Agent-visible lifecycle/result contracts, using real registered waits."""
import asyncio
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from vulcan.tests.test_agent_runtime import agent, chat, options
from vulcan import terminal as term

class EdgeResults(unittest.IsolatedAsyncioTestCase):
    def run_handle(self):
        return agent.AgentRun(chat=chat('terminal-edges'), options=options(settings={'cliWorkspaceEnabled': True, 'panelsEnabled': True}), manager=agent.RunManager(), run_id='edge-results')

    async def test_removed_webhook_fails_without_starting_a_wait(self):
        with patch.object(term, 'start_wait') as start:
            result = await agent.execute_tool(self.run_handle(), 'wait', {'seconds': 10, 'webhook_url': '/webhook/old'}, 'turn', 'event')
        self.assertIn('removed', result['error'])
        start.assert_not_called()

    async def test_timed_wait_really_waits(self):
        started = time.monotonic()
        result = (await agent.execute_tool(self.run_handle(), 'wait', {'seconds': .06}, 'turn', 'event'))['result']
        self.assertEqual(result['waited'], .06)
        self.assertGreaterEqual(time.monotonic() - started, .06)
        self.assertLess(time.monotonic() - started, 2)

    async def test_timed_wait_detach(self):
        pid = term.start_wait('wait-detach', 10)
        self.assertTrue(term.detach_wait(pid, 'cancelled'))
        result = await agent._wait_result(pid, 1)
        self.assertTrue(result['detached'])
        self.assertEqual(result['detach_reason'], 'cancelled')

    async def test_http_callback_route_removed_and_old_wait_rejected(self):
        try:
            from fastapi.testclient import TestClient
        except ImportError:
            self.skipTest('HTTP integration requires the backend server dependencies')
        from vulcan import server
        client = TestClient(server.app)
        with patch.object(server.auth, 'server_requires_auth', return_value=False):
            self.assertEqual(client.post('/webhook/old').status_code, 404)
            response = client.post('/terminal/wait', json={'chat_id': 'old', 'seconds': .01, 'webhook_url': '/webhook/old'})
            self.assertIn('removed', response.json()['error'])

    async def test_unknown_exit_status_is_not_reported_as_success(self):
        run = self.run_handle()
        run.terminal_slots = [1]
        run.terminal_focus = 1
        command = SimpleNamespace(output=['interrupted output'], finished=True, detached=False, exit_code=None, detach_reason='Host lost; command was not rerun')
        with patch.object(agent, '_resume_agent_terminals', return_value=[]), patch.object(term, 'list_slots', return_value=[]), patch.object(term, 'use_terminal_in_slot', return_value='edge-command'), patch.object(term, 'consume_slot_resume_notice', return_value=None), patch.object(agent, '_initial_terminal_result', return_value=(command, True)):
            result = (await agent.execute_tool(run, 'use_terminal', {'cmd': 'echo test'}, 'turn', 'event'))['result']
        self.assertIsNone(result['exit_code'])
        self.assertTrue(result['interrupted'])
        self.assertIn('not rerun', result['note'])

    async def test_close_failure_keeps_terminal_available_for_retry(self):
        slot = term.TerminalSlot(chat_id='close-failure', kind='agent', slot=1,
                                proc=SimpleNamespace(finished=False), master_fd=-1,
                                host_key='close-failure:agent:1')
        key = ('close-failure', 'agent', 1)
        term._slots[key] = slot
        try:
            with patch.object(term.terminal_host, 'call', side_effect=RuntimeError('host unavailable')):
                with self.assertRaisesRegex(RuntimeError, 'remains open for retry'):
                    term.close_slot('close-failure', 'agent', 1)
            self.assertFalse(slot.finished)
            self.assertEqual(slot.close_reason, '')
        finally:
            term._slots.pop(key, None)

if __name__ == '__main__': unittest.main()
