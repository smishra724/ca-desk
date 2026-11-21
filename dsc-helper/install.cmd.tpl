@echo off
rem CA Desk DSC reader — installs a small read-only helper so CA Desk can see the DSC tokens plugged into this computer.
rem Installs for the current Windows user only (no admin rights needed). Uninstall: run this file with  /uninstall
setlocal
set "EXTID=__EXTID__"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:EXTID='%EXTID%'; $env:MODE='%~1'; $s=(Get-Content -Raw -LiteralPath '%~f0') -split '#PSBEGIN#',2; iex $s[1]"
echo.
pause
exit /b
#PSBEGIN#
$dir = Join-Path $env:LOCALAPPDATA 'CADeskDSC'
$keys = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.smconsultancy.cadesk_dsc', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.smconsultancy.cadesk_dsc'
if ($env:MODE -eq '/uninstall') { foreach ($k in $keys) { Remove-Item -Path $k -Force -ErrorAction SilentlyContinue }; Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue; Write-Host 'CA Desk DSC reader removed.'; return }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$hostPs = @'
__HOSTPS__
'@
[IO.File]::WriteAllText((Join-Path $dir 'host.ps1'), $hostPs)
[IO.File]::WriteAllText((Join-Path $dir 'host.bat'), "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0host.ps1`"`r`n")
$manifest = [ordered]@{ name = 'com.smconsultancy.cadesk_dsc'; description = 'CA Desk DSC reader'; path = (Join-Path $dir 'host.bat'); type = 'stdio'; allowed_origins = @("chrome-extension://$($env:EXTID)/") } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $dir 'manifest.json'), $manifest)
foreach ($k in $keys) { New-Item -Path $k -Force | Out-Null; Set-ItemProperty -Path $k -Name '(default)' -Value (Join-Path $dir 'manifest.json') }
Write-Host ''
Write-Host 'CA Desk DSC reader is installed.' -ForegroundColor Green
Write-Host 'Go back to CA Desk -> DSC register. Plugged-in DSC tokens now show up there by themselves.'
