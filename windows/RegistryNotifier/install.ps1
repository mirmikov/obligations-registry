param([switch]$NoStart)

$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $env:LOCALAPPDATA "Mirt\RegistryNotifier\App"
$sourceResolved = (Resolve-Path $source).Path
$targetResolved = [System.IO.Path]::GetFullPath($target)
if ($targetResolved -eq $sourceResolved -or $targetResolved.StartsWith($sourceResolved + [System.IO.Path]::DirectorySeparatorChar)) {
    throw "Do not run the installer from the application target directory."
}
New-Item -ItemType Directory -Force -Path $target | Out-Null
Get-Process RegistryNotifier -ErrorAction SilentlyContinue | Stop-Process -ErrorAction SilentlyContinue
Copy-Item -Path (Join-Path $source "RegistryNotifier.exe") -Destination $target -Force
$executable = Join-Path $target "RegistryNotifier.exe"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
New-ItemProperty -Path $runKey -Name "MirtRegistryNotifier" -Value ('"' + $executable + '" --autostart') -PropertyType String -Force | Out-Null
if (-not $NoStart) { Start-Process -FilePath $executable }
Write-Host "Installed: $executable"
