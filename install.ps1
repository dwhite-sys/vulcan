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
New-Item -ItemType Directory -Force -Path $LocalRoot,$CacheRoot,$BinRoot | Out-Null


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
    $expected = $null

    if ($digest -match '^sha256:([0-9A-Fa-f]{64})$') {
        $expected = $Matches[1].ToLowerInvariant()
    }
    else {
        $bodyMatch = [regex]::Match(
            [string]$release.body,
            '(?m)^\|\s*`?Vulcan-Setup\.exe`?\s*\|\s*`?([0-9A-Fa-f]{64})`?\s*\|'
        )

        if (-not $bodyMatch.Success) {
            Fail "GitHub release metadata did not contain a SHA-256 digest for Vulcan-Setup.exe"
        }

        $expected = $bodyMatch.Groups[1].Value.ToLowerInvariant()
    }
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

function Test-EtnaHealthy {
    try {
        $health = Invoke-RestMethod `
            -UseBasicParsing `
            -TimeoutSec 2 `
            -Uri "http://127.0.0.1:8467/health"

        return (
            $health.service -eq "etna-mcp" -and
            $health.status -eq "ok"
        )
    }
    catch {
        return $false
    }
}

function Invoke-Etna([string[]]$EtnaArgs) {
    $etna = Get-Command etna `
        -CommandType Application `
        -ErrorAction SilentlyContinue

    if ($etna) {
        & $etna.Source @EtnaArgs *> $null
        if ($LASTEXITCODE -eq 0) { return $true }
    }

    if ($env:USERPROFILE) {
        $localEtna = Join-Path $env:USERPROFILE ".local\bin\etna.exe"

        if (Test-Path $localEtna) {
            & $localEtna @EtnaArgs *> $null
            if ($LASTEXITCODE -eq 0) { return $true }
        }
    }

    $python = Get-Command python `
        -CommandType Application `
        -ErrorAction SilentlyContinue

    if ($python) {
        & $python.Source -m etna @EtnaArgs *> $null
        if ($LASTEXITCODE -eq 0) { return $true }
    }

    $py = Get-Command py `
        -CommandType Application `
        -ErrorAction SilentlyContinue

    if ($py) {
        & $py.Source -3 -m etna @EtnaArgs *> $null
        if ($LASTEXITCODE -eq 0) { return $true }
    }

    return $false
}

function Install-HostEtna {
    $pip = Get-Command pip `
        -CommandType Application `
        -ErrorAction SilentlyContinue

    if ($pip) {
        & $pip.Source install "etna-mcp>=1.0.0b41" *> $null

        if ($LASTEXITCODE -eq 0 -and (Invoke-Etna @("--help"))) {
            return $true
        }
    }

    $pipx = Get-Command pipx `
        -CommandType Application `
        -ErrorAction SilentlyContinue

    if ($pipx) {
        & $pipx.Source install "etna-mcp>=1.0.0b41" *> $null

        if ($LASTEXITCODE -eq 0 -and (Invoke-Etna @("--help"))) {
            return $true
        }
    }

    $uv = Get-Command uv `
        -CommandType Application `
        -ErrorAction SilentlyContinue

    if (-not $uv) {
        $uvPath = Join-Path $BinRoot "uv.exe"

        if (-not (Test-Path $uvPath)) {
            $env:UV_UNMANAGED_INSTALL = $BinRoot
            $env:UV_NO_MODIFY_PATH = "1"

            try {
                $installer = Invoke-RestMethod `
                    -UseBasicParsing `
                    -Uri "https://astral.sh/uv/install.ps1"

                Invoke-Expression $installer
            }
            finally {
                Remove-Item Env:UV_UNMANAGED_INSTALL -ErrorAction SilentlyContinue
                Remove-Item Env:UV_NO_MODIFY_PATH -ErrorAction SilentlyContinue
            }
        }

        if (Test-Path $uvPath) {
            $uv = @{ Source = $uvPath }
        }
    }

    if ($uv) {
        & $uv.Source tool install `
            --force `
            "etna-mcp>=1.0.0b41" *> $null

        if ($LASTEXITCODE -eq 0 -and (Invoke-Etna @("--help"))) {
            return $true
        }
    }

    return $false
}

function Ensure-HostEtna {
    # Etna is intentionally native Windows. Its Playwright kit drives the user's
    # visible host Chrome. Vulcan uses the running Etna service through HTTP.

    # Remove artifacts created by older Vulcan-owned Etna installs.
    $legacyEtna = Join-Path $BinRoot "etna.exe"
    $legacyTools = Join-Path $LocalRoot "uv-tools"
    $legacyPython = Join-Path $LocalRoot "python"

    if (Test-Path $legacyEtna) {
        Remove-Item -Force $legacyEtna
    }

    if (Test-Path $legacyTools) {
        Remove-Item -Recurse -Force $legacyTools
    }

    if (Test-Path $legacyPython) {
        Remove-Item -Recurse -Force $legacyPython
    }

    if (-not (Invoke-Etna @("--help"))) {
        Write-Step "Installing Etna"

        if (-not (Install-HostEtna)) {
            Fail "Could not install Etna with pip, pipx, or uv"
        }
    }

    if (-not (Test-EtnaHealthy)) {
        if (-not (Invoke-Etna @("init"))) {
            if (-not (Install-HostEtna)) {
                Fail "Could not repair Etna"
            }

            if (-not (Invoke-Etna @("init"))) {
                Fail "Etna init failed"
            }
        }

        if (-not (Test-EtnaHealthy)) {
            Fail "Etna init completed but Etna is not healthy on port 8467"
        }
    }

    $etnaRoot = Join-Path $env:APPDATA "Etna"
    $configPath = Join-Path $etnaRoot "config.json"

    foreach ($kit in @("web", "playwright", "ntfy")) {
        $installed = $false

        try {
            if (Test-Path $configPath) {
                $cfg = Get-Content -Raw $configPath | ConvertFrom-Json
                $installed = (
                    @($cfg.kits.PSObject.Properties.Name) -contains $kit
                ) -and (
                    Test-Path (Join-Path $etnaRoot "kits\$kit.py")
                )
            }
        }
        catch {
            $installed = $false
        }

        if (-not $installed) {
            if (-not (Invoke-Etna @("install", $kit))) {
                Fail "Could not install Etna kit '$kit'"
            }
        }
    }

    if (-not (Test-EtnaHealthy)) {
        Fail "Etna is not healthy on port 8467"
    }
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

$wslConfig = ""

try {
    $wslConfig = (
        & wsl.exe -d $DistroName -u root -- cat /etc/wsl.conf 2>$null
    ) -join "`n"
}
catch { }

$needsWslRestart = -not (
    $wslConfig -match "(?m)^systemd=true\s*$" -and
    $wslConfig -match "(?m)^default=vulcan\s*$"
)

$baseCheck = @'
set -e
command -v sudo >/dev/null 2>&1
command -v curl >/dev/null 2>&1
[ -r /etc/ssl/certs/ca-certificates.crt ]
command -v docker >/dev/null 2>&1
id vulcan >/dev/null 2>&1
id -nG vulcan | tr " " "\n" | grep -qx docker
grep -Fxq "vulcan ALL=(ALL) NOPASSWD: /usr/bin/systemctl, /usr/bin/tee" /etc/sudoers.d/vulcan
grep -Eq "^[[:space:]]*systemd=true[[:space:]]*$" /etc/wsl.conf
grep -Eq "^[[:space:]]*default=vulcan[[:space:]]*$" /etc/wsl.conf
systemctl is-enabled --quiet docker.service
'@

& wsl.exe -d $DistroName -u root -- bash -lc $baseCheck *> $null

if ($LASTEXITCODE -ne 0) {
    Write-Step "Repairing WSL2 base state"

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

id vulcan >/dev/null 2>&1 || useradd -m -s /bin/bash vulcan

id -nG vulcan | tr " " "\n" | grep -qx docker \
  || usermod -aG docker vulcan

sudoers='vulcan ALL=(ALL) NOPASSWD: /usr/bin/systemctl, /usr/bin/tee'

if ! grep -Fxq "$sudoers" /etc/sudoers.d/vulcan 2>/dev/null; then
  printf '%s\n' "$sudoers" >/etc/sudoers.d/vulcan
fi

[ "$(stat -c %a /etc/sudoers.d/vulcan 2>/dev/null || true)" = 440 ] \
  || chmod 0440 /etc/sudoers.d/vulcan

if ! grep -Eq "^[[:space:]]*systemd=true[[:space:]]*$" /etc/wsl.conf 2>/dev/null \
  || ! grep -Eq "^[[:space:]]*default=vulcan[[:space:]]*$" /etc/wsl.conf 2>/dev/null
then
  cat >/etc/wsl.conf <<'EOF'
[boot]
systemd=true
[user]
default=vulcan
EOF
fi

systemctl is-enabled --quiet docker.service 2>/dev/null \
  || systemctl enable docker.service >/dev/null 2>&1 \
  || true
'@

    & wsl.exe -d $DistroName -u root -- bash -lc $bootstrap

    if ($LASTEXITCODE -ne 0) {
        Fail "Could not repair the Vulcan WSL2 base state"
    }

    if ($needsWslRestart) {
        & wsl.exe --terminate $DistroName *> $null
        Start-Sleep -Milliseconds 500

        & wsl.exe -d $DistroName -u root -- true

        if ($LASTEXITCODE -ne 0) {
            Fail "Vulcan WSL2 distro would not restart"
        }
    }

    & wsl.exe -d $DistroName -u root -- bash -lc `
        'systemctl is-enabled --quiet docker.service || systemctl enable docker.service >/dev/null'

    if ($LASTEXITCODE -ne 0) {
        Fail "Could not enable Docker in the Vulcan WSL2 distro"
    }
}

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

Write-Step "Checking Vulcan Linux runtime inside WSL2"
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

# The guest converger owns service state. Verify Windows localhost forwarding.
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
