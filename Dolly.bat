@echo off
title CS2 Dolly
cd /d "%~dp0app"
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js not found. Install from https://nodejs.org then retry.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install --no-fund --no-audit
)
echo Starting CS2 Dolly... your browser will open automatically.
echo Leave this window open. Ctrl+C to stop.
echo.
node server.mjs
echo.
echo Dolly stopped.
pause
