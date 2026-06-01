@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-launch-protocol.ps1"
start "" "jlc-ngspice-launch://start"
exit /b 0
