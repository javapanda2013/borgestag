@echo off
:: install.bat
:: Registers the Native Messaging host for Firefox.
:: No administrator rights required (writes to HKCU).
::
:: Usage:
::   1. Place this file, image_saver.py and image_saver_wrapper.bat
::      in the same folder (e.g. C:\firefox-ext-native\)
::   2. Double-click install.bat
::   3. Restart Firefox and reload the extension

setlocal

:: Get the directory where this script lives (no trailing backslash)
set "NATIVE_DIR=%~dp0"
if "%NATIVE_DIR:~-1%"=="\" set "NATIVE_DIR=%NATIVE_DIR:~0,-1%"

:: Show the version of image_saver.py being installed
echo Installing from: %NATIVE_DIR%
python -c "import re,sys; src=open(sys.argv[1],encoding='utf-8').read(); m=re.search(r'version:\s*(\S+)',src); print('image_saver.py version: '+m.group(1) if m else 'version: unknown')" "%NATIVE_DIR%\image_saver.py"
echo.

set "BAT_PATH=%NATIVE_DIR%\image_saver_wrapper.bat"
set "JSON_DST=%NATIVE_DIR%\image_saver_registered.json"

:: Generate the manifest JSON via Python
:: (avoids cmd.exe bracket / encoding issues with inline echo)
python -c "import json,sys; d={'name':'image_saver_host','description':'BorgesTag','path':sys.argv[1],'type':'stdio','allowed_extensions':['image-saver-tags@example.com']}; open(sys.argv[2],'w',encoding='utf-8').write(json.dumps(d,indent=2,ensure_ascii=False))" "%BAT_PATH%" "%JSON_DST%"

if errorlevel 1 (
    echo [ERROR] Failed to generate JSON manifest. Is Python installed?
    pause
    exit /b 1
)

echo Manifest written to: %JSON_DST%

:: Install Pillow (required for thumbnail generation)
echo.
echo Checking Pillow...
python -c "from PIL import Image" >nul 2>&1
if errorlevel 1 (
    echo Pillow not found. Installing...
    python -m pip install Pillow --quiet
    if errorlevel 1 (
        echo [WARN] Failed to install Pillow. Thumbnails may not be generated.
    ) else (
        echo Pillow installed successfully.
    )
) else (
    echo Pillow OK.
)
echo.

:: Register the manifest path in the Windows registry (HKCU, no admin needed)
set "REG_KEY=HKCU\Software\Mozilla\NativeMessagingHosts\image_saver_host"

reg add "%REG_KEY%" /ve /t REG_SZ /d "%JSON_DST%" /f

if errorlevel 1 (
    echo [ERROR] Failed to write registry key.
    pause
    exit /b 1
)

echo.
echo ===================================================
echo  Install complete!
echo  Please restart Firefox and reload the extension.
echo ===================================================
echo.

pause
endlocal
