@echo off
setlocal
chcp 65001 >nul
title Antigravity zh-TW Patch Manager
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto NO_NODE
node "%~dp0patch-asar.js" %*
set "EXIT_CODE=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %EXIT_CODE%

:NO_NODE
set "APP_EXE=%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"
if not exist "%APP_EXE%" set "APP_EXE=%ProgramFiles%\Antigravity\Antigravity.exe"
if not exist "%APP_EXE%" (
    echo [ERROR] Node.js and Antigravity.exe not found: "%APP_EXE%"
    pause
    exit /b 1
)

set "PATCH_JS=%~dp0patch-asar.js"
set ELECTRON_RUN_AS_NODE=1
if "%~1"=="" goto FALLBACK_MENU

set "AGY_A1=%~1"
set "AGY_A2=%~2"
set "AGY_A3=%~3"
set "AGY_A4=%~4"
powershell -NoProfile -Command "$a = @(@($env:AGY_A1,$env:AGY_A2,$env:AGY_A3,$env:AGY_A4) | Where-Object { $_ }); & $env:APP_EXE $env:PATCH_JS @a 2>&1 | ForEach-Object { $_.ToString() }; exit $LASTEXITCODE"
exit /b %ERRORLEVEL%

:FALLBACK_MENU
echo.
"%APP_EXE%" "%PATCH_JS%" --menu-prompt 2>&1 | find /v ""
echo.
set "CHOICE="
set /p CHOICE="Select option (0-4): "
echo.
if "%CHOICE%"=="1" goto MENU_1
if "%CHOICE%"=="2" goto MENU_2
if "%CHOICE%"=="3" goto MENU_3
if "%CHOICE%"=="4" goto MENU_4
exit /b 0

:MENU_1
call :RUN_PATCH_ACTION --apply
call :WAIT_ENTER
goto FALLBACK_MENU

:MENU_2
call :RUN_PATCH_ACTION --restore
call :WAIT_ENTER
goto FALLBACK_MENU

:MENU_3
"%APP_EXE%" "%PATCH_JS%" --scan 2>&1 | find /v ""
call :WAIT_ENTER
goto FALLBACK_MENU

:MENU_4
echo   [1] Enable - MyMemory Free Translation
echo   [2] Enable - Gemini API (Gemini Flash)
echo   [0] Disable Auto-Translate
echo.
set "AT_MODE="
set /p AT_MODE="Select mode (0-2, Enter to cancel): "
if "%AT_MODE%"=="0" "%APP_EXE%" "%PATCH_JS%" --set-auto-translate off 2>&1 | find /v ""
if "%AT_MODE%"=="1" "%APP_EXE%" "%PATCH_JS%" --set-auto-translate mymemory 2>&1 | find /v ""
if "%AT_MODE%"=="2" goto MENU_4_GEMINI
call :WAIT_ENTER
goto FALLBACK_MENU

:MENU_4_GEMINI
set "AT_KEY="
set /p AT_KEY="Paste Gemini API Key (or press Enter to reuse existing key): "
"%APP_EXE%" "%PATCH_JS%" --set-auto-translate gemini "%AT_KEY%" 2>&1 | find /v ""
call :WAIT_ENTER
goto FALLBACK_MENU

:WAIT_ENTER
echo.
set "DUMMY="
set /p DUMMY="Press Enter to return to menu..."
exit /b 0

:RUN_PATCH_ACTION
tasklist /FI "IMAGENAME eq Antigravity.exe" /NH 2>nul | find /I "Antigravity.exe" >nul
if errorlevel 1 goto RUN_PATCH_DIRECT
set "CONFIRM=Y"
set /p CONFIRM="Antigravity is running. Close, apply change, and restart? (Y/n): "
if /I "%CONFIRM%"=="n" (
    echo Cancelled. Please close Antigravity first.
    exit /b 0
)
"%APP_EXE%" "%PATCH_JS%" %* --force-restart 2>&1 | find /v ""
exit /b 0

:RUN_PATCH_DIRECT
"%APP_EXE%" "%PATCH_JS%" %* 2>&1 | find /v ""
exit /b 0
