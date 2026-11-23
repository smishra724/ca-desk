@echo off
rem CA Desk DSC reader — installs a small read-only helper so CA Desk can see the DSC tokens plugged into this computer.
rem Installs for the current Windows user only (no admin rights needed). Uninstall: run this file with  /uninstall
setlocal
set "EXTID=__EXTID__"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:EXTID='%EXTID%'; $env:MODE='%~1'; $t=Get-Content -Raw -LiteralPath '%~f0'; iex $t.Substring($t.LastIndexOf('#PS'+'BEGIN#')+9)"
echo.
pause
exit /b
#PSBEGIN#
$dir = Join-Path $env:LOCALAPPDATA 'CADeskDSC'
$keys = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.smconsultancy.cadesk_dsc', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.smconsultancy.cadesk_dsc'
if ($env:MODE -eq '/uninstall') { foreach ($k in $keys) { Remove-Item -Path $k -Force -ErrorAction SilentlyContinue }; Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue; Write-Host 'CA Desk DSC reader removed.'; return }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$hostPs = @'
# CA Desk DSC reader — Chrome / Edge native messaging host.
# Lists the digital signature certificates Windows can see (a plugged-in token registers its certificate in
# CurrentUser\My) and the USB tokens / smart-card readers that are connected. Read-only: it never asks for the
# token PIN, never signs anything and never touches the private key.
$ErrorActionPreference = 'SilentlyContinue'
$stdin = [Console]::OpenStandardInput(); $stdout = [Console]::OpenStandardOutput()
function Read-Msg { $lb = New-Object byte[] 4; $n = $stdin.Read($lb, 0, 4); if ($n -lt 4) { return $null }
  $len = [BitConverter]::ToInt32($lb, 0); $buf = New-Object byte[] $len; $r = 0
  while ($r -lt $len) { $k = $stdin.Read($buf, $r, $len - $r); if ($k -le 0) { break }; $r += $k }
  return ([Text.Encoding]::UTF8.GetString($buf) | ConvertFrom-Json) }
function Send-Msg($o) { $j = $o | ConvertTo-Json -Depth 6 -Compress; $b = [Text.Encoding]::UTF8.GetBytes($j)
  $stdout.Write([BitConverter]::GetBytes($b.Length), 0, 4); $stdout.Write($b, 0, $b.Length); $stdout.Flush() }
function Part($dn, $k) { if ($dn -match "(?:^|,\s*)$k=(`"[^`"]*`"|[^,]*)") { return $matches[1].Trim('"').Trim() }; return '' }
$null = Read-Msg
$tokens = @(Get-PnpDevice -PresentOnly | Where-Object { $_.Class -eq 'SmartCardReader' -or $_.Class -eq 'SmartCard' -or $_.FriendlyName -match 'ePass|ProxKey|Watchdata|eToken|HyperPKI|HyperSecu|mToken|Trust ?Key|Feitian|SafeNet|CryptoID|Smart ?Card' } | Select-Object -ExpandProperty FriendlyName -Unique)
$list = @()
foreach ($c in Get-ChildItem Cert:\CurrentUser\My) {
  if (-not $c.HasPrivateKey) { continue }
  $prov = ''
  $o = certutil -user -silent -store My $c.Thumbprint 2>$null | Out-String
  if ($o -match 'Provider = (.+)') { $prov = $matches[1].Trim() }
  $list += [pscustomobject]@{
    thumb = $c.Thumbprint; serial = $c.SerialNumber; subject = $c.Subject; issuer = $c.Issuer
    cn = (Part $c.Subject 'CN'); o = (Part $c.Subject 'O'); ou = (Part $c.Subject 'OU'); st = (Part $c.Subject 'S'); pin = (Part $c.Subject 'PostalCode')
    icn = (Part $c.Issuer 'CN'); io = (Part $c.Issuer 'O')
    from = $c.NotBefore.ToString('yyyy-MM-dd'); to = $c.NotAfter.ToString('yyyy-MM-dd'); provider = $prov
    onToken = [bool]($prov -match 'ePass|ProxKey|Watchdata|eToken|HyperPKI|HyperSecu|mToken|Trust|Feitian|SafeNet|Smart Card|Base Smart|CryptoID') }
}
Send-Msg @{ ok = $true; host = '1.0'; tokens = $tokens; certs = $list }
'@
[IO.File]::WriteAllText((Join-Path $dir 'host.ps1'), $hostPs)
[IO.File]::WriteAllText((Join-Path $dir 'host.bat'), "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0host.ps1`"`r`n")
$manifest = [ordered]@{ name = 'com.smconsultancy.cadesk_dsc'; description = 'CA Desk DSC reader'; path = (Join-Path $dir 'host.bat'); type = 'stdio'; allowed_origins = @("chrome-extension://$($env:EXTID)/") } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $dir 'manifest.json'), $manifest)
foreach ($k in $keys) { New-Item -Path $k -Force | Out-Null; Set-ItemProperty -Path $k -Name '(default)' -Value (Join-Path $dir 'manifest.json') }
Write-Host ''
Write-Host 'CA Desk DSC reader is installed.' -ForegroundColor Green
Write-Host 'Go back to CA Desk -> DSC register. Plugged-in DSC tokens now show up there by themselves.'
