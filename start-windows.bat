@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js ne naiden.
  echo Ustanovite LTS-versiyu s https://nodejs.org i zapustite fail snova.
  start https://nodejs.org
  pause
  exit /b 1
)

set HOST=127.0.0.1
set PORT=3000
set NODE_NO_WARNINGS=1
node server.js
