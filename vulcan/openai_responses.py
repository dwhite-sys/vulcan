"""Native Responses wire adapter. Only local function tools are advertised."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Callable
from urllib.parse import urlsplit


def uses_responses(provider: dict) -> bool:
    return urlsplit(str(provider.get('baseUrl') or provider.get('base_url') or '')).hostname == 'api.openai.com'


def provider_key(provider: dict) -> str:
    # Do not put credentials in storage. Keep opaque state scoped to the
    # endpoint, model and account, including when a saved connection is edited.
    value = [str(provider.get('baseUrl') or provider.get('base_url') or '').rstrip('/'),
             provider.get('model'), provider.get('apiKey') or provider.get('api_key') or '',
             provider.get('networkPointOfView'), provider.get('clientId')]
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


_CONTEXT_FIELDS = ('id', 'type', 'turnId', 'content', 'quotes', 'references', 'elements',
                   'contextOrder', 'attachmentNotices', 'attachments', 'tool', 'callId',
                   'rawToolCall', 'rawArguments', 'arguments', 'result')


def _hash_event(digest, event: dict, *, visible: bool = False) -> None:
    if event.get('type') not in ('user_message', 'system_message', 'assistant_text', 'reasoning', 'tool'):
        return
    fields = {key: event[key] for key in _CONTEXT_FIELDS if key in event and not (visible and key == 'result')}
    digest.update(json.dumps(fields, sort_keys=True, default=str, ensure_ascii=False).encode())
    digest.update(b'\n')


def history_digest(events: list[dict], *, visible: bool = False) -> str:
    digest = hashlib.sha256()
    for event in events:
        _hash_event(digest, event, visible=visible)
    return digest.hexdigest()


def history_prefixes(events: list[dict]) -> list[str]:
    # Hash the transcript once, rather than rehashing the entire preceding
    # history for every saved response (quadratic for long conversations).
    digest = hashlib.sha256()
    prefixes = []
    for event in events:
        prefixes.append(digest.hexdigest())
        _hash_event(digest, event)
    return prefixes


def input_items(messages: list[dict]) -> list[dict]:
    items: list[dict] = []
    for message in messages:
        if '_responses_output' in message:
            items.extend(message['_responses_output'])
            continue
        role = message.get('role')
        if role == 'tool':
            items.append({'type': 'function_call_output', 'call_id': message['tool_call_id'],
                          'output': message.get('content') or ''})
            continue
        content = message.get('content')
        if content:
            if isinstance(content, list):
                parts = []
                for part in content:
                    if part.get('type') == 'text':
                        parts.append({'type': 'input_text', 'text': part.get('text', '')})
                    elif part.get('type') == 'image_url':
                        image = part['image_url']
                        parts.append({'type': 'input_image', 'image_url': image['url'],
                                      **({'detail': image['detail']} if image.get('detail') else {})})
                    else:
                        raise ValueError(f"Unsupported OpenAI input content type: {part.get('type')}")
                content = parts
            items.append({'role': role, 'content': content})
        for call in message.get('tool_calls') or []:
            function = call['function']
            items.append({'type': 'function_call', 'call_id': call['id'],
                          'name': function['name'], 'arguments': function.get('arguments') or '{}'})
    return items


def request_body(provider: dict, messages: list[dict], tools: list[dict], *, title: bool = False) -> dict:
    body: dict[str, Any] = {'model': provider['model'], 'input': input_items(messages),
                            'stream': not title, 'store': False}
    if title:
        body['max_output_tokens'] = 512
    else:
        body['include'] = ['reasoning.encrypted_content']
        if re.match(r'^(?:o\d(?:-|$)|gpt-[56](?:[.\-]|$))', provider['model']):
            body['reasoning'] = {'summary': 'auto'}
            effort = provider.get('reasoningEffort')
            if effort and effort != 'default':
                body['reasoning']['effort'] = effort
    if tools and not title:
        body['tools'] = [{'type': 'function', 'name': tool['name'],
                          'description': tool.get('description', ''),
                          'parameters': tool.get('parameters', {'type': 'object', 'properties': {}}),
                          'strict': False} for tool in tools]
        body['tool_choice'] = 'auto'
    # Never accept built-in tool declarations from provider config or schemas.
    return body


def response_text(response: dict) -> str:
    return ''.join(part.get('text', '') for item in response.get('output', [])
                   if item.get('type') == 'message' for part in item.get('content', [])
                   if part.get('type') == 'output_text')


class ResponsesParser:
    """Consume complete SSE data frames, retaining item/part identities."""
    def __init__(self, emit: Callable[[dict], None]):
        self.emit = emit
        self.items: dict[int, dict] = {}
        self.parts: dict[tuple[str, str, int], list[str]] = {}
        self.tool_indices: dict[str, int] = {}
        self.completed = False
        self.response: dict = {}
        self.buffer = ''
        self.frame: list[str] = []

    def feed(self, chunk: str) -> None:
        self.buffer += chunk
        while '\n' in self.buffer:
            line, self.buffer = self.buffer.split('\n', 1)
            line = line.rstrip('\r')
            if not line:
                self._frame()
            elif line.startswith('data:'):
                self.frame.append(line[5:].lstrip(' '))

    def _frame(self) -> None:
        if not self.frame:
            return
        payload = '\n'.join(self.frame)
        self.frame = []
        if payload == '[DONE]':
            return
        try:
            event = json.loads(payload)
        except ValueError as exc:
            raise ValueError('Malformed OpenAI Responses stream event') from exc
        self.process(event)

    def _part(self, kind: str, item_id: str, index: int, text: str, *, final: bool = False):
        key = (kind, item_id, index)
        parts = self.parts.setdefault(key, [])
        if final:
            previous = ''.join(parts)
            if not text.startswith(previous):
                raise ValueError('OpenAI response text changed after streaming')
            text = text[len(previous):]
        if not text:
            return
        parts.append(text)
        self.emit({'type': 'reasoning_delta' if kind == 'summary' else 'text_delta',
                   'delta': text, 'itemKey': f'{kind}:{item_id}:{index}',
                   **({'wire': 'summary'} if kind == 'summary' else {})})

    def _item(self, index: int, item: dict, *, final: bool = False):
        self.items[index] = item
        item_id = item.get('id') or str(index)
        kind = item.get('type')
        if kind == 'function_call':
            if item_id not in self.tool_indices:
                tool_index = len(self.tool_indices)
                self.tool_indices[item_id] = tool_index
                self.emit({'type': 'tool_call_delta', 'index': tool_index,
                           'id': item.get('call_id'), 'nameDelta': item.get('name') or ''})
        elif final and kind == 'reasoning':
            for part_index, part in enumerate(item.get('summary') or []):
                self._part('summary', item_id, part_index, part.get('text', ''), final=True)
        elif final and kind == 'message':
            for part_index, part in enumerate(item.get('content') or []):
                text = part.get('text', '') if part.get('type') == 'output_text' else part.get('refusal', '')
                self._part('text', item_id, part_index, text, final=True)

    def process(self, event: dict):
        kind = event.get('type')
        item_id = str(event.get('item_id') or '')
        if kind in ('response.output_item.added', 'response.output_item.done'):
            self._item(int(event['output_index']), event['item'], final=kind.endswith('.done'))
        elif kind in ('response.output_text.delta', 'response.refusal.delta'):
            self._part('text', item_id, int(event.get('content_index', 0)), event.get('delta', ''))
        elif kind == 'response.reasoning_summary_text.delta':
            self._part('summary', item_id, int(event.get('summary_index', 0)), event.get('delta', ''))
        elif kind == 'response.function_call_arguments.delta':
            index = self.tool_indices.get(item_id)
            if index is None:
                raise ValueError('OpenAI tool arguments arrived before their call')
            self.emit({'type': 'tool_call_delta', 'index': index, 'argumentsDelta': event.get('delta', '')})
        elif kind == 'response.completed':
            self.response = event.get('response') or {}
            if self.response.get('status') not in (None, 'completed'):
                raise RuntimeError('OpenAI response did not complete successfully')
            for index, item in enumerate(self.response.get('output') or []):
                self._item(index, item, final=True)
            self.completed = True
        elif kind in ('response.failed', 'response.incomplete', 'error'):
            response = event.get('response') or event
            detail = response.get('error') or response.get('incomplete_details') or {}
            message = detail.get('message') or detail.get('reason') or event.get('message') or 'provider failure'
            raise RuntimeError(f'OpenAI response {kind.rsplit(".", 1)[-1]}: {message}')

    def finish(self) -> dict:
        if self.buffer.strip():
            line = self.buffer.rstrip('\r')
            if line.startswith('data:'):
                self.frame.append(line[5:].lstrip(' '))
        self._frame()
        if not self.completed:
            raise RuntimeError('OpenAI stream ended before response.completed; partial output was preserved')
        output = [self.items[index] for index in sorted(self.items)]
        calls = []
        for item in output:
            if item.get('type') != 'function_call':
                continue
            if not item.get('call_id') or not item.get('name') or item.get('status') not in (None, 'completed'):
                raise ValueError('Incomplete OpenAI function call')
            try:
                arguments = json.loads(item.get('arguments') or '{}')
            except ValueError as exc:
                raise ValueError('Invalid OpenAI function arguments; no tools were executed') from exc
            if not isinstance(arguments, dict):
                raise ValueError('OpenAI function arguments must be an object')
            calls.append({'id': item['call_id'], 'type': 'function',
                          'function': {'name': item['name'], 'arguments': item.get('arguments') or '{}'}})
        return {'content': ''.join(''.join(parts) for (kind, _, _), parts in self.parts.items() if kind == 'text'),
                'thinking': ''.join(''.join(parts) for (kind, _, _), parts in self.parts.items() if kind == 'summary'),
                'toolCalls': calls, 'providerTerminal': True, 'finishReason': 'stop',
                'responsesOutput': output}


def unsupported_summary(error: Exception) -> bool:
    match = re.fullmatch(r'LLM error 400: (.*)', str(error), re.DOTALL)
    if not match:
        return False
    try:
        detail = json.loads(match[1]).get('error', {})
    except (ValueError, AttributeError):
        return False
    if not isinstance(detail, dict):
        return False
    message = str(detail.get('message') or '').lower()
    names_summary = detail.get('param') == 'reasoning.summary' or 'reasoning.summary' in message
    return names_summary and any(term in message for term in ('not supported', 'unsupported', 'unknown parameter'))
