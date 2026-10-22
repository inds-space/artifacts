$ErrorActionPreference = "Stop"

$repo = "inds-space/artifacts"
$asset = "artifacts-windows-x64.exe"
$installDir = Join-Path $env:LOCALAPPDATA "Programs\artifacts"
$destination = Join-Path $installDir "artifacts.exe"

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Invoke-WebRequest -Uri "https://github.com/$repo/releases/latest/download/$asset" -OutFile $destination -UseBasicParsing

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $installDir) {
  [Environment]::SetEnvironmentVariable("Path", (($userPath.TrimEnd(";"), $installDir) -join ";"), "User")
}

Write-Output "Installed artifacts to $destination"
Write-Output "Provide ARTIFACTS_ACCESS_CLIENT_ID and ARTIFACTS_ACCESS_CLIENT_SECRET privately, then run: artifacts setup --url https://artifacts.<your-domain>"
