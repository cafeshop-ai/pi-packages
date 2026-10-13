param(
  [switch]$Race,
  [string]$Compiler = ''
)
$ErrorActionPreference = 'Stop'
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$output = Join-Path $packageRoot '.refactor\reports\R08'
$binary = Join-Path $output $(if ($Race) { 'service-race.test.exe' } else { 'service.test.exe' })
$oldPath = $env:PATH
$oldCC = $env:CC
$oldCGO = $env:CGO_ENABLED
$oldEnabled = $env:PI_CAFE_GO_TRACE_TESTS
$oldBinary = $env:PI_CAFE_GO_TRACE_BINARY
$oldLocation = Get-Location
try {
  if ($Race) {
    if (-not $Compiler -or -not (Test-Path -LiteralPath $Compiler -PathType Leaf)) {
      throw 'Race requires an explicit compatible C compiler path; this script never installs a toolchain.'
    }
    $env:CC = [IO.Path]::GetFullPath($Compiler)
    $env:CGO_ENABLED = '1'
    $env:PATH = "$(Split-Path -Parent $env:CC);$oldPath"
  }
  New-Item -ItemType Directory -Path $output -Force | Out-Null
  Set-Location -LiteralPath (Join-Path $packageRoot 'relay')
  $goArgs = @('test', '-c', '-o', $binary)
  if ($Race) { $goArgs += '-race' }
  $goArgs += './internal/service'
  & go @goArgs
  if ($LASTEXITCODE -ne 0) { throw 'Go test bridge build failed' }
  Set-Location -LiteralPath $packageRoot
  $env:PI_CAFE_GO_TRACE_TESTS = '1'
  $env:PI_CAFE_GO_TRACE_BINARY = $binary
  & (Join-Path $packageRoot 'node_modules\.bin\vitest.cmd') run src/protocol/go-relay.test.ts --reporter=verbose
  if ($LASTEXITCODE -ne 0) { throw 'Go/TS trace parity failed' }
} finally {
  $env:PATH = $oldPath
  $env:CC = $oldCC
  $env:CGO_ENABLED = $oldCGO
  $env:PI_CAFE_GO_TRACE_TESTS = $oldEnabled
  $env:PI_CAFE_GO_TRACE_BINARY = $oldBinary
  Set-Location -LiteralPath $oldLocation.Path
}
