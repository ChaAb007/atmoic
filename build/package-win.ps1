# Packages Atomic 0.1.0. Does not build or update Surface Workspace.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

npm ci
if ($LASTEXITCODE -ne 0) { throw "Atomic install failed" }

$Out = Join-Path $Root "dist"
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

npx esbuild src/host.ts --bundle --platform=node --format=esm --outfile=dist/atomic-host.js --external:node:*
if ($LASTEXITCODE -ne 0) { throw "Atomic bundle failed" }

Copy-Item (Join-Path $Root "src\schema.sql") (Join-Path $Out "schema.sql")

@'
{
  "name": "Surface Atomic",
  "version": "0.1.0",
  "protocolVersion": 1,
  "entry": "atomic-host.js"
}
'@ | Set-Content -Encoding utf8 (Join-Path $Out "atomic.json")

$Zip = Join-Path $Out "SurfaceAtomic-0.1.0.zip"
if (Test-Path $Zip) { Remove-Item $Zip -Force }
Compress-Archive -Path (Join-Path $Out "atomic-host.js"), (Join-Path $Out "schema.sql"), (Join-Path $Out "atomic.json") -DestinationPath $Zip
Write-Host "Atomic package: $Zip"
