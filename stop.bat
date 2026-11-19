@echo off
rem Switches Laudi off (he stays off until you press Start in the phone app or run start.bat).
cd /d "%~dp0"
if not exist data mkdir data
echo stop> data\stop.flag
echo shutdown>> data\remote.txt
echo Laudi is stopping...
timeout /t 4 >nul
