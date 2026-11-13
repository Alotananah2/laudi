@echo off
REM Run this on the PC once Laudi lives on the Raspberry Pi.
REM Stops the PC Laudi and stops him (and Laudi Control) starting with Windows.
cd /d "%~dp0"
echo stop> data\stop.flag
echo shutdown>> data\remote.txt
timeout /t 8 >NUL
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Laudi.bat" 2>NUL
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\LaudiControl.bat" 2>NUL
taskkill /im "Laudi Control.exe" /f >NUL 2>NUL
echo Done. Laudi is off on this PC and won't start with Windows anymore.
echo (To bring him back here: double-click start.bat)
pause
