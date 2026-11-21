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
