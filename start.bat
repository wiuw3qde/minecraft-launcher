@echo off
rem ASCII only: cmd.exe parses batch files with the ANSI codepage (GBK on
rem Chinese Windows), so any non-ASCII text in this file gets garbled.
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [INFO] Electron not found, installing dependencies...
  call npm install --registry=https://registry.npmmirror.com --electron_mirror=https://npmmirror.com/mirrors/electron/ --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed. Please run "npm install" manually in this folder.
    pause
    exit /b 1
  )
)

start "" "node_modules\electron\dist\electron.exe" .
