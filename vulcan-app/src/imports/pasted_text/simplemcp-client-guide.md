# SimpleMCP V2 — Client Developer Guide

This document explains how to build a client that connects to a SimpleMCP V2 server. SimpleMCP V2 uses a lightweight HTTP JSON API. There is no WebSocket, no SSE, and no special handshake — just POST and GET requests.

---

## Server Address

By default, SimpleMCP runs on `http://localhost:8000`. The port may vary depending on how the user started the server. Your client should make this configurable.

---

## The Protocol at a Glance

SimpleMCP V2 exposes five endpoints:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/list_kits` | Get the names of all installed kits |
| POST | `/inspect_kit` | Get metadata for a specific kit |
| POST | `/list_tools_in_kit` | Get all tools belonging to a kit |
| POST | `/inspect_tool` | Get the schema for a specific tool |
| POST | `/run_tool` | Execute a tool |

All request and response bodies are JSON. All POST requests must include the header `Content-Type: application/json`.

---

## Step 1 — Discover Kits

```
GET /list_kits
```

**Response:**
```json
{
  "kits": ["Web Kit", "SQLite Tools", "My Custom Kit"]
}
```

This returns a flat list of `kit_name` strings. These are the human-readable display names of every installed kit, including disabled ones. Use this to populate a kit list in your UI.

---

## Step 2 — Inspect a Kit

```
POST /inspect_kit
Content-Type: application/json

{ "kit": "Web Kit" }
```

**Response:**
```json
{
  "kit_name": "Web Kit",
  "kit_description": "Web crawling and content extraction toolkit.",
  "filename": "web_kit.py",
  "enabled": true
}
```

Use `enabled` to render the kit as active or inactive in your UI. Kits can be toggled by the user independently — your client should respect this flag and not send tool calls to a disabled kit.

---

## Step 3 — List Tools in a Kit

```
POST /list_tools_in_kit
Content-Type: application/json

{ "kit": "Web Kit" }
```

**Response:**
```json
{
  "kit": "Web Kit",
  "tools": [
    {
      "name": "web_search",
      "description": "Search the web using a query string.",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "num_results": { "type": "integer" }
        },
        "required": ["query"]
      }
    },
    {
      "name": "extract_page_content",
      "description": "Retrieve the full content of one or more URLs.",
      "parameters": {
        "type": "object",
        "properties": {
          "urls": { "type": "string" }
        },
        "required": ["urls"]
      }
    }
  ]
}
```

The `parameters` object follows JSON Schema. `required` lists fields the user must provide. Fields not in `required` are optional.

Only fetch tools for kits where `enabled` is `true`. You do not need to call this endpoint for disabled kits.

---

## Step 4 — Inspect a Specific Tool (Optional)

If you want detail on a single tool — for example, to render a help tooltip or validate arguments before sending:

```
POST /inspect_tool
Content-Type: application/json

{ "tool": "web_search" }
```

**Response:**
```json
{
  "name": "web_search",
  "description": "Search the web using a query string.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "num_results": { "type": "integer" }
    },
    "required": ["query"]
  },
  "kit": "web_kit"
}
```

The `kit` field is the internal filename stem (not the display name). This is informational — you do not need it to run the tool.

---

## Step 5 — Run a Tool

```
POST /run_tool
Content-Type: application/json

{
  "tool": "web_search",
  "arguments": {
    "query": "SimpleMCP documentation",
    "num_results": 5
  }
}
```

**Success response:**
```json
{
  "result": { ... }
}
```

The `result` value can be any JSON type — a string, object, array, or number, depending on what the tool returns. Your client should handle all of these gracefully.

**Error response:**
```json
{
  "error": "Tool 'web_search' not found"
}
```

Always check for the presence of an `error` key before using `result`.

---

## Recommended Client Lifecycle

A well-behaved SimpleMCP client should follow this flow on startup:

1. **Connect** — attempt a `GET /list_kits` to verify the server is reachable
2. **Enumerate** — call `/inspect_kit` for each kit to get metadata and enabled status
3. **Load tools** — call `/list_tools_in_kit` for each enabled kit
4. **Present** — show the user their enabled kits and available tools
5. **Execute** — call `/run_tool` when the user (or an AI agent) invokes a tool
6. **Refresh** — re-run steps 1–4 when the user installs or removes a kit, or toggles one on/off

---

## Kit Enable/Disable

The SimpleMCP V2 protocol is designed so clients can handle kit toggling in-house, without needing separate server instances per kit. The intended UX (as shown in the reference implementation) is a toggle list — one toggle per kit, independent of the others.

When a kit is disabled:
- Still appears in `/list_kits`
- `/inspect_kit` returns `"enabled": false`
- Your client should **not** load its tools or allow them to be called
- You do not need to call `/list_tools_in_kit` for it

When a kit is re-enabled, call `/list_tools_in_kit` to load its tools fresh.

---

## Error Handling

| Situation | What happens |
|-----------|--------------|
| Tool not found | `{ "error": "Tool 'x' not found" }` with HTTP 200 |
| Kit not found | `{ "error": "Kit 'x' not found" }` with HTTP 404 |
| Missing field in request | `{ "error": "Missing 'kit' field" }` with HTTP 400 |
| Tool throws an exception | `{ "error": "ExceptionType: message" }` with HTTP 200 |
| Server not reachable | Connection refused / timeout at the HTTP level |

Note that tool execution errors return HTTP 200 — the error is in the response body, not the status code. Always inspect the body.

---

## Example: Minimal JavaScript Client

```javascript
const BASE = "http://localhost:8000";

async function listKits() {
  const res = await fetch(`${BASE}/list_kits`);
  const { kits } = await res.json();
  return kits; // ["Web Kit", "SQLite Tools", ...]
}

async function inspectKit(kitName) {
  const res = await fetch(`${BASE}/inspect_kit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kit: kitName }),
  });
  return res.json(); // { kit_name, kit_description, filename, enabled }
}

async function listTools(kitName) {
  const res = await fetch(`${BASE}/list_tools_in_kit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kit: kitName }),
  });
  const { tools } = await res.json();
  return tools;
}

async function runTool(toolName, args) {
  const res = await fetch(`${BASE}/run_tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: toolName, arguments: args }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}
```

---

## Notes for AI-Backed Clients

If your client routes tool calls through an LLM:

- Pass the tool list from `/list_tools_in_kit` directly as the `tools` parameter in your model API call — the schema format is compatible with OpenAI-style function calling
- When the model returns a tool call, extract `name` and `arguments` and forward them to `/run_tool`
- The `result` from `/run_tool` should be passed back to the model as the tool result content
- Only load tools from enabled kits — this is how the user controls what the model can access