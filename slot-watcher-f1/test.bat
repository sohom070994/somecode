@echo off
setlocal
rem Each run is appended to test-logs\YYYY-MM-DD.log (written by test-log.ps1 after the click,
rem so logging never delays it).
set "STARTED=%date% %time%"
set "OUT=%TEMP%\slotwatcher-test-%RANDOM%%RANDOM%.txt"
cd /d "C:\Users\tck07\OneDrive\Documents\GitHub\Test"
python "%~dp0test_run.py" > "%OUT%" 2>&1
set "CODE=%errorlevel%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0test-log.ps1" -Started "%STARTED%" -Code "%CODE%" -OutFile "%OUT%" -LogDir "%~dp0test-logs"
del "%OUT%" 2>nul
exit
