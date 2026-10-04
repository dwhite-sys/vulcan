$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\..\install.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Get-HostEtnaCommand', 'Install-EtnaIfAbsent', 'Wait-EtnaHealth', 'Ensure-HostEtna')) {
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
    Set-Content (Join-Path $root 'etna.exe') 'launcher fixture'
    function Write-Step { param($Message) }
    function Get-Command {
        param($Name, [switch]$All, $ErrorAction)
        if ($Name -eq 'uv') { return @{ Source = 'uv-test' } }
    }
    $script:installCalls = 0
    function uv-test {
        $global:LASTEXITCODE = 0
        if ($args[1] -eq 'install') {
            $script:installCalls++
            if ($env:UV_PYTHON_INSTALL_DIR -or $env:UV_TOOL_DIR -or $env:UV_TOOL_BIN_DIR) { throw 'Etna inherited Vulcan managed locations' }
            if ($args -notcontains '3.12') { throw 'Etna fallback did not select supported Python' }
        } elseif ($args[1] -eq 'dir') { Write-Output $root }
    }
    if (-not (Install-EtnaIfAbsent)) { throw 'uv installation did not resolve the Etna launcher' }
    if ($script:installCalls -ne 1 -or (Get-HostEtnaCommand) -ne (Join-Path $root 'etna.exe')) { throw 'Non-PATH uv launcher was not retained' }
    if ($env:UV_PYTHON_INSTALL_DIR -ne 'Vulcan managed Python' -or $env:UV_TOOL_DIR -ne 'Vulcan managed tools' -or $env:UV_TOOL_BIN_DIR -ne 'Vulcan managed bin') { throw 'Vulcan environment was not restored' }
    function Start-Sleep { param($Milliseconds) }
    $script:checks = 0
    function Test-EtnaHealth { $script:checks++; return $script:checks -ge 3 }
    if (-not (Wait-EtnaHealth) -or $script:checks -ne 3) { throw 'Etna startup readiness was not awaited' }
    # An existing home should start itself without acquiring packages or reinitializing.
    function Test-Path {
        param($Path, $PathType)
        if ([string]$Path -match '\.etna_server') { return $true }
        return Microsoft.PowerShell.Management\Test-Path $Path -PathType $PathType
    }
    function Install-EtnaIfAbsent { throw 'Existing Etna was reinstalled' }
    $script:checks = 0; $script:verbs = @()
    function Invoke-EtnaModule { param($Verb) $script:verbs += $Verb; return 0 }
    Ensure-HostEtna
    if ($script:verbs.Count -ne 1 -or $script:verbs[0] -ne 'start') { throw 'Existing Etna was not started idempotently' }
} finally {
    $env:UV_PYTHON_INSTALL_DIR = $oldPython
    $env:UV_TOOL_DIR = $oldTools
    $env:UV_TOOL_BIN_DIR = $oldBins
    Remove-Item -Recurse -Force $root
}
Write-Host "Native Etna launcher discovery, separate tool locations, startup wait, and repeat repair verified under PowerShell $($PSVersionTable.PSVersion)."
