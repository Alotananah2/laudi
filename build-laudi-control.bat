@echo off
REM Builds "Laudi Control.exe" on your Desktop (uses Windows' own C# compiler, nothing to install).
cd /d "%~dp0"
taskkill /im "Laudi Control.exe" /f >NUL 2>NUL
timeout /t 1 >NUL
set FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
if not exist "%FW%\csc.exe" set FW=%WINDIR%\Microsoft.NET\Framework\v4.0.30319
set OUT=%USERPROFILE%\Desktop\Laudi Control.exe
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set OUT=%%D\Laudi Control.exe
if exist "%OUT%" move /y "%OUT%" "gui\old-%RANDOM%.exe" >NUL
"%FW%\csc.exe" /nologo /target:winexe /codepage:65001 /optimize+ "/out:%OUT%" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Core.dll /r:System.Web.Extensions.dll gui\LaudiControl.cs > gui\build-log.txt 2>&1
if errorlevel 1 (
  type gui\build-log.txt
  echo.
  echo Build FAILED - send gui\build-log.txt to Claude.
  pause
  exit /b 1
)
echo Done! Opening Laudi Control...
start "" "%OUT%"
