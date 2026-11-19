@echo off
rem Starts the Laudi dashboard (phone app talks to it) and Laudi himself.
cd /d "%~dp0"
if not exist data mkdir data
netstat -ano | findstr /r /c:":8787 .*LISTENING" >nul || start "Laudi dashboard" /min cmd /c run-dashboard.bat
netstat -ano | findstr /r /c:"127.0.0.1:8788 .*LISTENING" >nul && (echo Laudi is already running. & timeout /t 3 >nul & exit /b)
if exist data\stop.flag (echo Laudi is switched off - start him from the phone app. & timeout /t 5 >nul & exit /b)
call run-laudi.bat
