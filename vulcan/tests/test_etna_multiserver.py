import asyncio
import unittest
from unittest.mock import patch

from vulcan import etna_registry
from vulcan import agent_runtime


def kit(name='Playwright', tools=('browser_start','browser_screenshot')):
    return {'kit_name': name, 'kit_description': '', 'filename': name.lower()+'.py', 'enabled': True,
            'tools': [{'name': t, 'description': '', 'parameters': {}} for t in tools]}


class EtnaMultiServerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        etna_registry.CLIENT_SESSIONS.clear()
        etna_registry.RELAY_FUTURES.clear()
        etna_registry.HTTP_STREAMS.clear()
        etna_registry.RELAY_CLIENTS.clear()

    def tearDown(self):
        etna_registry.CLIENT_SESSIONS.clear()
        etna_registry.RELAY_FUTURES.clear()
        etna_registry.HTTP_STREAMS.clear()
        etna_registry.RELAY_CLIENTS.clear()

    def test_backend_registry_is_ephemeral_relay_only(self):
        for obsolete in ('save_servers', 'list_servers', 'set_route', 'routes', 'logical_kits', 'logical_skills', 'update_inventory'):
            self.assertFalse(hasattr(etna_registry, obsolete), f'{obsolete} would reintroduce server-owned Etna configuration')

    async def test_client_relay_uses_registered_encrypted_session(self):
        class Session:
            async def send(self, message):
                relay_id = message['payload']['relay_id']
                asyncio.get_running_loop().call_soon(
                    etna_registry.resolve_http_event, relay_id,
                    {'event': 'response', 'status': 200, 'text': '{"result":"ok"}'},
                )
        session = Session()
        etna_registry.register_client('device', session)
        result = await etna_registry.relay_json('device','http://localhost:8467','/run_tool','POST',{'x':1})
        self.assertEqual(result, {'result':'ok'})

    async def test_agent_dispatch_uses_selected_client_source(self):
        source = {'url':'http://localhost:8467','networkPointOfView':'client','clientId':'device'}
        selected = {**kit(), 'effective_source': source}
        with patch.object(etna_registry, 'relay_json', new=unittest.mock.AsyncMock(return_value={'result': {'ok': True}})) as relay:
            result = await agent_runtime._dispatch_etna_tool(unittest.mock.MagicMock(), '', selected, 'browser_start', {}, 'event')
        self.assertEqual(result, {'result': {'ok': True}})
        relay.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
