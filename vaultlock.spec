# vaultlock.spec — PyInstaller build spec for VaultLock
#
# Run this on a WINDOWS machine (PyInstaller cannot cross-compile):
#     pyinstaller vaultlock.spec
#
# Output lands in dist\VaultLock\VaultLock.exe (or dist\VaultLock.exe if
# you switch to onefile mode below).

block_cipher = None

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('frontend', 'frontend'),   # ship the UI files alongside the app
    ],
    hiddenimports=[
        'webview.platforms.edgechromium',
        'webview.platforms.winforms',
        'PIL._tkinter_finder',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='VaultLock',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,          # no terminal window — this is a GUI app
    icon=None,              # point this at a .ico file if you add one
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='VaultLock',
)
