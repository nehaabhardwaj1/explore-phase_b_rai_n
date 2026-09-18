@echo off
title Fulcrum · SAP S/4HANA Cloud PE
cd /d "%~dp0"
set LOG=%~dp0fulcrum-startup.log
echo Fulcrum startup %date% %time% > "%LOG%"

echo.
echo  ==========================================
echo   Fulcrum  ^|  Design Intelligence for SAP Activate
echo   SAP S/4HANA Cloud Public Edition
echo  ==========================================
echo.

:: ── Check Node.js ──────────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Node.js is not installed or not in PATH.
    echo.
    echo  How to fix:
    echo  1. Open https://nodejs.org in your browser
    echo  2. Download the LTS version and install it
    echo  3. Restart this script
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  [OK] Node.js %NODE_VER%
echo [OK] Node.js %NODE_VER% >> "%LOG%"

:: ── Install root dependencies if missing ───────────────────────────────────────
if not exist "node_modules" (
    echo.
    echo  First run detected — installing server dependencies...
    echo  (This takes about 30-60 seconds and only happens once)
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  ERROR: npm install failed. Check your internet connection and try again.
        echo.
        pause
        exit /b 1
    )
    echo  [OK] Server dependencies installed
)

:: ── Install kdd-generator dependencies if missing ──────────────────────────────
if not exist "kdd-generator\node_modules" (
    echo.
    echo  Installing KDD generator dependencies...
    echo.
    pushd kdd-generator
    call npm install
    if errorlevel 1 (
        echo.
        echo  ERROR: npm install in kdd-generator failed.
        echo.
        popd
        pause
        exit /b 1
    )
    popd
    echo  [OK] KDD generator dependencies installed
)

:: ── Find Claude CLI and set CLAUDE_PATH so Node.js subprocesses can find it ────
set "CLAUDE_PATH="
for /f "tokens=* delims=" %%p in ('where claude.cmd 2^>nul') do (
    if not defined CLAUDE_PATH set "CLAUDE_PATH=%%p"
)
for /f "tokens=* delims=" %%p in ('where claude.exe 2^>nul') do (
    if not defined CLAUDE_PATH set "CLAUDE_PATH=%%p"
)
if not defined CLAUDE_PATH if exist "%USERPROFILE%\.local\bin\claude.exe"                              set "CLAUDE_PATH=%USERPROFILE%\.local\bin\claude.exe"
if not defined CLAUDE_PATH if exist "%LOCALAPPDATA%\Programs\claude\claude.exe"                        set "CLAUDE_PATH=%LOCALAPPDATA%\Programs\claude\claude.exe"
if not defined CLAUDE_PATH if exist "%LOCALAPPDATA%\Programs\Claude\claude.exe"                        set "CLAUDE_PATH=%LOCALAPPDATA%\Programs\Claude\claude.exe"
if not defined CLAUDE_PATH if exist "%LOCALAPPDATA%\Programs\claude\resources\app\bin\claude.exe"      set "CLAUDE_PATH=%LOCALAPPDATA%\Programs\claude\resources\app\bin\claude.exe"
if not defined CLAUDE_PATH if exist "%APPDATA%\npm\claude.cmd"                                         set "CLAUDE_PATH=%APPDATA%\npm\claude.cmd"

if defined CLAUDE_PATH (
    echo  [OK] Claude CLI: %CLAUDE_PATH%
    echo [OK] Claude CLI: %CLAUDE_PATH% >> "%LOG%"
) else (
    echo [FAIL] Claude CLI not found >> "%LOG%"
    echo.
    echo  ============================================================
    echo   ACTION REQUIRED: Claude CLI not found.
    echo.
    echo   1. Open https://claude.ai/code in your browser
    echo   2. Download and install Claude Code for Windows
    echo   3. Close this window and double-click START.bat again
    echo  ============================================================
    echo.
    pause
    exit /b 1
)

:: ── Check Claude login ──────────────────────────────────────────────────────────
set "CLAUDE_AUTHED=0"
if exist "%USERPROFILE%\.claude\.credentials.json" set "CLAUDE_AUTHED=1"
if exist "%USERPROFILE%\.claude\auth.json"         set "CLAUDE_AUTHED=1"

if "%CLAUDE_AUTHED%"=="0" (
    echo [INFO] Claude not logged in - running claude login >> "%LOG%"
    echo.
    echo  ============================================================
    echo   ACTION REQUIRED: Sign in to Claude.
    echo.
    echo   1. A browser window will open NOW
    echo   2. Sign in with your Claude account
    echo   3. Come back to this window — it will continue automatically
    echo  ============================================================
    echo.
    claude login
    if errorlevel 1 (
        echo [FAIL] claude login failed or cancelled >> "%LOG%"
        echo.
        echo  Login failed. Please try again.
        echo.
        pause
        exit /b 1
    )
    echo  [OK] Claude login complete
    echo [OK] Claude login complete >> "%LOG%"
) else (
    echo  [OK] Claude already logged in
    echo [OK] Claude already logged in >> "%LOG%"
)

:: ── Create folders ──────────────────────────────────────────────────────────────
if not exist "output"    mkdir output
if not exist "decisions" mkdir decisions

:: ── Open browser after 3 seconds ───────────────────────────────────────────────
echo.
echo  Starting Fulcrum at http://127.0.0.1:8321
echo  Browser opens in 3 seconds — leave this window open.
echo  Press Ctrl+C to stop.
echo.

ping -n 4 127.0.0.1 >nul
start "" "http://127.0.0.1:8321"

:: ── Launch notify server ────────────────────────────────────────────────────────
if exist "notify\notify.js" (
    start /min "Fulcrum Notify" node notify\notify.js --server
    echo  [OK] Notify server started
)

:: ── Launch main server — window stays open until Ctrl+C ────────────────────────
echo [OK] Launching server >> "%LOG%"
node server.js 2>> "%LOG%"
echo [INFO] Server exited with code %ERRORLEVEL% >> "%LOG%"

echo.
echo  ==========================================
echo   Server stopped. Press any key to close.
echo  ==========================================
pause
