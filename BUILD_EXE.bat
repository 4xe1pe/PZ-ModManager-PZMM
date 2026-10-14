@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title PZ Mod Manager - Build EXE

REM ============================================================
REM  Fully automatic: double-click this file in the project
REM  folder (next to package.json). It installs Node.js if
REM  needed, installs dependencies and builds the portable exe.
REM  Result: dist\*.exe
REM ============================================================

REM --- Ask for administrator rights ONCE (electron-builder needs them) ---
REM The "-elevated" flag guarantees we never relaunch in a loop.
if /i not "%~1"=="-elevated" (
    fltmsg >nul 2>&1
    if errorlevel 1 (
        echo Requesting administrator rights...
        powershell -NoProfile -Command "Start-Process cmd.exe -Verb RunAs -ArgumentList '/k','call','\"%~f0\"','-elevated'"
        exit /b
    )
)

cd /d "%~dp0"

if not exist package.json (
    echo [ERROR] package.json not found in:
    echo   %cd%
    echo Put this file in the project folder, next to package.json.
    pause
    exit /b 1
)

REM --- Node.js: install automatically if missing, no restart needed ---
where node >nul 2>&1
if %errorlevel% neq 0 call :install_node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js could not be installed automatically.
    echo Install it from https://nodejs.org and run this script again.
    pause
    exit /b 1
)

echo.
echo [1/3] Installing dependencies (this can take a few minutes)...
call npm install
if %errorlevel% neq 0 goto :fail

echo.
echo [2/3] Building the portable exe...
set CSC_IDENTITY_AUTO_DISCOVERY=false
if not exist build mkdir build
if exist "%~dp0icon.ico" copy /y "%~dp0icon.ico" "build\icon.ico" >nul
if exist dist\win-unpacked rmdir /s /q dist\win-unpacked

REM Clear a possibly broken winCodeSign cache
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"

call npx electron-builder --win portable
if %errorlevel% neq 0 (
    echo.
    echo [WARNING] Build with custom icon failed. Retrying without icon editing...
    call npx electron-builder --win portable -c.win.signAndEditExecutable=false
    if !errorlevel! neq 0 goto :fail
    echo.
    echo [NOTE] Exe built with the default Electron icon. Enable Windows Developer Mode and run again to get the custom icon.
)

echo.
echo [3/3] Done! Opening the "dist" folder...
start "" "%cd%\dist"
echo.
echo The .exe is in the dist folder. You can move it anywhere and run it.
pause
exit /b 0

:install_node
echo.
echo Node.js not found. Installing it automatically...
where winget >nul 2>&1
if %errorlevel% equ 0 (
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
)
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>&1
if %errorlevel% equ 0 goto :eof
echo winget not available or failed. Downloading the Node.js installer directly...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $b='https://nodejs.org/dist/latest-v22.x/'; $f=[regex]::Match((Invoke-WebRequest -UseBasicParsing $b).Content,'node-v[\d\.]+-x64\.msi').Value; Invoke-WebRequest -UseBasicParsing ($b+$f) -OutFile (Join-Path $env:TEMP 'node-setup.msi')"
if exist "%TEMP%\node-setup.msi" msiexec /i "%TEMP%\node-setup.msi" /qn /norestart
set "PATH=%ProgramFiles%\nodejs;%PATH%"
goto :eof

:fail
echo.
echo [ERROR] Something went wrong. Copy the text above to see what failed.
pause
exit /b 1
