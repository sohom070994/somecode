@echo off
rem Registers the log helper with Chrome for the current Windows user (no admin needed).
rem Undo with uninstall.bat. If the extension's folder moves, update "path" in
rem com.slotwatcher.f1.logger.json and run this again.
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.slotwatcher.f1.logger" /ve /t REG_SZ /d "%~dp0com.slotwatcher.f1.logger.json" /f
