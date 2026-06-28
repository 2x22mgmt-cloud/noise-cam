@echo off
title Noise Cam - editor server (Phase 1)
cd /d "%~dp0server"
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found on PATH.
  echo Install it from https://nodejs.org then run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install --no-fund --no-audit
)
echo.
echo ================================================
echo  Noise Cam editor server
echo  Leave this window OPEN. Type a console command
echo  + Enter to run it in-game. Ctrl+C to stop.
echo ================================================
echo.
node server.mjs
echo.
echo Server stopped.
pause
