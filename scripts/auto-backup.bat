@echo off
setlocal enabledelayedexpansion

chcp 65001 >nul

:: 切换到脚本自身所在目录，保证相对路径有效
cd /d "%~dp0"

:: 用 PowerShell 获取当前年月（两种格式）
for /f "delims=" %%a in ('powershell -Command "Get-Date -Format 'yyyyMM'"') do set "CurrentMonth=%%a"
for /f "delims=" %%a in ('powershell -Command "Get-Date -Format 'yyyy-MM'"') do set "CurrentMonthDash=%%a"

:: 日志目录相对路径（scripts 的上一级是 resources，再上一级是项目根，logs 在根下）
set "LogDir=..\..\logs"

:: 检查是否存在当月任何日期的备份日志
if not exist "%LogDir%\backup-%CurrentMonthDash%-*.log" (
    echo 本月尚未备份，开始执行...
    node "run-backup.mjs"
) else (
    echo 本月已备份（存在 %CurrentMonthDash% 的日志），跳过。
)

exit