<#
.SYNOPSIS
  Start SKYNET's local services from one command (Windows PowerShell 5.1+).

.DESCRIPTION
  Phase 2: starts the intel service (news ingest and API) on 127.0.0.1 only.
  Phase 6 extends this script to start the web app as well; until then run
  `npm run dev` in a second terminal.

  First run creates intel\.venv with uv (Python 3.12) and installs the
  pinned dependencies from intel\uv.lock.

.PARAMETER Port
  Port for the intel service. The app's dev server expects 8100.

.PARAMETER Sync
  Re-sync the Python environment before starting.

.EXAMPLE
  .\scripts\skynet.ps1
#>
param(
  [int]$Port = 8100,
  [switch]$Sync
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$intel = Join-Path $root 'intel'

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Error 'uv was not found. Install it with: winget install --id=astral-sh.uv -e   (then open a new terminal)'
  exit 1
}

if ($Sync -or -not (Test-Path (Join-Path $intel '.venv'))) {
  Write-Host 'Setting up the intel Python environment (first run takes a minute)...'
  & uv sync --project "$intel" --frozen
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "SKYNET intel: http://127.0.0.1:$Port/api/intel/health  (Ctrl+C to stop)"
& uv run --project "$intel" --frozen uvicorn app.main:create_default_app --factory --app-dir "$intel" --host 127.0.0.1 --port $Port
exit $LASTEXITCODE
