@echo off
setlocal enabledelayedexpansion

chcp 65001 >nul

rem Change to this script's directory so relative paths work.
rem NOTE: keep the comments ASCII-only. cmd.exe reads batch files with the
rem OEM code page, so UTF-8 Chinese comments can be misread as commands.
cd /d "%~dp0"

rem The success marker is written by the app only after every archive was
rem verified, so a failed month has no marker and will be retried.
if not defined APPDATA set "APPDATA=%USERPROFILE%\AppData\Roaming"

for /f "delims=" %%a in ('powershell -Command "Get-Date -Format 'yyyy-MM'"') do set "CurrentMonthDash=%%a"

rem The userData directory name follows the Electron app name, probe each one.
set "SuccessMarker="
for %%d in ("PersonalDataCenter" "personal-data-center" "个人数据中心") do (
    if exist "%APPDATA%\%%~d\logs\backup-success-!CurrentMonthDash!.log" (
        set "SuccessMarker=%APPDATA%\%%~d\logs\backup-success-!CurrentMonthDash!.log"
    )
)

if defined SuccessMarker (
    echo 本月（!CurrentMonthDash!）已成功备份，跳过。成功标记: !SuccessMarker!
    exit /b 0
)

echo 本月尚未成功备份，开始执行...
node "run-backup.mjs"
if errorlevel 1 (
    echo 备份失败，未生成成功标记，本月下次启动时会重试。
    exit /b 1
)

echo 备份成功完成。
exit /b 0