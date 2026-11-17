CA Desk DSC helper
==================
Reads the certificate (holder, issuer, valid from/till, token serial) from a DSC token plugged into this computer
and gives it to the CA Desk Helper browser extension, which fills the DSC register in CA Desk.

It never asks for, reads or stores the token PIN, and it does not sign anything.

Install
  Windows: unzip, double-click install.bat
  Mac:     unzip, right-click install.command -> Open (or in Terminal: bash install.command)
Then reload "CA Desk Helper" (version 1.6 or later) in chrome://extensions and click "Read from token" in the DSC register.

Troubleshooting
  Run  cadesk-dsc-host-...  --scan  in Command Prompt / Terminal to see every driver tried and what it found.
  If your token's driver is not found, put its file path in libs.txt (in the install folder) and try again.
  The token's own driver / client software must be installed (the same one you use to sign on GST / MCA).
  Uninstall (Windows): uninstall.bat. Mac: delete ~/Library/Application Support/CADeskDSC.
