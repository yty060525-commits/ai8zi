@echo off
setlocal
rem ============================================================
rem  Build the Windows double-click app (NSIS installer + exe)
rem  Prereqs (one time): Rust MSVC + Node.js
rem    - Install Microsoft C++ Build Tools (admin PowerShell):
rem        winget install Microsoft.VisualStudio.2022.BuildTools
rem        --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
rem    - Install Rust (per user, from a NEW terminal after install):
rem        winget install Rustlang.Rustup
rem    - Node.js 20+:  https://nodejs.org
rem ============================================================
set "ROOT=%~dp0.."
cd /d "%ROOT%"

where rustc >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Rust toolchain not found. Install it first, then re-run.
  echo   winget install Rustlang.Rustup
  pause
  exit /b 1
)
where cargo >nul 2>nul || ( echo [ERROR] cargo not found & pause & exit /b 1 )

echo [1/3] npm install (Windows native binaries) ...
call npm ci --no-audit --no-fund
if errorlevel 1 ( echo [ERROR] npm ci failed & pause & exit /b 1 )

echo [2/3] Frontend typecheck + build ...
call npm run build
if errorlevel 1 ( echo [ERROR] frontend build failed & pause & exit /b 1 )

rem 编译中间件放项目外，保持源码目录小巧
set "CARGO_TARGET_DIR=%LOCALAPPDATA%\mingli-client-target"
echo [3/3] Rust + NSIS bundle (release, external target dir) ...
call npm run tauri:build
if errorlevel 1 ( echo [ERROR] tauri build failed & pause & exit /b 1 )

echo.
echo ============================================================
echo  DONE. Your Windows app:
echo    Double-click exe : %LOCALAPPDATA%\mingli-client-target\release\mingli-client.exe
echo    Installer        : %ROOT%src-tauri\target\release\bundle\nsis\*-setup.exe
echo  (Win10/11 includes WebView2; the installer covers it otherwise)
echo ============================================================
pause