@echo off
setlocal

cd /d "%~dp0"

set "BLOCKPILOT_GATEWAY_HOST=127.0.0.1"
set "BLOCKPILOT_GATEWAY_PORT=8787"
set "BLOCKPILOT_GATEWAY_URL=ws://127.0.0.1:8787/worker"
set "BLOCKPILOT_BOT_ID=BlockPilot"

set "MC_HOST=127.0.0.1"
set "MC_PORT=25565"
set "MC_USERNAME=BlockPilot"
set "MC_AUTH=offline"

if not "%~1"=="" set "MC_USERNAME=%~1"
if not "%~1"=="" set "BLOCKPILOT_BOT_ID=%~1"
if not "%~2"=="" set "MC_PORT=%~2"

echo.
echo BlockPilot local offline launcher
echo ---------------------------------
echo Gateway:   http://%BLOCKPILOT_GATEWAY_HOST%:%BLOCKPILOT_GATEWAY_PORT%
echo Worker:    %BLOCKPILOT_GATEWAY_URL%
echo Minecraft: %MC_HOST%:%MC_PORT%
echo Bot ID:    %BLOCKPILOT_BOT_ID%
echo Username:  %MC_USERNAME%
echo Auth:      %MC_AUTH%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found in PATH.
  echo Install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)

where corepack >nul 2>nul
if errorlevel 1 (
  echo ERROR: Corepack was not found in PATH.
  echo Reinstall Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)

echo Preparing pnpm...
call corepack prepare pnpm@11.9.0 --activate
if errorlevel 1 (
  echo ERROR: Failed to prepare pnpm through Corepack.
  pause
  exit /b 1
)

echo Installing dependencies...
call corepack pnpm install
if errorlevel 1 (
  echo ERROR: pnpm install failed.
  pause
  exit /b 1
)

echo Building project...
call corepack pnpm build
if errorlevel 1 (
  echo ERROR: pnpm build failed.
  pause
  exit /b 1
)

echo Starting Gateway and Bot Worker in separate windows...

start "BlockPilot Gateway" /D "%~dp0" cmd /k "set BLOCKPILOT_GATEWAY_HOST=%BLOCKPILOT_GATEWAY_HOST%&& set BLOCKPILOT_GATEWAY_PORT=%BLOCKPILOT_GATEWAY_PORT%&& corepack pnpm dev:gateway"

timeout /t 2 /nobreak >nul

start "BlockPilot Bot Worker" /D "%~dp0" cmd /k "set BLOCKPILOT_BOT_ID=%BLOCKPILOT_BOT_ID%&& set BLOCKPILOT_GATEWAY_URL=%BLOCKPILOT_GATEWAY_URL%&& set MC_HOST=%MC_HOST%&& set MC_PORT=%MC_PORT%&& set MC_USERNAME=%MC_USERNAME%&& set MC_AUTH=%MC_AUTH%&& corepack pnpm dev:bot"

echo.
echo Started. Use this command to inspect bots:
echo curl http://127.0.0.1:8787/bots
echo.
echo To use another bot username:
echo start-local-offline.bat MyBotName
echo.

endlocal
