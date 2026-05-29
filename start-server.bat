@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

set "NODE_VERSION=22.15.0"
set "NODE_INSTALL_DIR=%ProgramFiles%\nodejs"
set "NODE_EXE=%NODE_INSTALL_DIR%\node.exe"
set "NPM_CMD=%NODE_INSTALL_DIR%\npm.cmd"
set "NODE_MSI_NAME=node-v%NODE_VERSION%-x64.msi"
set "NODE_MSI_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_MSI_NAME%"
set "TEMP_MSI=%TEMP%\%NODE_MSI_NAME%"
set "CONFIG_PATH=%SCRIPT_DIR%server\data\config.json"
set "SHARED_DIST=%SCRIPT_DIR%shared\dist\index.js"
set "SERVER_DIST=%SCRIPT_DIR%server\dist\index.js"
set "CLIENT_INDEX=%SCRIPT_DIR%client\dist\index.html"
set "LOG_DIR=%SCRIPT_DIR%logs"
set "NODE_INSTALL_LOG=%LOG_DIR%\node-install.log"
set "NPM_INSTALL_LOG=%LOG_DIR%\npm-install.log"
set "PREPARE_LOG=%LOG_DIR%\prepare.log"
set "SERVER_LOG=%LOG_DIR%\server.log"
set "SERVER_PORT=11037"
set "LAST_ERROR="
set "LAST_LOG="

echo [superJinroh] start-server.bat
echo [superJinroh] Working directory: %SCRIPT_DIR%

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

call :load_config

call :ensure_node
if errorlevel 1 goto :fail

call :ensure_dependencies
if errorlevel 1 goto :fail

call :prepare_server
if errorlevel 1 goto :fail

echo [superJinroh] Starting server on http://localhost:%SERVER_PORT%
echo [superJinroh] Server log: %SERVER_LOG%
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; & '%NPM_CMD%' --workspace server run start 2>&1 | Tee-Object -FilePath '%SERVER_LOG%'; exit $LASTEXITCODE"
if errorlevel 1 (
  set "LAST_ERROR=Server startup failed."
  set "LAST_LOG=%SERVER_LOG%"
  goto :fail
)

goto :eof

:load_config
if not exist "%CONFIG_PATH%" exit /b 0
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$config = Get-Content -Raw '%CONFIG_PATH%' | ConvertFrom-Json; if($null -ne $config.port){ [int]$config.port }" 2^>nul`) do (
  set "SERVER_PORT=%%P"
)
exit /b 0

:ensure_node
call :resolve_node_from_path
if errorlevel 1 (
  echo [superJinroh] Node.js %NODE_VERSION% or newer was not found. Installing it now.
  goto :install_node
)

call :get_node_version
if errorlevel 1 (
  echo [superJinroh] Found node.exe, but the version could not be determined.
  goto :install_node
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$minimum=[version]'%NODE_VERSION%'; $current=[version]'!CURRENT_NODE_VERSION!'; if($current -ge $minimum){exit 0}else{exit 1}" >nul 2>nul
if not errorlevel 1 (
  echo [superJinroh] Node.js !CURRENT_NODE_VERSION! is available and will be used.
  goto :node_ready
)

echo [superJinroh] Node.js !CURRENT_NODE_VERSION! was found, but %NODE_VERSION% or newer is required.

:install_node

call :ensure_admin
if errorlevel 1 exit /b 1

echo [superJinroh] Downloading %NODE_MSI_URL%
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '%NODE_MSI_URL%' -OutFile '%TEMP_MSI%'" > "%NODE_INSTALL_LOG%" 2>&1
if errorlevel 1 (
  set "LAST_ERROR=Failed to download Node.js installer."
  set "LAST_LOG=%NODE_INSTALL_LOG%"
  exit /b 1
)

echo [superJinroh] Running Node.js installer.
msiexec /i "%TEMP_MSI%" /qn /norestart >> "%NODE_INSTALL_LOG%" 2>&1
if errorlevel 1 (
  set "LAST_ERROR=Node.js installer failed."
  set "LAST_LOG=%NODE_INSTALL_LOG%"
  exit /b 1
)

del /f /q "%TEMP_MSI%" >nul 2>nul

:node_ready
if exist "%NODE_INSTALL_DIR%\node.exe" set "PATH=%NODE_INSTALL_DIR%;%PATH%"
if not exist "%NODE_EXE%" (
  call :resolve_node_from_path
  if errorlevel 1 (
    set "LAST_ERROR=node.exe was not found after installation."
    exit /b 1
  )
)
if not exist "%NPM_CMD%" (
  call :resolve_node_from_path
  if errorlevel 1 (
    set "LAST_ERROR=npm.cmd was not found after installation."
    exit /b 1
  )
)
call :get_node_version
if errorlevel 1 (
  set "LAST_ERROR=Node.js version could not be determined after installation."
  exit /b 1
)
exit /b 0

:get_node_version
set "CURRENT_NODE_VERSION="
for /f "usebackq delims=" %%V in (`"%NODE_EXE%" --version 2^>nul`) do (
  if not defined CURRENT_NODE_VERSION set "CURRENT_NODE_VERSION=%%V"
)
if not defined CURRENT_NODE_VERSION exit /b 1
if /I "!CURRENT_NODE_VERSION:~0,1!"=="v" set "CURRENT_NODE_VERSION=!CURRENT_NODE_VERSION:~1!"
exit /b 0

:resolve_node_from_path
set "NODE_EXE="
set "NPM_CMD="
for /f "usebackq delims=" %%P in (`where node 2^>nul`) do (
  if not defined NODE_EXE set "NODE_EXE=%%P"
)
for /f "usebackq delims=" %%P in (`where npm.cmd 2^>nul`) do (
  if not defined NPM_CMD set "NPM_CMD=%%P"
)
if defined NODE_EXE if defined NPM_CMD exit /b 0
set "NODE_EXE=%NODE_INSTALL_DIR%\node.exe"
set "NPM_CMD=%NODE_INSTALL_DIR%\npm.cmd"
if exist "%NODE_EXE%" if exist "%NPM_CMD%" exit /b 0
exit /b 1

:ensure_admin
net session >nul 2>nul
if %errorlevel%==0 exit /b 0

echo [superJinroh] Administrator rights are required to install Node.js.
echo [superJinroh] Re-launching this script with elevation.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b 1

:ensure_dependencies
if exist "%SCRIPT_DIR%node_modules" (
  echo [superJinroh] node_modules already exists. Skipping npm install.
  exit /b 0
)

echo [superJinroh] Installing npm dependencies.
echo [superJinroh] npm install log: %NPM_INSTALL_LOG%
call "%NPM_CMD%" install > "%NPM_INSTALL_LOG%" 2>&1
if errorlevel 1 (
  set "LAST_ERROR=npm install failed."
  set "LAST_LOG=%NPM_INSTALL_LOG%"
  exit /b 1
)
exit /b 0

:prepare_server
echo [superJinroh] Building shared package.
echo [superJinroh] Build log: %PREPARE_LOG%
call "%NPM_CMD%" run build:shared > "%PREPARE_LOG%" 2>&1
if errorlevel 1 (
  set "LAST_ERROR=Shared package build failed."
  set "LAST_LOG=%PREPARE_LOG%"
  exit /b 1
)

echo [superJinroh] Generating Prisma client.
call "%NPM_CMD%" --workspace server run prisma:generate >> "%PREPARE_LOG%" 2>&1
if errorlevel 1 (
  set "LAST_ERROR=Prisma client generation failed."
  set "LAST_LOG=%PREPARE_LOG%"
  exit /b 1
)

echo [superJinroh] Applying SQLite schema.
call "%NPM_CMD%" --workspace server run prisma:migrate:deploy >> "%PREPARE_LOG%" 2>&1
if errorlevel 1 (
  set "LAST_ERROR=Database setup failed."
  set "LAST_LOG=%PREPARE_LOG%"
  exit /b 1
)

echo [superJinroh] Building server.
call "%NPM_CMD%" --workspace server run build >> "%PREPARE_LOG%" 2>&1
if errorlevel 1 (
  set "LAST_ERROR=Server build failed."
  set "LAST_LOG=%PREPARE_LOG%"
  exit /b 1
)

echo [superJinroh] Building client.
call "%NPM_CMD%" --workspace client run build >> "%PREPARE_LOG%" 2>&1
if errorlevel 1 (
  set "LAST_ERROR=Client build failed."
  set "LAST_LOG=%PREPARE_LOG%"
  exit /b 1
)

if not exist "%SHARED_DIST%" (
  set "LAST_ERROR=Shared build output was not created."
  exit /b 1
)
if not exist "%SERVER_DIST%" (
  set "LAST_ERROR=Server build output was not created."
  exit /b 1
)
if not exist "%CLIENT_INDEX%" (
  set "LAST_ERROR=Client build output was not created."
  exit /b 1
)
exit /b 0

:fail
echo [superJinroh] start-server.bat failed.
if defined LAST_ERROR echo [superJinroh] Error: %LAST_ERROR%
if defined LAST_LOG echo [superJinroh] Log: %LAST_LOG%
echo [superJinroh] Press any key to close this window.
pause >nul
exit /b 1
