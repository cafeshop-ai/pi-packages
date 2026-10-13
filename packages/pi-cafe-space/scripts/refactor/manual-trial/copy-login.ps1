param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
try {
  $file=Join-Path $Root 'credentials.json'
  $info=Get-Item -LiteralPath $file
  if($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $info.Length -gt 65536){throw 'Invalid file'}
  $config=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
  if($config.format -ne 'pi-cafe-space-manual-trial-v1' -or $config.room -ne 'manual-trial'){throw 'Wrong installation'}
  $token=$config.clientToken
  if($token -isnot [string] -or $token.Length -lt 16 -or $token.Length -gt 4096 -or $token -match '[\x00-\x1f\x7f]'){throw 'Invalid token'}
} catch {throw 'Cannot read the local Relay login configuration; private details suppressed.'}
try {
  Set-Clipboard -Value $token
  if((Get-Clipboard -Raw) -cne $token){throw 'Clipboard mismatch'}
} catch {throw 'Could not copy the client token to the Windows clipboard; private details suppressed.'}
Write-Host 'Client token copied to clipboard. Paste into the client-token field.'
Write-Host 'Room: manual-trial'
Write-Host 'Web: http://127.0.0.1:37983/'
Write-Host 'After login, copy ordinary text to replace the token in your clipboard.'
