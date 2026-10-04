"""Real HTTP-server close, sibling isolation, and retry-free shell recovery."""
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
root = tempfile.mkdtemp(prefix='vulcan-terminal-edge-')
os.environ['VULCAN_CONFIG_DIR'] = root
from vulcan import terminal as term, terminal_host, docker
container = 'vulcan-terminal-edge-' + uuid.uuid4().hex[:10]
subprocess.run(['docker', 'run', '-d', '--name', container, 'ubuntu:24.04', 'sleep', '600'], check=True, capture_output=True)
def wait(predicate):
    for _ in range(300):
        result = predicate()
        if result: return result
        time.sleep(.02)
    raise AssertionError('Terminal edge case did not settle')
try:
    subprocess.run(['docker', 'exec', container, 'bash', '-c', 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['docker', 'exec', container, 'mkdir', '-p', '/workspace'], check=True)
    docker.container_name = lambda chat: container
    docker.workspace_path = lambda chat: '/workspace'
    docker.prepare_terminal_identity = lambda *args: True
    docker.prepare_workspace_identity = lambda *args: True
    for slot in (1, 2):
        ts = term._start_slot_proc('edges', 'user', slot)
        term._slots[('edges', 'user', slot)] = ts
    server = term.use_terminal_in_slot('edges', 'user', 1, 'python3 -u -m http.server 0 --bind 127.0.0.1')
    sibling = term.use_terminal_in_slot('edges', 'user', 2, 'sleep 300')
    output = wait(lambda: ''.join(term.get_command(server).output) if 'Serving HTTP' in ''.join(term.get_command(server).output) else None)
    port = re.search(r'port (\d+)', output).group(1)
    def reachable():
        return subprocess.run(['docker', 'exec', container, 'python3', '-c', f'import urllib.request; urllib.request.urlopen("http://127.0.0.1:{port}",timeout=.3)'], capture_output=True).returncode == 0
    assert reachable()
    term.close_slot('edges', 'user', 1)
    assert term.get_command(server).finished
    assert term.get_command(server).exit_code is None
    wait(lambda: not reachable())
    time.sleep(.1)
    assert term._slots[('edges', 'user', 1)].close_reason == 'explicit'
    assert not term.get_command(sibling).finished, 'Closing one terminal stopped another'
    print('HTTP foreground server stops on explicit close; sibling terminal remains running')
finally:
    try: os.kill(terminal_host.call('health')['pid'], 15)
    except Exception: pass
    subprocess.run(['docker', 'rm', '-f', container], capture_output=True)
    shutil.rmtree(root, ignore_errors=True)
