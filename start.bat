@echo off
title DB AutoRun
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing database drivers. This can take a few minutes...
  call npm install --omit=dev --no-fund --no-audit
  if errorlevel 1 (
    echo Installing the database drivers failed. See the messages above.
    pause
    exit /b 1
  )
)

node server.js --open
if errorlevel 1 pause
