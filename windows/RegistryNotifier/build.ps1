param(
    [string]$Runtime = "win-x64",
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outputDir = Join-Path $projectDir "dist\$Runtime"
$package = Join-Path $projectDir "dist\RegistryNotifier-$Runtime.zip"

dotnet publish (Join-Path $projectDir "RegistryNotifier.csproj") -c $Configuration -r $Runtime --self-contained true -o $outputDir
$selfTest = Join-Path $outputDir "self-test.txt"
$selfTestProcess = Start-Process -FilePath (Join-Path $outputDir "RegistryNotifier.exe") -ArgumentList @("--self-test", $selfTest) -Wait -PassThru
if ($selfTestProcess.ExitCode -ne 0) { throw "RegistryNotifier self-test failed." }
Get-Content $selfTest
Remove-Item -LiteralPath $selfTest -Force
Remove-Item -LiteralPath (Join-Path $outputDir "RegistryNotifier.pdb") -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $projectDir "install.ps1") -Destination $outputDir -Force
Copy-Item -LiteralPath (Join-Path $projectDir "README.md") -Destination $outputDir -Force
if (Test-Path $package) { Remove-Item -LiteralPath $package }
Compress-Archive -Path (Join-Path $outputDir "*") -DestinationPath $package
Write-Host "Ready: $package"
