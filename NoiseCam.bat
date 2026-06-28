@echo off
title Noise Cam
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
echo Starting Noise Cam... your browser will open automatically.
echo Leave this window open. Ctrl+C to stop.
echo.
node server.mjs
echo.
echo Noise Cam stopped.
pause
