$ErrorActionPreference='Stop'
$Root=$PSScriptRoot
$config=Get-Content -LiteralPath (Join-Path $Root 'credentials.json') -Raw | ConvertFrom-Json
$Host.UI.RawUI.WindowTitle='Pi Cafe Space - Manual Trial'
Set-Location -LiteralPath (Join-Path $Root 'project')
# Only this new console's environment changes. No global settings/auth writes.
$info=New-Object Diagnostics.ProcessStartInfo
$info.FileName=$config.node
$info.WorkingDirectory=(Join-Path $Root 'project')
$info.UseShellExecute=$false
$info.CreateNoWindow=$false
$argsList=@($config.piCli,'--offline','--no-extensions','-e',$config.package,'-e',(Join-Path $Root 'provider.mjs'),'--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--provider','cafe','--model','gpt-6-astra','--thinking','low','--session-dir',(Join-Path $Root 'sessions'),'--name','Pi Cafe Space manual trial')
$info.Arguments=($argsList | ForEach-Object {'"'+$_+'"'}) -join ' '
$info.EnvironmentVariables.Clear()
foreach($name in @('SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT','TERM','COLORTERM')){if([Environment]::GetEnvironmentVariable($name,'Process')){$info.EnvironmentVariables[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}}
foreach($name in @('USERPROFILE','HOME','APPDATA','LOCALAPPDATA')){$info.EnvironmentVariables[$name]=(Join-Path $Root 'home')}
foreach($name in @('TEMP','TMP')){$info.EnvironmentVariables[$name]=(Join-Path $Root 'temp')}
$values=@{PI_CODING_AGENT_DIR=(Join-Path $Root 'agent');PI_OFFLINE='1';PI_TELEMETRY='0';PI_CAFE_SOURCE_MODELS=$config.models;PI_CAFE_TRIAL_ROOT=$Root;PI_COLLAB_ENABLED='1';PI_COLLAB_RELAY_URL='ws://127.0.0.1:37983/ws';PI_COLLAB_ROOM=$config.room;PI_COLLAB_PEER_ID=$config.peer;PI_COLLAB_HOST_TOKEN=$config.hostToken;PI_COLLAB_CLIENT_TOKEN=$config.clientToken}
foreach($entry in $values.GetEnumerator()){$info.EnvironmentVariables[$entry.Key]=$entry.Value}
$child=[Diagnostics.Process]::Start($info)
$null=$child.Handle
$record=& (Join-Path $Root 'native-process.ps1') -Operation Query -ProcessId $child.Id
if(!$record){throw 'Cannot capture new Pi identity'}
$decoded=$record|ConvertFrom-Json
if(![string]::Equals($decoded.executable,$config.node,[StringComparison]::OrdinalIgnoreCase) -or !$decoded.commandLine.Contains((Join-Path $Root 'sessions'))){throw 'Unexpected Pi process identity'}
$file=[IO.File]::Open((Join-Path $Root 'pi-owner.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$bytes=[Text.Encoding]::UTF8.GetBytes($record);$file.Write($bytes,0,$bytes.Length)}finally{$file.Dispose()}
$child.WaitForExit()
$code=$child.ExitCode
$child.Dispose()
exit $code
