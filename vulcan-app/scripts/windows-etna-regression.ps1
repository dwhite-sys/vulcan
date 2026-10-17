$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\..\install.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Get-HostEtnaRoot', 'Get-EtnaInitializationVerb', 'Invoke-EtnaModule', 'Get-HostEtnaCommand', 'Install-EtnaIfAbsent', 'Wait-EtnaHealth', 'Ensure-HostEtna')) {
    $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
    Invoke-Expression $node.Extent.Text
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('Etna tool bin with spaces ' + [Guid]::NewGuid())
New-Item -ItemType Directory $root | Out-Null
$oldPython = $env:UV_PYTHON_INSTALL_DIR
$oldTools = $env:UV_TOOL_DIR
$oldBins = $env:UV_TOOL_BIN_DIR
try {
    $env:UV_PYTHON_INSTALL_DIR = 'Vulcan managed Python'
    $env:UV_TOOL_DIR = 'Vulcan managed tools'
    $env:UV_TOOL_BIN_DIR = 'Vulcan managed bin'
    $BinRoot = 'Vulcan managed bin'
    $EtnaPackage = 'etna-mcp>=1.0.0b41'
    Set-Content (Join-Path $root 'etna.exe') 'launcher fixture'
    function Write-Step { param($Message) }
    function Get-Command {
        param($Name, [switch]$All, $ErrorAction)
        if ($Name -eq 'python' -and $script:testPython) { return @{ Source = 'etna-python-test' } }
        if ($Name -eq 'uv') { return @{ Source = 'uv-test' } }
    }
    $script:installCalls = 0
    function uv-test {
        $global:LASTEXITCODE = 0
        if ($args[1] -eq 'install') {
            $script:installCalls++
            if ($env:UV_PYTHON_INSTALL_DIR -or $env:UV_TOOL_DIR -or $env:UV_TOOL_BIN_DIR) { throw 'Etna inherited Vulcan managed locations' }
            if ($args -notcontains $EtnaPackage) { throw 'Etna acquisition has no compatible minimum version' }
            Write-Output 'Noisy package-manager success output'
            if ($args -notcontains '3.12') { throw 'Etna fallback did not select supported Python' }
        } elseif ($args[1] -eq 'dir') { Write-Output $root }
    }
    $installed = Install-EtnaIfAbsent
    if ($installed -isnot [bool]) { throw 'Package-manager output contaminated installation status' }
    if (-not $installed) { throw 'uv installation did not resolve the Etna launcher' }
    if ($script:installCalls -ne 1 -or (Get-HostEtnaCommand) -ne (Join-Path $root 'etna.exe')) { throw 'Non-PATH uv launcher was not retained' }
    if ($env:UV_PYTHON_INSTALL_DIR -ne 'Vulcan managed Python' -or $env:UV_TOOL_DIR -ne 'Vulcan managed tools' -or $env:UV_TOOL_BIN_DIR -ne 'Vulcan managed bin') { throw 'Vulcan environment was not restored' }
    # Reproduce the user's old CLI and its noisy native stdout exactly.
    $script:testPython = $true
    function etna-python-test {
        $global:LASTEXITCODE = 0
        if ($args -contains '--help') {
            if ($script:modernEtna) { Write-Output ("etna " + [char]27 + "[32minit" + [char]27 + "[0m") }
            else { Write-Output 'Commands: install, update, start, stop' }
            return
        }
        $script:chosenVerb = $args[-1]
        Write-Output 'Etna native command output'
        $global:LASTEXITCODE = $script:nativeCode
    }
    foreach ($modern in @($false, $true)) {
        foreach ($nativeCode in @(0, 1)) {
            $script:modernEtna = $modern; $script:nativeCode = $nativeCode
            $code = Invoke-EtnaModule 'init'
            $expected = if ($modern) { 'init' } else { 'install' }
            if ($code -isnot [int] -or $code -ne $nativeCode -or $script:chosenVerb -ne $expected) { throw 'Etna verb compatibility or numeric exit-code handling failed' }
        }
    }
    $script:testPython = $false
    # The simulated failing native command must not become the test runner's
    # exit status after all assertions pass.
    $global:LASTEXITCODE = 0
    function Start-Sleep { param($Milliseconds) }
    $script:checks = 0
    function Test-EtnaHealth { $script:checks++; return $script:checks -ge 3 }
    if (-not (Wait-EtnaHealth) -or $script:checks -ne 3) { throw 'Etna startup readiness was not awaited' }
    # A healthy HTTP endpoint is insufficient when the login task is missing.
    function Get-HostEtnaRoot { return $root }
    function Test-Path {
        param($Path, $PathType)
        return $script:existingHome
    }
    function Test-EtnaHealth { return $script:healthy }
    function Test-EtnaStartupTask { return $script:startupReady }
    function Install-EtnaIfAbsent { $script:acquisitions++; return $true }
    function Invoke-EtnaModule {
        param($Verb)
        $script:verbs += $Verb
        if ($Verb -eq 'init') { $script:startupReady = $true }
        $script:healthy = $true
        return 0
    }
    foreach ($case in @(
        @{ existing=$true; healthy=$true; startup=$false; verb='init'; acquire=0 },
        @{ existing=$true; healthy=$false; startup=$false; verb='init'; acquire=0 },
        @{ existing=$true; healthy=$false; startup=$true; verb='start'; acquire=0 },
        @{ existing=$true; healthy=$true; startup=$true; verb=''; acquire=0 },
        @{ existing=$false; healthy=$false; startup=$false; verb='init'; acquire=1 },
        @{ existing=$false; healthy=$true; startup=$false; verb='init'; acquire=0 }
    )) {
        $script:existingHome = $case.existing
        $script:healthy = $case.healthy
        $script:startupReady = $case.startup
        $script:verbs = @(); $script:acquisitions = 0
        Ensure-HostEtna
        if (($script:verbs -join ',') -ne $case.verb -or $script:acquisitions -ne $case.acquire) {
            throw "Etna startup convergence failed: $($case | Out-String)"
        }
    }
} finally {
    $env:UV_PYTHON_INSTALL_DIR = $oldPython
    $env:UV_TOOL_DIR = $oldTools
    $env:UV_TOOL_BIN_DIR = $oldBins
    Remove-Item -Recurse -Force $root
}
Write-Host "Native Etna launcher discovery, separate tool locations, startup wait, and repeat repair verified under PowerShell $($PSVersionTable.PSVersion)."
