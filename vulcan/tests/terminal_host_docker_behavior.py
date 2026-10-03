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
    print(json.dumps({'docker_geometry': results, 'manual_busy_interrupt': 'passed', 'backend_reconnect_same_shell': 'passed', 'persistent_environment_cwd': 'passed', 'rendered_tool_output': 'passed', 'host_loss_revive_without_rerun': 'passed', 'container_stop_restart_history_cwd_env': 'passed'}))
finally:
    try:
        health = terminal_host.call('health')
        os.kill(health['pid'], 15)
    except Exception:
        pass
    subprocess.run(['docker', 'rm', '-f', container], capture_output=True)
    shutil.rmtree(root, ignore_errors=True)
