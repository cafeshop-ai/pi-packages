param([string]$Bind='127.0.0.1',[int]$Port=37891,[string]$HostToken='local-dev-host-token',[string]$ClientToken='local-dev-client-token')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'process-owner.ps1')
$Root=Split-Path -Parent $PSScriptRoot
if($Bind.Length -gt 255 -or $HostToken.Length -gt 4096 -or $ClientToken.Length -gt 4096 -or $env:PI_COLLAB_ALLOWED_ORIGINS.Length -gt (64*2049)){throw 'Relay configuration exceeds raw limits'}
$Bind=$Bind.Trim().Trim('[',']');if($Bind -eq 'localhost'){$Bind='127.0.0.1'}
if(!$Bind -or !$HostToken.Trim() -or !$ClientToken.Trim() -or $Port -lt 1 -or $Port -gt 65535){throw 'Invalid relay configuration'}
$Binary=Get-GoBinary $Root
$healthHost=$Bind;if($Bind -eq '0.0.0.0' -or $Bind -eq '::'){$healthHost='127.0.0.1'};if($healthHost.Contains(':')){$healthHost="[$healthHost]"}
$health="http://${healthHost}:$Port/healthz"
if(Test-GoHealth $health){Write-Output 'Relay already running; no process changed';return}
$runtime=Join-Path $Root '.runtime-go';if(!(Test-Path -LiteralPath $runtime)){New-Item -ItemType Directory -Path $runtime -ErrorAction Stop|Out-Null}
if(!(Test-OrdinaryPath $runtime $false)){throw 'Untrusted or read-only runtime directory; run the executable explicitly'}
$key=("$Bind-$Port" -replace '[^a-zA-Z0-9_.-]','_');$lockPath=Join-Path $runtime "relay.$key.lock";$marker=Join-Path $runtime "relay.$key.json"
$lock=$null;$child=$null;$published=$false;$nonce=[guid]::NewGuid().ToString('N')
try {
  try {$lock=[IO.File]::Open($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)} catch {
    for($i=0;$i -lt 30;$i++){Start-Sleep -Milliseconds 100;if(Test-GoHealth $health){Write-Output 'Relay already running';return}}
    throw 'Relay start lock unavailable; no stale/unknown lock was removed'
  }
  if(Test-GoHealth $health){Write-Output 'Relay already running';return}
  if(Test-Path -LiteralPath $marker){throw 'An ownership marker already exists; refusing to overwrite it'}
  $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$Binary;$info.Arguments="--instance=$nonce";$info.WorkingDirectory=$Root;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $info.EnvironmentVariables.Clear()
  foreach($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()){
    if($entry.Key -match '^(PATH|SYSTEMROOT|WINDIR|SYSTEMDRIVE|TEMP|TMP|USERPROFILE|HOME)$'){$info.EnvironmentVariables[$entry.Key]=$entry.Value}
  }
  $info.EnvironmentVariables['PI_COLLAB_HOST']=$Bind;$info.EnvironmentVariables['PI_COLLAB_PORT']=[string]$Port;$info.EnvironmentVariables['PI_COLLAB_HOST_TOKEN']=$HostToken;$info.EnvironmentVariables['PI_COLLAB_CLIENT_TOKEN']=$ClientToken
  if($null -ne $env:PI_COLLAB_ALLOWED_ORIGINS){$info.EnvironmentVariables['PI_COLLAB_ALLOWED_ORIGINS']=$env:PI_COLLAB_ALLOWED_ORIGINS}
  if($null -ne $env:PI_COLLAB_MANAGED_CONFIG){$info.EnvironmentVariables['PI_COLLAB_MANAGED_CONFIG']=$env:PI_COLLAB_MANAGED_CONFIG}
  $child=[Diagnostics.Process]::Start($info)
  for($i=0;$i -lt 30;$i++){
    Start-Sleep -Milliseconds 100
    if($child.HasExited){if(Test-GoHealth $health){Write-Output 'Another relay won the port race';return};throw 'Relay startup failed; check configuration/bind permission'}
    if(Test-GoHealth $health){
      Start-Sleep -Milliseconds 100
      $record=Get-GoRecord $child.Id
      if($child.HasExited -or !$record -or !(Test-GoIdentity $record $Binary $nonce $record.creation)){throw 'Cannot prove ownership of newly started relay'}
      $json=@{version=1;pid=$child.Id;executable=$Binary;instance=$nonce;creation=$record.creation}|ConvertTo-Json -Compress
      $file=[IO.File]::Open($marker,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try {$bytes=[Text.Encoding]::UTF8.GetBytes($json);$file.Write($bytes,0,$bytes.Length)}finally{$file.Dispose()}
      $published=$true;Write-Output "Started owned Go relay PID $($child.Id)";return
    }
  }
  throw 'Relay readiness timeout'
} finally {
  if($child){if(!$published -and !$child.HasExited){$child.Kill();$null=$child.WaitForExit(5000)};$child.Dispose()}
  if($lock){$lock.Dispose();Remove-Item -LiteralPath $lockPath -ErrorAction SilentlyContinue}
}
