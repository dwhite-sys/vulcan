---
name: kit-building
description: Guidance for writing Etna kit files. Read this when the user wants you to build a kit — a new tool or set of tools they can install into Etna. Also read this when you're about to write any @tool-decorated Python for Etna, whether that's a full kit from scratch or adding tools to an existing one.
---

# Kit Building

A kit is a Python file that exposes one or more tools to the model via Etna. The file has four metadata fields at the top, and any number of `@tool`-decorated functions. Everything else — schema generation, dependency management, hot-reload — is handled by Etna.

## Starting point

If the user has described what they want, start there. If the conversation contains enough context to infer the kit's purpose, extract it before asking questions. What you need to know before writing:

- What should the kit do? What problem does it solve?
- Are there external services, APIs, or libraries involved?
- Are there configuration values the user will want to change (API keys, URLs, credentials)?
- How many tools does it need, and are they distinct enough to be separate functions?

Don't over-interview. If the answers are clear from context, write the draft and confirm as you go.

## Kit anatomy

```python
from utils import tool
import os

kit_name        = "My Kit"
kit_description = "One sentence describing what this kit does."
requirements    = ["requests"]
config          = {"MY_VAR": "default_value"}

@tool
def do_something(query: str, limit: int = 10) -> dict:
    """
    WHEN TO USE: One sentence describing the task this tool solves.

    query: what to search for.
    limit: max results (default 10).

    Returns {"results": list, "count": int}.
    """
    my_var = os.getenv("MY_VAR", "default_value")
    return {"results": [], "count": 0}
```

**`kit_name`** — display name shown in the UI and client configs.

**`kit_description`** — one sentence. Shown alongside kit_name. Write it for a human or an LLM skimming a list of kits.

**`requirements`** — pip packages needed. Etna installs these into its managed venv automatically before the kit loads. No imports needed to declare them.

**`config`** — environment variables with defaults. Stored in `~/.etna_server/kit_configs/<stem>/config.json`, exposed as env vars at runtime. User sets them with `etna kit config set <stem> <VAR> <value>`. Use these for anything the user will need to customize: API keys, base URLs, instance addresses.

**`@tool`** — the only import required from Etna. Only decorated functions are registered as tools — this is intentional, so you can include helper functions in the kit file without them being exposed to the model. Type hints are mandatory on tool functions — they build the JSON schema. Parameters without defaults are required; parameters with defaults are optional.

## Writing tool docstrings

The docstring is what the model sees. Write it for the model, not for humans.

Lead with `WHEN TO USE:` — one sentence that tells the model exactly what task this tool solves and when to reach for it over alternatives. This is the most important line in the docstring.

Document each parameter on its own line: `param_name: what it does, and any constraints or options.`

End with what the tool returns, especially error shapes: `Returns {"result": str} on success or {"error": str} on failure.`

```python
@tool
def ntfy_send(topic: str, message: str, title: str = "") -> dict:
    """
    WHEN TO USE: Send a push notification to the user's phone or device.
    Call this when the user asks to be notified, or proactively when finishing
    a long task they asked to be notified about on completion.

    topic: The ntfy topic to publish to (e.g. "alerts"). No slashes.
    message: The body of the notification.
    title: Optional title shown above the message. Leave empty to omit.

    Returns {"status": "ok", "topic": str} on success or {"error": str} on failure.
    """
```

Always annotate the return type. The linter will warn on install if a tool has no return type annotation — even a tool that returns nothing should have `-> None`. In practice, most tools should return a dict.

## Type hints

Etna's schema generation handles `str`, `int`, `float`, and `bool`. Anything else is treated as `str`. For parameters that accept JSON (dicts, lists), use `str` and document the expected format in the docstring — the model will serialize appropriately.

## Error handling

Always return a dict. Never raise — a tool that raises gives the model an opaque error instead of something it can reason about. Return `{"error": str(e)}` on failure, and document the error shape in the docstring so the model knows what to expect.

## Testing

Once the kit file is written, install it and test it in the terminal:

```bash
etna install /path/to/kit.py
```

Etna lints the kit on install and reports warnings — missing return type annotations, missing docstrings, and similar issues. Warnings don't block installation but should be addressed before handing the kit off. A clean install looks like:

```
[Etna] ✔ Resolved 'my_kit' == 1.0.0
[Etna] Downloaded 'my_kit'
[Etna] Linting 'my_kit.py'...
✔ Passed with 0 warnings
```

If there are warnings, fix them and reinstall. If Etna is running, hot-reload happens automatically — no restart needed.

Test each tool by calling it through the session — check that the schema looks right, the tool description reads clearly, and the return values are what you expect. Fix and reinstall until it's working cleanly before handing it off.

If something isn't loading, `etna status` and `etna kit inspect <stem>` are the first diagnostic moves. For install and client sync guidance, refer to the etna-usage skill.

## When to add a skill

A kit warrants a skill when the model could plausibly pick the wrong tool, get the order wrong, or miss context that would change its approach. A single self-explanatory tool doesn't need one. A kit with overlapping tools, stateful behavior, or non-obvious sequencing does.

If the kit warrants a skill, read the skill-builder skill before writing it — it covers the full authoring process, description optimization, and testing. What the kit-building skill adds is the Etna-specific context: kit skills are reported with a `kits/<kit-stem>` source (and also surface through `inspect_kit`), while the skill body should focus on tool selection logic and workflow patterns specific to this kit.
