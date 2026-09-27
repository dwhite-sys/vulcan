import asyncio
import json
import unittest
from unittest import mock

from vulcan import agent_runtime, etna_registry


class FakeSession:
    def __init__(self):
        self.sent = []

    async def send(self, message):
        self.sent.append(message)
        if message["type"] == "push/client-http-request":
            payload = message["payload"]
            relay_id = payload["relay_id"]
            if payload.get("stream"):
                etna_registry.resolve_http_event(relay_id, {"event": "headers", "status": 200})
                etna_registry.resolve_http_event(relay_id, {"event": "chunk", "data": "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n"})
                etna_registry.resolve_http_event(relay_id, {"event": "done"})
            else:
                etna_registry.resolve_http_event(relay_id, {"event": "response", "status": 200, "text": "{\"data\":[]}"})

class ProviderClientRelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        etna_registry.CLIENT_SESSIONS.clear()
        etna_registry.RELAY_FUTURES.clear()
        etna_registry.HTTP_STREAMS.clear()
        etna_registry.RELAY_CLIENTS.clear()

    async def test_buffered_request_is_sent_only_to_selected_client(self):
        chosen, other = FakeSession(), FakeSession()
        etna_registry.register_client("chosen", chosen)
        etna_registry.register_client("other", other)
        result = await etna_registry.relay_http(
            "chosen", "http://localhost:11434/v1/models", headers={"Authorization": "Bearer secret"}
        )
        self.assertEqual(result["status"], 200)
        self.assertEqual(len(chosen.sent), 1)
        self.assertEqual(other.sent, [])
        self.assertEqual(chosen.sent[0]["payload"]["headers"]["Authorization"], "Bearer secret")

    async def test_streaming_chunks_flow_without_buffering_completion(self):
        session = FakeSession()
        etna_registry.register_client("laptop", session)
        chunks = []
        async for chunk in etna_registry.relay_http_stream(
            "laptop", "http://localhost:11434/v1/chat/completions", body={"stream": True}
        ):
            chunks.append(chunk)
        self.assertIn('"content":"Hi"', "".join(chunks))

    async def test_disconnect_fails_inflight_stream_immediately(self):
        class HangingSession:
            async def send(self, message):
                pass
        session = HangingSession()
        etna_registry.register_client("laptop", session)

        async def consume():
            async for _ in etna_registry.relay_http_stream("laptop", "http://localhost/stream"):
                pass

        task = asyncio.create_task(consume())
        await asyncio.sleep(0)
        etna_registry.unregister_client("laptop", session)
        with self.assertRaisesRegex(RuntimeError, "disconnected"):
            await asyncio.wait_for(task, timeout=.2)

    async def test_cancelling_stream_propagates_abort_to_client(self):
        class HangingSession:
            def __init__(self):
                self.sent = []
            async def send(self, message):
                self.sent.append(message)
        session = HangingSession()
        etna_registry.register_client("laptop", session)

        async def consume():
            async for _ in etna_registry.relay_http_stream("laptop", "http://localhost/stream"):
                pass

        task = asyncio.create_task(consume())
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(any(item["type"] == "push/client-http-cancel" for item in session.sent))


if __name__ == "__main__":
    unittest.main()

class OllamaVisionFallbackTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        agent_runtime._OLLAMA_VISION_CACHE.clear()

    async def test_native_show_resolves_custom_client_alias_vision(self):
        provider = {
            'name': 'Ollama',
            'baseUrl': 'http://127.0.0.1:11434/v1',
            'model': 'my-custom-copy:latest',
            'networkPointOfView': 'client',
            'clientId': 'device',
        }
        response = {
            'status': 200,
            'text': json.dumps({'capabilities': ['completion', 'vision', 'tools']}),
        }
        with mock.patch.object(agent_runtime.etna_registry, 'relay_http', new=mock.AsyncMock(return_value=response)) as relay:
            result = await agent_runtime.resolve_ollama_model_vision(provider)
        self.assertIs(result, True)
        args, kwargs = relay.await_args
        self.assertEqual(args[:3], ('device', 'http://127.0.0.1:11434/api/show', 'POST'))
        self.assertEqual(kwargs['body'], {'model': 'my-custom-copy:latest'})

    async def test_native_show_marks_known_ollama_text_model_nonvision(self):
        provider = {
            'name': 'Ollama',
            'baseUrl': 'http://127.0.0.1:11434/v1',
            'model': 'text-alias',
            'networkPointOfView': 'client',
            'clientId': 'device',
        }
        response = {'status': 200, 'text': json.dumps({'capabilities': ['completion', 'tools']})}
        with mock.patch.object(agent_runtime.etna_registry, 'relay_http', new=mock.AsyncMock(return_value=response)):
            result = await agent_runtime.resolve_ollama_model_vision(provider)
        self.assertIs(result, False)

    async def test_non_ollama_unknown_does_not_probe_native_endpoint(self):
        provider = {
            'name': 'OpenRouter',
            'baseUrl': 'https://openrouter.ai/api/v1',
            'model': 'some/unknown-model',
            'networkPointOfView': 'client',
            'clientId': 'device',
        }
        with mock.patch.object(agent_runtime.etna_registry, 'relay_http', new=mock.AsyncMock()) as relay:
            result = await agent_runtime.resolve_ollama_model_vision(provider)
        self.assertEqual(result, 'unknown')
        relay.assert_not_awaited()
