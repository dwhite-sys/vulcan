$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\..\install.ps1'))
$root = Join-Path ([IO.Path]::GetTempPath()) ('Vulcan flow Jos' + [char]0xE9 + ' with spaces ' + [Guid]::NewGuid())
New-Item -ItemType Directory $root | Out-Null
try {
    foreach ($case in @('first-install', 'stale-cache', 'existing-distro', 'import-failure', 'terminal-unhealthy', 'bootstrap-failure', 'reboot-required', 'elevation-cancelled', 'missing-payload')) {
        $caseRoot = Join-Path $root $case
        $resources = Join-Path $caseRoot 'packaged resources'
        New-Item -ItemType Directory -Force $resources | Out-Null
        if ($case -ne 'missing-payload') {
            New-Item -ItemType Directory (Join-Path $resources 'vulcan-server') | Out-Null
            Set-Content (Join-Path $resources 'install.sh') '# simulated Linux converger'
        }
        if ($case -eq 'stale-cache') {
            $cache = Join-Path $caseRoot 'Vulcan\cache'
            New-Item -ItemType Directory -Force $cache | Out-Null
            Set-Content (Join-Path $cache 'ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz') 'outdated cached image'
        }
        $injection = @'
$env:LOCALAPPDATA = '__CASE_ROOT__'
$testCase = '__CASE__'
$callLog = Join-Path $env:LOCALAPPDATA 'wsl-calls.jsonl'
function Start-Sleep { }
function wsl.exe {
    $arguments = @($args)
    ConvertTo-Json -InputObject $arguments -Compress | Add-Content $callLog
    $global:LASTEXITCODE = 0
    if (($arguments -contains 'wslpath' -or $arguments -contains 'bash' -or $arguments -contains 'systemctl') -and $arguments -notcontains '--exec') { throw 'Linux commands must bypass WSL shell path interpretation' }
    if ($arguments[0] -eq '--status' -and $testCase -in @('reboot-required', 'elevation-cancelled')) {
        $global:LASTEXITCODE = 1
    } elseif ($arguments[0] -eq '--list') {
        if ($testCase -eq 'existing-distro') { Write-Output ('Vul' + [char]0 + 'can') }
    } elseif ($arguments[0] -eq '--import' -and $testCase -eq 'import-failure') {
        $global:LASTEXITCODE = 42
        Write-Output 'WSL failed 0x80370102'
    } elseif ($arguments[-1] -match 'base64 --decode' -and $testCase -eq 'bootstrap-failure') {
        $global:LASTEXITCODE = 7
        Write-Output 'Bootstrap package install failed'
    } elseif ($arguments[-1] -match 'base64 --decode' -and $testCase -in @('first-install', 'stale-cache')) {
        Write-Output 'VULCAN_WSL_RESTART_REQUIRED=1'
    } elseif ($arguments -contains 'wslpath') {
        Write-Output '/mnt/c/Users/Test User/packaged resources'
    }
}
function Start-Process {
    param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru)
    if ($testCase -eq 'elevation-cancelled') { throw 'Windows elevation was cancelled' }
    return @{ ExitCode = 3010 }
}
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
    if ($Uri -match '/SHA256SUMS$') {
        $bytes = [Text.Encoding]::UTF8.GetBytes('rootfs fixture')
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
        Set-Content $OutFile ($digest + '  ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz')
    } elseif ($OutFile) {
        [IO.File]::WriteAllText($OutFile, 'rootfs fixture', (New-Object Text.UTF8Encoding($false)))
    } else {
        $healthy = if ($testCase -eq 'terminal-unhealthy') { 'false' } else { 'true' }
        return @{ StatusCode = 200; Content = ('{"ok":true,"terminalHost":{"ok":' + $healthy + ',"protocol":1}}') }
    }
}
'@
        $injection = $injection.Replace('__CASE_ROOT__', $caseRoot.Replace("'", "''")).Replace('__CASE__', $case)
        # Insert after the param block, before local paths are initialized.
        $fixtureSource = $source.Replace('$ErrorActionPreference = "Stop"', ('$ErrorActionPreference = "Stop"' + "`n" + $injection))
        # Host Etna is tested separately; never acquire packages in a simulated flow.
        $fixtureSource = [regex]::Replace($fixtureSource, '(?m)^Ensure-HostEtna\r?$', 'Write-Step "Simulated native Etna ready"')
        $fixture = Join-Path $caseRoot 'install.ps1'
        Set-Content -Encoding UTF8 $fixture $fixtureSource
        $savedArch = $env:PROCESSOR_ARCHITECTURE
        $savedNativeArch = $env:PROCESSOR_ARCHITEW6432
        $env:PROCESSOR_ARCHITECTURE = 'AMD64'
        $env:PROCESSOR_ARCHITEW6432 = ''
        $ErrorActionPreference = 'Continue'
        $output = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fixture -FromApp -ResourcesDir $resources -Version test -Json 2>&1 | Out-String)
        $code = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        $env:PROCESSOR_ARCHITECTURE = $savedArch
        $env:PROCESSOR_ARCHITEW6432 = $savedNativeArch
        $line = $output -split "`r?`n" | Where-Object { $_.StartsWith('VULCAN_RESULT=') } | Select-Object -Last 1
        if (-not $line) { throw "${case}: no result: $output" }
        $result = $line.Substring('VULCAN_RESULT='.Length) | ConvertFrom-Json
        $success = $case -in @('first-install', 'stale-cache', 'existing-distro', 'reboot-required')
        $expectedCode = if ($case -eq 'reboot-required') { 20 } elseif ($success) { 0 } else { 1 }
        if ($result.ok -ne $success -or $code -ne $expectedCode) { throw "${case}: incorrect result: $output" }
        if ($case -eq 'stale-cache' -and ([IO.File]::ReadAllText((Join-Path $caseRoot 'Vulcan\cache\ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz'))) -ne 'rootfs fixture') { throw 'Stale cached rootfs was not refreshed' }
        $log = Join-Path $caseRoot 'wsl-calls.jsonl'
        if ($case -eq 'missing-payload') {
            if (Test-Path $log) { throw 'Missing payload must fail before WSL mutations' }
            continue
        }
        $calls = @(Get-Content $log | ForEach-Object { ,($_ | ConvertFrom-Json) })
        if ($case -eq 'reboot-required') {
            if (-not $result.rebootRequired -or @($calls | Where-Object { $_[0] -eq '--import' }).Count) { throw 'Reboot path attempted import too soon' }
            continue
        }
        if ($case -eq 'elevation-cancelled') {
            if ($result.message -notmatch 'elevation was cancelled') { throw 'Elevation cancellation was not explained' }
            continue
        }
        $imports = @($calls | Where-Object { $_[0] -eq '--import' })
        if ($case -eq 'existing-distro' -and $imports.Count -ne 0) { throw 'Existing NUL-padded distro was imported again' }
        if ($case -ne 'existing-distro' -and $imports.Count -ne 1) { throw 'Expected exactly one import' }
        if ($case -eq 'import-failure') {
            if ($result.message -notmatch '0x80370102') { throw 'Import diagnostics lost' }
            continue
        }
        if ($case -eq 'bootstrap-failure') {
            if ($result.message -notmatch 'Bootstrap package install failed') { throw 'Captured bootstrap failure lost its structured result' }
            continue
        }
        $terminations = @($calls | Where-Object { $_[0] -eq '--terminate' })
        if ($case -eq 'existing-distro' -and $terminations.Count -ne 0) { throw 'Routine repair terminated the distro and its terminals' }
        if ($case -eq 'first-install' -and $terminations.Count -ne 1) { throw 'Changed boot configuration was not applied' }
        $bootstrap = @($calls | Where-Object { $_[-1] -match 'echo .*base64 --decode' })
        if ($bootstrap.Count -ne 1) { throw 'Expected one encoded bootstrap' }
        $encoded = [regex]::Match($bootstrap[0][-1], 'echo ([A-Za-z0-9+/=]+)').Groups[1].Value
        $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
        if ($decoded.Contains("`r") -or $decoded -notmatch 'build-essential' -or $decoded -notmatch 'vulcan-terminal-host.service' -or $decoded -notmatch 'visudo -cf') { throw 'Linux bootstrap omitted required provisioning' }
        $guest = @($calls | Where-Object { $_ -contains '--guest' })
        if ($guest.Count -ne 1 -or $guest[0] -notcontains '/mnt/c/Users/Test User/packaged resources/install.sh') { throw 'Guest resource path was split or lost' }
        if ($case -eq 'terminal-unhealthy' -and $result.message -notmatch 'terminal host') { throw 'Terminal health failure did not block success' }
    }
} finally { Remove-Item -Recurse -Force $root }
Write-Host "Simulated Windows first install, repeat repair, import errors, payload validation, and terminal health verified under PowerShell $($PSVersionTable.PSVersion)."
