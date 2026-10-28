<#
.SYNOPSIS
  Start SKYNET from one command (Windows PowerShell 5.1+).

.DESCRIPTION
  Starts the intel service (news, the Neural Core and local voice) on
  127.0.0.1, then the web app (Vite) on http://localhost:4173. The intel
  service logs to .skynet-logs\intel.err.log (its requests to intel.log).
  Ctrl+C stops both; closing the window instead can leave the intel service
  running (stop it with taskkill or by its port).

  Ollama is not started here: run the Ollama app yourself (npm run doctor
  checks it).

  First run creates intel\.venv with uv (Python 3.12) from intel\uv.lock and,
  when node_modules is missing, runs npm ci.

.PARAMETER Port
  Port for the intel service (default 8100). The web app is told about it.

.PARAMETER IntelOnly
  Start only the intel service, in this window (as before Phase 6).

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

.EXAMPLE
  .\scripts\skynet.ps1 -IntelOnly
#>
param(
  [int]$Port = 8100,
  [switch]$IntelOnly,
  [switch]$Sync,
  [switch]$Voice
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$intel = Join-Path $root 'intel'
$webPort = 4173

function Stop-IfPortBusy([int]$port, [string]$what) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($listener) {
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    $name = if ($process) { $process.ProcessName } else { 'an unknown process' }
    Write-Error "Port $port, needed for $what, is already in use by $name (PID $($listener.OwningProcess)). Stop it, or pass -Port for the intel service."
    exit 1
  }
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Error 'uv was not found. Install it with: winget install --id=astral-sh.uv -e   (then open a new terminal)'
  exit 1
}
if (-not $IntelOnly -and -not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error 'npm was not found. Install Node.js 24.14 or newer from https://nodejs.org (then open a new terminal)'
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

$uvicorn = @(
  'run', '--project', "$intel", '--frozen', 'uvicorn', 'app.main:create_default_app', '--factory',
  '--app-dir', "$intel", '--host', '127.0.0.1', '--port', "$Port"
)

Stop-IfPortBusy $Port 'the intel service'
if ($IntelOnly) {
  Write-Host "SKYNET intel: http://127.0.0.1:$Port/api/intel/health  (Ctrl+C to stop)"
  & uv @uvicorn
  exit $LASTEXITCODE
}

Stop-IfPortBusy $webPort 'the web app'
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host 'Installing the web app''s locked dependencies (npm ci, first run only)...'
  Push-Location $root
  try { & npm ci } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$logs = Join-Path $root '.skynet-logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$intelLog = Join-Path $logs 'intel.log'
$intelErr = Join-Path $logs 'intel.err.log'
# Windows PowerShell joins -ArgumentList without quoting, so quote paths with
# spaces. uv starts Python as a child; stopping it later takes the whole tree.
$argumentLine = ($uvicorn | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
$intelProcess = Start-Process -FilePath 'uv' -ArgumentList $argumentLine -WorkingDirectory $root `
  -RedirectStandardOutput $intelLog -RedirectStandardError $intelErr -WindowStyle Hidden -PassThru
Write-Host "SKYNET intel:   http://127.0.0.1:$Port/api/intel/health  (log: $intelErr)"
Write-Host "SKYNET web app: http://localhost:$webPort  (Ctrl+C stops both)"

$env:SKYNET_INTEL_URL = "http://127.0.0.1:$Port"
Push-Location $root
try {
  & npm run dev
} finally {
  Pop-Location
  if (-not $intelProcess.HasExited) {
    & taskkill.exe /T /F /PID $intelProcess.Id | Out-Null
  }
  Write-Host 'SKYNET stopped.'
}
