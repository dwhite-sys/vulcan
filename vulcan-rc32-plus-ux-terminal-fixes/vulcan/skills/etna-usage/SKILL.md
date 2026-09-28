---
name: etna-usage
description: Guidance for working with Etna from within a Vulcan session. Read this when the user wants to install, update, configure, or troubleshoot kits or skills; when something in the kit system isn't working and you need to help diagnose it; when the user is thinking about building a kit and wants to understand how Etna works before diving in; or when you need enough Etna literacy to have a real conversation about kit structure without building anything yourself.
---

# Etna Usage

Etna is a tool server that runs on the host machine — not inside your workspace container. It manages kits (tool collections) and skills (guidance documents), serves them to Vulcan and other clients, and handles the full lifecycle of installing, updating, and configuring them. You don't have direct access to it from the terminal unless the user has set things up that way. What you do have is enough understanding to guide the user through it and help them when things go wrong.

## The Etna/Vulcan boundary

**Etna** — kits, skills, tool registration, kit config values, the `etna` CLI. Lives on the host, by default at `localhost:8467`, though if that port is taken Etna will find the next available one.

**Vulcan** — the workspace container, chat history, terminals, file browser, dashboards, the chat UI itself. By default at `localhost:8468`, with the same port-finding behavior if needed.

When something isn't working, the boundary matters. A tool that's not showing up is probably an Etna issue. A terminal that won't connect is a Vulcan issue. A dashboard that's not rendering is Vulcan. A kit config value that's not taking effect is Etna.

## Checking what's there

If the user isn't sure what's installed or whether Etna is running:

```bash
etna status          # server, browser, kits, and client summary
etna list            # installed kits and skills
etna search <query>  # search the curated repo
```

`etna status` is the first move when something seems off — it shows whether the server is actually running and what's connected.

## Installing and updating

```bash
etna install <name>              # from the curated repo
etna install <name>==<version>   # specific version
etna install /path/to/kit.py     # local file
etna install /path/to/pkg.ekp    # kit + skill bundle
etna update <name>               # update a kit
etna update --all                # update everything
etna remove <name>               # remove a kit or skill
```

Hot-reload happens automatically — no server restart needed after install or update.

## Kit configuration

Kits expose config variables that can be set per-kit. These are environment variables with defaults baked into the kit file. To see what's configurable:

```bash
etna kit config list <kit-stem>
```

To set a value:

```bash
etna kit config set <kit-stem> <VAR> <value>
```

Config values persist across restarts and survive updates. If a kit isn't behaving as expected, checking its config is worth doing early — a wrong URL or missing API key is a common cause.

## MCP compatibility and client setup

Etna natively speaks the Etna Protocol, but exposes MCP JSON-RPC endpoints and stdio shims for compatibility with clients that speak MCP. To connect other clients — Claude Desktop, LM Studio, Cursor, VS Code, OpenWebUI — use the compat commands:

```bash
etna compat              # auto-detect and configure all supported clients
etna compat claude       # write kit entries to Claude Desktop config
etna compat lmstudio     # write kit entries to LM Studio config
etna compat cursor       # write kit entries to Cursor config
etna compat vscode       # write kit entries to VS Code settings
etna compat openwebui <url> <api_key>  # register kits with OpenWebUI
```

After any kit install or update, registered clients are re-synced automatically.

The stdio shim is how MCP clients connect — it's a thin bridge that reads MCP JSON-RPC from stdin and forwards it to the running Etna server. Each kit gets its own stdio entry in the client config, scoped to `/mcp/<kit_stem>`. The user doesn't need to manage this manually — `etna compat` handles it. But if a client isn't seeing a kit, running `etna compat <client>` again is the right first move.



If tool calls are failing with connection errors, Etna's server may not be running. The user can check with `etna status` and restart with `etna start`. Etna runs on `localhost:8467` by default — if that port isn't responding, check whether it jumped to a different port, or whether the server is down.

## Kit anatomy — enough to have the conversation

A kit is a Python file with `@tool`-decorated functions. The model sees the function name and its docstring as the tool description, so docstrings are written for the model, not for humans. Type hints are mandatory — they build the JSON schema automatically.

```python
kit_name        = "My Kit"
kit_description = "What this kit does."
requirements    = ["requests"]
config          = {"MY_VAR": "default_value"}

@tool
def do_something(query: str, limit: int = 10) -> dict:
    """
    WHEN TO USE: one sentence describing the task this solves.

    query: what to search for.
    limit: max results (default 10).
    """
    return {"results": [], "count": 0}
```

The `requirements` list is installed automatically into Etna's managed venv. The `config` dict defines environment variables the user can set with `etna kit config set`.

This is enough to explain kit structure to a user, help them understand why a tool description isn't landing well, or talk through what a kit should look like before they write it. If the user wants you to build the kit yourself rather than guide them through it, read the kit-building skill first.
