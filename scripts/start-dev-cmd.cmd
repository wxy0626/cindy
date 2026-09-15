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
rem Start and wait for ready; no nested restart wrapper to avoid competing restart chains.
"%NODE_EXE%" "%PROJECT_DIR%\scripts\start-desktop-dev.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
rem 2026-09-15: do not leave the console window behind after exit/restart.
rem Only pause on startup failure; on normal exit close the window right away.
rem NOTE: use "exit", NOT "exit /b" - this script is usually launched via "cmd /k",
rem where "exit /b" only returns to the prompt and keeps the window open.
rem NOTE: keep comments ASCII-only. This file has no "chcp" line, and cmd parses
rem it with the legacy ANSI codepage (GBK on zh-CN systems); UTF-8 Chinese
rem comments get misread as garbled commands and can swallow the final "exit".
if not "%EXIT_CODE%"=="0" (
  echo ERROR: startup failed with exit code %EXIT_CODE%
  echo.
  pause
  exit /b %EXIT_CODE%
)
echo Cindy development version startup command completed.
exit 0
