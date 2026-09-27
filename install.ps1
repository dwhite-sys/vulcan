[CmdletBinding()]
param(
    [switch]$FromApp,
    [string]$ResourcesDir = "",
    [string]$Version = "unknown",
    [switch]$Json,
    [switch]$ElevatedWslBootstrap
)

$ErrorActionPreference = "Stop"
$DistroName = "Vulcan"
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
        Write-Output "VULCAN_RESULT=$payload"
    }
}
function Fail([string]$Message, [int]$Code = 1) {
    Write-Error "Vulcan install failed: $Message"
    Emit-Result @{ ok = $false; message = $Message }
    exit $Code
}
function Invoke-Wsl([string[]]$Arguments, [switch]$AllowFailure) {
    & wsl.exe @Arguments
    $code = $LASTEXITCODE
    if (-not $AllowFailure -and $code -ne 0) {
        throw "wsl.exe $($Arguments -join ' ') failed with exit code $code"
    }
    return $code
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

function Get-HostEtnaCommand {
    $cmd = Get-Command etna -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -and -not $_.Source.StartsWith($BinRoot, [StringComparison]::OrdinalIgnoreCase) } |
        Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $null
}

function Invoke-EtnaModule([string]$Verb) {
    foreach ($python in @("python", "py")) {
        $cmd = Get-Command $python -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $cmd) { continue }
        try {
            if ($python -eq "py") { & $cmd.Source -3 -m etna --help *> $null }
            else { & $cmd.Source -m etna --help *> $null }
            if ($LASTEXITCODE -ne 0) { continue }
            if ($python -eq "py") { & $cmd.Source -3 -m etna $Verb }
            else { & $cmd.Source -m etna $Verb }
            return $LASTEXITCODE
        } catch { }
    }

    $etna = Get-HostEtnaCommand
    if (-not $etna) { return 127 }
    & $etna $Verb
    return $LASTEXITCODE
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
            if ($python -eq "py") { & $cmd.Source -3 -m pip install --user etna-mcp }
            else { & $cmd.Source -m pip install --user etna-mcp }
            if ($LASTEXITCODE -eq 0) { return $true }
        } catch { }
        break
    }

    $pipx = Get-Command pipx -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pipx) {
        Write-Step "Installing Etna with pipx"
        try {
            & $pipx.Source install etna-mcp
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
            Invoke-Expression $installer
        } catch {
            Write-Warning "Etna uv bootstrap failed: $($_.Exception.Message)"
            return $false
        } finally {
            $env:UV_PYTHON_INSTALL_DIR = $savedPythonDir
            $env:UV_TOOL_DIR = $savedToolDir
            $env:UV_TOOL_BIN_DIR = $savedToolBinDir
        }
        $candidate = Join-Path $HOME ".local\bin\uv.exe"
        if (Test-Path $candidate) { $uv = Get-Item $candidate }
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
        & $uv.Source tool install etna-mcp
        return $LASTEXITCODE -eq 0
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
        if (Test-EtnaHealth) {
            Write-Step "Etna ready"
            return
        }
    }

    $initCode = 127
    try { $initCode = Invoke-EtnaModule "init" }
    catch { Write-Warning "Etna init failed: $($_.Exception.Message)" }

    if ($initCode -eq 0 -and (Test-EtnaHealth)) {
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

Ensure-HostEtna

if (-not (Test-WslAvailable)) {
    Write-Step "WSL2 is not available; requesting Windows elevation"
    $self = $MyInvocation.MyCommand.Path
    if (-not $self) { Fail "Cannot locate install.ps1 for elevated WSL bootstrap" }
    $args = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $self + '"'), "-ElevatedWslBootstrap"
    )
    $proc = Start-Process -FilePath "powershell.exe" -ArgumentList ($args -join ' ') -Verb RunAs -Wait -PassThru
    if ($proc.ExitCode -ne 0) { Fail "Windows could not enable WSL2" }
    if (-not (Test-WslAvailable)) {
        Emit-Result @{ ok = $true; rebootRequired = $true; message = "Windows enabled WSL2 and requires a reboot before Vulcan can continue." }
        exit 20
    }
}

# Do not silently move a user onto a preview WSL build. Use the installed stable WSL.
try { & wsl.exe --set-default-version 2 *> $null } catch { }


$distros = @()
try { $distros = @(& wsl.exe --list --quiet | ForEach-Object { $_.Trim([char]0).Trim() } | Where-Object { $_ }) } catch { }
if ($distros -notcontains $DistroName) {
    Write-Step "Creating Vulcan-owned Ubuntu 24.04 WSL2 distro"
    $arch = $env:PROCESSOR_ARCHITECTURE
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
    if (-not (Test-Path $rootfs)) {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile $rootfs
    }
    $expectedLine = Get-Content $sums | Where-Object { $_ -match [regex]::Escape($file) } | Select-Object -First 1
    if (-not $expectedLine) { Fail "Ubuntu did not publish a checksum for $file" }
    $expected = ($expectedLine -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 $rootfs).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        Remove-Item -Force $rootfs
        Fail "Ubuntu WSL rootfs checksum mismatch"
    }
    New-Item -ItemType Directory -Force -Path $WslRoot | Out-Null
    & wsl.exe --import $DistroName $WslRoot $rootfs --version 2
    if ($LASTEXITCODE -ne 0) { Fail "Could not import the Vulcan WSL2 distro" }
}

Write-Step "Repairing WSL2 base state"
# Initial distro configuration is intentionally root-owned. It creates a dedicated
# unprivileged account and uses stock Ubuntu packages only inside the Vulcan distro.
$bootstrap = @'
set -e
export DEBIAN_FRONTEND=noninteractive
need_pkgs=()
command -v sudo >/dev/null 2>&1 || need_pkgs+=(sudo)
command -v curl >/dev/null 2>&1 || need_pkgs+=(curl)
[ -r /etc/ssl/certs/ca-certificates.crt ] || need_pkgs+=(ca-certificates)
command -v docker >/dev/null 2>&1 || need_pkgs+=(docker.io)
if [ "${#need_pkgs[@]}" -gt 0 ]; then
  apt-get update -qq
  apt-get install -y -qq "${need_pkgs[@]}" >/dev/null
fi
if ! id vulcan >/dev/null 2>&1; then useradd -m -s /bin/bash vulcan; fi
usermod -aG docker vulcan
cat >/etc/sudoers.d/vulcan <<'EOF'
vulcan ALL=(ALL) NOPASSWD: /usr/bin/systemctl, /usr/bin/tee
EOF
chmod 0440 /etc/sudoers.d/vulcan
cat >/etc/wsl.conf <<'EOF'
[boot]
systemd=true
[user]
default=vulcan
EOF
systemctl enable docker.service >/dev/null 2>&1 || true
'@
& wsl.exe -d $DistroName -u root -- bash -lc $bootstrap
if ($LASTEXITCODE -ne 0) { Fail "Could not configure the Vulcan WSL2 distro" }

# Make sure wsl.conf/systemd changes are active, then wake the dedicated distro.
& wsl.exe --terminate $DistroName *> $null
Start-Sleep -Milliseconds 500
& wsl.exe -d $DistroName -u root -- true
if ($LASTEXITCODE -ne 0) { Fail "Vulcan WSL2 distro would not start" }

if (-not $ResourcesDir) {
    $candidate = Split-Path -Parent $MyInvocation.MyCommand.Path
    if (Test-Path (Join-Path $candidate "vulcan-server")) { $ResourcesDir = $candidate }
}
if (-not $ResourcesDir) { Fail "Packaged Vulcan resources directory was not provided" }
if (-not (Test-Path (Join-Path $ResourcesDir "vulcan-server"))) { Fail "Packaged Vulcan server payload is missing" }
if (-not (Test-Path (Join-Path $ResourcesDir "install.sh"))) { Fail "Packaged Linux converger is missing" }

# Convert the packaged Windows resource directory to its mounted WSL path.  The
# converger immediately installs into the Linux filesystem; it never runs Vulcan
# from /mnt/c.
$guestResources = (& wsl.exe -d $DistroName -u vulcan -- wslpath -a $ResourcesDir).Trim()
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
if ($LASTEXITCODE -ne 0) { Fail "Vulcan Linux runtime repair failed inside WSL2" }

# Wake systemd-managed services and verify Windows localhost forwarding.
& wsl.exe -d $DistroName -u root -- systemctl start docker.service vulcan.service *> $null
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri "http://127.0.0.1:8468/meta"
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 250
}
if (-not $ready) { Fail "Vulcan server did not become reachable through WSL2 localhost forwarding" }

Emit-Result @{ ok = $true; rebootRequired = $false }
exit 0
