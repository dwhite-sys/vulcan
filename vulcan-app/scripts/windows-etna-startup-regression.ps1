$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\..\install.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Get-HostEtnaRoot', 'Test-EtnaStartupDefinition')) {
    $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
    Invoke-Expression $node.Extent.Text
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('Etna startup Ren' + [char]0xE9 + ' & spaces ' + [Guid]::NewGuid())
$oldConfig = $env:ETNA_CONFIG_DIR; $oldAppData = $env:APPDATA
try {
    $env:ETNA_CONFIG_DIR = Join-Path $root 'custom'
    if ((Get-HostEtnaRoot) -ne $env:ETNA_CONFIG_DIR) { throw 'Etna config override ignored' }
    Remove-Item Env:ETNA_CONFIG_DIR
    $env:APPDATA = $root
    if ((Get-HostEtnaRoot) -ne (Join-Path $root 'Etna')) { throw 'Etna Windows home differs from Etna config.py' }

    $scripts = Join-Path (Join-Path $root 'venv') 'Scripts'
    New-Item -ItemType Directory -Force $scripts | Out-Null
    $python = Join-Path $scripts 'pythonw.exe'
    $launcher = Join-Path $root 'service_launcher.py'
    Set-Content $python 'fixture'; Set-Content $launcher 'fixture'
    $xmlPython = [Security.SecurityElement]::Escape($python)
    $xmlLauncher = [Security.SecurityElement]::Escape($launcher)
    $xmlRoot = [Security.SecurityElement]::Escape($root)
    $sid = 'S-1-5-21-123'
    $valid = @"
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$sid</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals>
  <Settings><Enabled>true</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>$xmlPython</Command><Arguments>"$xmlLauncher"</Arguments><WorkingDirectory>$xmlRoot</WorkingDirectory></Exec></Actions>
</Task>
"@
    if (-not (Test-EtnaStartupDefinition ([xml]$valid) $sid $root)) { throw 'Valid login task rejected' }
    foreach ($invalid in @(
        $valid.Replace('<Settings><Enabled>true', '<Settings><Enabled>false'),
        $valid.Replace('<LogonTrigger><Enabled>true', '<LogonTrigger><Enabled>false'),
        $valid.Replace('LogonTrigger', 'BootTrigger'),
        $valid.Replace($sid, 'S-1-5-21-999'),
        $valid.Replace('InteractiveToken', 'ServiceAccount'),
        $valid.Replace('pythonw.exe', 'missing.exe'),
        $valid.Replace('service_launcher.py', 'missing.py'),
        $valid.Replace('<WorkingDirectory>', '<WorkingDirectory>wrong'),
        '<Task />'
    )) {
        if (Test-EtnaStartupDefinition ([xml]$invalid) $sid $root) { throw "Broken login task accepted: $invalid" }
    }
    Remove-Item $launcher
    if (Test-EtnaStartupDefinition ([xml]$valid) $sid $root) { throw 'Missing launcher accepted' }
} finally {
    $env:ETNA_CONFIG_DIR = $oldConfig; $env:APPDATA = $oldAppData
    if (Test-Path $root) { Remove-Item -Recurse -Force $root }
}
Write-Host 'Etna login startup: config roots, user identity, enabled triggers, stale paths, and missing launchers verified.'
