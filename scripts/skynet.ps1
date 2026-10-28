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
  Re-sync the Python environment before starting. Packages installed with
  -Voice are kept.

.PARAMETER Voice
  Install local voice for the Neural Core (push-to-talk) and fetch its pinned
  models (about 270 MB) into intel\data\voice. The voice packages include
  espeak-ng and phonemizer, which are GPL-3.0; see NOTICE.md.

.EXAMPLE
  .\scripts\skynet.ps1

.EXAMPLE
  .\scripts\skynet.ps1 -Voice
#>
param(
  [int]$Port = 8100,
  [switch]$Sync,
  [switch]$Voice
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$intel = Join-Path $root 'intel'

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Error 'uv was not found. Install it with: winget install --id=astral-sh.uv -e   (then open a new terminal)'
  exit 1
}

if ($Voice -or $Sync -or -not (Test-Path (Join-Path $intel '.venv'))) {
  Write-Host 'Setting up the intel Python environment (first run takes a minute)...'
  # --inexact keeps an earlier -Voice install; -Voice adds the voice extra.
  $extra = if ($Voice) { @('--extra', 'voice') } else { @('--inexact') }
  & uv sync --project "$intel" --frozen @extra
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($Voice) {
  & uv run --project "$intel" --frozen python (Join-Path $intel 'scripts\fetch_voice_models.py')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "SKYNET intel: http://127.0.0.1:$Port/api/intel/health  (Ctrl+C to stop)"
& uv run --project "$intel" --frozen uvicorn app.main:create_default_app --factory --app-dir "$intel" --host 127.0.0.1 --port $Port
exit $LASTEXITCODE
