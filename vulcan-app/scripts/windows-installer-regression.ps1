$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\..\install.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$functions = @('Emit-Result', 'Fail', 'Invoke-Wsl') | ForEach-Object {
    $name = $_
    $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
    if (-not $node) { throw "Missing function $name" }
    $node.Extent.Text
}
$fixtureDir = Join-Path ([IO.Path]::GetTempPath()) ('Vulcan regression with spaces ' + [Guid]::NewGuid())
New-Item -ItemType Directory $fixtureDir | Out-Null
try {
    foreach ($case in @('failure', 'success')) {
        $fixture = Join-Path $fixtureDir "$case.ps1"
        $mock = if ($case -eq 'failure') {
            'function wsl.exe { $global:LASTEXITCODE = 42; Write-Output ("WSL" + [char]0 + " import error 0x80370102") }'
        } else {
            'function wsl.exe { $global:LASTEXITCODE = 0; Write-Output ("Vul" + [char]0 + "can") }'
        }
        @('$ErrorActionPreference = "Stop"', '$Json = $true', ($functions -join "`n"), $mock,
          'Invoke-Wsl -Arguments @("--import", "Vulcan", "C:\Users\Test User\Vulcan", "rootfs.tar.gz", "--version", "2")',
          'Write-Output "SUCCESS"') -join "`n" | Set-Content -Encoding UTF8 $fixture
        $ErrorActionPreference = "Continue"
        $output = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fixture 2>&1 | Out-String)
        $code = $LASTEXITCODE
        $ErrorActionPreference = "Stop"
        if ($case -eq 'failure') {
            if ($code -ne 1) { throw "Failure exit code was $code" }
            $line = ($output -split "`r?`n" | Where-Object { $_.StartsWith('VULCAN_RESULT=') } | Select-Object -First 1)
            if (-not $line) { throw "Failure did not emit structured result: $output" }
            $result = $line.Substring('VULCAN_RESULT='.Length) | ConvertFrom-Json
            if ($result.ok -ne $false -or $result.message -notmatch '0x80370102' -or $result.message -notmatch 'exit 42') { throw 'Native WSL error was lost' }
            if ($output.Contains([string][char]0)) { throw 'WSL NUL padding was not stripped' }
        } elseif ($code -ne 0 -or $output -notmatch 'Vulcan' -or $output -notmatch 'SUCCESS') {
            throw "Success path failed: $output"
        }
    }
} finally { Remove-Item -Recurse -Force $fixtureDir }
Write-Host "Installer parsing and WSL failure/success reporting verified under PowerShell $($PSVersionTable.PSVersion)."
