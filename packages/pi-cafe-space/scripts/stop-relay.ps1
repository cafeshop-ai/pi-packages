$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Entry = Join-Path $Root "dist\relay\index.js"

function Get-FallbackRuntime {
  $HashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $RootHash = [System.BitConverter]::ToString($HashAlgorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Root))).Replace("-", "").Substring(0, 16).ToLowerInvariant()
  } finally {
    $HashAlgorithm.Dispose()
  }
  return Join-Path ([System.IO.Path]::GetTempPath()) ("pi-cafe-space-" + $RootHash)
}

$PidFiles = @()
$PackageRuntime = Join-Path $Root ".runtime"
$PackageRuntimeItem = Get-Item -LiteralPath $PackageRuntime -ErrorAction SilentlyContinue
if ($PackageRuntimeItem -is [System.IO.DirectoryInfo]) {
  $PidFiles += Get-ChildItem -LiteralPath $PackageRuntime -Filter "relay*.pid" -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
}
$FallbackRuntime = Get-FallbackRuntime
$FallbackRuntimeItem = Get-Item -LiteralPath $FallbackRuntime -ErrorAction SilentlyContinue
if ($FallbackRuntimeItem -is [System.IO.DirectoryInfo]) {
  $PidFiles += Get-ChildItem -LiteralPath $FallbackRuntime -Filter "relay*.pid" -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
}
# Keep compatibility with the original convenience locations.
$PidFiles += (Join-Path $Root ".relay.pid")
$PidFiles = @($PidFiles | Where-Object { $_ } | Select-Object -Unique)
$Stopped = $false

function Get-ProcessRecord([int]$ProcessId) {
  try {
    return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  } catch {
    return $null
  }
}

function Test-RelayRecord($Record) {
  if (-not $Record) { return $false }
  $Name = [string]$Record.Name
  $CommandLine = [string]$Record.CommandLine
  if ($Name -notmatch "^node(\.exe)?$") { return $false }
  $NormalizedCommand = $CommandLine.Replace("/", "\").Trim()
  $NormalizedEntry = [System.IO.Path]::GetFullPath($Entry).Replace("/", "\")
  # Match only the node script argument. Merely mentioning the relay path in
  # an unrelated node process must never authorize terminating that process.
  $NodeToken = '(?:"[^"]*\\node(?:\.exe)?"|(?:[A-Za-z]:\\[^"\s]*\\)?node(?:\.exe)?)'
  $PathPattern = '(?i)^\s*' + $NodeToken + '\s+"?' + [regex]::Escape($NormalizedEntry) + '"?\s*$'
  return $NormalizedCommand -match $PathPattern
}

function Test-RelayOwnership([int]$ProcessId) {
  return Test-RelayRecord (Get-ProcessRecord $ProcessId)
}

function Stop-OwnedProcess([int]$ProcessId) {
  $Before = Get-ProcessRecord $ProcessId
  if (-not (Test-RelayRecord $Before)) { return $false }
  $Creation = [string]$Before.CreationDate
  if (-not $Creation) { return $false }
  $Confirm = Get-ProcessRecord $ProcessId
  if (-not (Test-RelayRecord $Confirm) -or [string]$Confirm.CreationDate -ne $Creation) { return $false }
  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

foreach ($PidFile in $PidFiles) {
  if (-not (Test-Path -LiteralPath $PidFile)) { continue }
  $PidTextValue = $null
  try {
    $Marker = Get-Item -LiteralPath $PidFile -ErrorAction Stop
    if (($Marker.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $Marker.Length -gt 64) {
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
      continue
    }
    $PidTextValue = [System.IO.File]::ReadAllText($PidFile)
  } catch {
    # A marker may be locked while another starter is publishing it. Do not
    # infer ownership or delete a file that could still be in use.
    continue
  }
  if ($null -eq $PidTextValue) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    continue
  }
  $PidText = $PidTextValue.Trim()
  $RelayPid = 0
  if ([int]::TryParse($PidText, [ref]$RelayPid) -and $RelayPid -gt 0) {
    if (Stop-OwnedProcess $RelayPid) {
      for ($Attempt = 0; $Attempt -lt 20; $Attempt++) {
        $Remaining = Get-ProcessRecord $RelayPid
        if (-not $Remaining -or -not (Test-RelayOwnership $RelayPid)) { break }
        Start-Sleep -Milliseconds 50
      }
      Write-Host "Stopped Pi Cafe Space relay PID $RelayPid"
      $Stopped = $true
    } else {
      Write-Host "Did not stop unrelated or already-exited process PID $RelayPid"
    }
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}
if (-not $Stopped) { Write-Host "No owned Pi Cafe Space relay process was stopped" }
