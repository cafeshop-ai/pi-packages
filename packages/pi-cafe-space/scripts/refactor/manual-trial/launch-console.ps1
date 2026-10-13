$ErrorActionPreference='Stop'
$Root=$PSScriptRoot
$arguments='-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $Root 'pi-console.ps1')+'"'
$child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WorkingDirectory (Join-Path $Root 'project') -PassThru
$null=$child.Handle
$record=& (Join-Path $Root 'native-process.ps1') -Operation Query -ProcessId $child.Id
if(!$record){throw 'Cannot capture new console identity'}
$value=$record|ConvertFrom-Json
if(!$value.commandLine.Contains((Join-Path $Root 'pi-console.ps1'))){throw 'Unexpected console identity'}
$file=[IO.File]::Open((Join-Path $Root 'console-owner.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$bytes=[Text.Encoding]::UTF8.GetBytes($record);$file.Write($bytes,0,$bytes.Length)}finally{$file.Dispose()}
$child.Dispose()
Write-Output 'Started independent native Pi console'
