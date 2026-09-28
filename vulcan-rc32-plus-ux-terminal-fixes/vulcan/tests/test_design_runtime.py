from __future__ import annotations

import unittest
from unittest import mock

from vulcan import agent_runtime as agent


class DummyManager:
    def __init__(self):
        self.published = []

    def publish(self, chat_id, event, payload):
        self.published.append((chat_id, event, payload))


def make_run(*, vision='unknown'):
    chat = {
        'schemaVersion': 2,
        'id': 'design-runtime-chat',
        'title': 'Design test',
        'createdAt': '2026-09-15T00:00:00Z',
        'updatedAt': '2026-09-15T00:00:00Z',
        'events': [],
    }
    options = {
        'settings': {'toolMode': 'search', 'discoveryExecution': 'search-inspect', 'cliWorkspaceEnabled': True, 'panelsEnabled': True},
        'enabledKits': [], 'disabledTools': [], 'kitsWithTools': [],
        'modelVision': vision, 'clientId': 'client-one',
    }
    return agent.AgentRun(chat=chat, options=options, manager=DummyManager(), run_id='run-design')


class DesignRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def test_registry_tools_are_native_and_view_file_schema_tracks_vision(self):
        base = {'toolMode': 'search', 'cliWorkspaceEnabled': True, 'panelsEnabled': True}
        blind = agent.native_tools({**base, '_modelVision': 'unknown'})
        sighted = agent.native_tools({**base, '_modelVision': True})
        blind_names = {tool['name'] for tool in blind}
        self.assertTrue({'design_register', 'design_update', 'design_info', 'design_list', 'design_remove', 'open_design'} <= blind_names)
        self.assertFalse({'design_inspect', 'design_click', 'design_screenshot'} & blind_names,
                         'Live-surface controls must stay out of the native creation/configuration cluster')
        blind_view = next(tool for tool in blind if tool['name'] == 'view_file')
        sighted_view = next(tool for tool in sighted if tool['name'] == 'view_file')
        self.assertNotIn('region', blind_view['parameters']['properties'])
        self.assertNotIn('Images', blind_view['description'])
        self.assertIn('region', sighted_view['parameters']['properties'])
        self.assertIn('Images', sighted_view['description'])
        self.assertNotIn('design_screenshot', {tool['name'] for tool in agent.design_surface_tools('unknown')})
        self.assertIn('design_screenshot', {tool['name'] for tool in agent.design_surface_tools(True)})
        design_register = next(tool for tool in blind if tool['name'] == 'design_register')
        open_design = next(tool for tool in blind if tool['name'] == 'open_design')
        self.assertIn('precision frontend-development surface', design_register['description'])
        self.assertIn('prefer preview', design_register['description'])
        self.assertIn('normal workspace tools', design_register['description'])
        self.assertIn('transition into live-surface control', open_design['description'])
        self.assertIn('discoverable through search_tools', open_design['description'])
        screenshot_tool = next(tool for tool in agent.design_surface_tools(True) if tool['name'] == 'design_screenshot')
        self.assertIn('actual pixels', screenshot_tool['description'])
        self.assertIn('prefer visual evidence', screenshot_tool['description'])

    async def test_registry_crud_preserves_design_identity(self):
        run = make_run()
        with mock.patch.object(agent.chats, 'save_chat'):
            created = await agent.execute_tool(run, 'design_register', {'name': 'App', 'url': 'localhost:5173'}, 'turn', 'event')
            design = created['result']['design']
            updated = await agent.execute_tool(run, 'design_update', {'name': 'App', 'url': 'http://localhost:4173'}, 'turn', 'event')
            self.assertEqual(updated['result']['design']['id'], design['id'])
            listed = await agent.execute_tool(run, 'design_list', {}, 'turn', 'event')
            self.assertEqual(listed['result']['designs'][0]['url'], 'http://localhost:4173')
            removed = await agent.execute_tool(run, 'design_remove', {'name': 'App'}, 'turn', 'event')
            self.assertEqual(removed['result']['id'], design['id'])
        self.assertEqual(run.chat['designs'], [])

    async def test_live_surface_discovery_is_contextual_and_screenshot_is_vision_gated(self):
        run = make_run(vision='unknown')
        with mock.patch.object(agent, '_design_surface_available', new=mock.AsyncMock(return_value=False)):
            closed = await agent.execute_tool(run, 'search_tools', {'query': 'frontend inspect'}, 'turn', 'event')
            self.assertNotIn('design_inspect', {item['tool'] for item in closed['result']['results']})
        with mock.patch.object(agent, '_design_surface_available', new=mock.AsyncMock(return_value=True)):
            result = await agent.execute_tool(run, 'search_tools', {'query': 'live surface click'}, 'turn', 'event')
            names = {item['tool'] for item in result['result']['results']}
            self.assertIn('design_click', names)
            frontend = await agent.execute_tool(run, 'search_tools', {'query': 'frontend inspect'}, 'turn', 'event')
            self.assertIn('design_inspect', {item['tool'] for item in frontend['result']['results']})
            screenshot = await agent.execute_tool(run, 'search_tools', {'query': 'screenshot visual'}, 'turn', 'event')
            self.assertNotIn('design_screenshot', {item['tool'] for item in screenshot['result']['results']})

        run.options['modelVision'] = True
        with mock.patch.object(agent, '_design_surface_available', new=mock.AsyncMock(return_value=True)):
            screenshot = await agent.execute_tool(run, 'search_tools', {'query': 'screenshot visual'}, 'turn', 'event')
            self.assertIn('design_screenshot', {item['tool'] for item in screenshot['result']['results']})


    async def test_live_surface_discovery_uses_open_state_not_dom_readiness(self):
        run = make_run(vision='unknown')
        with mock.patch.object(agent, '_design_surface_available', new=mock.AsyncMock(return_value=True)), \
             mock.patch.object(agent, '_design_surface_ready', new=mock.AsyncMock(return_value=False)):
            result = await agent.execute_tool(run, 'search_tools', {'query': 'design controller'}, 'turn', 'event')
            names = {item['tool'] for item in result['result']['results']}
            self.assertIn('design_inspect', names)
            inspected = await agent.execute_tool(run, 'inspect_tool', {'tool': 'design_click'}, 'turn', 'event')
            self.assertEqual(inspected['result'].get('tool'), 'design_click')
            action = await agent.execute_tool(run, 'design_click', {'target': 'e1'}, 'turn', 'event')
            self.assertEqual(action['result'].get('error'), 'design_surface_unavailable')


    async def test_open_design_announces_live_surface_control_transition(self):
        run = make_run(vision=True)
        with mock.patch.object(agent.chats, 'save_chat'), \
             mock.patch.object(agent, '_design_client_action', new=mock.AsyncMock(return_value={
                 'ok': True, 'designId': 'design-one', 'name': 'App', 'url': 'http://localhost:5173',
                 'surface': 'open', 'liveSurfaceReady': True,
             })):
            await agent.execute_tool(run, 'design_register', {'name': 'App', 'url': 'http://localhost:5173'}, 'turn', 'event')
            opened = await agent.execute_tool(run, 'open_design', {'name': 'App'}, 'turn', 'event')
        self.assertTrue(opened['result']['liveSurfaceReady'])
        self.assertIn('search_tools', opened['result']['guidance'])
        self.assertIn('actual running frontend', opened['result']['guidance'])
        self.assertIn('normal workspace tools for implementation', opened['result']['guidance'])

    async def test_design_client_timeout_has_stage_specific_error(self):
        run = make_run(vision=True)
        with mock.patch.object(agent.etna_registry, 'relay_client_action', new=mock.AsyncMock(side_effect=agent.asyncio.TimeoutError())):
            with self.assertRaisesRegex(RuntimeError, 'design_screenshot_timeout'):
                await agent._design_client_action(run, 'screenshot', {}, timeout=0.01)

    async def test_live_surface_action_relays_to_owning_client(self):
        run = make_run(vision=True)
        with mock.patch.object(agent, '_design_surface_ready', new=mock.AsyncMock(return_value=True)), \
             mock.patch.object(agent, '_design_client_action', new=mock.AsyncMock(return_value={'ok': True, 'saved_to': '/workspace/screenshots/design-app.png'})) as relay:
            result = await agent.execute_tool(run, 'design_screenshot', {}, 'turn', 'event')
        self.assertEqual(result['result']['saved_to'], '/workspace/screenshots/design-app.png')
        relay.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
