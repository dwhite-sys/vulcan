"""Opt-in real Docker + Python tools + independent host behavioral acceptance.
Run with the backend Python runtime and Docker available; no existing container
or config directory is modified.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

root = tempfile.mkdtemp(prefix='vulcan-terminal-acceptance-')
os.environ['VULCAN_CONFIG_DIR'] = root
from vulcan import terminal as term, terminal_host, docker
container = 'vulcan-terminal-test-' + uuid.uuid4().hex[:12]
subprocess.run(['docker', 'run', '-d', '--name', container, 'ubuntu:24.04', 'sleep', '600'], check=True, capture_output=True)
try:
    subprocess.run(['docker', 'exec', container, 'mkdir', '-p', '/workspace'], check=True)
    docker.container_name = lambda chat: container
    docker.workspace_path = lambda chat: '/workspace'
    docker.prepare_terminal_identity = lambda *args: True
    docker.prepare_workspace_identity = lambda *args: True
    docker.terminal_exec_flags = lambda *args: []
    ts = term._start_slot_proc('acceptance', 'user', 1, cols=80, rows=24)
    term._slots[('acceptance', 'user', 1)] = ts
    def wait(predicate):
        for _ in range(300):
            value = predicate()
            if value: return value
            time.sleep(.02)
        raise AssertionError('Terminal did not reach expected state')
    wait(lambda: ts.shell_integration)
    term.resize_slot('acceptance', 'user', 1, 0, 0)
    assert (ts.cols, ts.rows) == (80, 24)
    unchanged = terminal_host.call('state', ts.host_key)
    assert (unchanged['cols'], unchanged['rows']) == (80, 24)
    results = []
    for cols, rows in [(30, 12), (160, 40), (55, 19), (80, 24)]:
        term.resize_slot('acceptance', 'user', 1, cols, rows)
        pid = term.use_terminal_in_slot('acceptance', 'user', 1, 'stty size; printf "Unicode: café 世界\\n"; false')
        cp = wait(lambda: term.get_command(pid) if term.get_command(pid).finished else None)
        output = ''.join(cp.output)
        assert f'{rows} {cols}' in output, output
        assert 'café 世界' in output, output
        assert cp.exit_code == 1, cp.exit_code
        assert '\x1b' not in output, repr(output)
        results.append({'cols': cols, 'rows': rows, 'exit_code': cp.exit_code})
    pid = term.use_terminal_in_slot('acceptance', 'user', 1, 'export VULCAN_ACCEPTANCE=kept; cd /tmp; printf "state saved\\n"')
    wait(lambda: term.get_command(pid).finished)
    term.send_slot_input('acceptance', 'user', 1, 'sleep 30\n')
    wait(lambda: ts.prompt_busy)
    try:
        term.use_terminal_in_slot('acceptance', 'user', 1, 'echo should-not-run')
        raise AssertionError('Manual foreground command was not detected')
    except RuntimeError as error:
        assert 'busy' in str(error).lower() or 'foreground' in str(error).lower(), error
    term.send_slot_input('acceptance', 'user', 1, '\x03')
    wait(lambda: not ts.prompt_busy)
    # Drop/recreate the Python handle: the independent host owns the same shell.
    restored = term._start_slot_proc('acceptance', 'user', 1, cols=80, rows=24)
    assert restored.generation == ts.generation
    term._slots[('acceptance', 'user', 1)] = restored
    wait(lambda: restored.shell_integration)
    pid = term.use_terminal_in_slot('acceptance', 'user', 1, 'printf "%s\\n" "$VULCAN_ACCEPTANCE"; pwd')
    cp = wait(lambda: term.get_command(pid) if term.get_command(pid).finished else None)
    assert 'kept' in ''.join(cp.output) and '/tmp' in ''.join(cp.output), cp.output
    snapshot = terminal_host.call('snapshot', ts.host_key)
    # A late/unknown viewer cursor receives a coherent snapshot, not an empty tail.
    replay = terminal_host.call('poll', ts.host_key, sequence=0, generation='previous')
    assert replay['snapshot']['generation'] == snapshot['generation']
    assert '1;2c0;276;0c' not in term.read_slot_output('acceptance', 'user', 1, 500)
    pid = term.use_terminal_in_slot('acceptance', 'user', 1, 'printf "HOST_LOSS_PID=%s\\n" "$BASHPID"; printf once >> /tmp/not-rerun; sleep 30')
    wait(lambda: ts.prompt_busy or restored.prompt_busy)
    time.sleep(.2)
    import re
    old_shell_pid = re.search(r'HOST_LOSS_PID=(\d+)', ''.join(term.get_command(pid).output)).group(1)
    time.sleep(1.2)  # Observe a durable checkpoint before simulating host loss.
    health = terminal_host.call('health')
    os.kill(health['pid'], 9)
    time.sleep(.2)
    orphan = subprocess.run(['docker', 'exec', container, 'bash', '-c', f'kill -0 {old_shell_pid} 2>/dev/null'], capture_output=True).returncode == 0
    # Docker may retain the inner shell; revival retires it using its verified token.
    revived = term._start_slot_proc('acceptance', 'user', 1, cols=80, rows=24)
    term._slots[('acceptance', 'user', 1)] = revived
    wait(lambda: revived.shell_integration)
    time.sleep(.2)
    retired = subprocess.run(['docker', 'exec', container, 'bash', '-c', f'kill -0 {old_shell_pid} 2>/dev/null'], capture_output=True).returncode != 0
    assert retired, 'Revival failed to retire the abandoned inner shell'
    assert revived.generation != restored.generation
    interrupted = term.get_command(pid)
    assert interrupted.finished and interrupted.exit_code is None, interrupted
    assert 'not rerun' in interrupted.detach_reason
    pid = term.use_terminal_in_slot('acceptance', 'user', 1, 'cat /tmp/not-rerun; printf "\\n%s\\n" "$VULCAN_ACCEPTANCE"; pwd')
    cp = wait(lambda: term.get_command(pid) if term.get_command(pid).finished else None)
    output = ''.join(cp.output)
    assert 'once' in output and 'onceonce' not in output, output
    assert 'kept' in output and '/tmp' in output, output
    time.sleep(1.2)
    generation_before_stop = revived.generation
    subprocess.run(['docker', 'stop', '-t', '1', container], check=True, capture_output=True)
    wait(lambda: revived.finished)
    subprocess.run(['docker', 'start', container], check=True, capture_output=True)
    restarted = term._start_slot_proc('acceptance', 'user', 1, cols=80, rows=24)
    term._slots[('acceptance', 'user', 1)] = restarted
    wait(lambda: restarted.shell_integration)
    assert restarted.generation != generation_before_stop
    pid = term.use_terminal_in_slot('acceptance', 'user', 1, 'printf "%s\\n" "$VULCAN_ACCEPTANCE"; pwd')
    cp = wait(lambda: term.get_command(pid) if term.get_command(pid).finished else None)
    assert 'kept' in ''.join(cp.output) and '/tmp' in ''.join(cp.output)
    assert 'Unicode: café 世界' in term.read_slot_output('acceptance', 'user', 1, lines=5000)
    # Execute immediately after shell death: recovery must wait for integration,
    # retain the real exit code, and permit subsequent ordinary tool commands.
    subprocess.run(['docker', 'exec', container, 'bash', '-c', "printf '\\nsleep .3\\n' >> /root/.bashrc"], check=True)
    pid = term.use_terminal_in_slot('acceptance', 'user', 1, 'printf "EXIT42_LATEST_HISTORY\\n"; exit 42')
    cp = wait(lambda: term.get_command(pid) if term.get_command(pid).finished else None)
    assert cp.exit_code == 42, cp.exit_code
    for count in range(20):
        pid = term.use_terminal_in_slot('acceptance', 'user', 1, f'printf "SEQUENTIAL_{count}\\n"; false' if count % 2 else f'printf "SEQUENTIAL_{count}\\n"')
        cp = wait(lambda: term.get_command(pid) if term.get_command(pid).finished else None)
        assert cp.exit_code == count % 2, (count, cp.exit_code)
        assert f'SEQUENTIAL_{count}' in ''.join(cp.output)
    assert 'EXIT42_LATEST_HISTORY' in term.read_slot_output('acceptance', 'user', 1, lines=5000)
    # Foreground process close must not stop a different terminal's job.
    second = term._start_slot_proc('acceptance', 'user', 2)
    term._slots[('acceptance', 'user', 2)] = second
    third = term._start_slot_proc('acceptance', 'user', 3)
    term._slots[('acceptance', 'user', 3)] = third
    first_pid = term.use_terminal_in_slot('acceptance', 'user', 2, 'printf "FOREGROUND_READY\\n"; sleep 300')
    sibling_pid = term.use_terminal_in_slot('acceptance', 'user', 3, 'sleep 300')
    wait(lambda: 'FOREGROUND_READY' in ''.join(term.get_command(first_pid).output))
    shell_pid = subprocess.check_output(['docker', 'exec', container, 'bash', '-c', 'read -r pid token < /tmp/vulcan-host-user-2.pid; printf "%s" "$pid"'], text=True).strip()
    def foreground_child():
        pid = subprocess.check_output(['docker', 'exec', container, 'bash', '-c', f'IFS= read -r status < /proc/{shell_pid}/stat; read -r state parent group session tty foreground rest <<< "${{status##*) }}"; printf "%s" "$foreground"'], text=True).strip()
        return pid if pid.isdigit() and int(pid) > 1 and pid != shell_pid else None
    child_pid = wait(foreground_child)
    def child_running():
        probe = subprocess.run(['docker', 'exec', container, 'bash', '-c', f'IFS= read -r status < /proc/{child_pid}/stat || exit 1; read -r state rest <<< "${{status##*) }}"; [ "$state" != Z ]'], capture_output=True)
        return probe.returncode == 0
    assert child_running()
    term.close_slot('acceptance', 'user', 2)
    wait(lambda: not child_running())
    assert not third.finished and not term.get_command(sibling_pid).finished
    term.send_slot_input('acceptance', 'user', 3, '\x03')
    wait(lambda: term.get_command(sibling_pid).finished)
    print(json.dumps({'docker_geometry': results, 'manual_busy_interrupt': 'passed', 'backend_reconnect_same_shell': 'passed', 'persistent_environment_cwd': 'passed', 'rendered_tool_output': 'passed', 'host_loss_revive_without_rerun': 'passed', 'container_stop_restart_history_cwd_env': 'passed', 'exit_status_immediate_recovery_sequential_commands': 'passed', 'close_foreground_sibling_isolation': 'passed'}))
finally:
    try:
        health = terminal_host.call('health')
        os.kill(health['pid'], 15)
    except Exception:
        pass
    subprocess.run(['docker', 'rm', '-f', container], capture_output=True)
    shutil.rmtree(root, ignore_errors=True)
