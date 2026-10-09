@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title PZ Mod Manager - Creazione EXE

REM ============================================================
REM  Metti questo file DENTRO la cartella pz-mod-manager
REM  (quella con package.json) e fai doppio clic.
REM ============================================================

REM --- Auto-elevazione ad amministratore (serve a electron-builder) ---
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Richiedo i permessi di amministratore...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

if not exist package.json (
    echo [ERRORE] package.json non trovato in:
    echo   %cd%
    echo Metti CREA-EXE.bat nella cartella pz-mod-manager.
    pause
    exit /b 1
)

REM --- Controllo Node.js ---
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js non e' installato. Provo a installarlo con winget...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    echo.
    echo Node.js installato. CHIUDI questa finestra e rilancia CREA-EXE.bat
    pause
    exit /b 0
)

echo.
echo [1/3] Installo le dipendenze (puo' richiedere qualche minuto)...
call npm install
if %errorlevel% neq 0 goto :fail

echo.
echo [2/3] Creo l'exe portatile con icona...
set CSC_IDENTITY_AUTO_DISCOVERY=false

REM Icona: se c'e' icon.ico accanto a questo file la uso
if not exist build mkdir build
if exist "%~dp0icon.ico" copy /y "%~dp0icon.ico" "build\icon.ico" >nul
if exist "%~dp0icon.ico" copy /y "%~dp0icon.ico" "src\icon.ico" >nul
if exist dist\win-unpacked rmdir /s /q dist\win-unpacked

REM Pulisco eventuale cache rotta di winCodeSign
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"

call npx electron-builder --win portable
if %errorlevel% neq 0 (
    echo.
    echo [ATTENZIONE] Con icona non e' riuscito. Riprovo SENZA icona...
    call npx electron-builder --win portable -c.win.signAndEditExecutable=false
    if !errorlevel! neq 0 goto :fail
    echo.
    echo [NOTA] Exe creato ma con icona standard. Attiva la Modalita sviluppatore di Windows e rilancia.
)

echo.
echo [3/3] Fatto! Apro la cartella "dist"...
start "" "%cd%\dist"
echo.
echo Il file .exe e' nella cartella dist. Puoi spostarlo dove vuoi e aprirlo con doppio clic.
pause
exit /b 0

:fail
echo.
echo [ERRORE] Qualcosa e' andato storto. Copia il testo qui sopra e mandamelo.
pause
exit /b 1
