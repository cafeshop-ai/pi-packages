param(
  [string]$Bind = "127.0.0.1",
  [int]$Port = 37891,
  [string]$HostToken = "local-dev-host-token",
  [string]$ClientToken = "local-dev-client-token"
)

$ErrorActionPreference = "Stop"
$OriginalPiCollabHost = $env:PI_COLLAB_HOST
$OriginalPiCollabPort = $env:PI_COLLAB_PORT
$OriginalPiCollabHostToken = $env:PI_COLLAB_HOST_TOKEN
$OriginalPiCollabClientToken = $env:PI_COLLAB_CLIENT_TOKEN
$HadPiCollabHost = [System.Environment]::GetEnvironmentVariables("Process").ContainsKey("PI_COLLAB_HOST")
$HadPiCollabPort = [System.Environment]::GetEnvironmentVariables("Process").ContainsKey("PI_COLLAB_PORT")
$HadPiCollabHostToken = [System.Environment]::GetEnvironmentVariables("Process").ContainsKey("PI_COLLAB_HOST_TOKEN")
$HadPiCollabClientToken = [System.Environment]::GetEnvironmentVariables("Process").ContainsKey("PI_COLLAB_CLIENT_TOKEN")
$Root = Split-Path -Parent $PSScriptRoot
if ($Bind.Length -gt 255) { throw "Bind must be at most 255 characters" }
if ($HostToken.Length -gt 4096 -or $ClientToken.Length -gt 4096) { throw "Host and client tokens must be at most 4096 characters" }
if ($env:PI_COLLAB_ALLOWED_ORIGINS -and $env:PI_COLLAB_ALLOWED_ORIGINS.Length -gt (64 * 2049)) { throw "PI_COLLAB_ALLOWED_ORIGINS is too large" }
$Bind = $Bind.Trim()
$ProcessBind = $Bind.Trim("[]")
if ($ProcessBind -eq "localhost") { $ProcessBind = "127.0.0.1" }
if (-not $ProcessBind) { throw "Bind must not be empty" }
$HostToken = $HostToken.Trim()
$ClientToken = $ClientToken.Trim()
if (-not $HostToken -or -not $ClientToken) { throw "Host and client tokens must not be empty" }
if ($HostToken.Length -gt 4096 -or $ClientToken.Length -gt 4096) { throw "Host and client tokens must be at most 4096 characters" }
$HostTokenLower = $HostToken.ToLowerInvariant()
$ClientTokenLower = $ClientToken.ToLowerInvariant()
$DisplayedClientToken = if ($ClientTokenLower -eq "local-dev-client-token") {
  $ClientToken
} elseif ($ClientToken.Length -le 8 -or $ClientToken -match '[^\x20-\x7E]') {
  "***"
} else {
  $ClientToken.Substring(0, 4) + "..." + $ClientToken.Substring($ClientToken.Length - 4)
}
$Entry = Join-Path $Root "dist\relay\index.js"
$isLoopback = @("127.0.0.1", "localhost", "::1") -contains $ProcessBind.ToLowerInvariant()
if ($Port -lt 1 -or $Port -gt 65535) { throw "Port must be between 1 and 65535" }
function Test-TokenEntropy([string]$Token) {
  if ($null -eq $Token -or $Token.Length -gt 4096) { return $false }
  # PowerShell 5.1 exposes UTF-16 code units rather than JavaScript-style
  # code points. Combine surrogate pairs so the policy matches the TypeScript
  # relay check for non-ASCII tokens as well as ordinary printable tokens.
  $characters = New-Object 'System.Collections.Generic.List[string]'
  for ($Index = 0; $Index -lt $Token.Length; $Index++) {
    $Character = $Token[$Index]
    if ([char]::IsHighSurrogate($Character) -and $Index + 1 -lt $Token.Length -and [char]::IsLowSurrogate($Token[$Index + 1])) {
      $characters.Add(([string]::Concat($Character, $Token[$Index + 1])))
      $Index++
    } else {
      $characters.Add([string]$Character)
    }
  }
  $distinctCharacters = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($Character in $characters) { [void]$distinctCharacters.Add($Character) }
  if ($characters.Count -lt 16 -or $distinctCharacters.Count -lt 8) { return $false }
  for ($Period = 1; $Period -le [Math]::Min(8, [Math]::Floor($characters.Count / 2)); $Period++) {
    $Repeated = $true
    for ($Index = $Period; $Index -lt $characters.Count; $Index++) {
      if ($characters[$Index] -cne $characters[$Index % $Period]) { $Repeated = $false; break }
    }
    if ($Repeated) { return $false }
  }
  $singleUnitCharacters = @($characters | Where-Object { $_.Length -ne 1 }).Count -eq 0
  if ($singleUnitCharacters) {
    $First = [int][char]$characters[0]
    $Second = [int][char]$characters[1]
    $Step = $Second - $First
    if ($Step -eq 1 -or $Step -eq -1) {
      $Sequential = $true
      for ($Index = 2; $Index -lt $characters.Count; $Index++) {
        if (([int][char]$characters[$Index] - [int][char]$characters[$Index - 1]) -ne $Step) { $Sequential = $false; break }
      }
      if ($Sequential) { return $false }
    }
  }
  $counts = New-Object 'System.Collections.Generic.Dictionary[string,int]'
  foreach ($Character in $characters) {
    $Key = [string]$Character
    if ($counts.ContainsKey($Key)) { $counts[$Key]++ } else { $counts.Add($Key, 1) }
  }
  foreach ($Count in $counts.Values) {
    if ($Count * 4 -gt $characters.Count) { return $false }
  }
  $Entropy = 0.0
  foreach ($Count in $counts.Values) {
    $Probability = [double]$Count / $characters.Count
    $Entropy -= $Probability * [Math]::Log($Probability, 2)
  }
  return $Entropy -ge 3.0 -and ($Entropy * $characters.Count) -ge 64
}
if (-not $isLoopback -and ($HostTokenLower -eq $ClientTokenLower -or $HostTokenLower -in @("local-dev-host-token", "local-dev-client-token") -or
    $ClientTokenLower -in @("local-dev-host-token", "local-dev-client-token") -or
    $HostToken -match "^replace-with-((a-long-random-)?(host|client)|a-long-random|random)-token$" -or $ClientToken -match "^replace-with-((a-long-random-)?(host|client)|a-long-random|random)-token$" -or
    -not (Test-TokenEntropy $HostToken) -or -not (Test-TokenEntropy $ClientToken))) {
  throw "Use explicit high-entropy tokens (at least 16 characters) when binding relay outside loopback"
}

function Test-RuntimeWritable([string]$Path) {
  try {
    New-Item -ItemType Directory -Path $Path -Force -ErrorAction Stop | Out-Null
    $Probe = Join-Path $Path (".write-test-" + [guid]::NewGuid().ToString("N"))
    [System.IO.File]::WriteAllText($Probe, "")
    Remove-Item -LiteralPath $Probe -Force -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

# Installed Pi packages can live under a read-only global directory. Prefer a
# package-local runtime, then a per-package temp runtime, and finally run
# without a lock/PID convenience file if neither location is writable.
$PackageRuntime = Join-Path $Root ".runtime"
$Runtime = $PackageRuntime
if (-not (Test-RuntimeWritable $Runtime)) {
  $HashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $RootHash = [System.BitConverter]::ToString($HashAlgorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Root))).Replace("-", "").Substring(0, 16).ToLowerInvariant()
  } finally {
    $HashAlgorithm.Dispose()
  }
  $Runtime = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-cafe-space-" + $RootHash)
  if (Test-RuntimeWritable $Runtime) {
    Write-Warning "Package runtime directory is not writable; using temporary runtime $Runtime"
  } else {
    $Runtime = $null
    Write-Warning "No writable runtime directory; starting without a lock or PID convenience file"
  }
}

$LockKey = ("{0}-{1}" -f $ProcessBind, $Port) -replace "[^a-zA-Z0-9_.-]", "_"
$PidFile = $null
$LockPath = $null
if ($Runtime) {
  $PidName = if ($ProcessBind -eq "127.0.0.1" -and $Port -eq 37891) { "relay.pid" } else { "relay.$LockKey.pid" }
  $PidFile = Join-Path $Runtime $PidName
  $LockPath = Join-Path $Runtime "relay.start.$LockKey.lock"
}
$PidFilesToCheck = @()
if ($PidFile) { $PidFilesToCheck += $PidFile }
if ($ProcessBind -eq "127.0.0.1" -and $Port -eq 37891) { $PidFilesToCheck += (Join-Path $Root ".relay.pid") }
$HealthHost = if ($ProcessBind -eq "0.0.0.0" -or $ProcessBind -eq "::") { "127.0.0.1" } else { $ProcessBind }
$HealthDisplayHost = if ($HealthHost.Contains(":")) { "[$HealthHost]" } else { $HealthHost }
$WebDisplayHost = if ($ProcessBind -eq "0.0.0.0" -or $ProcessBind -eq "::") { "<this-machine-LAN-IP>" } else { $HealthDisplayHost }
$HealthUrl = "http://${HealthDisplayHost}:$Port/healthz"

function Test-RelayHealth {
  $Response = $null
  $Stream = $null
  $Memory = $null
  try {
    $Request = [System.Net.HttpWebRequest]::Create($HealthUrl)
    $Request.Method = "GET"
    $Request.AllowAutoRedirect = $false
    $Request.KeepAlive = $false
    $Request.Proxy = $null
    $Request.Timeout = 2000
    $Request.ReadWriteTimeout = 2000
    $Request.MaximumResponseHeadersLength = 16
    $Response = [System.Net.HttpWebResponse]$Request.GetResponse()
    if ($Response.StatusCode -ne [System.Net.HttpStatusCode]::OK) { return $false }
    if ($Response.ContentLength -gt 8192) { return $false }
    $Stream = $Response.GetResponseStream()
    if (-not $Stream) { return $false }
    $Memory = New-Object System.IO.MemoryStream
    $Buffer = New-Object byte[] 1024
    $Total = 0
    while (($Read = $Stream.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
      $Total += $Read
      if ($Total -gt 8192) { return $false }
      $Memory.Write($Buffer, 0, $Read)
    }
    $Utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $Text = $Utf8.GetString($Memory.ToArray())
    $Body = $Text | ConvertFrom-Json
    return $Body.ok -eq $true -and $Body.protocolVersion -eq 1
  } catch {
    return $false
  } finally {
    if ($Memory) { try { $Memory.Dispose() } catch {} }
    if ($Stream) { try { $Stream.Dispose() } catch {} }
    if ($Response) { try { $Response.Dispose() } catch {} }
  }
}

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
  # The relay entry must be the node script argument, not merely an arbitrary
  # argument somewhere in an unrelated node process. This avoids PID-marker
  # spoofing such as `node malicious.js <path-to-relay-entry>`.
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
  # Re-read the exact record immediately before termination. Testing this
  # record directly avoids accidentally proving ownership on a third lookup.
  $Confirm = Get-ProcessRecord $ProcessId
  if (-not (Test-RelayRecord $Confirm) -or [string]$Confirm.CreationDate -ne $Creation) { return $false }
  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Stop-OwnedRelayFromPidFile {
  foreach ($Candidate in $PidFilesToCheck) {
    if (-not (Test-Path -LiteralPath $Candidate)) { continue }
    $PidTextValue = $null
    try {
      $Marker = Get-Item -LiteralPath $Candidate -ErrorAction Stop
      if (($Marker.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $Marker.Length -gt 64) {
        Remove-Item -LiteralPath $Candidate -Force -ErrorAction SilentlyContinue
        continue
      }
      $PidTextValue = [System.IO.File]::ReadAllText($Candidate)
    } catch {
      # A concurrently written/locked marker is not evidence of ownership.
      # Leave it for the next pass unless it can be removed safely.
      continue
    }
    if ($null -eq $PidTextValue) {
      Remove-Item -LiteralPath $Candidate -Force -ErrorAction SilentlyContinue
      continue
    }
    $PidText = $PidTextValue.Trim()
    $OldPid = 0
    if ([int]::TryParse($PidText, [ref]$OldPid) -and $OldPid -gt 0) {
      if (Stop-OwnedProcess $OldPid) {
        for ($Attempt = 0; $Attempt -lt 20; $Attempt++) {
          $Remaining = Get-ProcessRecord $OldPid
          if (-not $Remaining -or -not (Test-RelayOwnership $OldPid)) { break }
          Start-Sleep -Milliseconds 50
        }
        Write-Host "Stopped previous Pi Cafe Space relay PID $OldPid"
      } else {
        Write-Host "Ignoring relay PID file for unrelated or already-exited process PID $OldPid"
      }
    }
    Remove-Item -LiteralPath $Candidate -Force -ErrorAction SilentlyContinue
  }
}

function Write-PidMarker([string]$Path, [int]$ProcessId) {
  if (-not $Path) { return $false }
  $Stream = $null
  try {
    # CreateNew prevents a lockless/read-only-runtime starter from replacing
    # another starter's ownership marker after both observe the healthy port.
    $Stream = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None
    )
    $Bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$ProcessId)
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true)
    return $true
  } catch {
    return $false
  } finally {
    if ($Stream) {
      try { $Stream.Dispose() } catch {}
    }
  }
}

function Start-RelayChild {
  $NodeCommand = @(Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1)[0]
  if (-not $NodeCommand -or -not $NodeCommand.Source) { throw "Could not find the node executable" }
  # Windows PowerShell 5.1 has no Start-Process -Environment parameter. Build
  # the child environment by temporarily scrubbing this process immediately
  # around CreateProcess, then restore every caller variable in a finally
  # block. The child receives only OS launch variables and relay config; the
  # caller never loses its environment after this helper returns.
  $originalEnvironment = @{}
  foreach ($Item in ([System.Environment]::GetEnvironmentVariables("Process")).GetEnumerator()) {
    $originalEnvironment[[string]$Item.Key] = [string]$Item.Value
  }
  $allowedNames = @(
    "path", "systemroot", "systemdrive", "windir", "comspec", "temp", "tmp", "localappdata",
    "appdata", "programdata", "allusersprofile", "public", "userprofile", "homedrive", "homepath", "homeshare",
    "programfiles", "programfiles(x86)", "programw6432", "commonprogramfiles", "commonprogramfiles(x86)",
    "commonprogramw6432", "os", "number_of_processors", "processor_architecture", "processor_identifier",
    "processor_level", "processor_revision", "pi_collab_host", "pi_collab_port", "pi_collab_host_token",
    "pi_collab_client_token", "pi_collab_allowed_origins")
  try {
    foreach ($Name in @($originalEnvironment.Keys)) {
      if ($allowedNames -notcontains $Name.ToLowerInvariant()) {
        [System.Environment]::SetEnvironmentVariable($Name, $null, "Process")
      }
    }
    $env:PI_COLLAB_HOST = $ProcessBind
    $env:PI_COLLAB_PORT = "$Port"
    $env:PI_COLLAB_HOST_TOKEN = $HostToken
    $env:PI_COLLAB_CLIENT_TOKEN = $ClientToken
    $Child = Start-Process -FilePath $NodeCommand.Source -ArgumentList ('"' + $Entry.Replace('"', '\"') + '"') -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    return $Child
  } finally {
    foreach ($Name in @(([System.Environment]::GetEnvironmentVariables("Process")).Keys)) {
      if (-not $originalEnvironment.ContainsKey([string]$Name)) {
        [System.Environment]::SetEnvironmentVariable([string]$Name, $null, "Process")
      }
    }
    foreach ($Item in $originalEnvironment.GetEnumerator()) {
      [System.Environment]::SetEnvironmentVariable([string]$Item.Key, [string]$Item.Value, "Process")
    }
  }
}

$LockHandle = $null
$Process = $null
$PidWritten = $false
try {
  if ($LockPath) {
    # CreateNew is atomic and the open handle keeps the lock owned for the whole
    # restart. This coordinates manual starts with extension auto-starts.
    for ($Attempt = 0; $Attempt -lt 600 -and -not $LockHandle; $Attempt++) {
      try {
        $LockHandle = [System.IO.File]::Open(
          $LockPath,
          [System.IO.FileMode]::CreateNew,
          [System.IO.FileAccess]::Write,
          [System.IO.FileShare]::None
        )
      } catch [System.UnauthorizedAccessException] {
        # A package can become read-only after the initial probe. Continue
        # without the convenience lock; the health/port race still protects
        # the actual listener.
        Write-Warning "Could not create the relay startup lock; continuing without a persistent lock"
        $LockPath = $null
        break
      } catch [System.IO.IOException] {
        if (Test-RelayHealth) {
          Write-Host "Pi Cafe Space relay is already healthy at $HealthUrl"
          return
        }
        try {
          $LockAge = (Get-Date) - (Get-Item -LiteralPath $LockPath).LastWriteTime
          if ($LockAge.TotalSeconds -gt 60) {
            Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
          }
        } catch {}
        Start-Sleep -Milliseconds 100
      }
    }
    if ($LockPath -and -not $LockHandle) { throw "Could not acquire the relay startup lock" }
  } elseif (Test-RelayHealth) {
    Write-Host "Pi Cafe Space relay is already healthy at $HealthUrl"
    return
  } else {
    Write-Warning "Starting without a persistent relay startup lock"
  }

  # Re-check after taking the lock; another starter may have won just before
  # this process created its lock file.
  if (Test-RelayHealth) {
    Write-Host "Pi Cafe Space relay is already healthy at $HealthUrl"
    return
  }

  Stop-OwnedRelayFromPidFile

  if (-not (Test-Path -LiteralPath $Entry)) {
    Push-Location $Root
    try {
      & npm run build
      if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    } finally {
      Pop-Location
    }
  }

  $env:PI_COLLAB_HOST = $ProcessBind
  $env:PI_COLLAB_PORT = "$Port"
  $env:PI_COLLAB_HOST_TOKEN = $HostToken
  $env:PI_COLLAB_CLIENT_TOKEN = $ClientToken

  $Process = Start-RelayChild

  for ($Attempt = 0; $Attempt -lt 30; $Attempt++) {
    Start-Sleep -Milliseconds 100
    if (Test-RelayHealth) {
      # A different process can make the port healthy while this child is
      # failing to bind. Only publish our PID after confirming ownership, so a
      # losing starter cannot overwrite the winner's convenience metadata.
      $OwnsHealthyRelay = $false
      for ($OwnershipAttempt = 0; $OwnershipAttempt -lt 10; $OwnershipAttempt++) {
        if (Test-RelayOwnership $Process.Id) {
          $OwnsHealthyRelay = $true
          break
        }
        Start-Sleep -Milliseconds 50
      }
      if (-not $OwnsHealthyRelay) {
        # This child lost the bind race. It is ours even though it did not own
        # the healthy listener, so clean it up if it is still present; never
        # touch the unrelated process that made the port healthy.
        if ($Process) { [void](Stop-OwnedProcess $Process.Id) }
        Write-Host "Pi Cafe Space relay is already healthy at $HealthUrl"
        return
      }
      if ($PidFile) {
        if (Write-PidMarker $PidFile $Process.Id) {
          $PidWritten = $true
        } else {
          Write-Warning "Could not write relay PID file; the relay will continue without convenience ownership metadata"
        }
      }
      Write-Host "Pi Cafe Space relay started (PID $($Process.Id))"
      Write-Host "Web: http://${WebDisplayHost}:$Port/"
      if ($ProcessBind -eq "0.0.0.0" -or $ProcessBind -eq "::") {
        Write-Host "Replace <this-machine-LAN-IP> with this computer's LAN address for phone access."
      }
      Write-Host "Room: main"
      Write-Host "Client token: $DisplayedClientToken"
      return
    }
  }

  if ($Process) { [void](Stop-OwnedProcess $Process.Id) }
  if ($PidWritten) { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue }
  throw "Relay failed to start; see the relay process output for details"
} finally {
  if ($LockHandle) {
    try { $LockHandle.Dispose() } catch {}
    if ($LockPath) { Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue }
  }
  # Do not leave relay credentials in an interactive PowerShell parent's
  # environment after the child has inherited them.
  if ($HadPiCollabHost) { $env:PI_COLLAB_HOST = $OriginalPiCollabHost } else { Remove-Item Env:PI_COLLAB_HOST -ErrorAction SilentlyContinue }
  if ($HadPiCollabPort) { $env:PI_COLLAB_PORT = $OriginalPiCollabPort } else { Remove-Item Env:PI_COLLAB_PORT -ErrorAction SilentlyContinue }
  if ($HadPiCollabHostToken) { $env:PI_COLLAB_HOST_TOKEN = $OriginalPiCollabHostToken } else { Remove-Item Env:PI_COLLAB_HOST_TOKEN -ErrorAction SilentlyContinue }
  if ($HadPiCollabClientToken) { $env:PI_COLLAB_CLIENT_TOKEN = $OriginalPiCollabClientToken } else { Remove-Item Env:PI_COLLAB_CLIENT_TOKEN -ErrorAction SilentlyContinue }
}
