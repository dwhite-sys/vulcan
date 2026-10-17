"""Reasoning dialects and pre-stream compatibility recovery on both routes."""

import asyncio
import json
import types
import unittest
from unittest import mock

import httpx

from vulcan import agent_runtime as agent, provider_reasoning as reasoning


def provider(base="https://api.groq.com/openai/v1", model="qwen/qwen3.8-27b", **extra):
    return {"baseUrl": base, "model": model, **extra}


class ReasoningTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        reasoning._REJECTED.clear()
        self.events = []

    def run_for(self, config):
        return types.SimpleNamespace(options={"provider": config},
                                     stream_event=lambda event, turn: self.events.append(event))

    def test_dialects(self):
        for config, expected in [
            (provider(), {"reasoning_format": "parsed"}),
            (provider(model="openai/gpt-oss-120b"), {"include_reasoning": True}),
            (provider(model="llama-3.3-70b-versatile"), {}),
            (provider(base="https://openrouter.ai/api/v1"), {"reasoning": {"enabled": True}}),
            (provider(base="https://api.openai.com/v1", model="gpt-5"), {}),
            (provider(base="http://localhost:1234/v1"), {}),
            (provider(base="https://api.groq.com.example.org/v1"), {}),
        ]:
            with self.subTest(config=config):
                self.assertEqual(reasoning.request_controls(config), expected)

    async def test_groq_and_custom_chat_wire_requests(self):
        # Exercise the real HTTP/SSE path with the formerly failing Groq model,
        # Groq GPT-OSS and a strict custom OpenAI-compatible endpoint.
        for config in [provider(), provider(model="openai/gpt-oss-20b"),
                       provider(base="http://localhost:1234/v1")]:
            requests = []

            def respond(request):
                requests.append(json.loads(request.content))
                return httpx.Response(200, text='data: {"choices":[{"delta":{"reasoning":"Think", "content":"Answer"}}]}\n\ndata: [DONE]\n\n')

            async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
                with mock.patch.object(agent.network, "client", new=mock.AsyncMock(return_value=client)):
                    result = await agent._provider_response_stream(self.run_for(config), [], [], "turn", first_data=asyncio.Event())
            self.assertEqual(len(requests), 1)
            self.assertNotIn("reasoning", requests[0])
            self.assertEqual(result["thinking"], "Think")
            self.assertEqual(result["content"], "Answer")
            for field, value in reasoning.request_controls(config).items():
                self.assertEqual(requests[0][field], value)

    async def test_server_rejection_retries_and_remembers_only_model(self):
        config = provider()
        requests = []

        def respond(request):
            body = json.loads(request.content)
            requests.append(body)
            if "reasoning_format" in body:
                return httpx.Response(400, json={"error": {"message": "property 'reasoning_format' is unsupported"}})
            return httpx.Response(200, text='data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n')

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            with mock.patch.object(agent.network, "client", new=mock.AsyncMock(return_value=client)):
                for _ in range(2):
                    result = await agent._provider_response_stream(self.run_for(config), [], [], "turn", first_data=asyncio.Event())
                    self.assertEqual(result["content"], "ok")
        self.assertEqual(len(requests), 3)
        self.assertIn("reasoning_format", requests[0])
        self.assertNotIn("reasoning_format", requests[1])
        self.assertNotIn("reasoning_format", requests[2])
        self.assertEqual(reasoning.request_controls(provider(model="qwen/another")), {"reasoning_format": "parsed"})
        self.assertEqual(reasoning.request_controls(provider(networkPointOfView="client", clientId="a")), {"reasoning_format": "parsed"})
        with mock.patch.object(reasoning.time, "monotonic", return_value=__import__("time").monotonic() + 3601):
            self.assertEqual(reasoning.request_controls(config), {"reasoning_format": "parsed"})

    async def test_client_relay_rejection_and_tool_stream(self):
        requests = []
        config = provider(networkPointOfView="client", clientId="desktop")

        async def relay(*args, **kwargs):
            body = json.loads(kwargs["body"])
            requests.append(body)
            if "reasoning_format" in body:
                raise RuntimeError('LLM error 400: {"error":{"message":"Unknown parameter: reasoning_format"}}')
            yield 'data: {"choices":[{"delta":{"reasoning_content":"Think", "tool_calls":[{"index":0,"id":"call-1","function":{"name":"test","arguments":"{}"}}]}}]}\n\n'
            yield 'data: [DONE]\n\n'

        with mock.patch.object(agent.etna_registry, "relay_http_stream", new=relay):
            result = await agent._provider_response_stream(self.run_for(config), [], [{"name": "test"}], "turn", first_data=asyncio.Event())
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0]["messages"], requests[1]["messages"])
        self.assertEqual(requests[0]["tools"], requests[1]["tools"])
        self.assertEqual(result["toolCalls"][0]["id"], "call-1")
        self.assertEqual(result["thinking"], "Think")

    async def test_never_retry_after_data(self):
        first_data = asyncio.Event()

        async def fail(*args, **kwargs):
            first_data.set()
            raise RuntimeError('LLM error 400: {"error":{"message":"property reasoning_format is unsupported"}}')

        with mock.patch.object(agent, "_provider_response_stream_once", new=mock.AsyncMock(side_effect=fail)) as stream:
            with self.assertRaises(RuntimeError):
                await agent._provider_response_stream(self.run_for(provider()), [], [], "turn", first_data=first_data)
        self.assertEqual(stream.await_count, 1)
        self.assertFalse(reasoning._REJECTED)

    def test_only_explicit_property_rejections_are_recoverable(self):
        for status, message in [(401, "property reasoning_format is unsupported"),
                                (429, "property reasoning_format is unsupported"),
                                (500, "property reasoning_format is unsupported"),
                                (400, "reasoning_format must be one of raw, parsed"),
                                (400, "model is not supported"),
                                (400, "property tools is unsupported")]:
            error = ValueError(f'LLM error {status}: ' + json.dumps({"error": {"message": message}}))
            self.assertIsNone(reasoning.rejected_control(error, {"reasoning_format": "parsed"}))

    def test_empty_aliases_do_not_hide_reasoning(self):
        for delta in [{"reasoning": None, "reasoning_content": "Think"},
                      {"reasoning_details": [], "reasoning": "Think"},
                      {"reasoning": "", "thinking": "Think"}]:
            parser = agent.ProviderStreamParser(self.events.append)
            parser.process_delta({**delta, "content": "Answer"})
            result = parser.finish()
            self.assertEqual(result["thinking"], "Think")
            self.assertEqual(result["content"], "Answer")


if __name__ == "__main__":
    unittest.main()
