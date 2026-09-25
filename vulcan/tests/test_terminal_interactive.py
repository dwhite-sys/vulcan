"""Exercise agent terminal commands against a real interactive Unix PTY."""

from __future__ import annotations

import contextlib
import asyncio
import os
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from vulcan import agent_runtime, terminal


class InteractiveTerminalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="vulcan-real-pty-")
        self.addCleanup(self.directory.cleanup)
        self.chat_id = f"pty-{os.getpid()}-{time.monotonic_ns()}"
        self.rcfile = Path(self.directory.name) / "interactive.bashrc"
        self.rcfile.write_text(
            "PS0=$'\\033]777;vulcan-terminal;busy\\007'\n"
            "PS1=$'\\033]777;vulcan-terminal;idle\\007'\"TEST$ \"\n"
            "export PS0 PS1\n",
            encoding="utf-8",
        )
        self.patches = contextlib.ExitStack()
        self.addCleanup(self.patches.close)
        self.patches.enter_context(mock.patch.object(terminal, "_ensure_chat_dirs"))
        self.patches.enter_context(mock.patch.object(terminal, "_start_inactivity_watcher"))
        self.patches.enter_context(mock.patch.object(
            terminal, "_install_slot_shell_integration", return_value=str(self.rcfile)
        ))
        self.patches.enter_context(mock.patch.object(terminal.docker, "container_running", return_value=True))
        self.patches.enter_context(mock.patch.object(terminal.docker, "prepare_workspace_identity", return_value=True))
        self.patches.enter_context(mock.patch.object(terminal.docker, "prepare_terminal_identity", return_value=True))
        self.patches.enter_context(mock.patch.object(terminal.docker, "terminal_exec_flags", return_value=[]))
        self.patches.enter_context(mock.patch.object(terminal, "_ensure_tmux_session"))
        self.patches.enter_context(mock.patch.object(terminal, "_kill_slot_tmux_session"))
        original_popen = subprocess.Popen

        def start_real_local_shell(_docker_arguments, **kwargs):
            return original_popen(["setsid", "--ctty", "/bin/bash", "--rcfile", str(self.rcfile), "-i"], **kwargs)

        self.patches.enter_context(mock.patch.object(
            terminal.subprocess, "Popen", side_effect=start_real_local_shell
        ))
        self.slot = terminal.open_slot(self.chat_id, "agent")
        self.addCleanup(terminal.close_slot, self.chat_id, "agent", self.slot)
        self.ts = terminal._slots[(self.chat_id, "agent", self.slot)]
        self.wait_for(lambda: "TEST$ " in "".join(self.ts.output))

    def wait_for(self, condition, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(0.01)
        self.fail(f"Condition did not complete; PTY output: {''.join(self.ts.output)!r}")

    def command(self, text, timeout=5):
        pid = terminal.use_terminal_in_slot(self.chat_id, "agent", self.slot, text, timeout)
        process = terminal.get_command(pid)
        self.wait_for(lambda: process.finished, timeout=timeout + 2)
        return process

    def test_commands_use_one_real_stateful_interactive_shell(self):
        first = self.command("cd /tmp && export VULCAN_PTY_STATE=preserved")
        second = self.command('printf "%s:%s:%s\\n" "$PWD" "$VULCAN_PTY_STATE" "$(test -t 0 && echo tty)"')
        self.assertEqual(first.exit_code, 0)
        self.assertEqual(second.exit_code, 0)
        self.assertIn("/tmp:preserved:tty", "".join(second.output))
        self.assertFalse(self.ts.is_busy)

    def test_password_prompt_stays_open_and_direct_input_never_enters_output(self):
        command = "read -r -s -p 'Password: ' value; printf '\\naccepted:%s\\n' \"${#value}\""
        pid = terminal.use_terminal_in_slot(self.chat_id, "agent", self.slot, command, 5)
        process = terminal.get_command(pid)
        # The typed command itself contains the word Password; wait until the
        # post-PS0 command capture sees the *actual* no-echo getpass prompt.
        self.wait_for(lambda: "Password:" in "".join(process.output))
        self.assertFalse(process.finished, "The interactive prompt must wait for real PTY input")
        self.assertTrue(terminal.send_slot_input(self.chat_id, "agent", self.slot, "supersecret\n"))
        self.wait_for(lambda: process.finished)
        self.assertEqual(process.exit_code, 0)
        self.assertIn("accepted:11", "".join(process.output))
        self.assertNotIn("supersecret", "".join(self.ts.output))
        self.assertNotIn("supersecret", "".join(process.output))

    def test_agent_yields_private_password_prompt_then_waits_for_user_takeover(self):
        command = "read -r -s -p 'Password: ' value; printf '\\naccepted:%s\\n' \"${#value}\""

        async def scenario():
            manager = mock.Mock()
            run = agent_runtime.AgentRun(
                chat={"id": self.chat_id},
                options={"settings": {"cliWorkspaceEnabled": True, "panelsEnabled": True},
                         "enabledKits": [], "disabledTools": [], "kitsWithTools": [],
                         "etnaUrl": "http://localhost:8467"},
                manager=manager,
                run_id="real-pty:agent",
            )
            run.terminal_focus = self.slot
            run.terminal_slots = [self.slot]
            started = time.monotonic()
            launched = await agent_runtime.execute_tool(run, "use_terminal", {"cmd": command}, "turn", "event")
            self.assertLess(time.monotonic() - started, 1)
            self.assertTrue(launched["result"]["running"])
            self.assertIn("Password:", launched["result"]["output"])
            self.assertTrue(terminal.send_slot_input(self.chat_id, "agent", self.slot, "supersecret\r"))
            completed = await agent_runtime.execute_tool(
                run, "wait", {"seconds": 3, "slot": self.slot}, "turn", "event"
            )
            self.assertFalse(completed["result"]["running"])
            self.assertEqual(completed["result"]["exit_code"], 0)
            self.assertIn("accepted:11", completed["result"]["output"])
            self.assertNotIn("supersecret", completed["result"]["output"])

        asyncio.run(scenario())

    def test_interactive_confirmation_accepts_semantic_text_and_enter(self):
        command = "read -r -p 'Continue? ' answer; printf 'answer:%s\\n' \"$answer\""
        pid = terminal.use_terminal_in_slot(self.chat_id, "agent", self.slot, command, None)
        process = terminal.get_command(pid)
        self.wait_for(lambda: "Continue?" in "".join(process.output))
        self.assertFalse(process.finished)
        self.assertTrue(terminal.send_slot_input(self.chat_id, "agent", self.slot, "yes\r"))
        self.wait_for(lambda: process.finished)
        self.assertIn("answer:yes", "".join(process.output))
        self.assertEqual(terminal.slot_state(self.chat_id, "agent", self.slot)["running"], False)

    def test_semantic_ctrl_c_interrupts_actual_foreground_process(self):
        pid = terminal.use_terminal_in_slot(self.chat_id, "agent", self.slot, "sleep 20", None)
        process = terminal.get_command(pid)
        self.wait_for(lambda: self.ts.prompt_busy)
        self.assertEqual(terminal.slot_state(self.chat_id, "agent", self.slot)["pid"], pid)
        self.assertTrue(terminal.send_slot_input(
            self.chat_id, "agent", self.slot, terminal.encode_terminal_key("C", ["CTRL"])
        ))
        self.wait_for(lambda: process.finished)
        self.wait_for(lambda: not self.ts.is_busy)
        self.assertEqual(process.exit_code, 130)

    def test_exit_status_and_multiline_heredoc_survive_same_shell(self):
        failed = self.command("false")
        self.assertEqual(failed.exit_code, 1)
        heredoc = self.command("cat <<'VULCAN_EOF'\nmultiline works\nVULCAN_EOF")
        self.assertEqual(heredoc.exit_code, 0)
        self.assertIn("multiline works", "".join(heredoc.output))

    def test_timeout_detaches_without_killing_interactive_foreground_process(self):
        pid = terminal.use_terminal_in_slot(self.chat_id, "agent", self.slot, "sleep 20", 1)
        process = terminal.get_command(pid)
        self.wait_for(lambda: process.finished, timeout=3)
        self.assertTrue(process.detached)
        self.assertTrue(self.ts.has_running)
        self.assertFalse(self.ts.finished)
        self.assertTrue(terminal.kill_process(pid))
        self.wait_for(lambda: not self.ts.is_busy)
        followup = self.command("printf recovered")
        self.assertIn("recovered", "".join(followup.output))

    def test_inactivity_close_preserves_scrollback_and_agent_automatically_resumes(self):
        previous = self.command("printf preserved-scrollback")
        self.assertIn("preserved-scrollback", "".join(previous.output))
        terminal.close_slot(self.chat_id, "agent", self.slot, reason="inactivity")
        scrollback = terminal.get_slot_scrollback(self.chat_id, "agent", self.slot)
        self.assertIn("preserved-scrollback", scrollback)
        self.assertNotIn("Terminal closed", scrollback)
        listed = terminal.list_slots(self.chat_id)
        self.assertTrue(listed[0]["finished"])
        self.assertEqual(listed[0]["close_reason"], "inactivity")

        pid = terminal.use_terminal_in_slot(self.chat_id, "agent", self.slot, "printf resumed", 5)
        self.ts = terminal._slots[(self.chat_id, "agent", self.slot)]
        process = terminal.get_command(pid)
        self.wait_for(lambda: process.finished)
        self.assertEqual(process.exit_code, 0)
        self.assertIn("resumed", "".join(process.output))
        self.assertFalse(self.ts.finished)

    def test_send_input_revives_inactivity_closed_slot_before_writing(self):
        terminal.close_slot(self.chat_id, "agent", self.slot, reason="inactivity")
        self.assertTrue(terminal.send_slot_input(self.chat_id, "agent", self.slot, "printf input-revived\r"))
        self.ts = terminal._slots[(self.chat_id, "agent", self.slot)]
        self.wait_for(lambda: "input-revived" in "".join(self.ts.output))
        self.assertFalse(self.ts.finished)

    def test_unexpected_agent_shell_exit_is_transparently_revived(self):
        # Reproduce the production failure: the logical slot remains selected, but
        # the backing docker-exec/PTY process disappears between terminal calls.
        original = self.ts
        original.proc.kill()
        self.wait_for(lambda: original.finished)
        self.assertEqual(original.close_reason, "process-exit")

        listed = terminal.list_slots(self.chat_id)
        agent_slot = next(item for item in listed if item["kind"] == "agent" and item["slot"] == self.slot)
        self.assertTrue(agent_slot["logical_open"])
        self.assertEqual(agent_slot["close_reason"], "process-exit")

        pid = terminal.use_terminal_in_slot(self.chat_id, "agent", self.slot, "printf recovered-after-exit", 5)
        self.ts = terminal._slots[(self.chat_id, "agent", self.slot)]
        process = terminal.get_command(pid)
        self.wait_for(lambda: process.finished)
        self.assertEqual(process.exit_code, 0)
        self.assertIn("recovered-after-exit", "".join(process.output))
        self.assertIsNot(self.ts, original)
        self.assertFalse(self.ts.finished)


    def test_concurrent_recovery_is_single_flight_per_logical_slot(self):
        original = self.ts
        original.proc.kill()
        self.wait_for(lambda: original.finished)
        self.assertEqual(original.close_reason, "process-exit")

        real_start = terminal._start_slot_proc
        starts = []
        starts_lock = threading.Lock()

        def counted_start(*args, **kwargs):
            with starts_lock:
                starts.append((args, kwargs))
            return real_start(*args, **kwargs)

        barrier = threading.Barrier(3)
        results = []
        errors = []

        def recover():
            try:
                barrier.wait()
                results.append(terminal.ensure_live_slot(self.chat_id, "agent", self.slot))
            except Exception as exc:
                errors.append(exc)

        with mock.patch.object(terminal, "_start_slot_proc", side_effect=counted_start):
            threads = [threading.Thread(target=recover) for _ in range(2)]
            for thread in threads:
                thread.start()
            barrier.wait()
            for thread in threads:
                thread.join(timeout=5)

        self.assertFalse(errors)
        self.assertEqual(len(starts), 1)
        self.assertEqual(len(results), 2)
        self.assertIs(results[0], results[1])
        self.assertNotEqual(results[0].generation, original.generation)
        self.ts = results[0]

    def test_explicit_close_racing_recovery_leaves_logical_slot_closed(self):
        original = self.ts
        original.proc.kill()
        self.wait_for(lambda: original.finished)
        self.assertEqual(original.close_reason, "process-exit")

        barrier = threading.Barrier(3)
        errors = []

        def recover():
            try:
                barrier.wait()
                terminal.ensure_live_slot(self.chat_id, "agent", self.slot)
            except Exception as exc:
                errors.append(exc)

        def close():
            try:
                barrier.wait()
                terminal.close_slot(self.chat_id, "agent", self.slot, reason="explicit")
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=recover), threading.Thread(target=close)]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join(timeout=5)

        self.assertFalse(errors)
        self.assertIsNone(terminal.ensure_live_slot(self.chat_id, "agent", self.slot))
        self.assertIsNone(terminal.agent_slot_state(self.chat_id, "agent", self.slot))

    def test_explicit_close_retires_process_exit_parked_agent_slot(self):
        original = self.ts
        original.proc.kill()
        self.wait_for(lambda: original.finished)
        self.assertEqual(original.close_reason, "process-exit")

        terminal.close_slot(self.chat_id, "agent", self.slot, reason="explicit")
        listed = terminal.list_slots(self.chat_id)
        agent_slot = next(item for item in listed if item["kind"] == "agent" and item["slot"] == self.slot)
        self.assertFalse(agent_slot["logical_open"])
        self.assertEqual(agent_slot["close_reason"], "explicit")
        with self.assertRaisesRegex(RuntimeError, "is not open"):
            terminal.use_terminal_in_slot(self.chat_id, "agent", self.slot, "echo nope", 5)

    def test_agent_lifecycle_view_stays_idle_and_scrollback_remains_readable(self):
        previous = self.command("printf opaque-lifecycle")
        self.assertIn("opaque-lifecycle", "".join(previous.output))
        terminal.close_slot(self.chat_id, "agent", self.slot, reason="inactivity")

        state = terminal.agent_slot_state(self.chat_id, "agent", self.slot)
        self.assertEqual(state, {"slot": self.slot, "running": False, "pid": None})
        output = terminal.read_slot_output(self.chat_id, "agent", self.slot, 50)
        self.assertIn("opaque-lifecycle", output)
        self.assertNotIn("Terminal closed", output)

        async def scenario():
            manager = mock.Mock()
            run = agent_runtime.AgentRun(
                chat={"id": self.chat_id},
                options={"settings": {"cliWorkspaceEnabled": True, "panelsEnabled": True},
                         "enabledKits": [], "disabledTools": [], "kitsWithTools": [],
                         "etnaUrl": "http://localhost:8467"},
                manager=manager,
                run_id="real-pty:opaque-lifecycle",
            )
            run.terminal_focus = self.slot
            run.terminal_slots = [self.slot]

            listed = await agent_runtime.execute_tool(run, "list_terminals", {}, "turn", "event")
            self.assertEqual(listed["result"]["terminals"], [{
                "slot": self.slot, "state": "idle", "focused": True,
            }])
            read = await agent_runtime.execute_tool(run, "read_output", {"lines": 50}, "turn", "event")
            self.assertFalse(read["result"]["running"])
            self.assertIn("opaque-lifecycle", read["result"]["output"])
            self.assertNotIn("inactive", str(read).lower())
            self.assertNotIn("closed", str(read).lower())
            waited = await agent_runtime.execute_tool(
                run, "wait", {"seconds": 0.1, "slot": self.slot}, "turn", "event"
            )
            self.assertFalse(waited["result"]["running"])
            self.assertNotIn("closed", str(waited).lower())
            self.assertNotIn("inactive", str(waited).lower())

        asyncio.run(scenario())

    def test_lifecycle_parked_slot_is_not_recycled_by_opening_another_terminal(self):
        terminal.close_slot(self.chat_id, "agent", self.slot, reason="inactivity")
        second = terminal.open_slot(self.chat_id, "agent")
        self.addCleanup(terminal.close_slot, self.chat_id, "agent", second)
        self.assertNotEqual(second, self.slot)

    def test_use_terminal_revives_container_lifecycle_closed_slot_and_runs_command(self):
        terminal.close_slot(self.chat_id, "agent", self.slot, reason="container-stopped")
        running = mock.Mock(side_effect=[False, True, True])
        with mock.patch.object(terminal.docker, "container_running", running), \
             mock.patch.object(terminal.docker, "start_container", return_value=True) as start:
            pid = terminal.use_terminal_in_slot(self.chat_id, "agent", self.slot, "printf container-revived", 5)
            self.ts = terminal._slots[(self.chat_id, "agent", self.slot)]
            process = terminal.get_command(pid)
            self.wait_for(lambda: process.finished)
        start.assert_called_once_with(self.chat_id)
        self.assertEqual(process.exit_code, 0)
        self.assertIn("container-revived", "".join(process.output))
        self.assertFalse(self.ts.finished)

    def test_explicit_close_is_not_implicitly_revived_by_agent_input(self):
        terminal.close_slot(self.chat_id, "agent", self.slot, reason="explicit")
        self.assertFalse(terminal.send_slot_input(self.chat_id, "agent", self.slot, "echo nope\r"))
        with self.assertRaisesRegex(RuntimeError, "is not open"):
            terminal.use_terminal_in_slot(self.chat_id, "agent", self.slot, "echo nope", 5)

    def test_repeated_inactivity_reopen_cycles_do_not_pollute_durable_scrollback(self):
        for cycle in range(3):
            process = self.command(f"printf cycle-{cycle}")
            self.assertIn(f"cycle-{cycle}", "".join(process.output))
            terminal.close_slot(self.chat_id, "agent", self.slot, reason="inactivity")

            scrollback = terminal.get_slot_scrollback(self.chat_id, "agent", self.slot)
            self.assertIn(f"cycle-{cycle}", scrollback)
            self.assertNotIn("[Terminal closed due to inactivity]", scrollback)
            self.assertNotIn("[Terminal closed]", scrollback)

            if cycle < 2:
                self.slot = terminal.open_slot(self.chat_id, "agent", preferred_slot=self.slot)
                self.ts = terminal._slots[(self.chat_id, "agent", self.slot)]
                self.wait_for(lambda: "TEST$ " in "".join(self.ts.output))

    def test_explicit_close_is_lifecycle_state_not_durable_terminal_output(self):
        process = self.command("printf explicit-output")
        self.assertIn("explicit-output", "".join(process.output))
        terminal.close_slot(self.chat_id, "agent", self.slot, reason="explicit")
        scrollback = terminal.get_slot_scrollback(self.chat_id, "agent", self.slot)
        self.assertIn("explicit-output", scrollback)
        self.assertNotIn("[Terminal closed]", scrollback)

    def test_user_can_reopen_same_numbered_inactivity_closed_slot(self):
        terminal.close_slot(self.chat_id, "agent", self.slot, reason="inactivity")
        resumed = terminal.open_slot(self.chat_id, "agent", preferred_slot=self.slot)
        self.assertEqual(resumed, self.slot)
        self.ts = terminal._slots[(self.chat_id, "agent", self.slot)]
        self.wait_for(lambda: "TEST$ " in "".join(self.ts.output))
        self.assertFalse(self.ts.finished)


class TerminalLifecycleTests(unittest.TestCase):
    def test_semantic_keys_translate_to_portable_terminal_sequences(self):
        self.assertEqual(terminal.encode_terminal_key("C", ["CTRL"]), "\x03")
        self.assertEqual(terminal.encode_terminal_key("D", ["CTRL"]), "\x04")
        self.assertEqual(terminal.encode_terminal_key("ENTER"), "\r")
        self.assertEqual(terminal.encode_terminal_key("UP"), "\x1b[A")
        self.assertEqual(terminal.encode_terminal_key("UP", ["CTRL"]), "\x1b[1;5A")
        self.assertEqual(terminal.encode_terminal_key("TAB", ["SHIFT"]), "\x1b[Z")
        self.assertEqual(terminal.encode_terminal_key("F5"), "\x1b[15~")
        with self.assertRaisesRegex(ValueError, "Unsupported key modifier"):
            terminal.encode_terminal_key("C", ["HYPER"])
        with self.assertRaisesRegex(ValueError, "Unsupported terminal key"):
            terminal.encode_terminal_key("BANANA")

    def test_opening_slot_starts_stopped_workspace_container(self):
        fake_slot = mock.Mock(finished=False)
        chat_id = f"autostart-{time.monotonic_ns()}"
        with mock.patch.object(terminal, "_ensure_chat_dirs"), \
             mock.patch.object(terminal.docker, "container_running", return_value=False), \
             mock.patch.object(terminal.docker, "start_container", return_value=True) as start, \
             mock.patch.object(terminal.docker, "prepare_workspace_identity", return_value=True), \
             mock.patch.object(terminal, "_start_slot_proc", return_value=fake_slot):
            slot = terminal.open_slot(chat_id, "user")
            self.assertEqual(slot, 1)
            start.assert_called_once_with(chat_id)
        terminal._slots.pop((chat_id, "user", slot), None)

    def test_stopped_workspace_failure_is_actionable(self):
        with mock.patch.object(terminal, "_ensure_chat_dirs"), \
             mock.patch.object(terminal.docker, "container_running", return_value=False), \
             mock.patch.object(terminal.docker, "start_container", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "Could not start the workspace container"):
                terminal.open_slot("failed-autostart", "user")


class TerminalPersistenceTests(unittest.TestCase):
    def test_legacy_lifecycle_notices_are_scrubbed_from_scrollback(self):
        legacy = (
            "before\r\n"
            "\x1b[2m[Terminal closed due to inactivity]\x1b[0m\r\n"
            "after\n"
            "[Terminal closed]\n"
        )
        cleaned = terminal._strip_lifecycle_notices(legacy)
        self.assertIn("before", cleaned)
        self.assertIn("after", cleaned)
        self.assertNotIn("Terminal closed", cleaned)

    def test_concurrent_scrollback_saves_are_atomic_and_keep_all_slots(self):
        from vulcan import config as cfg
        with tempfile.TemporaryDirectory(prefix="vulcan-terminal-persist-") as directory:
            old_dir, old_file, old_chats = cfg.CONFIG_DIR, cfg.CONFIG_FILE, cfg.CHATS_DIR
            try:
                cfg.CONFIG_DIR = Path(directory)
                cfg.CONFIG_FILE = Path(directory) / "config.json"
                cfg.CHATS_DIR = Path(directory) / "chats"
                terminal._scrollbacks.clear()
                import threading
                threads = [
                    threading.Thread(target=terminal.save_slot_scrollback,
                                     args=("chat", "user", slot, f"slot-{slot}"))
                    for slot in (1, 2, 3)
                ]
                for thread in threads: thread.start()
                for thread in threads: thread.join()
                saved = terminal._load_slot_meta("chat")
                self.assertEqual({saved[f"user:{slot}"]["scrollback"] for slot in (1, 2, 3)},
                                 {"slot-1", "slot-2", "slot-3"})
            finally:
                terminal._scrollbacks.clear()
                cfg.CONFIG_DIR, cfg.CONFIG_FILE, cfg.CHATS_DIR = old_dir, old_file, old_chats


if __name__ == "__main__":
    unittest.main(verbosity=2)

class TmuxTerminalPersistenceTests(unittest.TestCase):
    def completed(self, code=0, stdout="", stderr=""):
        return subprocess.CompletedProcess([], code, stdout, stderr)

    def test_creates_durable_tmux_shell_once_then_configures_transport(self):
        calls = []
        results = iter([
            self.completed(1),  # has-session: absent
            self.completed(0),  # new-session
            self.completed(0),  # status off
            self.completed(0),  # prefix None
        ])

        def run(args, **kwargs):
            calls.append((args, kwargs))
            return next(results)

        with mock.patch.object(terminal.docker, "terminal_exec_flags", return_value=["--user", "1000:1000"]), \
             mock.patch.object(terminal.docker, "container_name", return_value="vulcan-chat-test"), \
             mock.patch.object(terminal.docker, "run_docker", side_effect=run):
            terminal._ensure_tmux_session(
                "chat", "agent", 2,
                workdir="/workspace",
                revive_env=["FOO=bar"],
                shell_command="umask 000; exec /bin/bash -i",
            )

        self.assertEqual(len(calls), 4)
        self.assertIn("has-session", calls[0][0])
        create = calls[1][0]
        self.assertIn("new-session", create)
        self.assertIn("vulcan-agent-2", create)
        self.assertIn("FOO=bar", create)
        self.assertIn("umask 000; exec /bin/bash -i", create)
        self.assertEqual(calls[2][0][-2:], ["status", "off"])
        self.assertEqual(calls[3][0][-2:], ["prefix", "None"])

    def test_existing_tmux_shell_is_only_reattached_not_recreated(self):
        with mock.patch.object(terminal.docker, "terminal_exec_flags", return_value=[]), \
             mock.patch.object(terminal.docker, "container_name", return_value="vulcan-chat-test"), \
             mock.patch.object(terminal.docker, "run_docker", return_value=self.completed(0)) as run:
            terminal._ensure_tmux_session(
                "chat", "agent", 1,
                workdir="/workspace",
                revive_env=[],
                shell_command="exec /bin/bash -i",
            )
        run.assert_called_once()
        self.assertIn("has-session", run.call_args.args[0])

    def test_explicit_terminal_retirement_kills_tmux_session(self):
        with mock.patch.object(terminal.docker, "container_running", return_value=True), \
             mock.patch.object(terminal.docker, "terminal_exec_flags", return_value=[]), \
             mock.patch.object(terminal.docker, "container_name", return_value="vulcan-chat-test"), \
             mock.patch.object(terminal.docker, "run_docker", return_value=self.completed(0)) as run:
            terminal._kill_slot_tmux_session("chat", "agent", 3)
        args = run.call_args.args[0]
        self.assertIn("kill-session", args)
        self.assertEqual(args[-1], "vulcan-agent-3")
