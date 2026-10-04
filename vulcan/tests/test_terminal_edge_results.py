"""Agent-visible lifecycle/result contracts, using real registered waits."""
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from vulcan.tests.test_agent_runtime import agent, chat, options
from vulcan import terminal as term

class EdgeResults(unittest.IsolatedAsyncioTestCase):
    def run_handle(self):
        return agent.AgentRun(chat=chat('terminal-edges'), options=options(settings={'cliWorkspaceEnabled': True, 'panelsEnabled': True}), manager=agent.RunManager(), run_id='edge-results')

    async def test_webhook_reports_real_wake_reason_and_elapsed_time(self):
        run = self.run_handle()
        task = asyncio.create_task(agent.execute_tool(run, 'wait', {'seconds': 10, 'webhook_url': '/webhook/edge-results'}, 'turn', 'event'))
        for _ in range(100):
            if term._wait_webhooks.get('/webhook/edge-results'): break
            await asyncio.sleep(.005)
        self.assertEqual(term.trigger_webhook('/webhook/edge-results', 'POST'), 1)
        result = (await asyncio.wait_for(task, .5))['result']
        self.assertEqual(result['wake_reason'], 'webhook')
        self.assertEqual(result['webhook_method'], 'POST')
        self.assertEqual(result['webhook_path'], '/webhook/edge-results')
        self.assertLess(result['waited'], .5)
        self.assertFalse(term._wait_webhooks.get('/webhook/edge-results'))

    async def test_timeout_reports_timeout_and_actual_elapsed(self):
        result = (await agent.execute_tool(self.run_handle(), 'wait', {'seconds': .06, 'webhook_url': '/webhook/timeout-results'}, 'turn', 'event'))['result']
        self.assertEqual(result['wake_reason'], 'timeout')
        self.assertGreaterEqual(result['waited'], .06)
        self.assertLess(result['waited'], .5)

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
