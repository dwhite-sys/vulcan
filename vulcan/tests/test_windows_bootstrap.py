"""Validate WSL configuration convergence without touching a real distro."""
import contextlib
import io
from pathlib import Path
import re
import tempfile
import unittest

SOURCE = (Path(__file__).resolve().parents[2] / 'install.ps1').read_text()
CONFIG_SCRIPT = re.search(r"python3 - <<'PYCONFIG'\n(.*?)\nPYCONFIG", SOURCE, re.S)[1]


class WslConfigurationTests(unittest.TestCase):
    def converge(self, path):
        script = CONFIG_SCRIPT.replace("Path('/etc/wsl.conf')", f'Path({str(path)!r})')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exec(compile(script, 'wsl-config-test', 'exec'), {})
        return output.getvalue()

    def test_first_install_requests_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'wsl.conf'
            self.assertIn('VULCAN_WSL_RESTART_REQUIRED=1', self.converge(path))
            self.assertIn('systemd = true', path.read_text())
            self.assertIn('default = vulcan', path.read_text())

    def test_repeat_repair_preserves_bytes_and_does_not_request_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'wsl.conf'
            initial = '[boot]\nsystemd=true\n[user]\ndefault=vulcan\n# custom mounts\n[automount]\nroot=/custom/\n'
            path.write_text(initial)
            self.assertEqual(self.converge(path), '')
            self.assertEqual(path.read_text(), initial)

    def test_required_change_keeps_other_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'wsl.conf'
            path.write_text('[boot]\nsystemd=false\n[automount]\nroot=/custom/\n[interop]\nappendWindowsPath=false\n')
            self.assertIn('VULCAN_WSL_RESTART_REQUIRED=1', self.converge(path))
            result = path.read_text()
            self.assertIn('root = /custom/', result)
            self.assertIn('appendWindowsPath = false', result)


if __name__ == '__main__':
    unittest.main()
