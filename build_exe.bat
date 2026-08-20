@echo off
REM ============================================================
REM  build_exe.bat — builds VaultLock.exe on Windows
REM
REM  Run this by double-clicking it, on a Windows PC, from inside
REM  the VaultLock project folder. Requires Python 3.10+ to be
REM  installed and on PATH. Everything else installs itself.
REM ============================================================

echo.
echo === VaultLock build ===
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo Python was not found on PATH.
    echo Install it from https://www.python.org/downloads/ and re-run this.
    pause
    exit /b 1
)

echo Installing build + runtime dependencies...
python -m pip install --upgrade pip >nul
python -m pip install -r requirements.txt
python -m pip install pyinstaller

echo.
echo Cleaning previous build output...
rmdir /s /q build 2>nul
rmdir /s /q dist 2>nul

echo.
echo Building VaultLock.exe (this can take a few minutes)...
pyinstaller vaultlock.spec

echo.
if exist dist\VaultLock\VaultLock.exe (
    echo ============================================================
    echo  Done. Your app is at: dist\VaultLock\VaultLock.exe
    echo  Zip the whole dist\VaultLock folder to share it — the exe
    echo  needs the other files sitting next to it in that folder.
    echo ============================================================
) else (
    echo Something went wrong — scroll up for the PyInstaller error.
)

pause
