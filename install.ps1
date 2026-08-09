# Vulcan {{VERSION}} — Windows installer
# Triggered by: etna install vulcan
#
# Requires: Windows 10 22H2 (build 19045) or Windows 11
#
# This script installs:
#   1. WSL2 + Ubuntu 24.04 (if not present)
#   2. UV inside WSL2
#   3. Vulcan Python backend from source inside WSL2
#   4. Docker Engine inside WSL2
#   5. Vulcan Electron app (NSIS .exe)
#   6. vulcan CLI shim on the Windows side (delegates to WSL2)
#   7. vulcan install (first-time setup inside WSL2)

$ErrorActionPreference = "Stop"

$Version      = "{{VERSION}}"
$VersionsBase = "https://raw.githubusercontent.com/dwhite-sys/vulcan-versions/main/versions/$Version"
$ExeUrl       = "$VersionsBase/windows/Vulcan-Setup-$Version.exe"
$Distro       = "Ubuntu-24.04"

# ── ANSI helpers ──────────────────────────────────────────────────────────────

$ESC        = [char]27
$LightGreen = "$ESC[92m"
$Red        = "$ESC[31m"
$Orange     = "$ESC[38;5;208m"
$Grey       = "$ESC[90m"
$Reset      = "$ESC[0m"
$PREFIX     = "${Orange}[Vulcan]${Reset} "

function Ok($msg)   { Write-Host "${LightGreen}✔${Reset}  $msg" }
function Fail($msg) { Write-Host "${Red}✘${Reset}  $msg"; exit 1 }
function Info($msg) { Write-Host "${Grey}·${Reset}  $msg" }
function Step($msg) { Write-Host "${PREFIX}$msg" }

# ── Check Windows version ─────────────────────────────────────────────────────

$Build = [System.Environment]::OSVersion.Version.Build
if ($Build -lt 19045) {
    Fail "Vulcan requires Windows 10 22H2 (build 19045) or later. Current build: $Build"
}
Ok "Windows build $Build"

# ── Check hardware virtualization ─────────────────────────────────────────────

$VirtEnabled = (Get-CimInstance -ClassName Win32_Processor).VirtualizationFirmwareEnabled
if (-not $VirtEnabled) {
    Write-Host ""
    Fail "Hardware virtualization is not enabled. Please enable VT-x or AMD-V in your BIOS/UEFI settings, then retry."
}
Ok "Hardware virtualization enabled"

# ── Check / install WSL2 ──────────────────────────────────────────────────────

Step "Checking WSL2..."

wsl --status 2>&1 | Out-Null
$WslOk = ($LASTEXITCODE -eq 0)

if (-not $WslOk) {
    Write-Host ""
    Step "WSL2 not found — installing..."
    Info "This requires a reboot to complete."
    Info "After rebooting, run 'etna install vulcan' again to continue."
    Write-Host ""

    try {
        Start-Process powershell -ArgumentList "wsl --install -d $Distro" -Verb RunAs -Wait
        Write-Host ""
        Ok "WSL2 installation launched"
        Write-Host ""
        Write-Host "  Please reboot your machine, then run:"
        Write-Host "    ${Grey}etna install vulcan${Reset}"
        Write-Host ""
        exit 0
    } catch {
        Fail "Could not launch WSL2 installer. Please open PowerShell as Administrator and run: wsl --install -d $Distro"
    }
}

# wsl --list --quiet outputs UTF-16LE — decode explicitly to avoid null-byte matching issues
$RawBytes  = [byte[]](wsl --list --quiet 2>&1 | Out-String | [System.Text.Encoding]::Default.GetBytes)
$Distros   = [System.Text.Encoding]::Unicode.GetString($RawBytes) -split "`r?`n" |
             ForEach-Object { $_.Trim() } |
             Where-Object { $_ -ne "" }
$HasUbuntu = $Distros | Where-Object { $_ -match "Ubuntu" }

if (-not $HasUbuntu) {
    Info "Installing Ubuntu 24.04 in WSL2..."
    wsl --install -d $Distro
    if ($LASTEXITCODE -ne 0) {
        Fail "Failed to install Ubuntu 24.04. Please run: wsl --install -d Ubuntu-24.04"
    }
    Ok "Ubuntu 24.04 installed"
} else {
    Ok "WSL2 + Ubuntu found"
}

# ── Install UV inside WSL2 ────────────────────────────────────────────────────

Step "Setting up UV inside WSL2..."

$UvCheck = wsl -- bash -c "command -v uv" 2>&1
if ($LASTEXITCODE -ne 0 -or -not $UvCheck) {
    Info "Installing UV in WSL2..."
    wsl -- bash -c @"
if command -v pipx &>/dev/null; then
    pipx install uv
elif command -v pip3 &>/dev/null; then
    pip3 install uv --break-system-packages 2>/dev/null || pip3 install uv
else
    pip install uv --break-system-packages 2>/dev/null || pip install uv
fi
"@
    if ($LASTEXITCODE -ne 0) {
        Fail "Failed to install UV in WSL2"
    }
    Ok "UV installed in WSL2"
} else {
    Ok "UV already present in WSL2"
}

# ── Install Vulcan Python backend from source inside WSL2 ─────────────────────

Step "Installing Vulcan backend in WSL2..."

wsl -- bash -c @"
set -e
uv venv ~/.vulcan/.venv --python python3
uv pip install \
    --python ~/.vulcan/.venv/bin/python \
    'git+https://github.com/dwhite-sys/vulcan@v$Version#subdirectory=vulcan'
"@
if ($LASTEXITCODE -ne 0) {
    Fail "Failed to install Vulcan backend in WSL2"
}
Ok "Vulcan backend installed in WSL2"

# ── Install Docker inside WSL2 ────────────────────────────────────────────────

Step "Checking Docker in WSL2..."

wsl -- bash -c "docker info" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Info "Installing Docker Engine in WSL2..."
    wsl -- bash -c "curl -fsSL https://get.docker.com | sh"
    if ($LASTEXITCODE -ne 0) {
        Fail "Failed to install Docker in WSL2"
    }
    $WslUser = (wsl -- bash -c "whoami").Trim()
    wsl -- bash -c "sudo usermod -aG docker $WslUser"
    Ok "Docker installed in WSL2"
} else {
    Ok "Docker already running in WSL2"
}

wsl -- bash -c @"
if ! grep -q '\[boot\]' /etc/wsl.conf 2>/dev/null; then
    printf '[boot]\ncommand = service docker start\n' | sudo tee -a /etc/wsl.conf
fi
"@
Ok "Docker configured to start with WSL2"

# ── Install Vulcan Electron app ───────────────────────────────────────────────

Step "Installing Vulcan app..."

$ExeFile = "$env:TEMP\VulcanSetup-$Version.exe"
Info "Downloading Vulcan installer..."
Invoke-WebRequest -Uri $ExeUrl -OutFile $ExeFile -UseBasicParsing
Info "Running installer (silent)..."
Start-Process -FilePath $ExeFile -ArgumentList "/S" -Wait
Remove-Item $ExeFile -Force
Ok "Vulcan app installed"

# ── Install vulcan CLI shim ───────────────────────────────────────────────────

Step "Installing vulcan CLI shim..."

$ScriptsDir = Split-Path (Get-Command etna -ErrorAction SilentlyContinue).Source -Parent
if (-not $ScriptsDir) {
    $ScriptsDir = "$env:APPDATA\Python\Scripts"
}

@"
#!/usr/bin/env python3
# Vulcan CLI shim — delegates to the Vulcan backend inside WSL2
import sys, subprocess
subprocess.run(["wsl", "~/.vulcan/.venv/bin/vulcan"] + sys.argv[1:])
"@ | Set-Content -Path (Join-Path $ScriptsDir "vulcan.py") -Encoding UTF8

@"
@echo off
python "%~dp0vulcan.py" %*
"@ | Set-Content -Path (Join-Path $ScriptsDir "vulcan.cmd") -Encoding ASCII

Ok "vulcan shim installed at $ScriptsDir"

# ── Register Vulcan backend autostart ─────────────────────────────────────────

Step "Registering Vulcan backend autostart..."

$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
Set-ItemProperty -Path $RunKey -Name "VulcanBackend" -Value "`"$ScriptsDir\vulcan.cmd`" start"
Ok "Vulcan backend registered for autostart on login"

# ── First-time setup ──────────────────────────────────────────────────────────

Step "Running first-time setup in WSL2..."
wsl -- bash -c "~/.vulcan/.venv/bin/vulcan install"
if ($LASTEXITCODE -ne 0) {
    Fail "First-time setup failed. Run 'vulcan install' manually after setup."
}
Ok "Vulcan setup complete"

# ── Done ──────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "${PREFIX}${LightGreen}✔${Reset}  Vulcan $Version installed"
Write-Host ""
Write-Host "  Start the backend:   ${Grey}vulcan start${Reset}"
Write-Host "  Check status:        ${Grey}vulcan status${Reset}"
Write-Host "  Open the app:        ${Grey}Vulcan (Start Menu or Desktop)${Reset}"
Write-Host ""
