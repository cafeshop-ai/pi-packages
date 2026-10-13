param([string]$Operation='None',[int]$ProcessId=0,[string]$Executable='',[string]$Instance='',[string]$Creation='')
$ErrorActionPreference='Stop'
function Get-GoRecord([int]$IdValue) {
  try {
    $item=Get-CimInstance Win32_Process -Filter "ProcessId = $IdValue" -ErrorAction Stop
    if(!$item -or !$item.ExecutablePath -or !$item.CreationDate -or !$item.CommandLine){return $null}
    return [pscustomobject]@{pid=$IdValue;executable=[string]$item.ExecutablePath;creation=$item.CreationDate.ToUniversalTime().Ticks.ToString();commandLine=[string]$item.CommandLine}
  } catch {return $null}
}
function Test-GoIdentity($Record,[string]$Path,[string]$Nonce,[string]$Created) {
  if(!$Record -or !$Created -or $Nonce -notmatch '^[a-f0-9]{32}$' -or [string]$Record.creation -cne $Created){return $false}
  try {$expected=[IO.Path]::GetFullPath($Path);$actual=[IO.Path]::GetFullPath([string]$Record.executable)}catch{return $false}
  if(![string]::Equals($expected,$actual,[StringComparison]::OrdinalIgnoreCase)){return $false}
  $pattern='^\s*"?'+[regex]::Escape($expected)+'"?\s+--instance='+[regex]::Escape($Nonce)+'\s*$'
  return [string]$Record.commandLine -match $pattern
}
function Stop-GoOwned([int]$IdValue,[string]$Path,[string]$Nonce,[string]$Created) {
  $handle=$null
  try {
    # Acquire a process HANDLE first; retaining it prevents PID reuse between
    # the two CIM identity checks and termination from targeting another process.
    $handle=[Diagnostics.Process]::GetProcessById($IdValue);$null=$handle.Handle
    if(!(Test-GoIdentity (Get-GoRecord $IdValue) $Path $Nonce $Created)){return $false}
    if(!(Test-GoIdentity (Get-GoRecord $IdValue) $Path $Nonce $Created)){return $false}
    $handle.Kill();$null=$handle.WaitForExit(5000);return $true
  } catch {return $false} finally {if($handle){$handle.Dispose()}}
}
function Test-OrdinaryPath([string]$Path,[bool]$File) {
  try {
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if($File -and !($item -is [IO.FileInfo])){return $false}
    if(!$File -and !($item -is [IO.DirectoryInfo])){return $false}
    for($node=$item;$node;$node=$node.Parent){if(($node.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){return $false};if($node -is [IO.FileInfo]){$node=$node.Directory;if(!$node){break};if(($node.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){return $false}}}
    return $true
  } catch {return $false}
}
function Get-GoBinary([string]$PackageRoot) {
  if(![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -match 'ARM') {throw 'Unsupported Windows relay platform'}
  $metadataPath=Join-Path $PackageRoot 'dist\relay\build.json'
  if(!(Test-OrdinaryPath $metadataPath $true) -or (Get-Item -LiteralPath $metadataPath).Length -gt 65536){throw 'Relay metadata missing; build explicitly'}
  $metadata=[IO.File]::ReadAllText($metadataPath)|ConvertFrom-Json;$record=$metadata.platforms.'windows-amd64'
  if(!$record -or $record.platform -cne 'windows-amd64' -or $record.webDigest -cne $metadata.webDigest -or $record.version -cne $metadata.version){throw 'Matching relay binary is unavailable'}
  $binary=Join-Path $PackageRoot 'dist\relay\bin\windows-amd64\pi-cafe-relay.exe'
  if(!(Test-OrdinaryPath $binary $true) -or (Get-Item -LiteralPath $binary).Length -gt 67108864){throw 'Untrusted relay executable'}
  if((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.sha256){throw 'Relay checksum mismatch'}
  $bytes=[IO.File]::ReadAllBytes($binary)
  if($bytes.Length -lt 64 -or $bytes[0] -ne 77 -or $bytes[1] -ne 90){throw 'Wrong relay executable format'}
  $offset=[BitConverter]::ToUInt32($bytes,60)
  if($offset+6 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes,$offset) -ne 17744 -or [BitConverter]::ToUInt16($bytes,$offset+4) -ne 34404){throw 'Wrong relay executable platform'}
  return [IO.Path]::GetFullPath($binary)
}
function Test-GoHealth([string]$Url) {
  $response=$null;$stream=$null;$memory=$null
  try {
    $request=[Net.HttpWebRequest]::Create($Url);$request.Proxy=$null;$request.AllowAutoRedirect=$false;$request.Timeout=700;$request.ReadWriteTimeout=700;$request.MaximumResponseHeadersLength=16
    $response=$request.GetResponse();if([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt 8192){return $false}
    $stream=$response.GetResponseStream();$memory=New-Object IO.MemoryStream;$buffer=New-Object byte[] 1024;$total=0
    while(($read=$stream.Read($buffer,0,$buffer.Length))-gt 0){$total+=$read;if($total -gt 8192){return $false};$memory.Write($buffer,0,$read)}
    $utf8=New-Object Text.UTF8Encoding($false,$true);$data=$utf8.GetString($memory.ToArray())|ConvertFrom-Json
    return $data.ok -eq $true -and $data.protocolVersion -eq 1
  } catch {return $false} finally {if($memory){$memory.Dispose()};if($stream){$stream.Dispose()};if($response){$response.Dispose()}}
}
if($Operation -eq 'Query'){Get-GoRecord $ProcessId|ConvertTo-Json -Compress}
elseif($Operation -eq 'Stop'){[bool](Stop-GoOwned $ProcessId $Executable $Instance $Creation)|ConvertTo-Json -Compress}
elseif($Operation -ne 'None'){throw 'Unknown ownership operation'}
