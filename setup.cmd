@echo off
rem Double-click to set up Tab Thrashing on Windows. Runs setup.ps1 without changing your execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
pause
