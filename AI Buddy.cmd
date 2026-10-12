@echo off
if exist "%~dp0AI Buddy.exe" (
  start "" "%~dp0AI Buddy.exe"
  exit /b
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-AI-Buddy.ps1"
if errorlevel 1 pause
