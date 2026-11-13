@echo off
rem ReelsMaker: local UI at http://127.0.0.1:8787 in a Chrome app window (no default browser).
title ReelsMaker - START
set PORT=8787
rem Folder of the program = folder of this .bat. DATA must match RF_DATA_DIR in .env.
set DIR=%~dp0
if "%DIR:~-1%"=="\" set DIR=%DIR:~0,-1%
set DATA=C:\ReelsMaker
set SYS=%SystemRoot%\System32
set PS=%SYS%\WindowsPowerShell\v1.0\powershell.exe
set URL=http://127.0.0.1:%PORT%/
rem Separate light browser profile for ReelsMaker only: no extensions, no sync, no tabs.
set PROFILE=%DATA%\.browser
if not exist "%DATA%" mkdir "%DATA%"

%SYS%\netstat.exe -ano | %SYS%\findstr.exe /R /C:"127.0.0.1:%PORT% .*LISTENING" >nul
if %errorlevel%==0 (
  echo ReelsMaker server is already running.
  goto open
)

echo Starting server...
%PS% -NoProfile -Command "Start-Process node -ArgumentList '--import','tsx','apps/hub/src/main.ts' -WorkingDirectory '%DIR%' -WindowStyle Hidden -RedirectStandardOutput '%DATA%\ui.log' -RedirectStandardError '%DATA%\ui.err.log'"

for /L %%i in (1,1,30) do (
  %SYS%\netstat.exe -ano | %SYS%\findstr.exe /R /C:"127.0.0.1:%PORT% .*LISTENING" >nul && goto open
  %SYS%\timeout.exe /t 1 /nobreak >nul
)
echo Server did not start in 30 seconds. See %DATA%\ui.err.log
pause
exit /b 1

:open
rem Optional local steps before opening (e.g. start your proxy): local-start.bat next to this file, not in git.
if exist "%DIR%\local-start.bat" call "%DIR%\local-start.bat"

rem Window already open - do not open a second one.
%PS% -NoProfile -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome|msedge' -and $_.CommandLine -like '*--app=%URL%*' }) { exit 0 } else { exit 1 }"
if %errorlevel%==0 exit /b 0

set BROWSER=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if "%BROWSER%"=="" if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if "%BROWSER%"=="" if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe
if "%BROWSER%"=="" if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
if "%BROWSER%"=="" (
  echo Chrome not found. Open %URL% manually.
  pause
  exit /b 1
)
start "" "%BROWSER%" --app=%URL% --user-data-dir="%PROFILE%" --window-size=1600,1000 --no-first-run --no-default-browser-check --disable-extensions --disable-sync --disable-translate --disable-background-mode --disable-background-networking --disable-component-update --disable-breakpad --disable-features=Translate,MediaRouter,OptimizationHints --disk-cache-size=52428800
exit /b 0
