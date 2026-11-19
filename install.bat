@echo off
setlocal
title Laudi installer (Windows)
cd /d "%~dp0"
if not exist src\tiktok.js (echo Run this inside the laudi folder. & pause & exit /b)

echo.
echo === 1/5  Node.js and Git ===
where node >nul 2>nul
if errorlevel 1 (
  echo Installing Node.js...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo Node.js is installed. CLOSE this window and double-click install.bat again.
  pause
  exit /b
)
where git >nul 2>nul || winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
for /f "delims=" %%v in ('node -v') do echo Node %%v OK

echo.
echo === 2/5  Laudi's packages (takes a minute) ===
call npm install --omit=dev --legacy-peer-deps --no-audit --no-fund
if errorlevel 1 (echo npm install failed - send Claude a photo of this window. & pause & exit /b)
if not exist data mkdir data
if exist data\stop.flag del data\stop.flag

echo.
echo === 3/5  Start with Windows ===
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
(
  echo @echo off
  echo rem Starts Laudi ^(the TikTok/Discord friend bot^) when Windows starts. Delete this file to stop that.
  echo timeout /t 20 ^>NUL
  echo cd /d "%CD%"
  echo start "Laudi" /min cmd /c start.bat
) > "%STARTUP%\Laudi.bat"
echo Laudi will start by himself when the PC turns on.

echo.
echo === 4/5  Let your phone reach the dashboard (click YES on the admin popup) ===
powershell -NoProfile -Command "Start-Process cmd -Verb RunAs -Wait -ArgumentList '/c netsh advfirewall firewall delete rule name=Laudi-dashboard >nul & netsh advfirewall firewall add rule name=Laudi-dashboard dir=in action=allow protocol=TCP localport=8787 profile=any'"

echo.
echo === 5/5  Tailscale (phone app outside the house) ===
if exist "%ProgramFiles%\Tailscale\tailscale.exe" (
  echo Tailscale is installed.
) else (
  choice /m "Install Tailscale so the phone app works outside the house too"
  if not errorlevel 2 winget install -e --id tailscale.tailscale --accept-source-agreements --accept-package-agreements
)

echo.
echo Starting Laudi...
start "Laudi" /min cmd /c start.bat
timeout /t 5 >nul

echo.
echo ==========================================================
echo  DONE!  Type ONE of these in the Laudi phone app:
for /f "delims=" %%a in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notlike '*Tailscale*' -and $_.InterfaceAlias -notlike 'vEthernet*' }).IPAddress"') do echo    At home:      http://%%a:8787
if exist "%ProgramFiles%\Tailscale\tailscale.exe" for /f "delims=" %%t in ('call "%ProgramFiles%\Tailscale\tailscale.exe" ip -4 2^>nul') do echo    Anywhere:     http://%%t:8787
echo.
echo  Do the setup in the app between 8 PM and 10 AM.
echo  Stop Laudi: stop.bat   Start again: start.bat
echo ==========================================================
pause
