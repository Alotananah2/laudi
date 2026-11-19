@echo off
title Laudi dashboard
cd /d "%~dp0"
:loop
node dashboard.js
echo Dashboard stopped - restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
