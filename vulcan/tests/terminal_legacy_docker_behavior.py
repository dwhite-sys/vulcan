"""Migrate a real legacy tmux shell without replacing its process or environment."""
import os
import shutil
import subprocess
import tempfile
import time
import uuid
root = tempfile.mkdtemp(prefix='vulcan-legacy-acceptance-')
os.environ['VULCAN_CONFIG_DIR'] = root
from vulcan import terminal as term, docker
container = 'vulcan-legacy-test-' + uuid.uuid4().hex[:12]
subprocess.run(['docker', 'run', '-d', '--name', container, 'ubuntu:24.04', 'sleep', '600'], check=True, capture_output=True)
def execute(*args, **kwargs):
    return subprocess.run(['docker', 'exec', container, *args], check=True, **kwargs)
def wait(predicate):
    for _ in range(400):
        result = predicate()
        if result: return result
        time.sleep(.025)
    raise AssertionError('Legacy migration did not settle')
try:
    execute('bash', '-c', 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux', stdout=subprocess.DEVNULL)
    execute('mkdir', '-p', '/workspace')
    execute('bash', '-c', "printf '%s\\n' 'PS1=\"legacy@vulcan:\\\\w\\\\$ \"' 'export LEGACY_KEEP=preserved' > /tmp/old.bashrc")
    name = term._tmux_session_name('user', 1)
    execute('tmux', 'new-session', '-d', '-s', name, '/bin/bash --noprofile --rcfile /tmp/old.bashrc -i')
    original = execute('tmux', 'display-message', '-p', '-t', name, '#{pane_pid}', capture_output=True, text=True).stdout.strip()
    docker.container_name = lambda chat: container
    docker.workspace_path = lambda chat: '/workspace'
    docker.prepare_terminal_identity = lambda *args: True
    docker.terminal_exec_flags = lambda *args: []
    ts = term._start_slot_proc('legacy', 'user', 1)
    term._slots[('legacy', 'user', 1)] = ts
    wait(lambda: ts.shell_integration and not ts.legacy_hook_pending)
    assert not ts.host_key
    current = execute('tmux', 'display-message', '-p', '-t', name, '#{pane_pid}', capture_output=True, text=True).stdout.strip()
    assert original == current, 'Migration replaced the active legacy shell'
    pid = term.use_terminal_in_slot('legacy', 'user', 1, 'printf "%s\\n" "$LEGACY_KEEP"; false')
    cp = wait(lambda: term.get_command(pid) if term.get_command(pid).finished else None)
    assert cp.exit_code == 1, cp.exit_code
    assert 'preserved' in ''.join(cp.output), cp.output
    term.close_slot('legacy', 'user', 1)
    assert subprocess.run(['docker', 'exec', container, 'tmux', 'has-session', '-t', name], capture_output=True).returncode != 0
    print('Legacy tmux migration: same shell PID, exported environment, reliable markers, explicit close passed')
finally:
    subprocess.run(['docker', 'rm', '-f', container], capture_output=True)
    shutil.rmtree(root, ignore_errors=True)
