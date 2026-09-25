"""Server-owned T2 agent runtime.

The provider-visible prompt, tool descriptions, transcript projection, and
active-turn reasoning deliberately reproduce the established React T2 runner.
Runs belong to the server, never to a WebSocket connection.
"""

from __future__ import annotations

import asyncio
import copy
import base64
import html
import hashlib
import json
import logging
import math
import mimetypes
import re
import time
import threading
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit, urlunsplit
from typing import Any, Awaitable, Callable

from vulcan import chats, config as cfg, docker, terminal as term, workspace, etna_registry, title_classifier, network

logger = logging.getLogger("vulcan.agent")
ASSETS = Path(__file__).parent / "agent_assets"
SKILL_ORDER = ["tool-discovery", "etna-usage", "kit-building", "terminal", "visualization", "preview", "dashboard-authoring"]
TERMINAL_INITIAL_YIELD_SECONDS = 0.35
TERMINAL_OUTPUT_SETTLE_SECONDS = 0.06
MAX_WAIT_SECONDS = 3600

# Exact-call loop protection is intentionally local. The original guard counted an
# identical call for the lifetime of a run, which punished legitimate revisits much
# later in an agent session. Two complete intervening provider/tool turns clear the
# suspicion; only tightly clustered repeats contribute to the streak.
_REPEAT_GUARD_RESET_AFTER_MISSED_TURNS = 2

def _note_local_tool_repeat(
    state: dict[str, tuple[int, int]], signature: str, turn_index: int
) -> int:
    previous = state.get(signature)
    reset_gap = _REPEAT_GUARD_RESET_AFTER_MISSED_TURNS + 1
    if previous is None or turn_index - previous[1] >= reset_gap:
        count = 1
    else:
        count = previous[0] + 1
    state[signature] = (count, turn_index)
    return count

_TOOL_SEARCH_IGNORED = {"tool", "tools", "kit", "kits", "available", "find", "use", "using", "test"}
_TOOL_SEARCH_WORD = re.compile(r"[a-z0-9]+")

_DESIGN_REGISTER_GUIDANCE = (
    "Registered. Open this Design when the actual rendered frontend is ready for precision inspection or refinement."
)
_DESIGN_OPEN_GUIDANCE = (
    "The Design is live. Opening it has made its live-surface control tools discoverable through search_tools. "
    "Use search_tools to find the relevant Design control when you need to inspect, interact with, or visually verify "
    "the actual running frontend; use normal workspace tools for implementation."
)
_DESIGN_SURFACE_SEARCH_CONTEXT = "design live surface frontend rendered application ui precision"


def _tool_search_terms(query: str) -> list[str]:
    return [word for word in _TOOL_SEARCH_WORD.findall(query.lower()) if word not in _TOOL_SEARCH_IGNORED]


def _tool_search_document(kit_name: str, tool: dict[str, Any]) -> tuple[str, dict[str, str]]:
    properties = tool.get("parameters", {}).get("properties", {})
    parameter_names = " ".join(str(key) for key in properties)
    parameter_descriptions = " ".join(str(value.get("description", "")) for value in properties.values())
    fields = {
        "name": str(tool.get("name", "")).replace("_", " ").lower(),
        "description": str(tool.get("description", "")).lower(),
        "kit": str(kit_name).replace("_", " ").lower(),
        "parameter_names": parameter_names.replace("_", " ").lower(),
        "parameter_descriptions": parameter_descriptions.lower(),
    }
    document = " ".join(value for value in fields.values() if value).strip()
    return document, fields


def _tool_lexical_score(terms: list[str], fields: dict[str, str]) -> float:
    """Score every query word independently, keeping only its strongest field match."""
    if not terms:
        return 0.0
    weights = {"name": 1.0, "description": 0.8, "kit": 0.55, "parameter_names": 0.6, "parameter_descriptions": 0.4}
    total = 0.0
    for term in terms:
        total += max((weight for field, weight in weights.items() if term in fields[field]), default=0.0)
    return total / len(terms)


def _tool_semantic_ready() -> bool:
    try:
        from vulcan import recall
        return bool(recall.status().get("semantic_downloaded"))
    except Exception:
        return False


def _tool_semantic_scores(query: str, documents: list[str], index: dict[str, Any]) -> list[float]:
    """Embed only the query; corpus vectors are client-owned and supplied per run."""
    if not documents:
        return []
    import numpy as np
    from vulcan import recall
    if not isinstance(index, dict) or not index.get("complete") or index.get("model") != recall._MODEL_NAME:
        raise ValueError("client semantic tool index is unavailable or incompatible")
    dimensions = int(index.get("dimensions") or 0)
    vectors_by_hash = index.get("vectors")
    if dimensions <= 0 or not isinstance(vectors_by_hash, dict):
        raise ValueError("client semantic tool index is malformed")
    corpus = []
    for document in documents:
        digest = hashlib.sha256(document.encode("utf-8")).hexdigest()
        raw = vectors_by_hash.get(digest)
        if not isinstance(raw, list) or len(raw) != dimensions:
            raise ValueError("client semantic tool index is incomplete")
        vector = np.asarray(raw, dtype=np.float32)
        if not np.isfinite(vector).all():
            raise ValueError("client semantic tool index contains a non-finite vector")
        corpus.append(vector)
    query_vector = recall._normalize(list(recall.embedder().embed([query])))[0]
    return [float(np.dot(vector, query_vector)) for vector in corpus]


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _skill_metadata(directory: Path) -> dict[str, Any]:
    raw = (directory / "SKILL.md").read_text(encoding="utf-8")
    metadata: dict[str, str] = {}
    body = raw.strip()
    if raw.startswith("---"):
        parts = raw.split("---", 2)
        if len(parts) == 3:
            for line in parts[1].strip().splitlines():
                if ":" in line:
                    key, value = line.split(":", 1)
                    metadata[key.strip()] = value.strip()
            body = parts[2].strip()
    return {"name": metadata.get("name", directory.name), "description": metadata.get("description", ""),
            "source": "vulcan", "body": body, "directory": directory}


def _disabled_vulcan_skills(settings: dict[str, Any]) -> set[str]:
    configured = settings.get("disabledVulcanSkills", [])
    if not isinstance(configured, list):
        return set()
    return {name for name in configured if isinstance(name, str)}


def active_skills(settings: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    disabled = _disabled_vulcan_skills(settings)
    for name in SKILL_ORDER:
        if name in disabled:
            continue
        if name == "terminal" and not settings.get("cliWorkspaceEnabled", False):
            continue
        if name == "dashboard-authoring" and not settings.get("panelsEnabled", True):
            continue
        result.append(_skill_metadata(ASSETS / "skills" / name))
    return result


def _discovery_execution(settings: dict[str, Any]) -> str:
    value = settings.get("discoveryExecution", "wrapper")
    return value if value in ("wrapper", "promotion", "search-inspect") else "wrapper"


VIEW_FILE_TEXT_DESCRIPTION = "Read a workspace text file into context. For binary files, use the terminal."
VIEW_FILE_VISION_DESCRIPTION = (
    "Read a workspace file into context. Text files return their content. Images return a whole-image overview "
    "fitted within 512x512; use region.x and region.y to inspect a 512x512 detail window in original-image pixels. "
    "The overview reports the original dimensions so you can choose a closer view. For other binary files, use the terminal."
)


def design_surface_tools(model_vision: bool | str = "unknown") -> list[dict[str, Any]]:
    groups = json.loads((ASSETS / "tool_schemas.json").read_text(encoding="utf-8"))
    return [tool for tool in groups.get("design_surface", [])
            if tool.get("name") != "design_screenshot" or model_vision is True]


def native_tools(settings: dict[str, Any]) -> list[dict[str, Any]]:
    groups = json.loads((ASSETS / "tool_schemas.json").read_text(encoding="utf-8"))
    result = []
    if settings.get("toolMode", "broad") == "search":
        execution = _discovery_execution(settings)
        discovery = [tool for tool in groups["discovery"] if execution == "wrapper" or tool["name"] != "run_tool"]
        for tool in discovery:
            if tool["name"] == "search_tools":
                if execution == "search-inspect":
                    tool["description"] = (
                        "Find available tools by capability when the tool you need is not already visible. Search once "
                        "with concise capability terms, then use inspect_tool on the best returned match to see its exact "
                        "schema and make it callable."
                    )
                    tool["parameters"]["properties"]["query"]["description"] = (
                        "Concise capability terms, such as 'web search' or 'browser automation'"
                    )
                else:
                    tool["description"] = (
                        "Search available tools by capability or keyword when the capability index does not make the "
                        "right choice clear. Use inspect_tool on the selected result before calling it."
                    )
            elif tool["name"] == "inspect_tool":
                if execution == "search-inspect":
                    tool["description"] = (
                        "Load the full schema for a tool returned by search_tools. A successful inspection "
                        "makes that tool directly callable on the next turn."
                    )
                    tool["parameters"]["properties"]["tool"]["description"] = (
                        "Exact tool function name returned by search_tools"
                    )
                elif execution == "promotion":
                    tool["description"] = (
                        "Load an available tool's full schema into the active tool list. Use an exact name from the "
                        "capability index or search_tools; after inspection, call that tool directly on the next turn."
                    )
                else:
                    tool["description"] = (
                        "Get the full schema for an available tool named in the capability index or returned by "
                        "search_tools. Use it when you need exact parameters before executing the tool with run_tool."
                    )
                if execution != "search-inspect":
                    tool["parameters"]["properties"]["tool"]["description"] = (
                        "Exact tool function name from the capability index or search_tools"
                    )
            elif tool["name"] == "run_tool":
                tool["description"] = (
                    "Execute a discovered tool by exact name using an arguments object matching its inspected "
                    "schema. This is the execution path for dynamically discovered tools in the wrapper discovery variant."
                )
        result.extend(discovery)
    result.extend(groups["skills"])
    result.extend(groups["interaction"])
    if settings.get("recallEnabled", True):
        result.extend(groups.get("memory", []))
    if settings.get("libraryEnabled", True) and settings.get("cliWorkspaceEnabled", False):
        result.extend(groups.get("library", []))
    result.extend(groups["render"])
    result.extend(groups.get("design", []))
    if settings.get("cliWorkspaceEnabled", False):
        workspace_tools = groups["workspace"]
        for tool in workspace_tools:
            if tool.get("name") != "view_file":
                continue
            if settings.get("_modelVision") is True:
                tool["description"] = VIEW_FILE_VISION_DESCRIPTION
            else:
                tool["description"] = VIEW_FILE_TEXT_DESCRIPTION
                tool.get("parameters", {}).get("properties", {}).pop("region", None)
        result.extend(workspace_tools)
    if settings.get("panelsEnabled", True):
        result.extend(groups["panels"])
    disabled = _disabled_vulcan_skills(settings)
    if disabled:
        for tool in result:
            description = tool.get("description")
            if not isinstance(description, str):
                continue
            for skill in disabled:
                description = re.sub(
                    rf"\s*The {re.escape(skill)} skill[^.]*\.", "", description, flags=re.IGNORECASE,
                )
            tool["description"] = description.strip()
    return result


def build_prompt(chat: dict[str, Any], settings: dict[str, Any], kits: list[dict[str, Any]], enabled: list[str],
                 disabled_tools: list[str] | set[str] | None = None) -> str:
    skill_context = "\n".join(f"- {skill['name']}: {skill['description']}" for skill in active_skills(settings)) or "- none"
    workdir = "/workspace"
    terminal_guidance = ("." if "terminal" in _disabled_vulcan_skills(settings)
                         else "; the terminal skill covers it if you need to go deeper.")
    prefix = (
        "You are Aitna, a technical collaborator who lives in this workspace. You know it the way you know your own tools — "
        "the container, the filesystem, the processes running in it are yours to work with, not systems you're being given access to. "
        "You think before acting, work incrementally, and talk like a person. When someone says hello, you respond naturally; "
        "you don't inventory your capabilities unless asked.\n\n"
        f"Your workspace is an Ubuntu 24.04 Docker container. Working directory is {workdir} — persistent, git-backed, recoverable. "
        "Python packages through `uv pip install` or `uv add`. Full internet access. Networking uses the host network, "
        f"including host-accessible private VPNs{terminal_guidance}\n\n"
        f"Vulcan skills (read directly with read_skill when relevant):\n{skill_context}\n\n"
        "Etna skills are dynamic. Use list_skills or search_skills to discover standalone and kit-paired Etna skills; "
        "their source identifies them as skills or kits/<kit-stem>.\n\n"
    )
    if settings.get("toolMode", "broad") == "search":
        execution = _discovery_execution(settings)
        if execution == "search-inspect":
            middle = (
                "Etna tools are not listed in advance in this mode. Discover them on demand through capability search."
            )
        else:
            disabled = set(disabled_tools or [])
            index_lines = []
            for kit in kits:
                if kit.get("kit_name") not in enabled:
                    continue
                names = [tool["name"] for tool in kit.get("tools", [])
                         if f"{kit['kit_name']}::{tool['name']}" not in disabled]
                if names:
                    index_lines.append(f"{kit['kit_name']}: {', '.join(names)}")
            index = "\n".join(index_lines) or "none"
            if execution == "promotion":
                policy = (
                    "Etna schemas load on demand. The capability index below names enabled tools but does not make them "
                    "directly callable. Inspecting an indexed tool loads it for direct use on the next turn."
                )
            else:
                policy = (
                    "Etna schemas load on demand. The capability index below names enabled tools but does not make them "
                    "directly callable. Inspect an indexed tool before executing it through run_tool."
                )
            middle = f"{policy}\n\nEnabled Etna capability index (names only; schemas are not loaded):\n{index}"
    else:
        names = ", ".join(kit["kit_name"] for kit in kits if kit.get("kit_name") in enabled)
        middle = ("Enabled Etna kit tools are already present in your tool list. Use them directly like Vulcan's built-in tools."
                  f"\n\nAvailable kits: {names}.")
    return (prefix + middle + "\n\nNarrate at the level of intent. Say what you're doing and why; don't narrate each tool call. "
            "Say what failed and what you're doing about it. Prose over lists.")


_QUOTE_REFERENCE = re.compile(r"\ue000vulcan-(quote|reference|element):([A-Za-z0-9_-]+)\ue001")


def project_quoted_content(
    content: str,
    quotes: list[dict[str, Any]] | None = None,
    references: list[dict[str, Any]] | None = None,
    context_order: list[str] | None = None,
    elements: list[dict[str, Any]] | None = None,
) -> str:
    """Expand bounded quote/file/DOM context descriptors only in provider-visible text."""
    quotes = quotes or []
    references = references or []
    elements = elements or []
    if not quotes and not references and not elements:
        return content
    order = context_order or [*(str(quote.get("id", "")) for quote in quotes),
                              *(str(reference.get("id", "")) for reference in references),
                              *(str(element.get("id", "")) for element in elements)]
    numbers = {identifier: index + 1 for index, identifier in enumerate(order)}
    quote_by_id = {str(quote.get("id", "")): quote for quote in quotes}
    reference_by_id = {str(reference.get("id", "")): reference for reference in references}
    element_by_id = {str(element.get("id", "")): element for element in elements}
    placed: set[str] = set()

    def reference_xml(reference: dict[str, Any], number: int) -> str:
        attributes = [f'id="{number}"', f'path="{html.escape(str(reference.get("path", "")), quote=True)}"']
        start = reference.get("startLine")
        end = reference.get("endLine")
        if isinstance(start, int) and not isinstance(start, bool) and start > 0:
            attributes.append(f'start_line="{start}"')
            if isinstance(end, int) and not isinstance(end, bool) and end >= start:
                attributes.append(f'end_line="{end}"')
        if reference.get("revision"):
            attributes.append(f'revision="{html.escape(str(reference["revision"]), quote=True)}"')
        return "<reference " + " ".join(attributes) + "></reference>"

    def element_xml(element: dict[str, Any], number: int) -> str:
        attributes = [
            f'id="{number}"',
            f'design="{html.escape(str(element.get("designId", "")), quote=True)}"',
            f'locator="{html.escape(str(element.get("locator", "")), quote=True)}"',
            f'hierarchy="{html.escape(str(element.get("hierarchyAddress", "")), quote=True)}"',
            f'tag="{html.escape(str(element.get("tagName", "")), quote=True)}"',
        ]
        if element.get("text"):
            attributes.append(f'text="{html.escape(str(element["text"]), quote=True)}"')
        if element.get("route"):
            attributes.append(f'route="{html.escape(str(element["route"]), quote=True)}"')
        return "<element " + " ".join(attributes) + "></element>"

    def expand(match: re.Match[str]) -> str:
        kind, identifier = match.group(1), match.group(2)
        number = numbers.get(identifier)
        if number is None:
            return ""
        if kind == "quote":
            quote = quote_by_id.get(identifier)
            if quote is None:
                return ""
            placed.add(identifier)
            text = html.escape(str(quote.get("text", "")), quote=False)
            return f'<quote id="{number}">{text}</quote>'
        if kind == "reference":
            reference = reference_by_id.get(identifier)
            if reference is None:
                return ""
            placed.add(identifier)
            return reference_xml(reference, number)
        element = element_by_id.get(identifier)
        if element is None:
            return ""
        placed.add(identifier)
        return element_xml(element, number)

    message = _QUOTE_REFERENCE.sub(expand, content)
    unplaced_quotes = [
        f'  <quote id="{numbers[identifier]}">{html.escape(str(quote_by_id[identifier].get("text", "")), quote=False)}</quote>'
        for identifier in order if identifier in quote_by_id and identifier not in placed
    ]
    unplaced_references = [
        "  " + reference_xml(reference_by_id[identifier], numbers[identifier])
        for identifier in order if identifier in reference_by_id and identifier not in placed
    ]
    unplaced_elements = [
        "  " + element_xml(element_by_id[identifier], numbers[identifier])
        for identifier in order if identifier in element_by_id and identifier not in placed
    ]
    groups = []
    if unplaced_quotes:
        groups.append("<quotes>\n" + "\n".join(unplaced_quotes) + "\n</quotes>")
    if unplaced_references:
        groups.append("<references>\n" + "\n".join(unplaced_references) + "\n</references>")
    if unplaced_elements:
        groups.append("<elements>\n" + "\n".join(unplaced_elements) + "\n</elements>")
    context = "\n\n".join(groups)
    return context + ("\n\n" + message if context and message else message if not context else "")

def _user_content(event: dict[str, Any], content: str | None = None) -> Any:
    text = event.get("content", "") if content is None else content
    images = [attachment for attachment in event.get("attachments", []) if attachment.get("dataUrl")]
    if not images:
        return text
    parts = [{"type": "text", "text": text}] if text else []
    parts.extend({"type": "image_url", "image_url": {"url": image["dataUrl"]}} for image in images)
    return parts


def project_history(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Match the React projector: completed historical reasoning never returns."""
    output: list[dict[str, Any]] = []
    index = 0
    while index < len(events):
        event = events[index]
        if event.get("type") == "user_message":
            full = project_quoted_content(event.get("content", ""), event.get("quotes"), event.get("references"), event.get("contextOrder"), event.get("elements"))
            if event.get("attachmentNotices"):
                full = (full + "\n\n" + event["attachmentNotices"]).strip()
            output.append({"role": "user", "content": _user_content(event, full)})
            index += 1
            continue
        if event.get("type") == "system_message":
            output.append({"role": "system", "content": event.get("content", "")})
            index += 1
            continue
        turn_id = event.get("turnId")
        if not turn_id:
            index += 1
            continue
        group: list[dict[str, Any]] = []
        while index < len(events) and events[index].get("turnId") == turn_id:
            group.append(events[index])
            index += 1
        text = "".join(item.get("content", "") for item in group if item.get("type") == "assistant_text")
        tools = [item for item in group if item.get("type") == "tool"]
        if text or tools:
            assistant: dict[str, Any] = {"role": "assistant", "content": text or None}
            if tools:
                assistant["tool_calls"] = [item.get("rawToolCall") or {
                    "id": item.get("callId"), "type": "function",
                    "function": {"name": item.get("tool"), "arguments": item.get("rawArguments") or json.dumps(item.get("arguments", {}), separators=(",", ":"))},
                } for item in tools]
            output.append(assistant)
            for item in tools:
                result = item.get("result")
                if not result:
                    continue
                payload = {"error": result["error"]} if result.get("error") else result.get("result", result)
                output.append({"role": "tool", "tool_call_id": item.get("callId"), "name": item.get("tool"),
                               "content": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))})
    return output


class ProviderStreamParser:
    """Incremental OpenAI-compatible parser with split-tag-safe reasoning."""

    def __init__(self, emit: Callable[[dict[str, Any]], None]):
        self.emit = emit
        self.thinking = ""
        self.content = ""
        self.tool_calls: dict[int, dict[str, Any]] = {}
        self.reasoning_wire: str | None = None
        self.reasoning_details: list[Any] = []
        self.inline_buffer = ""
        self.in_think = False

    @staticmethod
    def _partial_suffix(text: str, tags: list[str]) -> int:
        for length in range(min(len(text), max(len(tag) - 1 for tag in tags)), 0, -1):
            if any(tag.startswith(text[-length:]) for tag in tags):
                return length
        return 0

    def _reason(self, text: str, wire: str | None = None, details: list[Any] | None = None):
        if text:
            self.thinking += text
            event: dict[str, Any] = {"type": "reasoning_delta", "delta": text}
            if wire:
                event["wire"] = wire
            if details is not None:
                event["details"] = details
            self.emit(event)

    def _text(self, text: str):
        if text:
            self.content += text
            self.emit({"type": "text_delta", "delta": text})

    def _drain(self, final: bool = False):
        while self.inline_buffer:
            if self.in_think:
                close = self.inline_buffer.find("</think>")
                if close >= 0:
                    self._reason(self.inline_buffer[:close], "inline")
                    self.inline_buffer = self.inline_buffer[close + 8:]
                    self.in_think = False
                    continue
                keep = 0 if final else self._partial_suffix(self.inline_buffer, ["</think>"])
                if len(self.inline_buffer) > keep:
                    stop = len(self.inline_buffer) - keep
                    self._reason(self.inline_buffer[:stop], "inline")
                    self.inline_buffer = self.inline_buffer[stop:]
                return
            opening = self.inline_buffer.find("<think>")
            closing = self.inline_buffer.find("</think>")
            if closing >= 0 and (opening < 0 or closing < opening):
                self.reasoning_wire = self.reasoning_wire or "inline"
                self._reason(self.inline_buffer[:closing], "inline")
                self.inline_buffer = self.inline_buffer[closing + 8:]
                continue
            if opening >= 0:
                self._text(self.inline_buffer[:opening])
                self.reasoning_wire = self.reasoning_wire or "inline"
                self.inline_buffer = self.inline_buffer[opening + 7:]
                self.in_think = True
                continue
            keep = 0 if final else self._partial_suffix(self.inline_buffer, ["<think>", "</think>"])
            if len(self.inline_buffer) > keep:
                stop = len(self.inline_buffer) - keep
                self._text(self.inline_buffer[:stop])
                self.inline_buffer = self.inline_buffer[stop:]
            return

    def process_delta(self, delta: dict[str, Any] | None):
        if not delta:
            return
        details = delta.get("reasoning_details")
        dedicated = ""
        wire = None
        if details is not None:
            wire = "reasoning_details"
            self.reasoning_details.extend(details)
            dedicated = "".join(str(item.get("text") or item.get("summary") or "") for item in details)
        else:
            for key in ("reasoning", "reasoning_content", "thinking"):
                if key in delta:
                    wire = key
                    dedicated = delta.get(key) or ""
                    break
        if wire:
            self.reasoning_wire = self.reasoning_wire or wire
        if dedicated:
            self._reason(dedicated, wire, details)
        if isinstance(delta.get("content"), str) and delta["content"]:
            self.inline_buffer += delta["content"]
            self._drain()
        for fragment in delta.get("tool_calls") or []:
            index = int(fragment.get("index", 0))
            call = self.tool_calls.setdefault(index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
            if fragment.get("id"):
                call["id"] = fragment["id"]
            function = fragment.get("function") or {}
            call["function"]["name"] += function.get("name") or ""
            call["function"]["arguments"] += function.get("arguments") or ""
            self.emit({"type": "tool_call_delta", "index": index, "id": fragment.get("id"),
                       "nameDelta": function.get("name"), "argumentsDelta": function.get("arguments")})

    def finish(self) -> dict[str, Any]:
        self._drain(final=True)
        calls = [self.tool_calls[index] for index in sorted(self.tool_calls)]
        for index, call in enumerate(calls):
            if not call["id"]:
                call["id"] = f"call_{uuid.uuid4().hex}_{index}"
        return {"content": self.content, "thinking": self.thinking, "toolCalls": calls,
                "reasoningWire": self.reasoning_wire, "reasoningDetails": self.reasoning_details}


@dataclass
class AgentRun:
    chat: dict[str, Any]
    options: dict[str, Any]
    manager: "RunManager"
    run_id: str
    task: asyncio.Task | None = None
    title_task: asyncio.Task | None = None
    status: str = "running"
    terminal_focus: int | None = None
    terminal_slots: list[int] = field(default_factory=list)
    question_future: asyncio.Future | None = None
    question_batch: dict[str, Any] | None = None
    sequence: int = 0
    active_semantic_id: str | None = None
    active_semantic_type: str | None = None
    streamed_tool_ids: dict[int, str] = field(default_factory=dict)
    last_broadcast: float = 0
    dirty: bool = False
    persistence_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    initial_persist_task: asyncio.Task | None = None
    workspace_warm_task: asyncio.Task | None = None
    terminal_resume_task: asyncio.Task | None = None
    checkpoint_task: asyncio.Task | None = None
    checkpoint_requested: bool = False
    generation_complete: bool = False

    @property
    def events(self) -> list[dict[str, Any]]:
        return self.chat.setdefault("events", [])

    def event_id(self, kind: str) -> str:
        self.sequence += 1
        return f"{self.run_id}:{kind}:{self.sequence}"

    def _publish(self):
        # Full snapshots are authoritative resync/checkpoint frames. They are
        # deliberately *not* the token-stream transport: on a long chat, sending
        # the whole transcript for every token can consume hundreds of Mbit/s and
        # starve unrelated General-WS RPC responses behind the secure send lock.
        self.manager.publish(self.chat["id"], "push/run-events", {
            "chat_id": self.chat["id"], "run_id": self.run_id,
            "events": self.events, "status": self.status, "updatedAt": self.chat.get("updatedAt"),
        })

    def _publish_stream_event(self, event: dict[str, Any]):
        # Streaming updates carry only the event currently changing. The client
        # already has the rest of the transcript from runs/start/subscribe, and a
        # later checkpoint snapshot remains the recovery authority.
        self.manager.publish(self.chat["id"], "push/run-event", {
            "chat_id": self.chat["id"], "run_id": self.run_id,
            "event": event, "status": self.status, "updatedAt": self.chat.get("updatedAt"),
        })

    async def checkpoint(self, *, publish_full: bool = False):
        self.chat["updatedAt"] = now()
        # Snapshot before leaving the event loop: persistence must never serialize
        # a dict that is concurrently being mutated by provider streaming.
        snapshot = copy.deepcopy(self.chat)
        # All writes for one run are ordered. start_async may have an initial
        # background save in flight; later checkpoints naturally queue behind it
        # instead of allowing the old snapshot to overwrite newer state.
        async with self.persistence_lock:
            await asyncio.to_thread(chats.save_chat, snapshot)
        self.dirty = False
        if publish_full:
            self._publish()

    def schedule_checkpoint(self) -> None:
        """Coalesce durable saves without stalling the active tool/provider loop."""
        self.checkpoint_requested = True
        if self.checkpoint_task is not None and not self.checkpoint_task.done():
            return

        async def drain() -> None:
            try:
                while self.checkpoint_requested:
                    self.checkpoint_requested = False
                    await self.checkpoint()
            except Exception:
                logger.exception("Background checkpoint failed for %s", self.chat.get("id"))

        self.checkpoint_task = asyncio.create_task(
            drain(), name=f"vulcan-checkpoint:{self.chat.get('id', 'unknown')}"
        )

    async def flush_checkpoint(self) -> None:
        task = self.checkpoint_task
        if task is not None and not task.done():
            await asyncio.shield(task)

    def stream_event(self, event: dict[str, Any], turn_id: str):
        kind = event.get("type")
        if kind in ("reasoning_delta", "text_delta"):
            semantic = "reasoning" if kind == "reasoning_delta" else "assistant_text"
            if self.active_semantic_type != semantic:
                self.seal_semantic()
                item = {"id": self.event_id(semantic), "type": semantic, "content": "", "status": "streaming",
                        "timestamp": now(), "runId": self.run_id, "turnId": turn_id}
                if semantic == "reasoning" and event.get("wire"):
                    item["reasoningWire"] = event["wire"]
                self.events.append(item)
                self.active_semantic_id = item["id"]
                self.active_semantic_type = semantic
            item = next(value for value in reversed(self.events) if value["id"] == self.active_semantic_id)
            item["content"] += event.get("delta", "")
            if event.get("details"):
                item.setdefault("reasoningDetails", []).extend(event["details"])
        elif kind == "tool_call_delta":
            self.seal_semantic()
            index = int(event.get("index", 0))
            existing_id = self.streamed_tool_ids.get(index)
            if not existing_id:
                existing_id = self.event_id(f"tool:{index}")
                self.streamed_tool_ids[index] = existing_id
                self.events.append({"id": existing_id, "type": "tool", "callId": event.get("id") or "",
                                    "tool": "", "arguments": {}, "rawArguments": "", "status": "running",
                                    "timestamp": now(), "runId": self.run_id, "turnId": turn_id})
            item = next(value for value in self.events if value["id"] == existing_id)
            if event.get("id"):
                item["callId"] = event["id"]
            item["tool"] += event.get("nameDelta") or ""
            item["rawArguments"] += event.get("argumentsDelta") or ""
        self.dirty = True
        instant = time.monotonic()
        if instant - self.last_broadcast >= 0.04:
            self.last_broadcast = instant
            # Do not retransmit the full transcript for every streamed delta.
            # A single-event snapshot is enough to render the live token/tool
            # state and is coalesced by event id if the socket falls behind.
            self._publish_stream_event(item)

    def seal_semantic(self, status: str = "complete"):
        if self.active_semantic_id:
            item = next((value for value in self.events if value["id"] == self.active_semantic_id), None)
            if item:
                item["status"] = status
                if item["type"] == "reasoning":
                    item["completedAt"] = now()
                # Ensure the renderer sees the terminal status even when the last
                # token arrived inside the 40ms stream throttle window.
                self._publish_stream_event(item)
        self.active_semantic_id = None
        self.active_semantic_type = None


class RunManager:
    def __init__(self):
        self.runs: dict[str, AgentRun] = {}
        self.subscribers: dict[str, set[Any]] = defaultdict(set)

    def subscribe(self, chat_id: str, session: Any):
        self.subscribers[chat_id].add(session)

    def unsubscribe(self, session: Any):
        for sessions in self.subscribers.values():
            sessions.discard(session)

    def publish(self, chat_id: str, event_type: str, payload: dict[str, Any]):
        message = {"type": event_type, "payload": payload}
        for session in list(self.subscribers.get(chat_id, set())):
            if hasattr(session, "queue_latest"):
                if event_type == "push/run-events":
                    session.queue_latest(f"run-events:{chat_id}", message)
                    continue
                if event_type == "push/run-event":
                    event = payload.get("event") if isinstance(payload, dict) else None
                    event_id = str(event.get("id") or "") if isinstance(event, dict) else ""
                    if event_id:
                        session.queue_latest(f"run-event:{chat_id}:{event_id}", message)
                        continue
            asyncio.create_task(session.send(message))

    def _prepare_start(self, chat: dict[str, Any], options: dict[str, Any]) -> AgentRun:
        chat_id = chat["id"]
        existing = self.runs.get(chat_id)
        if existing and existing.task and not existing.task.done():
            raise ValueError("An agent run is already active for this chat")
        if not chat.get("events") or chat["events"][-1].get("type") != "user_message":
            raise ValueError("A run must end in its triggering user message")
        event = chat["events"][-1]
        run_id = event.get("runId") or f"{chat_id}:{event['id']}"
        if not chat.get("title"):
            chat["title"] = "New Chat"
        chat.setdefault("schemaVersion", 2)
        chat.setdefault("createdAt", now())
        chat["updatedAt"] = now()
        run = AgentRun(chat=chat, options=options, manager=self, run_id=run_id)
        # Reserve the chat immediately.  start_async persists in a worker thread,
        # and another request arriving during that await must not create a second
        # run for the same transcript.
        self.runs[chat_id] = run
        return run

    def _launch(self, run: AgentRun, session: Any | None = None) -> AgentRun:
        chat_id = run.chat["id"]
        if session:
            self.subscribe(chat_id, session)
        run.task = asyncio.create_task(self._run(run), name=f"vulcan-agent:{chat_id}")
        return run

    def start(self, chat: dict[str, Any], options: dict[str, Any], session: Any | None = None) -> AgentRun:
        """Synchronous/test-compatible run start.

        Production General-WS traffic uses :meth:`start_async` so rewriting a
        large SQLite transcript never blocks the asyncio networking loop.
        """
        run = self._prepare_start(chat, options)
        try:
            chats.save_chat(chat)
        except Exception:
            if self.runs.get(chat["id"]) is run:
                self.runs.pop(chat["id"], None)
            raise
        return self._launch(run, session)

    async def start_async(self, chat: dict[str, Any], options: dict[str, Any], session: Any | None = None) -> AgentRun:
        # The renderer is released as soon as the provider explicitly ends the
        # final completion. If a user submits the next turn while the previous
        # run is only finishing persistence/title cleanup, accept that send and
        # wait for the old task rather than rejecting it as "already active".
        existing = self.runs.get(chat["id"])
        if existing and existing.task and not existing.task.done() and existing.generation_complete:
            try:
                await asyncio.shield(existing.task)
            except Exception:
                pass
        run = self._prepare_start(chat, options)
        # Provider dispatch must not wait for a potentially multi-megabyte
        # SQLite/FTS rewrite. Persist an immutable snapshot in the background;
        # AgentRun.checkpoint uses the same lock so durability remains ordered.
        snapshot = copy.deepcopy(chat)

        async def persist_initial() -> None:
            try:
                async with run.persistence_lock:
                    await asyncio.to_thread(chats.save_chat, snapshot)
            except Exception:
                logger.exception("Initial background persistence failed for %s", chat["id"])

        run.initial_persist_task = asyncio.create_task(
            persist_initial(), name=f"vulcan-persist-initial:{chat['id']}"
        )
        return self._launch(run, session)

    async def _generate_deterministic_title(self, run: AgentRun) -> None:
        if not run.options.get("autoGenerateTitle"):
            return
        user_messages = [item for item in run.events if item.get("type") == "user_message"]
        if len(user_messages) != 1 or run.chat.get("title") != "New Chat":
            return
        assistant_parts = [
            str(item.get("content", "")).strip()
            for item in run.events
            if item.get("type") == "assistant_text" and str(item.get("content", "")).strip()
        ]
        if not assistant_parts:
            return
        title = title_classifier.generate_chat_title(
            str(user_messages[0].get("content", "")),
            "\n".join(assistant_parts),
        )
        if not title or title == "New Chat":
            return
        # A manual rename during the first run always wins. Re-check persisted state
        # immediately before committing the deterministic title.
        persisted = await asyncio.to_thread(chats.load_chat, run.chat["id"])
        if persisted is None or persisted.get("title") != "New Chat" or run.chat.get("title") != "New Chat":
            return
        run.chat["title"] = title
        run.chat["updatedAt"] = now()
        await asyncio.to_thread(chats.save_chat, run.chat)
        self.publish(run.chat["id"], "push/chat-updated", {
            "chat_id": run.chat["id"], "title": title, "updatedAt": run.chat["updatedAt"],
        })

    def cancel(self, chat_id: str) -> bool:
        run = self.runs.get(chat_id)
        if not run or not run.task or run.task.done():
            return False
        run.task.cancel()
        return True

    def answer(self, chat_id: str, batch_id: str, answers: dict[str, Any]):
        run = self.runs.get(chat_id)
        if not run or not run.question_future or run.question_future.done():
            raise ValueError("No question is awaiting an answer")
        if not run.question_batch or run.question_batch.get("id") != batch_id:
            raise ValueError("Question batch does not match the active run")
        run.question_future.set_result(answers)

    async def _run(self, run: AgentRun):
        self.publish(run.chat["id"], "push/run-status", {"chat_id": run.chat["id"], "status": "running", "run_id": run.run_id})
        try:
            await execute_run(run)
            run.status = "complete"
            if run.initial_persist_task is not None:
                try:
                    await run.initial_persist_task
                except Exception:
                    pass
            await self._generate_deterministic_title(run)
        except asyncio.CancelledError:
            run.status = "interrupted"
        except Exception as exc:
            logger.exception("Agent run failed for %s", run.chat["id"])
            run.status = "error"
            run.events.append({"id": run.event_id("error"), "type": "system_message", "content": f"Error: {exc}",
                               "timestamp": now(), "runId": run.run_id})
        finally:
            run.seal_semantic("interrupted" if run.status != "complete" else "complete")
            for event in run.events:
                if event.get("status") in ("streaming", "running"):
                    event["status"] = "interrupted" if run.status != "complete" else "complete"
            await run.flush_checkpoint()
            await run.checkpoint(publish_full=True)
            self.publish(run.chat["id"], "push/run-status", {"chat_id": run.chat["id"], "status": run.status, "run_id": run.run_id})


MANAGER = RunManager()


_OLLAMA_VISION_CACHE: dict[tuple[str, str, str, str], tuple[float, bool | str]] = {}
_OLLAMA_VISION_CACHE_SECONDS = 600.0


def _likely_ollama_provider(provider: dict[str, Any]) -> bool:
    name = str(provider.get("name") or provider.get("providerName") or "").lower()
    base_url = str(provider.get("baseUrl") or provider.get("base_url") or "")
    try:
        parsed = urlsplit(base_url)
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except Exception:
        host, port = "", None
    return "ollama" in name or host.endswith("ollama.com") or port == 11434


def _ollama_show_url(base_url: str) -> str:
    parsed = urlsplit(base_url.rstrip("/"))
    path = parsed.path.rstrip("/")
    if path.endswith("/v1"):
        path = path[:-3]
    return urlunsplit((parsed.scheme, parsed.netloc, path + "/api/show", "", ""))


async def resolve_ollama_model_vision(provider: dict[str, Any]) -> bool | str:
    """Resolve aliases/custom Ollama model names through native /api/show.

    models.dev handles canonical IDs first. This fallback runs only for an unknown
    capability on endpoints that are recognizably Ollama, so arbitrary OpenAI
    providers never inherit probe latency. Ollama /api/show reports capabilities
    for the actual local model behind aliases created with `ollama cp`.
    """
    if not _likely_ollama_provider(provider):
        return "unknown"
    base_url = str(provider.get("baseUrl") or provider.get("base_url") or "").strip()
    model = str(provider.get("model") or "").strip()
    if not base_url or not model:
        return "unknown"
    pov = "server" if provider.get("networkPointOfView") == "server" else "client"
    client_id = str(provider.get("clientId") or "")
    key = (pov, base_url.rstrip("/"), model, client_id)
    cached = _OLLAMA_VISION_CACHE.get(key)
    now_monotonic = time.monotonic()
    if cached and now_monotonic - cached[0] < _OLLAMA_VISION_CACHE_SECONDS:
        return cached[1]

    result: bool | str = "unknown"
    try:
        url = _ollama_show_url(base_url)
        headers = {"Content-Type": "application/json"}
        api_key = provider.get("apiKey") or provider.get("api_key")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        if pov == "client":
            if not client_id:
                return "unknown"
            response = await etna_registry.relay_http(
                client_id, url, "POST", headers=headers, body={"model": model}, timeout=5.0,
            )
            if int(response.get("status", 0)) < 400:
                payload = json.loads(str(response.get("text") or "{}"))
            else:
                payload = {}
        else:
            response = await network.request(
                "POST", url, headers=headers, json={"model": model}, timeout=5.0,
                retries=1, retry_non_idempotent_connect=True,
            )
            payload = response.json() if response.status_code < 400 else {}
        capabilities = payload.get("capabilities") if isinstance(payload, dict) else None
        if isinstance(capabilities, list):
            normalized = {str(item).strip().lower() for item in capabilities}
            result = "vision" in normalized
    except Exception as exc:
        logger.debug("Ollama /api/show capability probe failed for %s: %s", model, exc)
    _OLLAMA_VISION_CACHE[key] = (now_monotonic, result)
    return result


async def _http_json(url: str, method: str = "GET", payload: dict[str, Any] | None = None) -> Any:
    response = await network.request(method, url, json=payload, timeout=60.0, retries=1)
    response.raise_for_status()
    return response.json()


async def _provider_title(run: AgentRun, user_message: str) -> str:
    provider = run.options.get("provider") or cfg.load().get("inference", {})
    base_url = provider.get("baseUrl") or provider.get("base_url") or ""
    model = provider.get("model") or ""
    if not base_url or not model:
        return ""
    headers = {"Content-Type": "application/json"}
    api_key = provider.get("apiKey") or provider.get("api_key")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    messages = [
        {"role": "system", "content": "Write a concise chat title in 2 to 5 words. Return only the title. No reasoning, quotes, punctuation, explanations, or extra text."},
        {"role": "user", "content": user_message[:500]},
    ]
    body = {
        "model": model,
        "messages": messages,
        "stream": False,
        "max_tokens": 64,
        # OpenAI-compatible backends use reasoning_effort="none". Provider-
        # specific reasoning.enabled/include_reasoning controls can be ignored,
        # leaving thinking models to spend the whole budget before visible text.
        "reasoning_effort": "none",
    }
    endpoint = base_url.rstrip("/") + "/chat/completions"
    compatible_body = dict(body)
    compatible_body.pop("reasoning_effort", None)
    compatible_body["max_tokens"] = 256
    attempts: list[tuple[dict[str, Any], str]] = [(body, "reasoning-disabled"), (compatible_body, "provider-neutral")]
    failures: list[str] = []
    for request, protocol in attempts:
        try:
            if provider.get("networkPointOfView") == "client":
                client_id = provider.get("clientId")
                if not client_id:
                    raise RuntimeError("Client provider has no connected Vulcan client")
                result = await etna_registry.relay_http(
                    str(client_id), endpoint, "POST", headers=headers, body=request, timeout=30,
                )
                status = int(result.get("status", 0))
                text = str(result.get("text") or "")
                if status >= 400:
                    raise RuntimeError(f"LLM error {status}: {text}")
                data = json.loads(text or "{}")
            else:
                response = await network.request(
                    "POST", endpoint, json=request, headers=headers, timeout=30.0,
                    retries=1, retry_non_idempotent_connect=True,
                )
                response.raise_for_status()
                data = response.json()
            choice = (data.get("choices") or [{}])[0]
            message = choice.get("message") or {}
            finish_reason = choice.get("finish_reason")
            raw = message.get("content")
            if isinstance(raw, list):
                raw = "".join(str(part.get("text", "")) for part in raw if isinstance(part, dict))
            title = str(raw or "").strip()
            if "</think>" in title:
                title = title.rsplit("</think>", 1)[-1].strip()
            cleaned = title.strip("\"'“”‘’ \t\r\n")
            if cleaned:
                return cleaned.splitlines()[0][:60]
            reasoning = message.get("reasoning") or message.get("reasoning_content") or message.get("thinking")
            failures.append(f"{protocol}: empty content (finish_reason={finish_reason!r}, thinking={bool(reasoning)})")
        except Exception as exc:
            failures.append(f"{protocol}: {type(exc).__name__}: {exc}")
    raise ValueError("Chat title generation returned no usable answer: " + "; ".join(failures))


async def _provider_response(run: AgentRun, messages: list[dict[str, Any]], tools: list[dict[str, Any]], turn_id: str) -> dict[str, Any]:
    import httpx
    provider = run.options.get("provider") or cfg.load().get("inference", {})
    base_url = provider.get("baseUrl") or provider.get("base_url") or ""
    model = provider.get("model") or ""
    if not base_url or not model:
        raise ValueError("LLM not configured. Go to Settings → Providers to add an endpoint and API key.")
    body: dict[str, Any] = {"model": model, "messages": messages, "stream": True,
                            "reasoning": {"enabled": True}, "include_reasoning": True}
    if tools:
        body["tools"] = [{"type": "function", "function": {"name": tool["name"], "description": tool.get("description", ""),
                                                           "parameters": tool.get("parameters", {})}} for tool in tools]
        body["tool_choice"] = "auto"
    headers = {"Content-Type": "application/json"}
    api_key = provider.get("apiKey") or provider.get("api_key")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    parser = ProviderStreamParser(lambda event: run.stream_event(event, turn_id))
    endpoint = base_url.rstrip("/") + "/chat/completions"
    provider_terminal = False
    finish_reason: str | None = None

    def process_line(line: str) -> bool:
        """Process one SSE line and report whether the provider has terminated.

        OpenAI-compatible servers are allowed to send the terminal `[DONE]` event
        before the HTTP connection itself closes. Some cloud/provider proxies keep
        that socket alive substantially longer, so treating EOF as the only end of
        generation can leave the run (and composer) stuck even though the model has
        already finished. A non-null finish_reason is terminal too and lets us stop
        one event earlier when providers omit/delay `[DONE]`.
        """
        nonlocal finish_reason
        if not line.startswith("data:"):
            return False
        data = line[5:].strip()
        if not data:
            return False
        if data == "[DONE]":
            return True
        try:
            parsed = json.loads(data)
            choice = (parsed.get("choices") or [{}])[0]
            parser.process_delta(choice.get("delta"))
            reason = choice.get("finish_reason")
            if choice.get("finish_reason") is not None:
                finish_reason = str(reason)
                return True
            return False
        except (json.JSONDecodeError, IndexError, TypeError):
            return False

    if provider.get("networkPointOfView") == "client":
        client_id = provider.get("clientId")
        if not client_id:
            raise RuntimeError("Client provider has no connected Vulcan client")
        pending = ""
        provider_stream = etna_registry.relay_http_stream(
            str(client_id), endpoint, "POST", headers=headers, body=body, timeout=3600,
        )
        terminal = False
        try:
            async for chunk in provider_stream:
                pending += chunk
                while "\n" in pending:
                    line, pending = pending.split("\n", 1)
                    if process_line(line.rstrip("\r")):
                        terminal = True
                        provider_terminal = True
                        break
                if terminal:
                    break
            if not terminal and pending:
                terminal = process_line(pending.rstrip("\r"))
                if terminal:
                    provider_terminal = True
        finally:
            # Explicitly close an early-terminated client relay. relay_http_stream
            # then cancels the browser-side fetch instead of leaving it alive until
            # its hour-long transport timeout.
            await provider_stream.aclose()
    else:
        # Keep one process-wide HTTP pool warm so a server-POV provider pays TCP/TLS
        # setup once, not once per turn. Retry only connect/pool establishment before
        # response streaming starts; never replay a mid-stream generation.
        client = await network.client()
        for attempt in range(2):
            try:
                async with client.stream(
                    "POST", endpoint, json=body, headers=headers,
                    timeout=httpx.Timeout(None, connect=10.0, pool=5.0),
                ) as response:
                    if response.status_code >= 400:
                        content = (await response.aread()).decode("utf-8", errors="replace")
                        raise ValueError(f"LLM error {response.status_code}: {content}")
                    async for line in response.aiter_lines():
                        if process_line(line):
                            provider_terminal = True
                            break
                break
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
                if attempt:
                    raise
                await asyncio.sleep(0.1)
    result = parser.finish()
    result["providerTerminal"] = provider_terminal
    result["finishReason"] = finish_reason
    return result


def _toolset(run: AgentRun) -> list[dict[str, Any]]:
    settings = {**run.options.get("settings", {}), "_modelVision": run.options.get("modelVision", "unknown")}
    result = native_tools(settings)
    if settings.get("toolMode", "broad") != "search":
        enabled = set(run.options.get("enabledKits", []))
        disabled = set(run.options.get("disabledTools", []))
        for kit in run.options.get("kitsWithTools", []):
            if kit.get("kit_name") in enabled:
                result.extend(tool for tool in kit.get("tools", []) if f"{kit['kit_name']}::{tool['name']}" not in disabled)
    return result


async def _reconcile_agent_terminal_focus(run: AgentRun) -> None:
    """Restore durable focus only when that logical terminal still exists."""
    slots = set(run.terminal_slots)

    if run.terminal_focus in slots:
        return

    persisted = await asyncio.to_thread(
        term.get_slot_focus,
        run.chat["id"],
        "agent",
    )

    if persisted in slots:
        run.terminal_focus = persisted
        return

    run.terminal_focus = None

    if persisted is not None:
        await asyncio.to_thread(
            term.clear_slot_focus_if_matches,
            run.chat["id"],
            "agent",
            persisted,
        )


async def _warm_workspace(run: AgentRun) -> None:
    try:
        if not await asyncio.to_thread(docker.container_running, run.chat["id"]):
            await asyncio.to_thread(docker.start_container, run.chat["id"])
        slots = await asyncio.to_thread(term.list_slots, run.chat["id"])
        run.terminal_slots = [
            int(slot["slot"]) for slot in slots
            if slot.get("kind") == "agent"
            and slot.get("logical_open", not slot.get("finished"))
        ]
        await _reconcile_agent_terminal_focus(run)
    except Exception:
        logger.warning("Could not warm workspace for %s", run.chat["id"], exc_info=True)


async def _resume_agent_terminals(run: AgentRun) -> list[dict[str, Any]]:
    """Wake/reconcile logical agent terminals once and share that recovery.

    Idle parking and server restarts are implementation details: the first
    terminal-sensitive tool transparently restores the environment, while
    concurrent callers join the same recovery instead of paying repeated cold
    starts/timeouts. Once restored, the common path is pure in-memory state.
    """
    # Fast path: all known logical slots still have live PTYs. Avoid even a
    # Docker status subprocess on every terminal tool call.
    if run.terminal_slots:
        live = await asyncio.to_thread(
            term.live_slot_states, run.chat["id"], "agent", sorted(set(run.terminal_slots))
        )
        if live is not None:
            return live

    task = run.terminal_resume_task
    if task is None or task.done():
        async def recover() -> list[dict[str, Any]]:
            # If background warmup is already running, let it finish first so we
            # do not race a second Docker start. Recovery itself then restores
            # persisted/lifecycle-parked shells.
            if run.workspace_warm_task is not None and not run.workspace_warm_task.done():
                try:
                    await run.workspace_warm_task
                except Exception:
                    pass
            previous_slots = sorted(set(run.terminal_slots))
            states = await asyncio.to_thread(term.resume_logical_slots, run.chat["id"], "agent")
            if states:
                run.terminal_slots = sorted({int(item["slot"]) for item in states})
                return states
            # Preserve already-known logical identity if metadata was not yet
            # materialized (notably immediately after open_terminal). Real tool
            # interaction will still validate/revive the selected slot.
            return [{"slot": int(slot), "running": False, "pid": None} for slot in previous_slots]
        task = asyncio.create_task(recover(), name=f"vulcan-terminal-resume:{run.chat['id']}")
        run.terminal_resume_task = task
    return await task


async def execute_run(run: AgentRun):
    settings = run.options.get("settings", {})
    enabled = run.options.get("enabledKits", [])
    kits = run.options.get("kitsWithTools", [])
    user_event = run.events[-1]
    user_content = run.options.get("userContent") or user_event.get("content", "")
    if user_event.get("quotes") or user_event.get("references"):
        user_content = project_quoted_content(user_event.get("content", ""), user_event.get("quotes"), user_event.get("references"), user_event.get("contextOrder"), user_event.get("elements"))
        if user_event.get("attachmentNotices"):
            user_content = (user_content + "\n\n" + user_event["attachmentNotices"]).strip()
    disabled_tools = set(run.options.get("disabledTools", []))
    messages = [{"role": "system", "content": build_prompt(run.chat, settings, kits, enabled, disabled_tools)},
                *project_history(run.events[:-1]), {"role": "user", "content": _user_content(user_event, user_content)}]
    tools = _toolset(run)
    promoted_tools: set[str] = set()
    if settings.get("cliWorkspaceEnabled"):
        # Warm Docker/terminal metadata beside the first provider request rather
        # than putting cold container startup on time-to-first-byte. Terminal
        # tools join this task if the model asks for them before it completes.
        run.workspace_warm_task = asyncio.create_task(
            _warm_workspace(run), name=f"vulcan-workspace-warm:{run.chat['id']}"
        )
    repeat_state: dict[str, tuple[int, int]] = {}
    turn = 0
    while True:  # Explicit cancellation and exact-repeat protection replace the old 50-turn ceiling.
        turn_id = f"{run.run_id}:turn:{turn}"
        turn += 1
        run.streamed_tool_ids = {}
        response = await _provider_response(run, messages, tools, turn_id)
        run.seal_semantic()
        calls = response.get("toolCalls", [])
        if response.get("providerTerminal") and not calls:
            # The OpenAI-compatible provider has explicitly ended the final model
            # completion.  Surface that fact immediately; persistence/title/final
            # checkpoint work must not keep the human composer locked.
            run.generation_complete = True
            run.manager.publish(run.chat["id"], "push/generation-complete", {
                "chat_id": run.chat["id"],
                "run_id": run.run_id,
                "finish_reason": response.get("finishReason"),
            })
        for index, call in enumerate(calls):
            event_id = run.streamed_tool_ids.get(index)
            if not event_id:
                event_id = run.event_id(f"tool:{index}")
                run.streamed_tool_ids[index] = event_id
                run.events.append({"id": event_id, "type": "tool", "timestamp": now(), "runId": run.run_id,
                                   "turnId": turn_id, "status": "running", "arguments": {}})
            event = next(item for item in run.events if item["id"] == event_id)
            try:
                arguments = json.loads(call.get("function", {}).get("arguments") or "{}")
            except json.JSONDecodeError:
                arguments = {}
            event.update({"callId": call["id"], "tool": call["function"]["name"], "arguments": arguments,
                          "rawArguments": call["function"].get("arguments", ""), "rawToolCall": call, "status": "running"})
            run._publish_stream_event(event)
        if not calls:
            break
        run.schedule_checkpoint()
        thinking = response.get("thinking")
        content = f"<think>{thinking}</think>{response.get('content') or ''}" if thinking else (response.get("content") or None)
        messages.append({"role": "assistant", "content": content, "tool_calls": calls})
        questions = []
        stop = False
        for index, call in enumerate(calls):
            name = call["function"]["name"]
            if name == "ask_user":
                try:
                    arguments = json.loads(call["function"].get("arguments") or "{}")
                except json.JSONDecodeError:
                    arguments = {}
                questions.append({"toolCallId": call["id"], "question": str(arguments.get("question", "Question")),
                                  "options": [str(value) for value in (arguments.get("options") or [])[:5]]})
                continue
            signature = f"{name}::{call['function'].get('arguments', '')}"
            # `turn` is incremented when the provider turn begins, so `turn - 1` is
            # the stable zero-based index for every tool call in this response.
            repeat_count = _note_local_tool_repeat(repeat_state, signature, turn - 1)
            eligible = name not in ("read_output", "send_input", "wait")
            event = next(item for item in run.events if item["id"] == run.streamed_tool_ids[index])
            if eligible and repeat_count > 2:
                result = {"error": "VULCAN_STATE: This exact tool call has been requested repeatedly. Vulcan suppressed this repetition. Reuse the evidence already available or take a different action unless the underlying state is expected to have changed."}
            else:
                event_count_before_tool = len(run.events)
                try:
                    result = await execute_tool(run, name, event.get("arguments", {}), turn_id, event["id"])
                except Exception as exc:
                    result = {"error": str(exc)}
                for appended_event in run.events[event_count_before_tool:]:
                    run._publish_stream_event(appended_event)
            if (name == "inspect_tool" and _discovery_execution(settings) in ("promotion", "search-inspect")
                    and not result.get("error") and not result.get("result", {}).get("error")):
                inspected_name = str(event.get("arguments", {}).get("tool", ""))
                if inspected_name and inspected_name not in promoted_tools:
                    result_payload = result.get("result", {}) if isinstance(result, dict) else {}
                    inspected = (next((tool for tool in design_surface_tools(run.options.get("modelVision", "unknown"))
                                       if tool.get("name") == inspected_name), None)
                                 if result_payload.get("kit") == "Design" else None)
                    if inspected is None:
                        inspected = next((tool for kit in kits if kit.get("kit_name") in enabled
                                          for tool in kit.get("tools", []) if tool.get("name") == inspected_name
                                          and f"{kit['kit_name']}::{inspected_name}" not in disabled_tools), None)
                    if inspected is not None:
                        tools.append(inspected)
                        promoted_tools.add(inspected_name)
            image_data_url = None
            persisted_result = result
            image_payload = result.get("result") if isinstance(result, dict) else None
            if isinstance(image_payload, dict) and image_payload.get("dataUrl") and image_payload.get("filename"):
                image_data_url = image_payload["dataUrl"]
                clean_image_payload = {key: value for key, value in image_payload.items() if key != "dataUrl"}
                persisted_result = {**result, "result": clean_image_payload}
            event.update({"status": "error" if result.get("error") else "complete", "result": persisted_result})
            run._publish_stream_event(event)
            run.schedule_checkpoint()
            payload = ({"error": persisted_result["error"]} if persisted_result.get("error")
                       else persisted_result.get("result", persisted_result))
            messages.append({"role": "tool", "tool_call_id": call["id"], "name": name,
                             "content": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))})
            if image_data_url and isinstance(payload, dict):
                if payload.get("view") == "detail":
                    region = payload.get("region", {})
                    notice = (f"[System] Detail view of {payload['filename']}: original image "
                              f"{payload.get('original_width')}x{payload.get('original_height')}; window "
                              f"x={region.get('x')}, y={region.get('y')}, "
                              f"{region.get('width')}x{region.get('height')} pixels.")
                else:
                    notice = (f"[System] Whole-image overview of {payload['filename']}: original image "
                              f"{payload.get('original_width')}x{payload.get('original_height')}; rendered "
                              f"{payload.get('rendered_width')}x{payload.get('rendered_height')} pixels.")
                messages.append({"role": "user", "content": [{"type": "text", "text": notice},
                                {"type": "image_url", "image_url": {"url": image_data_url}}]})
            if eligible and repeat_count > 4:
                stuck_event = {"id": run.event_id("stuck"), "type": "assistant_text", "status": "complete", "timestamp": now(),
                    "runId": run.run_id, "turnId": f"{run.run_id}:stuck", "content": f"I got stuck repeatedly trying the same `{name}` call and it wasn't going anywhere, so I'm stopping here instead of continuing to loop. Feel free to try again — a fresh attempt sometimes gets past it."}
                run.events.append(stuck_event)
                run._publish_stream_event(stuck_event)
                stop = True
                break
        if stop:
            break
        if questions:
            batch = {"id": run.event_id("questions"), "chatId": run.chat["id"], "questions": questions}
            run.question_batch = batch
            run.question_future = asyncio.get_running_loop().create_future()
            run.status = "waiting_for_user"
            await run.flush_checkpoint()
            await run.checkpoint()
            run.manager.publish(run.chat["id"], "push/run-question", batch)
            answers = await run.question_future
            run.question_future = None
            run.question_batch = None
            run.status = "running"
            for question in questions:
                answer = answers.get(question["toolCallId"], {"status": "skipped"})
                event = next(item for item in run.events if item.get("callId") == question["toolCallId"])
                event.update({"status": "complete", "result": {"result": answer}})
                run._publish_stream_event(event)
                messages.append({"role": "tool", "tool_call_id": question["toolCallId"], "name": "ask_user",
                                 "content": json.dumps(answer, separators=(",", ":"))})
            await run.flush_checkpoint()
            await run.checkpoint()


async def _wait_result(pid: str, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        command = term.get_command(pid)
        wait = term.get_wait(pid) if not command else None
        process = command or wait
        if process and (process.finished or process.detached):
            output = "".join(command.output).strip() if command else f"Waited {wait.seconds}s."
            return {"output": output, "exit_code": getattr(process, "exit_code", 0), "detached": process.detached,
                    "detach_reason": getattr(process, "detach_reason", "")}
        await asyncio.sleep(0.05)
    raise TimeoutError(f"Terminal result timed out after {timeout}s")


async def _initial_terminal_result(pid: str) -> tuple[Any, bool]:
    """Capture fast commands/prompts without holding an interactive agent turn."""
    deadline = time.monotonic() + TERMINAL_INITIAL_YIELD_SECONDS
    last_count = 0
    last_change = time.monotonic()
    while True:
        command = term.get_command(pid)
        if command is None:
            raise RuntimeError(f"Unknown terminal process: {pid}")
        if command.finished or command.detached:
            return command, True
        count = len(command.output)
        instant = time.monotonic()
        if count != last_count:
            last_count = count
            last_change = instant
        if instant >= deadline or (count and instant - last_change >= TERMINAL_OUTPUT_SETTLE_SECONDS):
            return command, False
        await asyncio.sleep(0.02)


async def _publish_terminal_completion(run: AgentRun, slot: int, pid: str) -> None:
    """Keep client terminal state truthful after a command outlives its tool call."""
    try:
        while True:
            state = await asyncio.to_thread(term.agent_slot_state, run.chat["id"], "agent", slot)
            if state is None:
                return
            if not state["running"]:
                run.manager.publish(run.chat["id"], "push/terminal-idle", {"chat_id": run.chat["id"], "slot": slot})
                return
            if state.get("pid") not in (None, pid):
                return
            await asyncio.sleep(0.05)
    except asyncio.CancelledError:
        return
    except Exception:
        logger.warning("Could not monitor terminal %s in %s", slot, run.chat["id"], exc_info=True)


async def _wait_for_terminal_slot(
    run: AgentRun, slot: int, seconds: float, webhook_url: str | None = None
) -> dict[str, Any]:
    """Wake on the slot command's shell-completion marker, a webhook, or timeout."""
    await asyncio.to_thread(term.ensure_slot_resumed, run.chat["id"], "agent", slot)
    notice = await asyncio.to_thread(term.consume_slot_resume_notice, run.chat["id"], "agent", slot)
    state = await asyncio.to_thread(term.agent_slot_state, run.chat["id"], "agent", slot)
    if state is None:
        return {"error": f"Terminal {slot} is not open."}

    pid = state.get("pid")
    process = term.get_command(pid) if pid else None
    completion_event = getattr(process, "completion_event", None)
    webhook_pid = term.start_wait(run.chat["id"], seconds, webhook_url) if webhook_url else None
    started = time.monotonic()
    deadline = started + seconds

    if state["running"] and completion_event is not None and webhook_pid is None:
        # use_terminal wraps each command with an OSC 777 completion marker.
        # The PTY parser sets this event only after it consumes the matching
        # marker, so a slot-only wait can sleep until the command actually
        # returns instead of polling agent_slot_state every 50 ms.
        await asyncio.to_thread(completion_event.wait, seconds)
        state = await asyncio.to_thread(term.agent_slot_state, run.chat["id"], "agent", slot)
        if state is None:
            return {"error": f"Terminal {slot} closed while waiting."}
    else:
        # Webhook + slot waits still have two independent wake sources. Keep
        # their existing race loop; ordinary slot waits use the event above.
        while state["running"] and time.monotonic() < deadline:
            if webhook_pid:
                webhook_wait = term.get_wait(webhook_pid)
                if webhook_wait and webhook_wait.finished and webhook_wait.wake_reason == "webhook":
                    return {"result": {
                        "ok": True,
                        "wake_reason": "webhook",
                        "webhook_method": webhook_wait.webhook_method,
                        "webhook_path": webhook_wait.webhook_path,
                        "elapsed_seconds": round(time.monotonic() - started, 3),
                    }}
            await asyncio.sleep(min(0.05, max(0, deadline - time.monotonic())))
            state = await asyncio.to_thread(term.agent_slot_state, run.chat["id"], "agent", slot)
            if state is None:
                if webhook_pid:
                    term.detach_wait(webhook_pid, "terminal closed")
                return {"error": f"Terminal {slot} closed while waiting."}

    if webhook_pid:
        term.detach_wait(webhook_pid, "terminal wait condition finished")
    process = term.get_command(pid) if pid else None
    output = "".join(process.output).strip() if process is not None else (
        await asyncio.to_thread(term.read_slot_output, run.chat["id"], "agent", slot, 50)
    ).strip()
    result: dict[str, Any] = {
        "slot": slot,
        "output": output,
        "running": state["running"],
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "wake_reason": "timeout" if state["running"] else "slot",
    }
    if state["running"]:
        result["timed_out"] = True
        if state.get("pid"):
            result["pid"] = state["pid"]
    elif process is not None:
        result["exit_code"] = process.exit_code
    if notice:
        result["notice"] = notice
    return {"result": result}

def _safe_path_fragment(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-")[:48] or "shot"


def _playwright_workspace_path(arguments: dict[str, Any], event_id: str) -> str:
    requested = str(arguments.get("save_path") or "").strip().replace("\\", "/")
    if requested.startswith("/workspace/"):
        requested = requested.removeprefix("/workspace/")
    elif requested and PurePosixPath(requested).is_absolute():
        requested = ""
    if not requested:
        requested = f"screenshots/playwright-{_safe_path_fragment(event_id)}.png"
    parsed = PurePosixPath(requested)
    if parsed.is_absolute() or any(part in ("", ".", "..") for part in parsed.parts):
        raise ValueError(f"Invalid screenshot workspace path: {requested}")
    return str(parsed)


async def _etna_json_for_kit(kit: dict[str, Any], fallback_etna: str, path: str, method: str = "GET", body: Any = None) -> dict[str, Any]:
    source = kit.get("effective_source") if isinstance(kit, dict) else None
    if isinstance(source, dict):
        base = str(source.get("url") or fallback_etna).rstrip("/")
        if source.get("networkPointOfView") == "client":
            client_id = source.get("clientId")
            if not client_id:
                raise RuntimeError("Selected Client Etna is not assigned to a connected Vulcan client")
            result = await etna_registry.relay_json(str(client_id), base, path, method, body)
            return result if isinstance(result, dict) else {"result": result}
        return await _http_json(base + path, method, body)
    raise RuntimeError("Selected Etna tool has no resolved client-owned source")

async def _dispatch_etna_tool(
    run: AgentRun,
    etna: str,
    kit: dict[str, Any],
    tool_name: str,
    arguments: dict[str, Any],
    event_id: str,
) -> dict[str, Any]:
    if kit.get("kit_name") != "Playwright" or tool_name != "browser_screenshot":
        return await _etna_json_for_kit(kit, etna, "/run_tool", "POST", {"tool": tool_name, "arguments": arguments})

    workspace_path = _playwright_workspace_path(arguments, event_id)
    host_arguments = {
        **arguments,
        "save_path": f"/tmp/vulcan-playwright-{_safe_path_fragment(event_id)}.png",
        "return_base64": True,
    }
    response = await _etna_json_for_kit(kit, etna, "/run_tool", "POST", {"tool": tool_name, "arguments": host_arguments})
    payload = response.get("result") if isinstance(response, dict) else None
    if not isinstance(payload, dict) or not isinstance(payload.get("png_base64"), str) or not payload["png_base64"]:
        if isinstance(payload, dict) and payload.get("error"):
            return response
        detail = payload.get("png_base64_error") if isinstance(payload, dict) else None
        return {"error": f"Playwright screenshot returned no PNG bytes{f': {detail}' if detail else ''}"}
    try:
        image = base64.b64decode(payload["png_base64"], validate=True)
    except Exception as exc:
        return {"error": f"Playwright screenshot returned invalid base64: {exc}"}
    await asyncio.to_thread(workspace.write_file_bytes, run.chat["id"], workspace_path, image)
    clean = {key: value for key, value in payload.items()
             if key not in ("png_base64", "png_base64_error", "saved_to")}
    clean.update({
        "saved_to": f"/workspace/{workspace_path}",
        "workspace_path": workspace_path,
        "mime_type": "image/png",
        "bytes": len(image),
    })
    return {"result": clean}


def _design_registry(run: AgentRun) -> list[dict[str, Any]]:
    designs = run.chat.get("designs")
    if not isinstance(designs, list):
        designs = []
        legacy = run.chat.get("design") or run.chat.get("livePane")
        if isinstance(legacy, dict) and legacy.get("url"):
            designs.append({
                "version": 1,
                "id": str(legacy.get("id") or f"design-{uuid.uuid4().hex}"),
                "name": str(legacy.get("name") or legacy.get("title") or "Design"),
                "url": str(legacy.get("url")),
                "attachedAt": legacy.get("attachedAt") or now(),
                "updatedAt": legacy.get("updatedAt") or legacy.get("attachedAt") or now(),
            })
        run.chat["designs"] = designs
    return designs


def _normalize_design_url(raw: Any) -> str | None:
    value = str(raw or "").strip()
    if not value:
        return None
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", value):
        value = "http://" + value
    if not re.match(r"^https?://[^\s]+$", value, re.IGNORECASE):
        return None
    return value


def _commit_design_registry(run: AgentRun) -> None:
    run.chat["updatedAt"] = now()
    chats.save_chat(run.chat)
    run.manager.publish(run.chat["id"], "push/design-registry", {
        "chat_id": run.chat["id"],
        "designs": run.chat.get("designs", []),
        "updatedAt": run.chat["updatedAt"],
    })


async def _design_client_action(run: AgentRun, action: str, payload: dict[str, Any] | None = None, *, timeout: float = 15.0) -> Any:
    client_id = str(run.options.get("clientId") or "")
    if not client_id:
        raise RuntimeError("design_surface_unavailable")
    try:
        return await etna_registry.relay_client_action(
            client_id,
            "design-action-request",
            {"action": action, "chat_id": run.chat["id"], **(payload or {})},
            timeout=timeout,
        )
    except asyncio.TimeoutError as exc:
        # asyncio.TimeoutError stringifies to an empty string, which previously
        # rendered as a mysterious blank red ERROR card in the transcript.
        raise RuntimeError(f"design_{action}_timeout") from exc


async def _design_surface_status(run: AgentRun) -> dict[str, Any]:
    try:
        status = await _design_client_action(run, "status", timeout=3.0)
    except Exception:
        return {}
    return status if isinstance(status, dict) else {}


async def _design_surface_available(run: AgentRun) -> bool:
    """Whether a Design is open in the owning client.

    The renderer publishes this tiny state projection proactively. Tool discovery
    therefore never blocks on a renderer round trip merely to learn that a panel
    is open. Fall back to the legacy action request only for older clients.
    """
    client_id = str(run.options.get("clientId") or "")
    cached = etna_registry.get_client_state(client_id, "design_surface") if client_id else None
    if isinstance(cached, dict) and str(cached.get("chat_id") or "") == str(run.chat.get("id") or ""):
        return bool(cached.get("open") or cached.get("design_id"))
    status = await _design_surface_status(run)
    return bool(status.get("open") or status.get("design_id"))


async def _design_surface_ready(run: AgentRun) -> bool:
    status = await _design_surface_status(run)
    return bool(status.get("ready"))


async def execute_tool(run: AgentRun, name: str, arguments: dict[str, Any], turn_id: str, event_id: str) -> dict[str, Any]:
    settings = run.options.get("settings", {})
    enabled = run.options.get("enabledKits", [])
    disabled = set(run.options.get("disabledTools", []))
    kits = run.options.get("kitsWithTools", [])
    etna = ""  # Etna execution must resolve through each client-owned kit source.
    natives = {tool["name"] for tool in native_tools({"toolMode": "search", "cliWorkspaceEnabled": True, "panelsEnabled": True, "_modelVision": True})}
    natives.update(tool["name"] for tool in design_surface_tools(True))

    if name == "recall":
        if not settings.get("recallEnabled", True):
            return {"error": "Recall is disabled in Vulcan settings."}
        from vulcan import recall
        result = await asyncio.to_thread(
            recall.search,
            str(arguments.get("query", "")),
            mode=str(arguments.get("mode") or "lexical"),
            keyword_seed_groups=arguments.get("keyword_seed_groups"),
            limit=int(arguments.get("limit", 8)),
            current_chat_id=run.chat["id"],
            scope=str(arguments.get("scope") or "previous"),
        )
        return {"result": result}

    if name in ("library_search", "library_attach"):
        if not settings.get("libraryEnabled", True) or not settings.get("cliWorkspaceEnabled", False):
            return {"error": "Library access is disabled in Vulcan settings."}
        from vulcan import library
        if name == "library_search":
            result = await asyncio.to_thread(library.search, str(arguments.get("query", "")), int(arguments.get("limit", 20)))
        else:
            result = await asyncio.to_thread(library.attach, run.chat["id"], str(arguments.get("file_id", "")),
                                             arguments.get("destination"))
        return {"result": result}

    if name == "list_skills":
        builtin = [{key: skill[key] for key in ("name", "description", "source")} for skill in active_skills(settings)]
        dynamic = run.options.get("etnaSkills", [])
        allowed = {skill["name"] for skill in run.options.get("enabledGeneralSkills", [])}
        kit_sources = {kit.get("skill") for kit in kits if kit.get("kit_name") in enabled and kit.get("skill")}
        builtin.extend({key: skill.get(key) for key in ("name", "description", "source")} for skill in dynamic if
                       (skill.get("source") == "skills" and skill.get("name") in allowed)
                       or skill.get("source") in kit_sources)
        return {"result": {"skills": sorted(builtin, key=lambda skill: skill["name"])}}
    if name == "search_skills":
        query = str(arguments.get("query", "")).strip().lower()
        if not query:
            return {"result": {"error": "search_skills requires a query"}}
        available = (await execute_tool(run, "list_skills", {}, turn_id, event_id))["result"]["skills"]
        return {"result": {"results": [skill for skill in available if any(term in (skill["name"] + " " + skill.get("description", "")).lower() for term in query.split())]}}
    if name in ("read_skill", "list_skill_files", "read_skill_file"):
        skill_name = str(arguments.get("skill", "")).strip()
        source = arguments.get("source")
        builtin = next((skill for skill in active_skills(settings) if skill["name"] == skill_name), None)
        if builtin and source in (None, "", "vulcan"):
            root = builtin["directory"]
            if name == "read_skill":
                return {"result": {"name": builtin["name"], "source": "vulcan", "body": builtin["body"],
                    "guidance": "This skill is a procedural reference, not an added capability. Apply the instructions that materially affect the current task. When SKILL.md points to bundled resources, inspect them with list_skill_files/read_skill_file as needed. Once its relevant guidance is in context, do not reload this skill unnecessarily."}}
            if name == "list_skill_files":
                paths = sorted(str(path.relative_to(root)) for path in root.rglob("*") if path.is_file())
                paths = (["SKILL.md"] if "SKILL.md" in paths else []) + [path for path in paths if path != "SKILL.md"]
                return {"result": {"skill": skill_name, "source": "vulcan", "files": paths}}
            relative = Path(str(arguments.get("file", "")))
            target = (root / relative).resolve()
            if not target.is_relative_to(root.resolve()) or not target.is_file():
                return {"result": {"error": f"Could not read '{relative}' from skill '{skill_name}'"}}
            try:
                return {"result": {"skill": skill_name, "file": str(relative), "source": "vulcan", "content": target.read_text(encoding="utf-8")}}
            except UnicodeDecodeError:
                return {"result": {"skill": skill_name, "file": str(relative), "source": "vulcan", "binary": True,
                    "contentType": mimetypes.guess_type(str(target))[0] or "application/octet-stream",
                    "base64": base64.b64encode(target.read_bytes()).decode("ascii")}}
        if source == "vulcan" or (source in (None, "") and skill_name in SKILL_ORDER):
            return {"result": {"error": f"Skill '{skill_name}' is not available in this chat"}}
        route = {"read_skill": "/read_skill", "list_skill_files": "/list_skill_files", "read_skill_file": "/read_skill_file"}[name]
        descriptor = next((skill for skill in run.options.get("etnaSkills", [])
                           if skill.get("name") == skill_name and (source in (None, "") or skill.get("source") == source)), None)
        skill_kit = {"effective_source": descriptor.get("effective_source")} if isinstance(descriptor, dict) else next((value for value in kits if value.get("kit_name") in enabled), {})
        return {"result": await _etna_json_for_kit(skill_kit, etna, route, "POST", arguments)}
    if name == "list_kits":
        return {"result": {"kits": [kit.get("kit_name") for kit in kits if kit.get("kit_name") in enabled]}}
    if name == "inspect_kit":
        if arguments.get("kit") not in enabled:
            return {"result": {"error": f"Kit '{arguments.get('kit')}' not found"}}
        kit_source = next((value for value in kits if value.get("kit_name") == arguments.get("kit")), None)
        if not kit_source:
            return {"result": {"error": f"Kit '{arguments.get('kit')}' not found"}}
        kit = {key: value for key, value in kit_source.items() if key not in ("tools", "sources", "effective_source")}
        if kit.get("skill"):
            descriptor = next((item for item in run.options.get("etnaSkills", [])
                               if item.get("source") == kit["skill"]), None)
            skill_name = descriptor.get("name") if isinstance(descriptor, dict) else None
            kit.update({"has_skill": True, "skill_name": skill_name,
                        "skill_guidance": f"This kit includes the skill '{skill_name}' from source '{kit['skill']}'. Read it with read_skill({{ skill: '{skill_name}', source: '{kit['skill']}' }}) when its instructions are likely to materially affect how you use the kit."
                        if skill_name else f"This kit includes a skill from source '{kit['skill']}'. Use list_skills to resolve its name before reading it."})
        else:
            kit.update({"has_skill": False, "skill": None})
        return {"result": kit}
    if name == "search_tools":
        query = str(arguments.get("query", "")).strip()
        terms = _tool_search_terms(query)
        if not terms:
            return {"result": {"error": "Use one or more specific capability terms, such as 'web search' or 'browser automation'."}}
        candidates = []
        for kit in kits:
            if kit.get("kit_name") not in enabled:
                continue
            for tool in kit.get("tools", []):
                if f"{kit['kit_name']}::{tool['name']}" in disabled:
                    continue
                document, fields = _tool_search_document(kit["kit_name"], tool)
                candidates.append({
                    "kit": kit["kit_name"], "tool": tool["name"], "description": tool.get("description", ""),
                    "document": document, "lexical": _tool_lexical_score(terms, fields),
                })
        semantic_scores = [0.0] * len(candidates)
        semantic_available = False
        semantic_index = run.options.get("toolSemanticIndex") or {}
        if candidates and _tool_semantic_ready() and semantic_index.get("complete"):
            try:
                semantic_scores = await asyncio.to_thread(
                    _tool_semantic_scores, query, [item["document"] for item in candidates], semantic_index,
                )
                semantic_available = True
            except Exception:
                logger.warning("Semantic tool search index was invalid; continuing with lexical ranking", exc_info=True)
        ranked = []
        for item, semantic in zip(candidates, semantic_scores):
            lexical = float(item["lexical"])
            semantic = max(-1.0, min(1.0, float(semantic)))
            combined = lexical * 0.55 + max(0.0, semantic) * 0.45
            # Any lexical overlap remains eligible. A semantic-only result needs a
            # meaningful cosine match so unrelated tools do not fill the result set.
            if lexical <= 0.0 and (not semantic_available or semantic < 0.45):
                continue
            ranked.append((combined, lexical, semantic, item))
        if await _design_surface_available(run):
            for tool in design_surface_tools(run.options.get("modelVision", "unknown")):
                document, fields = _tool_search_document("Design", tool)
                # Capability aliases describe the contextual cluster rather than any one action.
                # They make ordinary frontend/live-surface searches discover Design while
                # action words in each individual schema still decide which control ranks best.
                fields = dict(fields)
                search_context = _DESIGN_SURFACE_SEARCH_CONTEXT + " browser controller interaction dom page"
                fields["kit"] = fields["kit"] + " " + search_context
                document = document + " " + search_context
                lexical = _tool_lexical_score(terms, fields)
                if lexical <= 0.0:
                    continue
                ranked.append((lexical * 0.55, lexical, 0.0, {
                    "kit": "Design", "tool": tool["name"], "description": tool.get("description", ""),
                    "document": document, "lexical": lexical,
                }))
        ranked.sort(key=lambda row: (-row[0], -row[1], -row[2], row[3]["tool"]))
        logger.debug("Hybrid tool search %r: %s", query, [
            {"tool": row[3]["tool"], "lexical": round(row[1], 4), "semantic": round(row[2], 4), "combined": round(row[0], 4)}
            for row in ranked[:10]
        ])
        found = [{"kit": item["kit"], "tool": item["tool"], "description": item["description"]}
                 for _, _, _, item in ranked[:10]]
        result = {"results": found}
        if _discovery_execution(settings) == "search-inspect":
            result["guidance"] = ("Inspect the best matching tool to see its exact schema and make it directly callable."
                                  if found else "No matching tool was found. Refine the capability terms rather than repeating the same search.")
        return {"result": result}
    if name == "inspect_tool":
        requested_tool = str(arguments.get("tool") or "")
        known_design_tool = next((tool for tool in design_surface_tools(True) if tool.get("name") == requested_tool), None)
        if known_design_tool is not None:
            if not await _design_surface_available(run):
                return {"result": {"error": "design_surface_unavailable", "message": "Open a Design before inspecting live-surface tools."}}
            design_tool = next((tool for tool in design_surface_tools(run.options.get("modelVision", "unknown"))
                                if tool.get("name") == requested_tool), None)
            if design_tool is None:
                return {"result": {"error": f"Tool '{requested_tool}' not found. Use search_tools to find the correct name."}}
            if _discovery_execution(settings) in ("promotion", "search-inspect"):
                return {"result": {"kit": "Design", "tool": design_tool["name"], "status": "loaded",
                    "guidance": f"{design_tool['name']} is now directly callable while the current Design surface remains available."}}
            return {"result": {"kit": "Design", **design_tool}}
        for kit in kits:
            if kit.get("kit_name") not in enabled:
                continue
            for tool in kit.get("tools", []):
                if tool["name"] == arguments.get("tool"):
                    if f"{kit['kit_name']}::{tool['name']}" in disabled:
                        return {"result": {"error": f"Tool '{tool['name']}' is disabled"}}
                    if _discovery_execution(settings) in ("promotion", "search-inspect"):
                        return {"result": {"kit": kit["kit_name"], "tool": tool["name"], "status": "loaded",
                            "guidance": f"{tool['name']} is now directly callable."}}
                    return {"result": {"kit": kit["kit_name"], **tool}}
        return {"result": {"error": f"Tool '{arguments.get('tool')}' not found. Use search_tools to find the correct name."}}
    if name == "run_tool":
        if _discovery_execution(settings) != "wrapper":
            return {"error": "run_tool is not available in this discovery variant. Inspect the tool, then call it directly."}
        tool_name = str(arguments.get("name", "")).strip()
        tool_arguments = arguments.get("arguments", {})
        if not tool_name:
            return {"error": "run_tool requires the exact name of a discovered tool"}
        if not isinstance(tool_arguments, dict):
            return {"error": "run_tool arguments must be an object"}
        design_tool = next((tool for tool in design_surface_tools(run.options.get("modelVision", "unknown"))
                            if tool.get("name") == tool_name), None)
        if design_tool is not None:
            if not await _design_surface_ready(run):
                return {"result": {"error": "design_surface_unavailable", "message": "The shared Design surface is not currently available. Open a Design first."}}
            if tool_name == "design_screenshot":
                result = await _design_client_action(run, "screenshot", {}, timeout=30.0)
            else:
                result = await _design_client_action(run, "invoke", {"tool_name": tool_name, "arguments": tool_arguments})
            return {"result": result}
        kit = next((value for value in kits if value.get("kit_name") in enabled
                    and any(tool.get("name") == tool_name for tool in value.get("tools", []))), None)
        if not kit:
            return {"error": f"Tool '{tool_name}' is not available. Use search_tools to find the correct name."}
        if f"{kit['kit_name']}::{tool_name}" in disabled:
            return {"error": f"Tool '{tool_name}' is disabled"}
        return await _dispatch_etna_tool(run, etna, kit, tool_name, tool_arguments, event_id)
    if name == "visualize":
        return {"result": {"ok": True, "type": arguments.get("type", "svg")}}
    if name == "preview":
        return {"result": {"ok": True, "type": "html"}}
    if name == "get_visualization_width":
        return {"result": {"width": int(run.options.get("renderWidth", 680))}}
    if name in {"design_register", "design_update", "design_info", "design_list", "design_remove", "open_design"}:
        designs = _design_registry(run)
        requested_name = str(arguments.get("name") or "").strip()
        if name == "design_list":
            return {"result": {"designs": designs}}
        if not requested_name:
            return {"result": {"error": "invalid_arguments", "message": f"{name} requires name"}}
        existing = next((item for item in designs if str(item.get("name", "")) == requested_name), None)
        if name == "design_register":
            raw_url = _normalize_design_url(arguments.get("url"))
            if not raw_url:
                return {"result": {"error": "invalid_design", "message": "Design requires a name and a valid HTTP or HTTPS URL."}}
            if any(str(item.get("name", "")).casefold() == requested_name.casefold() for item in designs):
                return {"result": {"error": "design_already_exists", "name": requested_name}}
            stamp = now()
            design = {"version": 1, "id": f"design-{uuid.uuid4().hex}", "name": requested_name, "url": raw_url,
                      "attachedAt": stamp, "updatedAt": stamp}
            designs.append(design)
            _commit_design_registry(run)
            return {"result": {"ok": True, "design": design, "guidance": _DESIGN_REGISTER_GUIDANCE}}
        if existing is None:
            return {"result": {"error": "design_not_found", "name": requested_name}}
        if name == "design_update":
            raw_url = _normalize_design_url(arguments.get("url"))
            if not raw_url:
                return {"result": {"error": "invalid_design_url", "name": requested_name}}
            existing["url"] = raw_url
            existing["updatedAt"] = now()
            _commit_design_registry(run)
            return {"result": {"ok": True, "design": existing}}
        if name == "design_info":
            return {"result": {"ok": True, "design": existing}}
        if name == "design_remove":
            run.chat["designs"] = [item for item in designs if item is not existing]
            _commit_design_registry(run)
            try:
                await _design_client_action(run, "remove", {"name": requested_name, "design_id": existing.get("id")}, timeout=5.0)
            except Exception:
                pass
            return {"result": {"ok": True, "removed": requested_name, "id": existing.get("id")}}
        opened = await _design_client_action(run, "open", {"name": requested_name, "design_id": existing.get("id"), "design": existing})
        if isinstance(opened, dict):
            result = dict(opened)
            if result.get("ok"):
                result["guidance"] = _DESIGN_OPEN_GUIDANCE
            return {"result": result}
        return {"result": {"ok": True, "name": requested_name, "guidance": _DESIGN_OPEN_GUIDANCE}}
    if name in {tool["name"] for tool in design_surface_tools(True)}:
        if name == "design_screenshot" and run.options.get("modelVision") is not True:
            return {"result": {"error": "design_screenshot_unavailable"}}
        if not await _design_surface_ready(run):
            return {"result": {"error": "design_surface_unavailable", "message": "The shared Design surface is not currently available. Open a Design first."}}
        try:
            if name == "design_screenshot":
                result = await _design_client_action(run, "screenshot", {}, timeout=30.0)
            else:
                result = await _design_client_action(run, "invoke", {"tool_name": name, "arguments": arguments})
            return {"result": result}
        except Exception as exc:
            return {"result": {"error": str(exc)}}
    if name.startswith("dashboard_") or name == "open_dashboard":
        panel_name = arguments.get("name")
        if name == "dashboard_create":
            await asyncio.to_thread(workspace.dashboard_create, run.chat["id"], panel_name, arguments.get("html", ""), arguments.get("css", ""), arguments.get("js", ""), actor="agent")
        elif name == "dashboard_update":
            await asyncio.to_thread(workspace.dashboard_update, run.chat["id"], panel_name, arguments["part"], arguments["content"], actor="agent")
        elif name == "dashboard_inspect":
            return {"result": {"content": await asyncio.to_thread(workspace.dashboard_inspect, run.chat["id"], panel_name, arguments["part"])}}
        elif name == "dashboard_list":
            return {"result": {"dashboards": await asyncio.to_thread(workspace.dashboard_list, run.chat["id"])}}
        elif name == "dashboard_delete":
            await asyncio.to_thread(workspace.dashboard_delete, run.chat["id"], panel_name, actor="agent")
            run.manager.publish(run.chat["id"], "push/panel-delete", {"chat_id": run.chat["id"], "name": panel_name})
            return {"result": {"ok": True, "name": panel_name}}
        meta = {"name": panel_name, "updatedAt": now(), "messageId": event_id}
        run.events.append({"id": run.event_id("panel"), "type": "panel", "panel": meta, "timestamp": now(), "runId": run.run_id, "turnId": turn_id})
        return {"result": {"ok": True, "name": panel_name, **({"part": arguments["part"]} if name == "dashboard_update" else {})}}
    if name not in natives:
        kit = next((value for value in kits if any(tool.get("name") == name for tool in value.get("tools", []))), None)
        if not kit or kit.get("kit_name") not in enabled or f"{kit['kit_name']}::{name}" in disabled:
            return {"error": f"Tool '{name}' is not available"}
        return await _dispatch_etna_tool(run, etna, kit, name, arguments, event_id)
    if not settings.get("cliWorkspaceEnabled"):
        return {"result": {"error": "CLI workspace is not enabled"}}

    path = str(arguments.get("path", "")).removeprefix("/workspace/")
    if name == "open_terminal":
        slot = await asyncio.to_thread(term.open_slot, run.chat["id"], "agent")
        if slot not in run.terminal_slots:
            run.terminal_slots.append(slot)
        run.manager.publish(run.chat["id"], "push/terminal-state", {"chat_id": run.chat["id"], "slots": run.terminal_slots, "focused": run.terminal_focus})
        return {"result": {"ok": True, "slot": slot, "note": f"Opened agent terminal {slot}. Call switch_terminal({slot}) before running commands in it."}}
    if name == "switch_terminal":
        await _resume_agent_terminals(run)
        slot = int(arguments["slot"])
        if slot not in run.terminal_slots:
            slots = ", ".join(map(str, run.terminal_slots)) or "none"
            return {"result": {"error": f"Terminal {slot} is not open. Open slots: {slots}"}}
        run.terminal_focus = slot
        await asyncio.to_thread(
            term.set_slot_focus,
            run.chat["id"],
            "agent",
            slot,
        )
        run.manager.publish(run.chat["id"], "push/terminal-state", {"chat_id": run.chat["id"], "slots": run.terminal_slots, "focused": slot})
        return {"result": {"ok": True, "slot": slot, "note": f"Switched focus to terminal {slot}."}}
    if name == "close_terminal":
        slot = arguments.get("slot", run.terminal_focus)
        if slot is None:
            return {"result": {"error": "No terminal selected. Specify a slot explicitly or call switch_terminal first."}}
        await asyncio.to_thread(term.close_slot, run.chat["id"], "agent", int(slot))
        run.terminal_slots = [item for item in run.terminal_slots if item != slot]
        if run.terminal_focus == slot:
            run.terminal_focus = None
        return {"result": {"ok": True, "slot": slot}}
    if name == "list_terminals":
        # Listing is also the transparent recovery boundary after inactivity or
        # a server restart. One single-flight wake restores all logical slots;
        # subsequent terminal tools hit live in-memory PTYs.
        states = await _resume_agent_terminals(run)
        values = [{
            "slot": int(state["slot"]),
            "state": "running" if state.get("running") else "idle",
            "focused": int(state["slot"]) == run.terminal_focus,
        } for state in states]
        return {"result": {"terminals": values}}
    if name == "use_terminal":
        await _resume_agent_terminals(run)
        if run.terminal_focus is None:
            return {"result": {"error": "No agent terminal is selected. Call open_terminal, then switch_terminal with the returned slot before using use_terminal."}}
        slot = run.terminal_focus
        pid = await asyncio.to_thread(term.use_terminal_in_slot, run.chat["id"], "agent", slot, arguments["cmd"], None)
        resume_notice = await asyncio.to_thread(term.consume_slot_resume_notice, run.chat["id"], "agent", slot)
        run.manager.publish(run.chat["id"], "push/terminal-running", {"chat_id": run.chat["id"], "slot": slot, "pid": pid})
        command, complete = await _initial_terminal_result(pid)
        output = "".join(command.output).strip() or "(no output)"
        if not complete:
            asyncio.create_task(_publish_terminal_completion(run, slot, pid))
            result = {"output": output, "running": True, "slot": slot, "pid": pid}
            if resume_notice:
                result["notice"] = resume_notice
            return {"result": result}
        run.manager.publish(run.chat["id"], "push/terminal-idle", {"chat_id": run.chat["id"], "slot": slot})
        if command.detached:
            reason = str(command.detach_reason).strip()
            result = {"output": output, "detached": True, "note": f"Detached by user. Reason: {reason}" if reason else "Detached by user."}
            if resume_notice:
                result["notice"] = resume_notice
            return {"result": result}
        result = {"output": output, "exit_code": command.exit_code or 0}
        if resume_notice:
            result["notice"] = resume_notice
        return {"result": result}
    if name == "send_input":
        await _resume_agent_terminals(run)
        if run.terminal_focus is None:
            return {"result": {"error": "No agent terminal is selected. Call switch_terminal before using send_input."}}
        has_text = "text" in arguments
        has_key = "key" in arguments
        if has_text == has_key:
            return {"error": "send_input requires exactly one of text or key."}
        if has_text:
            if not isinstance(arguments["text"], str):
                return {"error": "text must be a string."}
            if arguments.get("modifiers"):
                return {"error": "modifiers can only be used with key."}
            value = arguments["text"] + ("\r" if arguments.get("submit", False) else "")
        else:
            if "submit" in arguments:
                return {"error": "submit can only be used with text."}
            try:
                value = term.encode_terminal_key(arguments["key"], arguments.get("modifiers"))
            except ValueError as error:
                return {"error": str(error)}
        ok = await asyncio.to_thread(term.send_slot_input, run.chat["id"], "agent", run.terminal_focus, value)
        resume_notice = await asyncio.to_thread(term.consume_slot_resume_notice, run.chat["id"], "agent", run.terminal_focus)
        result = {"ok": ok}
        if resume_notice:
            result["notice"] = resume_notice
        return {"result": result}
    if name == "kill_process":
        return {"result": {"ok": await asyncio.to_thread(term.kill_process, arguments["pid"])}}
    if name == "read_output":
        slot = arguments.get("slot", run.terminal_focus)
        if slot is None:
            return {"result": {"error": "No terminal selected. Specify a slot explicitly or call switch_terminal first."}}
        slot = int(slot)
        await _resume_agent_terminals(run)
        resume_notice = await asyncio.to_thread(term.consume_slot_resume_notice, run.chat["id"], "agent", slot)
        state = await asyncio.to_thread(term.agent_slot_state, run.chat["id"], "agent", slot)
        if state is None:
            return {"result": {"error": f"Terminal {slot} is not open."}}
        lines = int(arguments.get("lines", 50))
        output = await asyncio.to_thread(term.read_slot_output, run.chat["id"], "agent", slot, lines)
        result: dict[str, Any] = {"output": output, "slot": slot, "lines": lines, "running": bool(state["running"])}
        if state.get("pid"):
            result["pid"] = state["pid"]
        if resume_notice:
            result["notice"] = resume_notice
        return {"result": result}
    if name == "wait":
        raw_seconds = arguments.get("seconds")
        if isinstance(raw_seconds, bool) or not isinstance(raw_seconds, (int, float)):
            return {"error": "wait requires seconds as a positive number."}
        seconds = float(raw_seconds)
        if not math.isfinite(seconds) or seconds <= 0:
            return {"error": "wait requires seconds as a positive number."}
        if seconds > MAX_WAIT_SECONDS:
            return {"error": f"Timeout cannot exceed {MAX_WAIT_SECONDS} seconds."}
        webhook_url = arguments.get("webhook_url")
        if webhook_url is not None and (not isinstance(webhook_url, str) or not webhook_url.strip()):
            return {"error": "webhook_url must be a non-empty URL or /webhook/... path."}
        if "slot" in arguments:
            raw_slot = arguments["slot"]
            if isinstance(raw_slot, bool) or not isinstance(raw_slot, int):
                return {"error": "slot must be an agent terminal number."}
            await _resume_agent_terminals(run)
            if raw_slot not in run.terminal_slots:
                return {"error": f"Terminal {raw_slot} is not open."}
            try:
                return await _wait_for_terminal_slot(run, raw_slot, seconds, webhook_url)
            except ValueError as error:
                return {"error": str(error)}
        try:
            pid = term.start_wait(run.chat["id"], seconds, webhook_url)
        except ValueError as error:
            return {"error": str(error)}
        result = await _wait_result(pid, seconds + 5)
        if result.get("detached"):
            return {"result": {"detached": True, "note": "Detached by user."}}
        if webhook_url:
            return {"result": {
                "ok": True,
                "waited": seconds,
                "wake_reason": result.get("wake_reason") or "timeout",
                **({"webhook_method": result.get("webhook_method"), "webhook_path": result.get("webhook_path")}
                   if result.get("wake_reason") == "webhook" else {}),
            }}
        return {"result": {"ok": True, "waited": seconds}}
    if name == "present":
        await asyncio.to_thread(workspace.present_file, run.chat["id"], path)
        file = {"path": path, "name": Path(path).name, "presentedAt": now(), "messageId": event_id}
        run.events.append({"id": run.event_id("present"), "type": "presented_file", "file": file,
                           "timestamp": now(), "runId": run.run_id, "turnId": turn_id})
        return {"result": {"ok": True, "path": path}}
    if name == "view_file":
        extension = Path(path).suffix.lower().lstrip(".")
        if extension in {"png", "jpg", "jpeg", "gif", "webp", "svg"}:
            if run.options.get("modelVision") is not True:
                return {"result": {"error": "image_view_unavailable", "message": "Image viewing is unavailable for the selected model."}}
            if extension == "svg":
                if arguments.get("region") is not None:
                    return {"result": {"error": "Detail regions are available for raster images only; this file is SVG."}}
                encoded, mime = await asyncio.to_thread(workspace.read_file_base64, run.chat["id"], path)
                return {"result": {"ok": True, "dataUrl": f"data:{mime};base64,{encoded}",
                                    "filename": Path(path).name, "view": "vector",
                                    "guidance": "Vector image shown without raster downscaling."}}
            rendered = await asyncio.to_thread(
                workspace.render_image_view, run.chat["id"], path, arguments.get("region"), 512
            )
            return {"result": {"ok": True, "filename": Path(path).name, **rendered}}
        if extension == "pdf":
            return {"result": {"error": "PDF text extraction not yet implemented — Vulcan required"}}
        return {"result": {"content": await asyncio.to_thread(workspace.read_file, run.chat["id"], path)}}
    if name == "find_in_file":
        return {"result": await asyncio.to_thread(workspace.find_in_file, run.chat["id"], path, arguments["query"])}
    if name == "edit":
        result = await asyncio.to_thread(workspace.edit_file, run.chat["id"], path, arguments["edits"])
        await asyncio.to_thread(workspace.git_commit_agent, run.chat["id"], f"edited {path}", path)
        return {"result": result}
    if name == "workspace_history":
        revision = str(arguments.get("revision") or "").strip()
        if revision and path:
            content = await asyncio.to_thread(workspace.git_show, run.chat["id"], revision, f"workspace/{path}")
            return {"result": {"path": path, "revision": revision, "content": content}}
        commits = await asyncio.to_thread(workspace.git_log, run.chat["id"], f"workspace/{path}" if path else None)
        limit = max(1, min(int(arguments.get("limit", 10)), 50))
        return {"result": {"commits": commits[:limit], "path": path or None}}
    if name == "workspace_diff":
        revision = str(arguments.get("revision") or "HEAD")
        difference = await asyncio.to_thread(workspace.git_diff, run.chat["id"], path or None, revision)
        return {"result": {"revision": revision, "path": path or None, "diff": difference}}
    if name == "workspace_restore":
        result = await asyncio.to_thread(workspace.git_restore_file, run.chat["id"], str(arguments["revision"]), path)
        return {"result": result}
    return {"result": {"error": f"Unknown Vulcan tool: {name}"}}
