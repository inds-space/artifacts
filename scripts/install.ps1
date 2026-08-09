$ErrorActionPreference = "Stop"

$repo = "inds-space/artifacts"
$asset = "artifacts-windows-x64.exe"
$installDir = Join-Path $env:LOCALAPPDATA "Programs\artifacts"
$destination = Join-Path $installDir "artifacts.exe"
$gh = Get-Command gh -ErrorAction Stop
& $gh.Source auth status *> $null
if ($LASTEXITCODE -ne 0) { throw "Authenticated GitHub CLI access is required. Run: gh auth login" }
$release = & $gh.Source release view --repo $repo --json tagName | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $release.tagName) { throw "Latest private release could not be resolved." }
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("artifacts-install-" + [guid]::NewGuid().ToString("N"))

try {
  New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
  & $gh.Source release download $release.tagName --repo $repo --pattern $asset --dir $temporaryDirectory
  if ($LASTEXITCODE -ne 0) { throw "Release asset $asset could not be downloaded." }
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $temporaryDirectory $asset) -Destination $destination -Force
} finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $installDir) {
  [Environment]::SetEnvironmentVariable("Path", (($userPath.TrimEnd(";"), $installDir) -join ";"), "User")
}

Write-Output "Installed artifacts $($release.tag_name) to $destination"
Write-Output "Open a new terminal, then run: artifacts --help"
