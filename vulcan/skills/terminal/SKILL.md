---
name: terminal
description: Guidance for working effectively in the Vulcan terminal environment. Read this at the start of tasks involving parallel work, long-running processes, servers, downloads, or anything where understanding the environment or terminal organization would change how you approach it.
---

# Terminal

## Environment

You're running inside an Ubuntu 24.04 Docker container. Your working directory is `/workspace` — it persists across the conversation and is git-backed, so meaningful changes are recoverable. The shell remembers your working directory and environment between commands; use that continuity rather than fighting it.

Python packages go through `uv pip install` or `uv add`. The container has full internet access. You're root inside the container, but the container itself is isolated — you're not on the host machine.

What this means in practice: treat `/workspace` as your home base. Build there, write there, run things from there. Things outside `/workspace` don't persist.

---

## Terminal Management

You have up to 3 agent terminal slots. Slot 1 opens automatically — it's where most single-task work happens. Open additional slots when something needs to run alongside something else.

**When to open a second or third terminal:**
- A server needs to stay running while you work on something else
- A long download or install is in progress and you don't want to wait
- Two things need to happen in parallel and blocking on one would slow the other

Close terminals when the work they were opened for is done. An idle open terminal isn't a problem, but accumulating them without purpose is noise. `read_output` lets you check on a terminal without switching focus — use it to monitor a running process rather than jumping back and forth.

Keep track of what's running where. A terminal with a live server in it is not a general-purpose slot. Know your slot state before opening commands.

---

## Command Execution

The shell is stateful. Your working directory, environment variables, and running processes carry forward between commands in the same terminal. This is an asset — set something up once, use it across multiple commands — but it also means state from earlier commands is still there. Be aware of what you've left running.

Don't leave zombie processes. If you started something and no longer need it, kill it. If a command timed out or detached, check whether the process is still running before assuming it stopped.

For commands that will take a while, consider whether they belong in their own terminal slot so the current one stays responsive. A `pip install` or a model download is a good candidate for a background slot.

When something fails, read the output before retrying. The error is usually there.

---

## Shared Terminal Space

The user can step into any of your agent terminals at any time from the terminal list at the bottom of the workspace tab. This is intentional — it's how they can give you things you can't receive any other way: sudo passwords, SSH passphrases, API keys entered at a prompt, anything that needs to be typed directly rather than passed as an argument.

You only see what appears as visible terminal output. Masked input — password prompts, anything that doesn't echo — is not readable to you. If you need something sensitive entered, say what you need and where, and the user can step in and provide it.

The user also has their own 3 terminal slots that you don't have access to. These are primarily for their own work. In a tight spot — if your slots are occupied and the user needs to run something that would otherwise block you — it's reasonable to suggest they run it in one of their own terminals. A long-running server is a good example: if spinning one up would consume an agent slot for the rest of the session, pointing that out and suggesting the user host it themselves is worth doing.
