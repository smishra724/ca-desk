# CA Desk DSC helper — installs for the current Windows user (no administrator rights needed).
$ErrorActionPreference = 'Stop'
$ext  = 'ajnklhalmnpmiafebnoebjmjbmbgldoa'
$name = 'in.cadesk.dsc'
$src  = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'CADeskDSC'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Get-ChildItem -Path $src -File | Where-Object { $_.Name -match '^cadesk-dsc-host-.*\.exe$' -or $_.Name -eq 'README.txt' } | ForEach-Object { Copy-Item $_.FullName -Destination $dest -Force }
if (-not (Test-Path (Join-Path $dest 'libs.txt'))) { Copy-Item (Join-Path $src 'libs.txt') -Destination $dest -Force }
Get-ChildItem -Path $dest -File | Unblock-File -ErrorAction SilentlyContinue
$arch = if ([Environment]::Is64BitOperatingSystem) { 'amd64' } else { '386' }
$exe  = Join-Path $dest "cadesk-dsc-host-windows-$arch.exe"
if (-not (Test-Path $exe)) { throw "Missing $exe" }
$manifest = Join-Path $dest "$name.json"
$json = [ordered]@{ name = $name; description = 'CA Desk DSC helper'; path = $exe; type = 'stdio'; allowed_origins = @("chrome-extension://$ext/") } | ConvertTo-Json
[System.IO.File]::WriteAllText($manifest, $json, (New-Object System.Text.UTF8Encoding $false))
foreach ($k in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts', 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts')) {
  New-Item -Path "$k\$name" -Force | Out-Null
  Set-ItemProperty -Path "$k\$name" -Name '(default)' -Value $manifest
}
Write-Host ''
Write-Host 'DSC helper installed.' -ForegroundColor Green
Write-Host 'Now: Chrome -> chrome://extensions -> reload CA Desk Helper (version 1.6 or later), then in CA Desk open DSC register and click "Read from token".'
