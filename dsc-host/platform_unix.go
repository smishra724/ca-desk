//go:build darwin || linux

package main

import (
	"os/exec"
	"os/user"
	"path/filepath"
)

func hideWindow(c *exec.Cmd) {}

func platformLibs() (known, dirs, pats []string) {
	known = []string{
		"/usr/local/lib/libcastle_v2.1.0.dylib", "/usr/local/lib/libcastle.1.0.0.dylib", "/usr/local/lib/libcastle.so", // Feitian ePass 2003 (and rebrands)
		"/usr/local/lib/libwdpkcs.dylib", "/usr/local/lib/libWDPKCS.dylib", "/Library/WatchData/ProxKey/lib/libwdpkcs.dylib", "/Library/WatchData/PROXKey/lib/libwdpkcs.dylib", // WatchData ProxKey
		"/Library/Frameworks/eToken.framework/Versions/Current/libeToken.dylib", "/usr/local/lib/libeToken.dylib", "/usr/local/lib/libeTPkcs11.dylib", "/Library/Frameworks/eToken.framework/Versions/A/libIDPrimePKCS11.dylib", // SafeNet
		"/usr/local/lib/libcryptoid_pkcs11.dylib", "/usr/local/lib/libmtoken.dylib", "/usr/local/lib/libhypersecu.dylib", "/usr/local/lib/libShuttleCsp11_3003.dylib",
		"/Library/OpenSC/lib/opensc-pkcs11.so", "/usr/local/lib/opensc-pkcs11.so", "/opt/homebrew/lib/opensc-pkcs11.so", "/usr/lib/opensc-pkcs11.so", "/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so",
		"/usr/local/lib/libcastle.so.1.0.0", "/usr/lib/libcastle.so.1.0.0", "/usr/lib/libwdpkcs.so", "/usr/local/lib/libwdpkcs.so", "/usr/lib/libeToken.so", "/usr/lib/libeToken.so.9",
	}
	dirs = []string{"/usr/local/lib", "/opt/homebrew/lib", "/Library/OpenSC/lib", "/Library/WatchData/*/lib", "/Library/Frameworks/*/Versions/*", "/usr/lib"}
	if u, err := user.Current(); err == nil {
		dirs = append(dirs, filepath.Join(u.HomeDir, "Library", "*", "lib"))
	}
	pats = []string{"*pkcs11*", "*p11*", "*castle*", "*wdpkcs*", "*eToken*", "*proxkey*", "*mtoken*", "*epass*", "*cryptoki*"}
	return
}
