[CmdletBinding()]
param(
    [switch]$FromApp,
    [string]$ResourcesDir = "",
    [string]$Version = "unknown",
    [switch]$Json,
    [switch]$ElevatedWslBootstrap
)

$ErrorActionPreference = "Stop"
# Match Microsoft's WSL diagnostics: avoid UTF-16/NUL and code-page corruption.
$env:WSL_UTF8 = "1"
$OutputEncoding = New-Object Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $OutputEncoding } catch { }
$DistroName = "Vulcan"
$EtnaPackage = "etna-mcp>=1.0.0b41"
$LocalRoot = Join-Path $env:LOCALAPPDATA "Vulcan"
$WslRoot = Join-Path $LocalRoot "wsl"
$CacheRoot = Join-Path $LocalRoot "cache"
$BinRoot = Join-Path $LocalRoot "bin"
$PythonRoot = Join-Path $LocalRoot "python"
$UvToolRoot = Join-Path $LocalRoot "uv-tools"
New-Item -ItemType Directory -Force -Path $LocalRoot,$CacheRoot,$BinRoot,$PythonRoot,$UvToolRoot | Out-Null

$env:UV_PYTHON_INSTALL_DIR = $PythonRoot
$env:UV_TOOL_DIR = $UvToolRoot
$env:UV_TOOL_BIN_DIR = $BinRoot
if (($env:Path -split ';') -notcontains $BinRoot) { $env:Path = "$BinRoot;$env:Path" }

function Write-Step([string]$Message) { Write-Host "Vulcan: $Message" }
function Emit-Result([hashtable]$Value) {
    if ($Json) {
        $payload = $Value | ConvertTo-Json -Compress -Depth 6
        Write-Host "VULCAN_RESULT=$payload"
    }
}
function Fail([string]$Message, [int]$Code = 1) {
    Emit-Result @{ ok = $false; message = $Message }
    Write-Error "Vulcan install failed: $Message" -ErrorAction Continue
    exit $Code
}
function Invoke-Wsl([string[]]$Arguments, [switch]$Capture) {
    # Preserve WSL's own error code/message instead of displaying unrelated pip warnings.
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& wsl.exe @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    $detail = (($output | ForEach-Object { ([string]$_).Replace([string][char]0, "") }) -join "`n").Trim()
    if ($code -ne 0) {
        $commandText = ($Arguments -join ' ') -replace 'echo [A-Za-z0-9+/=]{80,}', 'echo [encoded bootstrap]'
        if ($commandText.Length -gt 240) { $commandText = $commandText.Substring(0, 240) + "..." }
        Fail "WSL operation failed (exit $code): wsl.exe $commandText`n$detail`nCheck WSL with wsl --status and wsl --list --verbose."
    }
    if ($Capture) { return $detail }
    if ($detail) { Write-Host $detail }
}

# Turn unexpected PowerShell exceptions into the same machine-readable result.
trap {
    Fail $_.Exception.Message
}

function Test-WslAvailable {
    try {
        & wsl.exe --status *> $null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}
function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-TcpPort([string]$HostName, [int]$Port, [int]$TimeoutMs = 500) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync($HostName, $Port)
        if (-not $task.Wait($TimeoutMs)) { return $false }
        return $client.Connected
    } catch { return $false }
    finally { $client.Dispose() }
}

function Start-StandaloneWindowsInstall {
    $release = Invoke-RestMethod `
        -UseBasicParsing `
        -Uri "https://api.github.com/repos/dwhite-sys/vulcan/releases/latest"

    $asset = $release.assets |
        Where-Object { $_.name -eq "Vulcan-Setup.exe" } |
        Select-Object -First 1

    if (-not $asset) {
        Fail "Vulcan-Setup.exe was not found in the latest release"
    }

    $digest = [string]$asset.digest

    if ($digest -notmatch '^sha256:([0-9A-Fa-f]{64})$') {
        Fail "Vulcan-Setup.exe does not have a valid SHA-256 digest"
    }

    $expected = $Matches[1].ToLowerInvariant()
    $tmp = Join-Path `
        ([IO.Path]::GetTempPath()) `
        ("Vulcan-Setup-{0}.exe" -f [Guid]::NewGuid())

    try {
        Write-Step "Downloading Vulcan"

        Invoke-WebRequest `
            -UseBasicParsing `
            -Uri $asset.browser_download_url `
            -OutFile $tmp

        $actual = (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLowerInvariant()

        if ($actual -ne $expected) {
            Fail "Vulcan installer checksum verification failed"
        }

        Write-Step "Launching Vulcan installer"

        $proc = Start-Process `
            -FilePath $tmp `
            -Wait `
            -PassThru

        if ($proc.ExitCode -ne 0) {
            Fail "Vulcan installer exited with code $($proc.ExitCode)"
        }
    }
    finally {
        Remove-Item -Force $tmp -ErrorAction SilentlyContinue
    }
}

if (-not $FromApp -and -not $ResourcesDir -and -not $ElevatedWslBootstrap) {
    Start-StandaloneWindowsInstall
    exit 0
}

function Test-EtnaHealth {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:8467/health"
        if ($r.StatusCode -ne 200) { return $false }
        $body = [string]$r.Content
        return $body -match '"service"\s*:\s*"etna-mcp"' -and $body -match '"status"\s*:\s*"ok"'
    }
    catch { return $false }
}

function Wait-EtnaHealth {
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if (Test-EtnaHealth) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Get-HostEtnaCommand {
    if ($script:HostEtnaCommand -and (Test-Path $script:HostEtnaCommand -PathType Leaf)) { return $script:HostEtnaCommand }
    $cmd = Get-Command etna -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -and -not $_.Source.StartsWith($BinRoot, [StringComparison]::OrdinalIgnoreCase) } |
        Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    # uv's user tool directory may not be on the current process PATH yet.
    $candidate = Join-Path $HOME ".local\bin\etna.exe"
    if (Test-Path $candidate -PathType Leaf) { return $candidate }
    return $null
}

function Get-EtnaInitializationVerb([string]$HelpText) {
    $plain = [regex]::Replace($HelpText, '\x1b\[[0-?]*[ -/]*[@-~]', '')
    if ($plain -match '\binit\b') { return "init" }
    # Older Etna initializes its runtime with a bare install command.
    return "install"
}

function Invoke-EtnaModule([string]$Verb) {
    foreach ($python in @("python", "py")) {
        $cmd = Get-Command $python -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $cmd) { continue }
        try {
            $prefix = if ($python -eq "py") { @("-3", "-m", "etna") } else { @("-m", "etna") }
            $helpText = (& $cmd.Source @prefix --help | Out-String)
            if ($LASTEXITCODE -ne 0) { continue }
            $actualVerb = if ($Verb -eq "init") { Get-EtnaInitializationVerb $helpText } else { $Verb }
            # Native stdout must not become part of the function's return value.
            & $cmd.Source @prefix $actualVerb | Out-Host
            return [int]$LASTEXITCODE
        } catch { }
    }

    $etna = Get-HostEtnaCommand
    if (-not $etna) { return 127 }
    $actualVerb = $Verb
    if ($Verb -eq "init") {
        $helpText = (& $etna --help | Out-String)
        if ($LASTEXITCODE -ne 0) { return [int]$LASTEXITCODE }
        $actualVerb = Get-EtnaInitializationVerb $helpText
    }
    & $etna $actualVerb | Out-Host
    return [int]$LASTEXITCODE
}

function Install-EtnaIfAbsent {
    # Acquisition only. Never use this ladder to repair an existing Etna home.
    foreach ($python in @("python", "py")) {
        $cmd = Get-Command $python -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $cmd) { continue }
        try {
            if ($python -eq "py") { & $cmd.Source -3 -m pip --version *> $null }
            else { & $cmd.Source -m pip --version *> $null }
            if ($LASTEXITCODE -ne 0) { continue }
            Write-Step "Installing Etna with pip"
            if ($python -eq "py") { & $cmd.Source -3 -m pip install --user $EtnaPackage | Out-Host }
            else { & $cmd.Source -m pip install --user $EtnaPackage | Out-Host }
            if ($LASTEXITCODE -eq 0) { return $true }
        } catch { }
        break
    }

    $pipx = Get-Command pipx -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pipx) {
        Write-Step "Installing Etna with pipx"
        try {
            & $pipx.Source install $EtnaPackage | Out-Host
            if ($LASTEXITCODE -eq 0) { return $true }
        } catch { }
    }

    $uv = Get-Command uv -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -and -not $_.Source.StartsWith($BinRoot, [StringComparison]::OrdinalIgnoreCase) } |
        Select-Object -First 1
    if (-not $uv) {
        Write-Step "Bootstrapping user uv for Etna"
        $savedPythonDir = $env:UV_PYTHON_INSTALL_DIR
        $savedToolDir = $env:UV_TOOL_DIR
        $savedToolBinDir = $env:UV_TOOL_BIN_DIR
        try {
            Remove-Item Env:UV_PYTHON_INSTALL_DIR -ErrorAction SilentlyContinue
            Remove-Item Env:UV_TOOL_DIR -ErrorAction SilentlyContinue
            Remove-Item Env:UV_TOOL_BIN_DIR -ErrorAction SilentlyContinue
            $installer = Invoke-RestMethod -UseBasicParsing -Uri "https://astral.sh/uv/install.ps1"
            Invoke-Expression $installer | Out-Host
        } catch {
            Write-Warning "Etna uv bootstrap failed: $($_.Exception.Message)"
            return $false
        } finally {
            $env:UV_PYTHON_INSTALL_DIR = $savedPythonDir
            $env:UV_TOOL_DIR = $savedToolDir
            $env:UV_TOOL_BIN_DIR = $savedToolBinDir
        }
        $uv = Get-Command uv -All -ErrorAction SilentlyContinue |
            Where-Object { $_.Source -and -not $_.Source.StartsWith($BinRoot, [StringComparison]::OrdinalIgnoreCase) } |
            Select-Object -First 1
        $candidate = Join-Path $HOME ".local\bin\uv.exe"
        if (-not $uv -and (Test-Path $candidate)) { $uv = Get-Command $candidate -ErrorAction SilentlyContinue }
    }

    if (-not $uv) { return $false }
    Write-Step "Installing Etna with uv"
    $savedPythonDir = $env:UV_PYTHON_INSTALL_DIR
    $savedToolDir = $env:UV_TOOL_DIR
    $savedToolBinDir = $env:UV_TOOL_BIN_DIR
    try {
        Remove-Item Env:UV_PYTHON_INSTALL_DIR -ErrorAction SilentlyContinue
        Remove-Item Env:UV_TOOL_DIR -ErrorAction SilentlyContinue
        Remove-Item Env:UV_TOOL_BIN_DIR -ErrorAction SilentlyContinue
        & $uv.Source tool install --python 3.12 $EtnaPackage | Out-Host
        if ($LASTEXITCODE -ne 0) { return $false }
        $toolBin = (& $uv.Source tool dir --bin | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $toolBin) { return $false }
        $script:HostEtnaCommand = Join-Path $toolBin "etna.exe"
        return Test-Path $script:HostEtnaCommand -PathType Leaf
    } catch { return $false }
    finally {
        $env:UV_PYTHON_INSTALL_DIR = $savedPythonDir
        $env:UV_TOOL_DIR = $savedToolDir
        $env:UV_TOOL_BIN_DIR = $savedToolBinDir
    }
}

function Ensure-HostEtna {
    # Etna is native Windows so Playwright can drive the user's visible host Chrome.
    # Vulcan only asks it to converge itself; Vulcan neither owns Etna's venv/runtime nor installs Etna kits.
    $etnaRoot = Join-Path $HOME ".etna_server"
    $existing = (Test-Path $etnaRoot -PathType Container) -and
        (Test-Path (Join-Path $etnaRoot "config.json") -PathType Leaf) -and
        (Test-Path (Join-Path $etnaRoot "kits") -PathType Container)

    if (-not $existing) {
        if (-not (Install-EtnaIfAbsent)) {
            Write-Warning "Etna failed: package installation failed"
            Write-Step "Etna failed"
            return
        }
    }

    if (Test-EtnaHealth) {
        Write-Step "Etna ready"
        return
    }

    if ($existing) {
        try { $null = Invoke-EtnaModule "start" } catch { }
        if (Wait-EtnaHealth) {
            Write-Step "Etna ready"
            return
        }
    }

    $initCode = 127
    try { $initCode = Invoke-EtnaModule "init" }
    catch { Write-Warning "Etna init failed: $($_.Exception.Message)" }

    if ($initCode -eq 0 -and (Wait-EtnaHealth)) {
        Write-Step "Etna ready"
        return
    }

    if ($initCode -eq 0) { Write-Warning "Etna failed: init completed but the health check did not pass" }
    else { Write-Warning "Etna failed: init exited with code $initCode" }
    Write-Step "Etna failed"
    return
}

if ($ElevatedWslBootstrap) {
    if (-not (Test-IsAdmin)) { Fail "Elevated WSL bootstrap did not receive administrator privileges" }
    Write-Step "Enabling WSL2"
    & wsl.exe --install --no-distribution
    exit $LASTEXITCODE
}

if (-not $ResourcesDir) {
    $candidate = Split-Path -Parent $MyInvocation.MyCommand.Path
    if (Test-Path (Join-Path $candidate "vulcan-server")) { $ResourcesDir = $candidate }
}
if (-not $ResourcesDir) { Fail "Packaged Vulcan resources directory was not provided" }
if (-not (Test-Path (Join-Path $ResourcesDir "vulcan-server"))) { Fail "Packaged Vulcan server payload is missing" }
if (-not (Test-Path (Join-Path $ResourcesDir "install.sh"))) { Fail "Packaged Linux converger is missing" }

Ensure-HostEtna

if (-not (Test-WslAvailable)) {
    Write-Step "WSL2 is not available; requesting Windows elevation"
    $self = $MyInvocation.MyCommand.Path
    if (-not $self) { Fail "Cannot locate install.ps1 for elevated WSL bootstrap" }
    $args = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $self + '"'), "-ElevatedWslBootstrap"
    )
    $proc = Start-Process -FilePath "powershell.exe" -ArgumentList ($args -join ' ') -Verb RunAs -Wait -PassThru
    if ($proc.ExitCode -eq 3010) {
        Emit-Result @{ ok = $true; rebootRequired = $true; message = "Restart Windows, then open Vulcan to finish WSL2 setup." }
        exit 20
    }
    if ($proc.ExitCode -ne 0) { Fail "Windows could not enable WSL2 (exit $($proc.ExitCode))" }
    if (-not (Test-WslAvailable)) {
        Emit-Result @{ ok = $true; rebootRequired = $true; message = "Windows enabled WSL2 and requires a reboot before Vulcan can continue." }
        exit 20
    }
}

# Report WSL status without changing the default for the user's other distros.
Invoke-Wsl -Arguments @("--status")


$distros = @()
try { $distros = @(& wsl.exe --list --quiet | ForEach-Object { ([string]$_).Replace([string][char]0, "").Trim() } | Where-Object { $_ }) } catch { }
if ($distros -notcontains $DistroName) {
    Write-Step "Creating Vulcan-owned Ubuntu 24.04 WSL2 distro"
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ($arch -eq "ARM64") {
        $file = "ubuntu-noble-wsl-arm64-wsl.rootfs.tar.gz"
    } else {
        $file = "ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz"
    }
    $base = "https://cloud-images.ubuntu.com/wsl/releases/noble/current"
    $rootfs = Join-Path $CacheRoot $file
    $sums = Join-Path $CacheRoot "SHA256SUMS"
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
    $checksumPattern = '^[0-9a-fA-F]{64}\s+\*?' + [regex]::Escape($file) + '$'
    $expectedLine = Get-Content $sums | Where-Object { $_ -match $checksumPattern } | Select-Object -First 1
    if (-not $expectedLine) { Fail "Ubuntu did not publish a checksum for $file" }
    $expected = ($expectedLine -split '\s+')[0].ToLowerInvariant()
    if ((-not (Test-Path $rootfs)) -or (Get-FileHash -Algorithm SHA256 $rootfs).Hash.ToLowerInvariant() -ne $expected) {
        $partial = "$rootfs.download"
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile $partial
        Move-Item -Force $partial $rootfs
    }
    $actual = (Get-FileHash -Algorithm SHA256 $rootfs).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        Remove-Item -Force $rootfs
        Fail "Ubuntu WSL rootfs checksum mismatch"
    }
    New-Item -ItemType Directory -Force -Path $WslRoot | Out-Null
    Invoke-Wsl -Arguments @("--import", $DistroName, $WslRoot, $rootfs, "--version", "2")
}

Write-Step "Repairing WSL2 base state"
# Initial distro configuration is intentionally root-owned. It creates a dedicated
# unprivileged account and uses stock Ubuntu packages only inside the Vulcan distro.
$bootstrap = @'
set -e
export DEBIAN_FRONTEND=noninteractive
# A Windows/Docker Desktop client on inherited PATH is not a native Engine.
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
need_pkgs=()
command -v sudo >/dev/null 2>&1 || need_pkgs+=(sudo)
command -v curl >/dev/null 2>&1 || need_pkgs+=(curl)
[ -r /etc/ssl/certs/ca-certificates.crt ] || need_pkgs+=(ca-certificates)
dpkg-query -W -f='${Status}' docker.io 2>/dev/null | grep -q 'install ok installed' || need_pkgs+=(docker.io)
if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; then
  need_pkgs+=(build-essential)
fi
command -v python3 >/dev/null 2>&1 || need_pkgs+=(python3)
[ -x /usr/lib/systemd/systemd ] || need_pkgs+=(systemd)
dpkg-query -W -f='${Status}' systemd-sysv 2>/dev/null | grep -q 'install ok installed' || need_pkgs+=(systemd-sysv)
if [ "${#need_pkgs[@]}" -gt 0 ]; then
  apt-get update -qq
  apt-get install -y -qq "${need_pkgs[@]}" >/dev/null
fi
getent group docker >/dev/null || groupadd --system docker
if ! id vulcan >/dev/null 2>&1; then useradd -m -s /bin/bash vulcan; fi
usermod -aG docker vulcan
cat >/etc/sudoers.d/vulcan <<'EOF'
vulcan ALL=(root) NOPASSWD: /usr/bin/systemctl
vulcan ALL=(root) NOPASSWD: /usr/bin/install -m 0644 /tmp/* /etc/systemd/system/vulcan.service
vulcan ALL=(root) NOPASSWD: /usr/bin/install -m 0644 /tmp/* /etc/systemd/system/vulcan-terminal-host.service
EOF
chmod 0440 /etc/sudoers.d/vulcan
visudo -cf /etc/sudoers.d/vulcan >/dev/null
# Preserve existing distro settings and restart only when boot/user settings change.
python3 - <<'PYCONFIG'
import configparser
from pathlib import Path
path = Path('/etc/wsl.conf')
config = configparser.ConfigParser(interpolation=None)
config.optionxform = str
config.read(path)
changed = False
for section, key, value in [('boot', 'systemd', 'true'), ('user', 'default', 'vulcan')]:
    if not config.has_section(section):
        config.add_section(section)
    if config.get(section, key, fallback=None) != value:
        config.set(section, key, value)
        changed = True
if changed:
    with path.open('w') as output:
        config.write(output)
    print('VULCAN_WSL_RESTART_REQUIRED=1')
PYCONFIG
systemctl enable docker.service >/dev/null 2>&1 || true
'@
# Windows PowerShell 5.1 strips embedded quotes in native arguments. Encode the
# script so bash receives its exact contents, including arrays and heredocs.
$bootstrapBytes = [Text.Encoding]::UTF8.GetBytes($bootstrap.Replace("`r`n", "`n"))
$bootstrapBase64 = [Convert]::ToBase64String($bootstrapBytes)
$bootstrapOutput = Invoke-Wsl -Capture -Arguments @("-d", $DistroName, "-u", "root", "--", "bash", "-lc", "set -o pipefail; echo $bootstrapBase64 | base64 --decode | bash -e")
if ($bootstrapOutput) { Write-Host $bootstrapOutput }

# Apply boot configuration changes without killing terminals on routine repairs.
if ($bootstrapOutput -match 'VULCAN_WSL_RESTART_REQUIRED=1') {
    Invoke-Wsl -Arguments @("--terminate", $DistroName)
    Start-Sleep -Milliseconds 500
}
Invoke-Wsl -Arguments @("-d", $DistroName, "-u", "root", "--", "bash", "-lc", "test `$(cat /proc/1/comm) = systemd || { echo WSL_systemd_is_unavailable_update_WSL_and_restart_Vulcan; exit 1; }")

# Convert the packaged Windows resource directory to its mounted WSL path.  The
# converger immediately installs into the Linux filesystem; it never runs Vulcan
# from /mnt/c.
$guestResources = (& wsl.exe -d $DistroName -u vulcan -- wslpath -a $ResourcesDir | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { Fail "Could not map packaged resources into WSL2 (exit $LASTEXITCODE)" }
if (-not $guestResources) { Fail "Could not map packaged resources into WSL2" }
$serverSource = "$guestResources/vulcan-server"
$guestScript = "$guestResources/install.sh"
$hashFile = "$guestResources/server-payload.sha256"

Write-Step "Repairing Vulcan Linux runtime inside WSL2"
$guestArgs = @(
    "-d", $DistroName, "-u", "vulcan", "--",
    "bash", $guestScript,
    "--guest", "windows-wsl",
    "--server-source", $serverSource,
    "--server-hash-file", $hashFile,
    "--version", $Version,
    "--json"
)
& wsl.exe @guestArgs
if ($LASTEXITCODE -ne 0) { Fail "Vulcan Linux runtime repair failed inside WSL2 (exit $LASTEXITCODE). See the repair log for details." }

# Wake systemd-managed services and verify Windows localhost forwarding.
Invoke-Wsl -Arguments @("-d", $DistroName, "-u", "root", "--", "systemctl", "start", "docker.service", "vulcan-terminal-host.service", "vulcan.service")
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri "http://127.0.0.1:8468/meta"
        $meta = $r.Content | ConvertFrom-Json
        if ($r.StatusCode -eq 200 -and $meta.ok -eq $true -and $meta.terminalHost.ok -eq $true -and $meta.terminalHost.protocol -eq 1) { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 250
}
if (-not $ready) { Fail "Vulcan server and terminal host did not become healthy through WSL2 localhost forwarding. Check repair.log, Windows port 8468 conflicts, and WSL localhostForwarding settings." }

Emit-Result @{ ok = $true; rebootRequired = $false }
exit 0
