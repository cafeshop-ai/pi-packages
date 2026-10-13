param([Parameter(Mandatory=$true)][string]$Compiler,[string]$NodeDirectory='')
$ErrorActionPreference='Stop'
$Root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$Repo=[IO.Path]::GetFullPath((Join-Path $Root '..\..'))
$OldPath=$env:PATH;$OldCC=$env:CC;$OldCGO=$env:CGO_ENABLED;$Location=Get-Location
function Check-Exit([string]$Step){if($LASTEXITCODE -ne 0){throw "$Step failed with exit $LASTEXITCODE"}}
try {
 if($NodeDirectory){$env:PATH="$NodeDirectory;$env:PATH"}
 if(!(Test-Path -LiteralPath $Compiler -PathType Leaf)){throw 'Native race compiler required'}
 $env:CC=[IO.Path]::GetFullPath($Compiler);$env:CGO_ENABLED='1';$env:PATH="$(Split-Path -Parent $env:CC);$env:PATH"
 Set-Location -LiteralPath $Repo
 npm.cmd run typecheck;Check-Exit 'root typecheck'
 Set-Location -LiteralPath $Root
 npm.cmd run check;Check-Exit 'extension typecheck'
 npm.cmd test;Check-Exit 'TS regression'
 npm.cmd run refactor:contracts:test;Check-Exit 'frozen contracts'
 npm.cmd run refactor:web:check;Check-Exit 'Web typecheck'
 npm.cmd run refactor:web:test;Check-Exit 'Web tests'
 npm.cmd run refactor:assets:test;Check-Exit 'asset and build policy tests'
 Set-Location -LiteralPath (Join-Path $Root 'relay')
 $format=@(gofmt -l cmd internal);Check-Exit 'Go formatting check';if($format.Count){throw "Unformatted Go files: $format"}
 go test ./...;Check-Exit 'Go tests'
 go vet ./...;Check-Exit 'Go vet'
 go test -race -count=1 ./...;Check-Exit 'Go race'
 & (Join-Path $PSScriptRoot 'test-go-traces.ps1') -Race -Compiler $Compiler;Check-Exit 'real Go bridge'
 Set-Location -LiteralPath $Root
 npm.cmd run refactor:relay:build;Check-Exit 'fresh candidate build'
 Set-Location -LiteralPath (Join-Path $Root 'relay')
 go test -tags webembed -race -count=1 ./...;Check-Exit 'embedded Go race'
 go test -race -count=5 ./internal/transport ./internal/service;Check-Exit 'transport/service repeated race'
 go test ./internal/protocol -run '^$' -fuzz '^FuzzDecodeWire$' -fuzztime 30s -parallel 2;Check-Exit 'protocol fuzz'
 Set-Location -LiteralPath $Root
 npm.cmd run refactor:build:test;Check-Exit 'candidate and isolated final source build'
 npm.cmd run refactor:launcher:test;Check-Exit 'native owner/PiArgs tests'
 npm.cmd run refactor:integration:test;Check-Exit 'fresh binary and actual bundle integration'
 Set-Location -LiteralPath $Repo
 git diff --check;Check-Exit 'diff whitespace'
 Write-Output 'PASS: authorized deterministic implementation/acceptance; no real Pi/Chrome/install/production switch'
} finally {
 $env:PATH=$OldPath;$env:CC=$OldCC;$env:CGO_ENABLED=$OldCGO;Set-Location -LiteralPath $Location
}
