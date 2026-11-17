@echo off
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\in.cadesk.dsc" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\in.cadesk.dsc" /f >nul 2>&1
reg delete "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\in.cadesk.dsc" /f >nul 2>&1
rmdir /s /q "%LOCALAPPDATA%\CADeskDSC" >nul 2>&1
echo DSC helper removed.
pause
