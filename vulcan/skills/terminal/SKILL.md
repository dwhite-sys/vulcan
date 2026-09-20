---
name: terminal
description: Guidance for working effectively in the Vulcan terminal environment. Read this at the start of tasks involving parallel work, long-running processes, servers, downloads, or anything where understanding the environment or terminal organization would change how you approach it.
---

# Terminal

## Environment

You're running inside an Ubuntu 24.04 Docker container. Your working directory is `/workspace`. It persists across the conversation and is git-backed, so meaningful changes are recoverable. The shell remembers your working directory and environment between commands; use that continuity rather than fighting it.

Python packages go through `uv pip install` or `uv add`. The container shares the host network, including its internet access, LAN, private VPNs, Tailscale, and localhost services. SSH is available. Network ports are shared with the host and other chats, so choose an unused port before starting a server. Ordinary workspace commands run as the host user's UID/GID so files remain host-accessible; passwordless `sudo` is available inside the isolated container when administrative access is needed. The filesystem and processes are container-isolated even though networking is shared with the host.

What this means in practice: treat the workspace directory stated in system context as your home base. Build there, write there, run things from there. Things outside the workspace don't persist.

---

## Terminal Management

You have up to 3 agent terminal slots. Terminals are allocated deliberately: use `open_terminal`, then `switch_terminal` with its returned slot before running commands. Opening a terminal never changes focus automatically. Keep the selected shell for ordinary work and allocate another slot only when something genuinely needs to run alongside it.

**When to open a second or third terminal:**
- A server needs to stay running while you work on something else
- A long download or install is in progress and you don't want to wait
- Two things need to happen in parallel and blocking on one would slow the other

Close terminals when the work they were opened for is done. An idle open terminal isn't a problem, but accumulating them without purpose is noise. `read_output` checks a terminal's recent output and running state without switching focus. `wait` with both `seconds` and `slot` suspends until that slot's foreground command completes or the timeout expires.

Keep track of what's running where. A terminal with a live server in it is not a general-purpose slot. Know your slot state before opening commands.

---

## Command Execution

The shell is stateful. Your working directory, environment variables, and running processes carry forward between commands in the same terminal. This is an asset — set something up once, use it across multiple commands — but it also means state from earlier commands is still there. Be aware of what you've left running.

`use_terminal` submits a shell command and returns promptly with available output. Fast commands finish in the same call. If the result says `running: true`, the foreground process remains alive in that shell: inspect it with `read_output`, wait for completion with `wait(seconds, slot)`, or interact when necessary with `send_input`.

Reserve `send_input` for a running interactive program. Default to `use_terminal` for any other terminal input needs. Use `text` and optional `submit: true` for a nonsensitive confirmation or REPL response, or use `key` with optional `modifiers` for keyboard actions such as `{"key":"C","modifiers":["CTRL"]}`. Ask the user to type passwords and other sensitive credentials directly into the terminal.

Don't leave zombie processes. If you started something and no longer need it, kill it. A wait timeout never kills the foreground process; check the reported running state before assuming it stopped.

For commands that will take a while, consider whether they belong in their own terminal slot so the current one stays responsive. A `pip install` or a model download is a good candidate for a background slot.

When something fails, read the output before retrying. The error is usually there.

---

## Shared Terminal Space

The user can step into any of your agent terminals at any time from the terminal list at the bottom of the workspace tab. This is intentional — it's how they can give you things you can't receive any other way: sudo passwords, SSH passphrases, API keys entered at a prompt, anything that needs to be typed directly rather than passed as an argument.

You only see what appears as visible terminal output. Masked input — password prompts, anything that doesn't echo — is not readable to you. If you need something sensitive entered, say what you need and where, and the user can step in and provide it.

The user also has their own 3 terminal slots that you don't have access to. These are primarily for their own work. In a tight spot — if your slots are occupied and the user needs to run something that would otherwise block you — it's reasonable to suggest they run it in one of their own terminals. A long-running server is a good example: if spinning one up would consume an agent slot for the rest of the session, pointing that out and suggesting the user host it themselves is worth doing.
