"""Terminal runtime provisioning, invoked by the current install.sh backend installer.

It operates in the
backend's Linux environment (native Linux, WSL, or Colima) using its managed
Python, and installs a separate terminal host service.
"""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from vulcan import config as cfg
from vulcan import terminal_host

NODE_VERSION = '24.20.0'


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def privileged(args):
    return args if os.geteuid() == 0 else ['sudo', '-n', *args]


def install_node():
    runtime = cfg.CONFIG_DIR / 'terminal-runtime'
    node = runtime / 'bin/node'
    if node.exists() and subprocess.check_output([str(node), '--version'], text=True).strip() == 'v' + NODE_VERSION:
        return runtime
    architecture = {'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    if platform.system() != 'Linux' or not architecture:
        raise RuntimeError('Terminal host must be provisioned in the Linux backend on x64 or arm64')
    name = f'node-v{NODE_VERSION}-linux-{architecture}.tar.xz'
    base = f'https://nodejs.org/dist/v{NODE_VERSION}/'
    cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.terminal-runtime-', dir=cfg.CONFIG_DIR) as temporary:
        stage = Path(temporary)
        archive = stage / name
        with urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=60) as response:
            checksums = response.read().decode()
        digest = next((line.split()[0] for line in checksums.splitlines() if line.split()[-1] == name), None)
        if not digest:
            raise RuntimeError('Pinned terminal runtime has no upstream checksum')
        with urllib.request.urlopen(base + name, timeout=120) as response, archive.open('wb') as output:
            shutil.copyfileobj(response, output)
        with archive.open('rb') as downloaded:
            actual_digest = hashlib.file_digest(downloaded, 'sha256').hexdigest()
        if actual_digest != digest:
            raise RuntimeError('Private terminal runtime checksum verification failed')
        with tarfile.open(archive) as bundle:
            bundle.extractall(stage, filter='data')
        extracted = stage / name.removesuffix('.tar.xz')
        previous = runtime.with_name('terminal-runtime.previous')
        if previous.exists(): shutil.rmtree(previous)
        if runtime.exists(): runtime.rename(previous)
        try:
            extracted.rename(runtime)
        except Exception:
            if previous.exists(): previous.rename(runtime)
            raise
        if previous.exists(): shutil.rmtree(previous)
    return runtime


def install_dependencies(runtime):
    sources = Path(terminal_host.__file__).with_name('terminal_host')
    digest = hashlib.sha256((sources / 'package-lock.json').read_bytes()).hexdigest()
    marker = runtime / 'dependencies.sha256'
    if marker.exists() and marker.read_text().strip() == digest and terminal_host.runtime_health()['ok']:
        return sources
    if not shutil.which('make') or not shutil.which('g++'):
        if shutil.which('apt-get'):
            run(privileged(['apt-get', 'update']))
            run(privileged(['apt-get', 'install', '-y', 'build-essential', 'python3']))
        elif shutil.which('pacman'):
            run(privileged(['pacman', '-S', '--needed', '--noconfirm', 'base-devel', 'python']))
        else:
            raise RuntimeError('Install make, g++, and Python in the backend to build terminal PTY support')
    environment = {**os.environ, 'PATH': str(runtime / 'bin') + os.pathsep + os.environ.get('PATH', '')}
    run([str(runtime / 'bin/npm'), 'ci', '--prefix', str(sources), '--omit=dev'], env=environment)
    run([str(runtime / 'bin/npm'), 'rebuild', '--prefix', str(sources), 'node-pty'], env=environment)
    if not terminal_host.runtime_health()['ok']:
        raise RuntimeError('Terminal host dependency health check failed')
    marker.write_text(digest + '\n')
    return sources


def install_service(runtime, sources, scope):
    root = cfg.CONFIG_DIR / 'terminal-host'
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    # Quoting here follows systemd's unit-file syntax, not shell syntax.
    quote = lambda value: json.dumps(str(value).replace("%", "%%"), ensure_ascii=False)
    system = scope == 'system'
    unit = '\n'.join([
        '[Unit]', 'Description=Vulcan independent terminal host', 'After=network-online.target', '',
        '[Service]', 'Type=simple',
        *([f'User={getpass.getuser()}'] if system else []),
        f'Environment={quote("HOME=" + str(Path.home()))}',
        f'Environment={quote("PATH=" + str(runtime / "bin") + ":/usr/local/bin:/usr/bin:/bin")}',
        f'ExecStart={quote(runtime / "bin/node")} {quote(sources / "host.mjs")} {quote(root)}',
        'Restart=on-failure', 'RestartSec=2', 'UMask=0077', '', '[Install]',
        'WantedBy=' + ('multi-user.target' if system else 'default.target'), ''
    ])
    if system:
        with tempfile.NamedTemporaryFile('w') as temporary:
            temporary.write(unit)
            temporary.flush()
            run(privileged(['install', '-m', '0644', temporary.name, '/etc/systemd/system/vulcan-terminal-host.service']))
        control = privileged(['systemctl'])
    else:
        directory = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'systemd/user'
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'vulcan-terminal-host.service').write_text(unit)
        control = ['systemctl', '--user']
    (root / 'service.json').write_text(json.dumps({'mode': scope}))
    run([*control, 'daemon-reload'])
    # Do not restart an existing host; shells survive app/backend updates.
    run([*control, 'enable', '--now', 'vulcan-terminal-host.service'])
    terminal_host.ensure_host()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['install', 'health'])
    parser.add_argument('--service', choices=['user', 'system'], default='user')
    args = parser.parse_args()
    if args.action == 'health':
        health = terminal_host.runtime_health()
        print(json.dumps(health))
        return 0 if health['ok'] else 1
    runtime = install_node()
    sources = install_dependencies(runtime)
    install_service(runtime, sources, args.service)
    print(json.dumps({'ok': True, 'protocol': 1}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
