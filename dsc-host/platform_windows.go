//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func hideWindow(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

func platformLibs() (known, dirs, pats []string) {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	pf, pf86 := os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")
	if pf == "" {
		pf = `C:\Program Files`
	}
	if pf86 == "" {
		pf86 = `C:\Program Files (x86)`
	}
	sys := []string{filepath.Join(root, "System32"), filepath.Join(root, "SysWOW64")}
	for _, d := range sys {
		for _, n := range []string{
			"eps2003csp11.dll", "eps2003csp11v2.dll", "ShuttleCsp11_3003.dll", "ngp11v211.dll", // Feitian ePass 2003 / 3003 / 1000-2000 (also HyperSecu, Capricorn, eMudhra, Pantasign ePass tokens)
			"WDPKCS.dll", "wdpkcs.dll", // WatchData ProxKey
			"eTPKCS11.dll", "aetpkss1.dll", // SafeNet / Aladdin eToken
			"IDPrimePKCS11.dll", "gclib.dll", "OcsCryptoki.dll", "dkck201.dll", "dkck232.dll", "SignatureP11.dll",
			"CryptoIDA_pkcs11.dll", "mToken.dll", "mtoken_pkcs11.dll", "TrustKeyPKCS11.dll", "cmp11.dll", "opensc-pkcs11.dll", "cryptoki.dll", "asepkcs.dll", "ccpkip11.dll", "incryptoki2.dll",
		} {
			known = append(known, filepath.Join(d, n))
		}
		dirs = append(dirs, d)
	}
	for _, base := range []string{pf, pf86, filepath.Join(root, "System32", "Watchdata"), filepath.Join(root, "SysWOW64", "Watchdata")} {
		for _, sub := range []string{"", "*", filepath.Join("*", "*")} {
			dirs = append(dirs, filepath.Join(base, sub))
		}
	}
	pats = []string{"*pkcs11*.dll", "*p11*.dll", "*csp11*.dll", "*cryptoki*.dll", "WDPKCS*.dll", "*epass*.dll", "*proxkey*.dll", "*mtoken*.dll", "*eToken*.dll"}
	return
}
