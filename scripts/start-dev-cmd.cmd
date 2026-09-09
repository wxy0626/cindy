@echo off
setlocal

set "PROJECT_DIR=E:\AI\cindy-harness\cindy"
set "NODE_EXE=D:\AI\NODEJS~1\node.exe"

if not exist "%PROJECT_DIR%\package.json" (
  echo ERROR: project not found: %PROJECT_DIR%
  pause
  exit /b 1
)
if not exist "%NODE_EXE%" (
  echo ERROR: node not found: %NODE_EXE%
  pause
  exit /b 1
)
cd /d "%PROJECT_DIR%"
echo Starting Cindy development version...
echo Project: %PROJECT_DIR%
echo.
rem 直接启动并等待 ready,不再嵌套 restart:desktop:remote,避免与已有重启器链竞争。
"%NODE_EXE%" "%PROJECT_DIR%\scripts\start-desktop-dev.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo ERROR: startup failed with exit code %EXIT_CODE%
if "%EXIT_CODE%"=="0" echo Cindy development version startup command completed.
pause
exit /b %EXIT_CODE%
