@echo off
REM Starts the TikTok friend bot and restarts it if it stops.
cd /d "%~dp0"

REM ---- find Node.js (works even if it isn't on PATH) ----
node -v >NUL 2>NUL
if not errorlevel 1 goto havenode
for %%D in ("%ProgramFiles%\nodejs" "%ProgramFiles(x86)%\nodejs" "%LOCALAPPDATA%\Programs\nodejs" "%NVM_SYMLINK%" "%ProgramFiles%\Volta" "%LOCALAPPDATA%\Volta\bin" "%APPDATA%\npm" "%USERPROFILE%\scoop\apps\nodejs\current" "%USERPROFILE%\scoop\apps\nodejs-lts\current") do (
  if exist "%%~D\node.exe" set "PATH=%%~D;%PATH%"
)
node -v >NUL 2>NUL
if not errorlevel 1 goto havenode
for /d %%D in ("%APPDATA%\nvm\v*") do if exist "%%~D\node.exe" set "PATH=%%~D;%PATH%"
node -v >NUL 2>NUL
if not errorlevel 1 goto havenode
echo.
echo Could not find Node.js on this PC.
echo Install the LTS version from https://nodejs.org (keep "Add to PATH" ticked),
echo then restart the PC and run start.bat again.
pause
exit /b 1

:havenode
for /f "delims=" %%V in ('node -v') do echo Using Node.js %%V

if not exist ".env" copy "settings-template.txt" ".env" >NUL
if not exist ".env.opened" (
  echo opened> ".env.opened"
  start "" notepad ".env"
)

if exist "node_modules" goto loop
echo Installing, this takes a minute the first time...
call npm install
if errorlevel 1 (
  echo Install failed. Check your internet connection and try again.
  pause
  exit /b 1
)

:loop
node src\tiktok.js
if exist "data\stop.flag" (
  del "data\stop.flag"
  echo Laudi was stopped from Laudi Control.
  exit
)
echo Bot stopped. Restarting in 10 seconds... (close this window to quit)
timeout /t 10 >NUL
goto loop
