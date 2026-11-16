@echo off
rem Removes the log helper registration from Chrome (log files already written are kept).
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.slotwatcher.logger" /f
