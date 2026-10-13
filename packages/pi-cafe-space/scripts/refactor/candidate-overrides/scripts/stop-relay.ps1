$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'process-owner.ps1')
$Root=Split-Path -Parent $PSScriptRoot
$Binary=Get-GoBinary $Root
$runtime=Join-Path $Root '.runtime-go';$stopped=$false
if(Test-OrdinaryPath $runtime $false){
  foreach($file in Get-ChildItem -LiteralPath $runtime -Filter 'relay.*.json' -File){
    if(!(Test-OrdinaryPath $file.FullName $true) -or $file.Length -gt 4096){continue}
    try {
      $original=[IO.File]::ReadAllText($file.FullName);$record=$original|ConvertFrom-Json
      if($record.version -ne 1 -or $record.pid -le 0 -or ![string]::Equals([string]$record.executable,$Binary,[StringComparison]::OrdinalIgnoreCase)){continue}
      if(Stop-GoOwned $record.pid $Binary $record.instance $record.creation){
        $stopped=$true;Write-Output "Stopped owned Go relay PID $($record.pid)"
        if((Test-OrdinaryPath $file.FullName $true) -and [IO.File]::ReadAllText($file.FullName) -ceq $original){Remove-Item -LiteralPath $file.FullName -ErrorAction SilentlyContinue}
      } else {Write-Output 'Ownership unavailable or changed; process and marker left untouched'}
    } catch {Write-Output 'Unverifiable marker left untouched'}
  }
}
# Old .runtime/*.pid and .relay.pid belong to the old Node backend. They are
# never converted/deleted or interpreted as Go ownership by this candidate.
if(!$stopped){Write-Output 'No owned Go relay stopped'}
