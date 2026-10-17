"""Native OpenAI request, stream, private state and agent-loop regressions."""
import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx
from vulcan.tests import test_agent_runtime as fixtures
from vulcan import agent_runtime as agent, chats, openai_responses as oai


def provider(**extra):
    return {'baseUrl': 'https://api.openai.com/v1', 'model': 'gpt-5', 'apiKey': 'test-only', **extra}


def message(text='Answer', id='msg-1'):
    return {'id': id, 'type': 'message', 'role': 'assistant', 'status': 'completed',
            'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}


def thought(id='rs-1', text='Check the evidence'):
    return {'id': id, 'type': 'reasoning', 'summary': [{'type': 'summary_text', 'text': text}],
            'encrypted_content': 'opaque-private-state'}


def function(id='fc-1', call='call-1', name='get_tools', args='{}'):
    return {'id': id, 'type': 'function_call', 'status': 'completed', 'call_id': call,
            'name': name, 'arguments': args}


def completion(items, **extra):
    return {'type': 'response.completed', 'response': {'id': 'resp-1', 'status': 'completed', 'output': items, **extra}}


def wire(events):
    return ''.join('event: ' + event['type'] + '\r\ndata: ' + json.dumps(event) + '\r\n\r\n' for event in events)


class ParserTests(unittest.TestCase):
    def test_api_selection_uses_exact_host(self):
        self.assertTrue(oai.uses_responses(provider()))
        for base in ['https://api.groq.com/openai/v1', 'https://api.openai.com.example/v1', 'http://localhost/v1']:
            self.assertFalse(oai.uses_responses(provider(baseUrl=base)))

    def test_request_contains_only_function_tools_and_correct_images(self):
        body = oai.request_body(provider(reasoningEffort='low', tools=[{'type': 'web_search'}]), [
            {'role': 'user', 'content': [{'type': 'text', 'text': 'Look'},
              {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AA', 'detail': 'high'}}]},
        ], [{'name': 'local_tool', 'parameters': {'type': 'object'}}])
        self.assertFalse(body['store'])
        self.assertEqual(body['reasoning'], {'effort': 'low', 'summary': 'auto'})
        self.assertEqual(body['tools'][0]['type'], 'function')
        self.assertEqual(body['tools'][0]['name'], 'local_tool')
        self.assertFalse(body['tools'][0]['strict'])
        self.assertEqual(body['input'][0]['content'][1]['type'], 'input_image')
        self.assertNotIn('reasoning', oai.request_body(provider(model='gpt-4.1'), [], []))
        self.assertNotIn('tools', oai.request_body(provider(), [], [], title=True))

    def test_fragmented_summary_answer_refusal_and_completion_do_not_duplicate(self):
        events = []
        parser = oai.ResponsesParser(events.append)
        rs, msg = thought(text='**Evidence**'), message('Yes')
        frames = wire([
            {'type': 'response.output_item.added', 'output_index': 0, 'item': {**rs, 'summary': []}},
            {'type': 'response.reasoning_summary_text.delta', 'item_id': 'rs-1', 'summary_index': 0, 'delta': '**Evi'},
            {'type': 'response.reasoning_summary_text.delta', 'item_id': 'rs-1', 'summary_index': 0, 'delta': 'dence**'},
            {'type': 'response.output_item.done', 'output_index': 0, 'item': rs},
            {'type': 'response.output_text.delta', 'item_id': 'msg-1', 'content_index': 0, 'delta': 'Yes'},
            completion([rs, msg]),
        ])
        for char in frames:
            parser.feed(char)
        result = parser.finish()
        self.assertEqual(result['thinking'], '**Evidence**')
        self.assertEqual(result['content'], 'Yes')
        self.assertEqual(''.join(e['delta'] for e in events if e['type'] == 'text_delta'), 'Yes')
        self.assertEqual(events[0]['wire'], 'summary')
        self.assertEqual(result['responsesOutput'][0]['encrypted_content'], 'opaque-private-state')

    def test_no_summary_produces_no_empty_reasoning_panel(self):
        events = []
        parser = oai.ResponsesParser(events.append)
        parser.feed(wire([completion([{**thought(), 'summary': []}, message()])]))
        self.assertEqual(parser.finish()['thinking'], '')
        self.assertFalse(any(e['type'] == 'reasoning_delta' for e in events))

    def test_refusal_and_multiple_message_items(self):
        events = []
        parser = oai.ResponsesParser(events.append)
        refusal = {**message(id='m2'), 'content': [{'type': 'refusal', 'refusal': 'Cannot do that'}]}
        parser.feed(wire([completion([message('First'), refusal])]))
        self.assertEqual(parser.finish()['content'], 'FirstCannot do that')
        self.assertNotEqual(events[0]['itemKey'], events[1]['itemKey'])

    def test_missing_terminal_and_invalid_tool_arguments_never_execute(self):
        parser = oai.ResponsesParser(lambda event: None)
        parser.feed('data: {"type":"response.created"}\n\n')
        with self.assertRaisesRegex(RuntimeError, 'before response.completed'):
            parser.finish()
        parser = oai.ResponsesParser(lambda event: None)
        parser.feed(wire([completion([function(args='{"broken"')])]))
        with self.assertRaisesRegex(ValueError, 'Invalid OpenAI function arguments'):
            parser.finish()
        for kind in ['response.failed', 'response.incomplete', 'error']:
            with self.assertRaises(RuntimeError):
                oai.ResponsesParser(lambda e: None).process({'type': kind, 'message': 'failure'})

    def test_parallel_function_ids_and_arguments_are_preserved(self):
        emitted = []
        parser = oai.ResponsesParser(emitted.append)
        a, b = function(), function(id='fc-2', call='call-2', name='second', args='{"x":1}')
        parser.feed(wire([
            {'type': 'response.output_item.added', 'output_index': 0, 'item': {**a, 'arguments': ''}},
            {'type': 'response.output_item.added', 'output_index': 1, 'item': {**b, 'arguments': ''}},
            {'type': 'response.function_call_arguments.delta', 'item_id': 'fc-2', 'delta': '{"x":'},
            {'type': 'response.function_call_arguments.delta', 'item_id': 'fc-1', 'delta': '{}'},
            {'type': 'response.function_call_arguments.delta', 'item_id': 'fc-2', 'delta': '1}'},
            completion([a, b]),
        ]))
        result = parser.finish()
        self.assertEqual([c['id'] for c in result['toolCalls']], ['call-1', 'call-2'])
        self.assertEqual(result['toolCalls'][1]['function']['arguments'], '{"x":1}')


class IntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Patch the already-imported config object too: test module ordering
        # must never send fixture data to a real user's installation. As in
        # the existing suite, retain the temp directory until process exit
        # because cached SQLite connections can hold files open on Windows.
        root = Path(tempfile.mkdtemp(prefix='vulcan-responses-tests-'))
        for name, value in {
            'CONFIG_DIR': root, 'CONFIG_FILE': root / 'config.json',
            'CHATS_DIR': root / 'chats', 'SHARED_DIR': root / 'shared',
            'LIBRARY_DIR': root / 'shared' / 'library', 'SNAPSHOTS_DIR': root / 'snapshots',
        }.items():
            patcher = mock.patch.object(agent.cfg, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_for(self, config=None, name='native'):
        return agent.AgentRun(chat=fixtures.chat(name), options=fixtures.options(provider=config or provider()),
                              manager=agent.RunManager(), run_id=name + ':run')

    async def test_direct_and_client_relay_use_same_native_wire_and_close_on_completed(self):
        for route in ['server', 'client']:
            captured = []
            closed = []
            run = self.run_for(provider(networkPointOfView=route, clientId='desktop'))
            frames = wire([completion([thought(), message()])])

            async def relay(*args, **kwargs):
                captured.append((args[1], json.loads(kwargs['body'])))
                try:
                    yield frames
                    raise AssertionError('Read beyond response.completed')
                finally:
                    closed.append(True)

            class Response:
                status_code = 200
                async def __aenter__(self): return self
                async def __aexit__(self, *args): closed.append(True)
                async def aiter_text(self):
                    yield frames
                    raise AssertionError('Read beyond response.completed')

            class Client:
                def stream(self, method, url, **kwargs):
                    captured.append((url, json.loads(kwargs['content'])))
                    return Response()

            with mock.patch.object(agent.network, 'client', new=mock.AsyncMock(return_value=Client())), mock.patch.object(agent.etna_registry, 'relay_http_stream', new=relay):
                result = await agent._provider_response(run, [{'role': 'user', 'content': 'Hi'}], [], 'turn')
            run.finalize_streams()
            self.assertTrue(closed)
            self.assertEqual(captured[0][0], 'https://api.openai.com/v1/responses')
            self.assertEqual(result['content'], 'Answer')
            self.assertEqual([e['reasoningWire'] for e in run.events if e['type'] == 'reasoning'], ['summary'])
            self.assertNotIn('encrypted_content', json.dumps(run.subscription_snapshot(), default=str))

    async def test_explicit_summary_rejection_retries_without_changing_effort(self):
        requests = []
        def respond(request):
            body = json.loads(request.content)
            requests.append(body)
            if len(requests) == 1:
                return httpx.Response(400, json={'error': {'message': 'Summary not supported', 'param': 'reasoning.summary'}})
            return httpx.Response(200, text=wire([completion([message()])]))
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            with mock.patch.object(agent.network, 'client', new=mock.AsyncMock(return_value=client)):
                run = self.run_for(provider(reasoningEffort='low'))
                result = await agent._provider_response(run, [], [], 'turn')
                run.finalize_streams()
        self.assertEqual(result['content'], 'Answer')
        self.assertEqual(requests[1]['reasoning'], {'effort': 'low'})
        self.assertEqual(len(requests), 2)

    async def test_agent_tool_roundtrip_reload_edit_and_private_state(self):
        run = self.run_for(name='native-persist')
        requests = []
        def respond(request):
            body = json.loads(request.content)
            requests.append(body)
            output = [thought(), function()] if len(requests) == 1 else [message()]
            return httpx.Response(200, text=wire([completion(output)]))
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            with mock.patch.object(agent.network, 'client', new=mock.AsyncMock(return_value=client)), mock.patch.object(agent, 'execute_tool', new=mock.AsyncMock(return_value={'result': {'tools': []}})) as tool:
                await agent.execute_run(run)
                await run.flush_checkpoint()
        self.assertEqual(tool.await_count, 1)
        self.assertEqual(len(requests), 2)
        self.assertTrue(any(i.get('encrypted_content') == 'opaque-private-state' for i in requests[1]['input']))
        self.assertTrue(any(i.get('type') == 'function_call_output' and i['call_id'] == 'call-1' for i in requests[1]['input']))
        await run.checkpoint()
        restored = chats.load_chat('native-persist')
        records = chats.load_provider_responses('native-persist', oai.provider_key(provider()))
        self.assertEqual(len(records), 2)
        projected = agent.project_history(restored['events'], records)
        self.assertTrue(any('_responses_output' in m for m in projected))
        self.assertNotIn('opaque-private-state', json.dumps(restored))
        self.assertNotIn('opaque-private-state', json.dumps(run.subscription_snapshot(), default=str))
        edited = copy.deepcopy(restored['events'])
        edited[0]['content'] = 'Changed user request'
        self.assertFalse(any('_responses_output' in m for m in agent.project_history(edited, records)))
        changed_model = chats.load_provider_responses('native-persist', oai.provider_key(provider(model='gpt-4.1')))
        self.assertEqual(changed_model, {})
        # Results changed on this branch invalidate later responses, while the
        # original call itself remains a valid wire item with the same call ID.
        edited = copy.deepcopy(restored['events'])
        next(e for e in edited if e['type'] == 'tool')['result'] = {'result': 'edited'}
        projected = agent.project_history(edited, records)
        self.assertEqual(sum('_responses_output' in m for m in projected), 1)
        chats.delete_chat('native-persist')
        self.assertEqual(chats.load_provider_responses('native-persist', oai.provider_key(provider())), {})

    async def test_cancel_closes_client_stream_and_executes_no_partial_tool(self):
        started, closed = asyncio.Event(), asyncio.Event()
        calls = []
        async def relay(*args, **kwargs):
            calls.append(kwargs['body'])
            try:
                yield wire([{'type': 'response.output_item.added', 'output_index': 0,
                             'item': {**function(), 'status': 'in_progress', 'arguments': ''}}])
                started.set()
                await asyncio.Event().wait()
            finally:
                closed.set()
        config = fixtures.options(provider=provider(networkPointOfView='client', clientId='desktop'))
        manager = agent.RunManager()
        with mock.patch.object(agent.etna_registry, 'relay_http_stream', new=relay), mock.patch.object(agent, 'execute_tool', new=mock.AsyncMock()) as tool:
            run = manager.start(fixtures.chat('native-cancel'), config)
            await asyncio.wait_for(started.wait(), 2)
            await manager.cancel_and_wait('native-cancel')
            self.assertTrue(closed.is_set())
            self.assertEqual(run.status, 'interrupted')
            self.assertEqual(tool.await_count, 0)
            self.assertEqual(len(calls), 1)

    async def test_partial_native_stream_is_not_replayed(self):
        requests = []
        def respond(request):
            requests.append(request)
            return httpx.Response(200, text=wire([
                {'type': 'response.output_text.delta', 'item_id': 'm', 'delta': 'Partial'}]))
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            with mock.patch.object(agent.network, 'client', new=mock.AsyncMock(return_value=client)):
                run = self.run_for()
                with self.assertRaisesRegex(RuntimeError, 'before response.completed'):
                    await agent._provider_response(run, [], [], 'turn')
                run.finalize_streams()
        self.assertEqual(len(requests), 1)
        self.assertEqual(next(e for e in run.events if e['type'] == 'assistant_text')['content'], 'Partial')

    def test_public_summaries_are_never_replayed_as_raw_thinking(self):
        events = [{'id': 'r', 'type': 'reasoning', 'turnId': 't', 'reasoningWire': 'summary', 'content': 'Public summary'},
                  {'id': 'a', 'type': 'assistant_text', 'turnId': 't', 'content': 'Answer'}]
        self.assertEqual(agent.project_history(events), [{'role': 'assistant', 'content': 'Answer'}])

    async def test_native_title_uses_responses_without_hosted_tools(self):
        request_body = {}
        async def request(method, url, **kwargs):
            request_body.update(kwargs['json'])
            self.assertTrue(url.endswith('/responses'))
            return httpx.Response(200, json={'status': 'completed', 'output': [message('Example Title')]}, request=httpx.Request(method, url))
        with mock.patch.object(agent.network, 'request', new=request):
            title = await agent._provider_title(self.run_for(), 'Question')
        self.assertEqual(title, 'Example Title')
        self.assertNotIn('tools', request_body)


if __name__ == '__main__':
    unittest.main()
