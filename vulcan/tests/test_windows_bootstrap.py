"""Validate WSL configuration convergence without touching a real distro."""
import contextlib
import io
from pathlib import Path
import re
import tempfile
import subprocess
import unittest

SOURCE = (Path(__file__).resolve().parents[2] / 'install.ps1').read_text()
BOOTSTRAP = re.search(r"\$bootstrap = @'\n(.*?)\n'@", SOURCE, re.S)[1]
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


class DockerProvisioningTests(unittest.TestCase):
    def plan(self, installed, group_exists):
        # Execute the actual package plan with fake system commands, so an inherited
        # docker CLI is visible but no host packages/accounts can be changed.
        prelude = f"installed={int(installed)}; group_exists={int(group_exists)}\n" + r"""
command() { return 0; }
dpkg-query() {
    if [[ "${@: -1}" == docker.io && "$installed" == 0 ]]; then return 1; fi
    printf 'install ok installed'
}
apt-get() { printf 'APT: %s\n' "$*" >&2; installed=1; }
getent() { [[ "$group_exists" == 1 ]]; }
groupadd() { printf 'GROUP: %s\n' "$*"; }
"""
        plan = BOOTSTRAP.split('if ! id vulcan')[0]
        result = subprocess.run(['bash', '-c', prelude + plan], check=True, capture_output=True, text=True)
        return result.stdout + result.stderr

    def test_client_without_native_package_installs_engine(self):
        result = self.plan(installed=False, group_exists=False)
        self.assertIn('docker.io', result)
        self.assertIn('GROUP: --system docker', result)

    def test_native_engine_and_group_do_not_reinstall(self):
        result = self.plan(installed=True, group_exists=True)
        self.assertNotIn('docker.io', result)
        self.assertNotIn('GROUP:', result)

    def test_missing_group_is_repaired_even_with_package_installed(self):
        self.assertIn('GROUP: --system docker', self.plan(installed=True, group_exists=False))


if __name__ == '__main__':
    unittest.main()
