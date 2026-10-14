@echo off
rem Start the Tab Thrashing live server and open the dashboard.
cd /d "%~dp0"
echo Tab Thrashing: starting the live server on http://127.0.0.1:4870 (Ctrl+C to stop)
start "" http://127.0.0.1:4870
node live\server.js
pause
