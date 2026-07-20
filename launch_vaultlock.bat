@echo off
title VaultLock
cd /d "%~dp0"

echo Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.10+ from https://python.org
    echo Make sure to check "Add Python to PATH" during install.
    pause & exit /b
)

echo Installing dependencies...
python -m pip install -r requirements.txt --quiet --user

echo Starting VaultLock...
python main.py

if errorlevel 1 (
    echo.
    echo *** VaultLock crashed. See error above. ***
    pause
)
