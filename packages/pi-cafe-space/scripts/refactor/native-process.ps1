param([ValidateSet('Query','Stop','Audit')][string]$Operation,[int]$ProcessId,[string]$ExpectedBase64='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
function Record([int]$IdValue){
 try{$p=Get-CimInstance Win32_Process -Filter "ProcessId = $IdValue" -ErrorAction Stop;if(!$p.ExecutablePath -or !$p.CreationDate -or !$p.CommandLine){return $null};return [pscustomobject]@{pid=$IdValue;executable=[string]$p.ExecutablePath;creation=$p.CreationDate.ToUniversalTime().Ticks.ToString();commandLine=[string]$p.CommandLine}}catch{return $null}
}
if($Operation -eq 'Query'){Record $ProcessId|ConvertTo-Json -Compress;exit}
if($Operation -eq 'Audit'){
 $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object {$_.LocalPort -in @(37891,9222,37983,9333)}|Sort-Object LocalPort,LocalAddress|Select-Object LocalAddress,LocalPort,OwningProcess)
 $marker=if($ExpectedBase64){[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ExpectedBase64))}else{''}
 $remaining=@();if($marker){$remaining=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -and $_.CommandLine.IndexOf($marker,[StringComparison]::OrdinalIgnoreCase) -ge 0}|Select-Object ProcessId,ParentProcessId)}
 [pscustomobject]@{listeners=$listeners;remaining=$remaining}|ConvertTo-Json -Depth 4 -Compress;exit
}
$handle=$null
try{
 $expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ExpectedBase64))|ConvertFrom-Json
 if($expected.pid -ne $ProcessId -or !$expected.creation -or !$expected.commandLine){throw 'Invalid expected owner'}
 $handle=[Diagnostics.Process]::GetProcessById($ProcessId);$null=$handle.Handle
 for($i=0;$i -lt 2;$i++){
  $actual=Record $ProcessId
  if(!$actual -or $actual.creation -cne $expected.creation -or $actual.commandLine -cne $expected.commandLine -or ![string]::Equals([IO.Path]::GetFullPath($actual.executable),[IO.Path]::GetFullPath($expected.executable),[StringComparison]::OrdinalIgnoreCase)){throw 'Identity mismatch; retained'}
 }
 $handle.Kill();if(!$handle.WaitForExit(5000)){throw 'Owned process did not exit'}
 'true'
}catch{'false'}finally{if($handle){$handle.Dispose()}}
