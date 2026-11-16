@echo off
rem Registers the log helper with Chrome for the current Windows user (no admin needed).
rem Undo with uninstall.bat. If the extension's folder moves, update "path" in
rem com.slotwatcher.logger.json and run this again.
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.slotwatcher.logger" /ve /t REG_SZ /d "%~dp0com.slotwatcher.logger.json" /f
