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
rem 2026-09-15 用户要求:退出/重启后不要残留命令行控制台。
rem 只有启动失败才停下来让用户看错误;正常退出(用户关了应用或点了托盘"重启程序")
rem 直接关掉窗口。注意用 exit 而不是 exit /b —— 本脚本通常被 `cmd /k` 拉起,
rem exit /b 只会回到 /k 的提示符、窗口照样留着,exit 才会真正关闭 cmd 进程。
if not "%EXIT_CODE%"=="0" (
  echo ERROR: startup failed with exit code %EXIT_CODE%
  echo.
  pause
  exit /b %EXIT_CODE%
)
echo Cindy development version startup command completed.
exit 0
