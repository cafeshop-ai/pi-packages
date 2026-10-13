param(
  [string]$RelayUrl = "ws://127.0.0.1:37891/ws",
  [string]$Room = "main",
  [string]$HostToken = "local-dev-host-token",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$PiArgs
)

$ErrorActionPreference = "Stop"
if ($RelayUrl.Length -gt 8192) { throw "RelayUrl is too long" }
if ($Room.Length -gt 64) { throw "Room is too long" }
if ($HostToken.Length -gt 4096) { throw "HostToken is too long" }
$Root = Split-Path -Parent $PSScriptRoot
$Extension = Join-Path $Root "dist\extension\index.js"

if (-not (Test-Path -LiteralPath $Extension)) {
  Push-Location $Root
  try { & npm run build; if ($LASTEXITCODE -ne 0) { throw "npm run build failed" } }
  finally { Pop-Location }
}

$OriginalPiCollabEnabled = $env:PI_COLLAB_ENABLED
$OriginalPiCollabRelayUrl = $env:PI_COLLAB_RELAY_URL
$OriginalPiCollabRoom = $env:PI_COLLAB_ROOM
$OriginalPiCollabHostToken = $env:PI_COLLAB_HOST_TOKEN
$HadPiCollabEnabled = [System.Environment]::GetEnvironmentVariables("Process").ContainsKey("PI_COLLAB_ENABLED")
$HadPiCollabRelayUrl = [System.Environment]::GetEnvironmentVariables("Process").ContainsKey("PI_COLLAB_RELAY_URL")
$HadPiCollabRoom = [System.Environment]::GetEnvironmentVariables("Process").ContainsKey("PI_COLLAB_ROOM")
$HadPiCollabHostToken = [System.Environment]::GetEnvironmentVariables("Process").ContainsKey("PI_COLLAB_HOST_TOKEN")
$ExitCode = 1
try {
  $env:PI_COLLAB_ENABLED = "1"
  $env:PI_COLLAB_RELAY_URL = $RelayUrl
  $env:PI_COLLAB_ROOM = $Room
  $env:PI_COLLAB_HOST_TOKEN = $HostToken

  & pi --collab @PiArgs
  $ExitCode = $LASTEXITCODE
} finally {
  if ($HadPiCollabEnabled) { $env:PI_COLLAB_ENABLED = $OriginalPiCollabEnabled } else { Remove-Item Env:PI_COLLAB_ENABLED -ErrorAction SilentlyContinue }
  if ($HadPiCollabRelayUrl) { $env:PI_COLLAB_RELAY_URL = $OriginalPiCollabRelayUrl } else { Remove-Item Env:PI_COLLAB_RELAY_URL -ErrorAction SilentlyContinue }
  if ($HadPiCollabRoom) { $env:PI_COLLAB_ROOM = $OriginalPiCollabRoom } else { Remove-Item Env:PI_COLLAB_ROOM -ErrorAction SilentlyContinue }
  if ($HadPiCollabHostToken) { $env:PI_COLLAB_HOST_TOKEN = $OriginalPiCollabHostToken } else { Remove-Item Env:PI_COLLAB_HOST_TOKEN -ErrorAction SilentlyContinue }
}
exit $ExitCode
