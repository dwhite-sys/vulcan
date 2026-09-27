"""Dependency-free coverage for server-owned chat container lifecycle policy."""

from __future__ import annotations

import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from vulcan import config as cfg
from vulcan import container_lifecycle as lifecycle
from vulcan import docker


class ContainerLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="vulcan-lifecycle-tests-")
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.patches = self.enterContext(mock.patch.multiple(
            cfg,
            CONFIG_DIR=root,
            CONFIG_FILE=root / "config.json",
            CHATS_DIR=root / "chats",
        ))
        lifecycle._service_leases.clear()
        lifecycle._client_chat_leases.clear()
        self.addCleanup(lifecycle._service_leases.clear)
        self.addCleanup(lifecycle._client_chat_leases.clear)

    @staticmethod
    def running_status(chat_id: str) -> dict:
        return {
            "image_exists": True,
            "container_exists": True,
            "container_running": True,
            "container_name": f"vulcan-chat-{chat_id}",
            "gpu_enabled": False,
            "network_mode": "host",
            "host_network": True,
        }

    def mock_running(self, chat_ids: list[str]):
        self.enterContext(mock.patch.object(docker, "list_running_containers", return_value=chat_ids))
        self.enterContext(mock.patch.object(docker, "status", side_effect=self.running_status))
        self.enterContext(mock.patch.object(docker, "container_has_listening_service", return_value=False))
        self.enterContext(mock.patch.object(lifecycle.terminal, "list_slots", return_value=[]))
        self.enterContext(mock.patch.object(lifecycle, "_active_run", return_value=False))

    def test_policy_defaults_to_thirty_minutes_and_persists_updates(self):
        current = lifecycle.policy()
        self.assertEqual(current["idle_timeout_seconds"], 1800)
        self.assertEqual(current["reap_interval_seconds"], 30)
        self.assertTrue(current["protect_active_runs"])
        self.assertTrue(current["protect_open_terminals"])
        self.assertTrue(current["protect_dashboard_services"])

        updated = lifecycle.update_policy({"idle_timeout_seconds": 600})
        self.assertEqual(updated["idle_timeout_seconds"], 600)
        self.assertEqual(json.loads(cfg.CONFIG_FILE.read_text())["containers"]["idle_timeout_seconds"], 600)

    def test_policy_validation_rejects_unsafe_or_unrecognized_values(self):
        for values in (
            {"idle_timeout_seconds": -1},
            {"idle_timeout_seconds": True},
            {"reap_interval_seconds": 4},
            {"protect_active_runs": "yes"},
            {"unexpected": 1},
        ):
            with self.subTest(values=values), self.assertRaises(ValueError):
                lifecycle.update_policy(values)

    def test_idle_timeout_zero_disables_container_reaping(self):
        lifecycle.update_policy({"idle_timeout_seconds": 0})
        with mock.patch.object(docker, "list_running_containers") as containers:
            result = lifecycle.reap_idle_containers()
        containers.assert_not_called()
        self.assertFalse(result["enabled"])

    def test_newly_discovered_running_container_receives_full_grace_period(self):
        self.mock_running(["new-container"])
        with mock.patch.object(docker, "stop_container") as stop:
            result = lifecycle.reap_idle_containers(now=10_000)
        stop.assert_not_called()
        self.assertEqual(result["stopped"], [])
        self.assertEqual(lifecycle._read_state("new-container")["last_activity"], 10_000)

    def test_expired_container_stops_without_deleting_container_or_workspace(self):
        self.mock_running(["idle-container"])
        lifecycle.record_activity("idle-container", "chat-opened", at=1_000)
        with mock.patch.object(docker, "stop_container", return_value=True) as stop, \
             mock.patch.object(docker, "remove_container") as remove:
            result = lifecycle.reap_idle_containers(now=2_801)
        stop.assert_called_once_with("idle-container")
        remove.assert_not_called()
        self.assertEqual(result["stopped"], ["idle-container"])
        self.assertEqual(lifecycle._read_state("idle-container")["last_stop_reason"], "idle-timeout")

    def test_recent_activity_keeps_container_running(self):
        self.mock_running(["recent-container"])
        lifecycle.record_activity("recent-container", "workspace/write-file", at=2_000)
        with mock.patch.object(docker, "stop_container") as stop:
            lifecycle.reap_idle_containers(now=2_500)
        stop.assert_not_called()

    def test_active_agent_run_is_protected_and_refreshes_activity(self):
        self.mock_running(["agent-container"])
        lifecycle.record_activity("agent-container", "old", at=1_000)
        with mock.patch.object(lifecycle, "_active_run", return_value=True), \
             mock.patch.object(docker, "stop_container") as stop:
            result = lifecycle.reap_idle_containers(now=5_000)
        stop.assert_not_called()
        self.assertEqual(result["protected"], ["agent-container"])
        self.assertEqual(lifecycle._read_state("agent-container")["last_activity_source"], "active-agent-run")

    def test_open_chat_presence_protects_container_from_idle_reaping(self):
        self.mock_running(["viewed-container"])
        lifecycle.record_activity("viewed-container", "old", at=1_000)
        with mock.patch.object(lifecycle.time, "time", return_value=5_000):
            lifecycle.set_client_chat("client-a", "viewed-container")
        # Make the persisted activity old again so the test proves protection is
        # the live lease rather than the chat-open timestamp itself.
        lifecycle.record_activity("viewed-container", "old-again", at=1_000)
        with mock.patch.object(docker, "stop_container") as stop:
            result = lifecycle.reap_idle_containers(now=5_000)
        stop.assert_not_called()
        self.assertEqual(result["protected"], ["viewed-container"])
        details = lifecycle.inspect_container("viewed-container", now=5_000)
        self.assertIn("open-chat", details["protection_reasons"])
        self.assertEqual(details["open_client_count"], 1)

    def test_client_presence_moves_between_chats_and_disconnect_releases_it(self):
        lifecycle.set_client_chat("client-a", "first-chat")
        self.assertEqual(lifecycle._open_client_count("first-chat"), 1)
        lifecycle.set_client_chat("client-a", "second-chat")
        self.assertEqual(lifecycle._open_client_count("first-chat"), 0)
        self.assertEqual(lifecycle._open_client_count("second-chat"), 1)
        lifecycle.set_client_chat("client-a", None)
        self.assertEqual(lifecycle._open_client_count("second-chat"), 0)

    def test_open_chat_does_not_block_explicit_manual_stop(self):
        self.mock_running(["manual-viewed-container"])
        lifecycle.set_client_chat("client-a", "manual-viewed-container")
        with mock.patch.object(docker, "stop_container", return_value=True) as stop:
            result = lifecycle.stop_container("manual-viewed-container", reason="manual")
        self.assertTrue(result["ok"])
        self.assertTrue(result["stopped"])
        stop.assert_called_once_with("manual-viewed-container")

    def test_open_terminal_protects_container_even_when_shell_is_idle(self):
        self.mock_running(["terminal-container"])
        lifecycle.record_activity("terminal-container", "old", at=1_000)
        slot = {"kind": "user", "slot": 1, "finished": False, "has_running": False}
        with mock.patch.object(lifecycle.terminal, "list_slots", return_value=[slot]), \
             mock.patch.object(docker, "stop_container") as stop:
            result = lifecycle.reap_idle_containers(now=5_000)
        stop.assert_not_called()
        self.assertEqual(result["protected"], ["terminal-container"])

    def test_container_owned_listener_protects_dashboard_services(self):
        self.mock_running(["dashboard-container"])
        lifecycle.record_activity("dashboard-container", "old", at=1_000)
        with mock.patch.object(docker, "container_has_listening_service", return_value=True), \
             mock.patch.object(docker, "stop_container") as stop:
            result = lifecycle.reap_idle_containers(now=5_000)
        stop.assert_not_called()
        self.assertEqual(result["protected"], ["dashboard-container"])

    def test_proxy_service_leases_are_reference_counted_and_refresh_after_close(self):
        self.mock_running(["proxy-container"])
        lifecycle.begin_service("proxy-container", 8600)
        lifecycle.begin_service("proxy-container", 8600)
        details = lifecycle.inspect_container("proxy-container")
        self.assertEqual(details["active_service_ports"], [8600])
        self.assertIn("dashboard-service", details["protection_reasons"])

        lifecycle.end_service("proxy-container", 8600)
        self.assertEqual(lifecycle.inspect_container("proxy-container")["active_service_ports"], [8600])
        lifecycle.end_service("proxy-container", 8600)
        self.assertEqual(lifecycle.inspect_container("proxy-container")["active_service_ports"], [])
        self.assertEqual(lifecycle._read_state("proxy-container")["last_activity_source"], "dashboard-service-ended")

    def test_manual_stop_refuses_active_work_unless_explicitly_forced(self):
        self.mock_running(["manual-container"])
        with mock.patch.object(lifecycle, "_active_run", return_value=True), \
             mock.patch.object(docker, "stop_container", return_value=True) as stop, \
             mock.patch.object(lifecycle.agent_runtime.MANAGER, "cancel", return_value=True) as cancel:
            protected = lifecycle.stop_container("manual-container")
            self.assertFalse(protected["ok"])
            self.assertEqual(protected["protection_reasons"], ["active-agent-run"])
            stop.assert_not_called()

            forced = lifecycle.stop_container("manual-container", force=True)
        self.assertTrue(forced["ok"])
        cancel.assert_called_once_with("manual-container")
        stop.assert_called_once_with("manual-container")

    def test_reaper_rechecks_protection_before_stopping(self):
        self.mock_running(["race-container"])
        lifecycle.record_activity("race-container", "old", at=1_000)
        slot = {"kind": "agent", "slot": 1, "finished": False, "has_running": True}
        with mock.patch.object(lifecycle.terminal, "list_slots", side_effect=[[], [slot]]), \
             mock.patch.object(docker, "stop_container") as stop:
            result = lifecycle.reap_idle_containers(now=5_000)
        stop.assert_not_called()
        self.assertEqual(result["protected"], ["race-container"])

    def test_state_paths_reject_directory_traversal(self):
        for identifier in ("../outside", "nested/chat", "..", ""):
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                lifecycle.record_activity(identifier, "invalid")

    def test_host_network_service_detection_requires_container_process_ownership(self):
        host_only = types.SimpleNamespace(
            returncode=0,
            stdout="LISTEN 0 4096 127.0.0.1:8468 0.0.0.0:*\n",
        )
        owned = types.SimpleNamespace(
            returncode=0,
            stdout='LISTEN 0 4096 0.0.0.0:8600 0.0.0.0:* users:(("python",pid=21,fd=4))\n',
        )
        with mock.patch.object(docker, "run_docker", return_value=host_only):
            self.assertFalse(docker.container_has_listening_service("service-container"))
        with mock.patch.object(docker, "run_docker", return_value=owned) as command:
            self.assertTrue(docker.container_has_listening_service("service-container"))
        self.assertEqual(command.call_args.args[0][-2:], ["ss", "-ltnpH"])


if __name__ == "__main__":
    unittest.main()
