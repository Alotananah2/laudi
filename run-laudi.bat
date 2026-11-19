@echo off
title Laudi
cd /d "%~dp0"
if not exist data mkdir data
:loop
if exist data\stop.flag (
  echo Laudi is switched off. Start him from the dashboard or the phone app.
  timeout /t 8 >nul
  exit /b
)
node src\tiktok.js
if exist data\stop.flag goto loop
echo.
echo Laudi stopped - restarting in 10 seconds. Close this window to keep him off.
timeout /t 10 /nobreak >nul
goto loop
