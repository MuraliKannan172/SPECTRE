@echo off
rem SPECTRE one-click start: double-click this file.
rem
rem 1. Starts Ollama (for the Neural Core) if it is installed and not running.
rem 2. Opens http://localhost:4173 in your browser once the web app answers.
rem 3. Runs scripts\spectre.ps1: the intel service and the web app together.
rem    Press Ctrl+C, or close this window, to stop both.
rem
rem Extra arguments go to spectre.ps1, for example:  run.bat -Voice
rem Set SPECTRE_NO_OLLAMA=1 or SPECTRE_NO_BROWSER=1 to skip step 1 or 2.

setlocal
cd /d "%~dp0"
title SPECTRE

if not defined SPECTRE_NO_OLLAMA call :start_ollama
if not defined SPECTRE_NO_BROWSER call :open_browser_when_ready

rem RemoteSigned for this process only: it runs this local script without
rem changing the machine's execution policy.
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0scripts\spectre.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
echo SPECTRE stopped (exit code %CODE%). If it did not start, the reason is above.
pause
endlocal
exit /b %CODE%

:start_ollama
curl -s -o nul -m 3 http://127.0.0.1:11434/api/version && exit /b 0
set "OLLAMA_APP=%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
if exist "%OLLAMA_APP%" (
  echo Starting Ollama for the Neural Core...
  start "" "%OLLAMA_APP%"
) else (
  echo Ollama was not found: the Neural Core will say so. Everything else works.
)
exit /b 0

:open_browser_when_ready
rem A hidden helper waits up to 3 minutes for the web app, then opens it.
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 90; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:4173/ | Out-Null; Start-Process 'http://localhost:4173/'; exit } catch { Start-Sleep -Seconds 2 } }"
exit /b 0
