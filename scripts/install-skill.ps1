param(
  [string[]]$Targets = @(
    (Join-Path $HOME ".codex\skills"),
    (Join-Path $HOME ".claude\skills"),
    (Join-Path $HOME ".gemini\antigravity\skills")
  )
)

$ErrorActionPreference = "Stop"
$source = Resolve-Path (Join-Path $PSScriptRoot "..\skills\artifacts")
foreach ($target in $Targets) {
  $destination = Join-Path $target "artifacts"
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Copy-Item -Path $source -Destination $destination -Recurse -Force
  Write-Output "Installed artifacts skill at $destination"
}
