"""Private, versioned connection to the independently owned terminal host."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import threading
import time
import uuid
from vulcan import config as cfg

_HOST_DIR = Path(__file__).with_name('terminal_host')
_start_lock = threading.Lock()


def _request(method, key='', **params):
    address = str(cfg.CONFIG_DIR / 'terminal-host' / 'host.sock')
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(20)
        connection.connect(address)
        connection.sendall((json.dumps({'protocol': 1, 'id': uuid.uuid4().hex,
                                        'method': method, 'key': key, 'params': params}) + '\n').encode())
        with connection.makefile('rb') as stream:
            response = json.loads(stream.readline(32 * 1024 * 1024))
    if response.get('error'):
        raise RuntimeError(response['error'])
    return response['result']


def ensure_host():
    root = cfg.CONFIG_DIR / 'terminal-host'
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with _start_lock, (root / 'launcher.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            health = _request('health')
            if health['protocol'] != 1:
                raise RuntimeError('Incompatible terminal host; update its runtime')
            return
        except (ConnectionError, FileNotFoundError):
            (root / 'host.sock').unlink(missing_ok=True)
        service_path = root / 'service.json'
        if service_path.exists():
            service = json.loads(service_path.read_text())
            args = ['systemctl'] + (['--user'] if service['mode'] == 'user' else [])
            subprocess.run(args + ['start', 'vulcan-terminal-host.service'], capture_output=True, timeout=10)
            for _ in range(100):
                try:
                    _request('health')
                    return
                except (ConnectionError, FileNotFoundError):
                    time.sleep(.05)
            raise RuntimeError('Independent terminal host service is unavailable; repair the backend installation')
        node = os.environ.get('VULCAN_TERMINAL_NODE') or str(cfg.CONFIG_DIR / 'terminal-runtime' / 'bin' / 'node')
        if not Path(node).is_file():
            node = shutil.which('node')
        if not node:
            raise RuntimeError('Terminal host runtime is not installed. Repair the backend installation.')
        with (root / 'host.log').open('ab') as log:
            proc = subprocess.Popen([node, str(_HOST_DIR / 'host.mjs'), str(root)],
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                    start_new_session=True, close_fds=True)
        for _ in range(100):
            try:
                _request('health')
                return
            except (ConnectionError, FileNotFoundError):
                if proc.poll() is not None:
                    raise RuntimeError('Terminal host failed to start; see terminal-host/host.log')
                time.sleep(.05)
        raise RuntimeError('Terminal host startup timed out')


def call(method, key='', **params):
    try:
        return _request(method, key, **params)
    except (ConnectionError, FileNotFoundError):
        ensure_host()
        return _request(method, key, **params)


class RemoteProcess:
    def __init__(self, key):
        self.key = key
        self.finished = False

    def poll(self):
        if self.finished: return 0
        try:
            state = call('state', self.key)
            self.finished = state['finished']
            return 0 if self.finished else None
        except RuntimeError as error:
            if 'Unknown terminal session' in str(error):
                self.finished = True
                return 1
            raise

    def kill(self):
        call('close', self.key)
        self.finished = True


def runtime_health():
    """Read-only installation probe; does not launch the host or touch shells."""
    node = os.environ.get('VULCAN_TERMINAL_NODE') or str(cfg.CONFIG_DIR / 'terminal-runtime' / 'bin' / 'node')
    if not Path(node).is_file():
        return {'ok': False, 'protocol': 1, 'reason': 'runtime-missing'}
    try:
        version = subprocess.run([node, '--version'], capture_output=True, text=True, timeout=5, check=True).stdout.strip()
        if int(version.lstrip('v').split('.')[0]) < 22:
            return {'ok': False, 'protocol': 1, 'reason': 'runtime-incompatible'}
        subprocess.run([node, '--input-type=module', '-e', "await import('./session.mjs')"], cwd=_HOST_DIR,
                       capture_output=True, timeout=5, check=True)
        return {'ok': True, 'protocol': 1, 'node': version}
    except (OSError, ValueError, subprocess.SubprocessError):
        return {'ok': False, 'protocol': 1, 'reason': 'dependencies-unhealthy'}
