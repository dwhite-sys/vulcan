"""Provisioning safety and service lifecycle tests; no live installation changes."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from vulcan import terminal_runtime as runtime


class ProvisioningTests(unittest.TestCase):
    def archive(self, name='node-v24.20.0-linux-x64/bin/node'):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:xz') as bundle:
            content = b'private-node'
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
            bundle.addfile(entry, io.BytesIO(content))
        return data.getvalue()

    def provision(self, root, payload, digest):
        filename = 'node-v24.20.0-linux-x64.tar.xz'
        def download(url, **kwargs):
            return io.BytesIO((digest + '  ' + filename).encode() if url.endswith('.txt') else payload)
        with patch.object(runtime.cfg, 'CONFIG_DIR', root), patch.object(runtime.platform, 'machine', return_value='x86_64'), patch.object(runtime.platform, 'system', return_value='Linux'), patch.object(runtime.urllib.request, 'urlopen', side_effect=download):
            return runtime.install_node()

    def test_checksum_failure_leaves_existing_runtime_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = root / 'terminal-runtime'
            old.mkdir()
            (old / 'saved').write_text('keep')
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                self.provision(root, self.archive(), '0' * 64)
            self.assertEqual((old / 'saved').read_text(), 'keep')

    def test_verified_archive_installs_atomically(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = self.archive()
            installed = self.provision(root, payload, hashlib.sha256(payload).hexdigest())
            self.assertEqual((installed / 'bin/node').read_bytes(), b'private-node')
            self.assertFalse((root / 'terminal-runtime.previous').exists())

    def test_archive_cannot_escape_private_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = self.archive('../../escaped-node')
            with self.assertRaises(tarfile.FilterError):
                self.provision(root, payload, hashlib.sha256(payload).hexdigest())

    def test_provisioning_keeps_running_host_and_separate_service(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(runtime.cfg, 'CONFIG_DIR', root), patch.dict(runtime.os.environ, {'XDG_CONFIG_HOME': str(root / 'config')}), patch.object(runtime, 'run') as commands, patch.object(runtime.terminal_host, 'ensure_host') as health:
                runtime.install_service(root / 'terminal-runtime', root / 'payload', 'user')
            unit = (root / 'config/systemd/user/vulcan-terminal-host.service').read_text()
            self.assertIn('host.mjs', unit)
            self.assertNotIn('PartOf=', unit)
            self.assertNotIn('BindsTo=', unit)
            self.assertEqual(json.loads((root / 'terminal-host/service.json').read_text()), {'mode': 'user'})
            self.assertEqual(commands.call_args_list[-1].args[0], ['systemctl', '--user', 'enable', '--now', 'vulcan-terminal-host.service'])
            self.assertTrue(all('restart' not in call.args[0] for call in commands.call_args_list))
            health.assert_called_once()


if __name__ == '__main__':
    unittest.main()
