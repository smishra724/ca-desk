package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const version = "1.0.0"

type Tried struct {
	Lib    string `json:"lib"`
	Status string `json:"status"` // token | no-token | error | skipped
	Detail string `json:"detail,omitempty"`
}

type probeOut struct {
	Tokens []struct {
		Label, Manufacturer, Model, Serial string
		Certs                              []string // base64 DER
	}
	Error string
}

func exeDir() string {
	p, err := os.Executable()
	if err != nil {
		return "."
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return filepath.Dir(p)
}

func candidates() []string {
	seen := map[string]bool{}
	var out []string
	add := func(p string) {
		if p == "" {
			return
		}
		k := strings.ToLower(p)
		if seen[k] {
			return
		}
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			seen[k] = true
			out = append(out, p)
		}
	}
	// 1) libs the user listed (libs.txt next to the helper, or CADESK_DSC_LIBS)
	if b, err := os.ReadFile(filepath.Join(exeDir(), "libs.txt")); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			l = strings.TrimSpace(l)
			if l != "" && !strings.HasPrefix(l, "#") {
				add(l)
			}
		}
	}
	for _, l := range filepath.SplitList(os.Getenv("CADESK_DSC_LIBS")) {
		add(strings.TrimSpace(l))
	}
	// 2) well-known token drivers, then 3) name patterns in the usual driver folders
	known, dirs, pats := platformLibs()
	for _, p := range known {
		add(p)
	}
	for _, d := range dirs {
		for _, pat := range pats {
			m, _ := filepath.Glob(filepath.Join(d, pat))
			sort.Strings(m)
			for _, p := range m {
				add(p)
			}
		}
	}
	return out
}

// libArch tells which CPU a driver file was built for ("" = unknown / same as us).
func libArch(path string) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	head := make([]byte, 4096)
	n, _ := f.Read(head)
	head = head[:n]
	switch runtime.GOOS {
	case "windows":
		if len(head) > 0x40 && head[0] == 'M' && head[1] == 'Z' {
			off := int(binary.LittleEndian.Uint32(head[0x3c:]))
			if off+6 < len(head) && string(head[off:off+4]) == "PE\x00\x00" {
				switch binary.LittleEndian.Uint16(head[off+4:]) {
				case 0x8664:
					return []string{"amd64"}
				case 0x14c:
					return []string{"386"}
				case 0xaa64:
					return []string{"arm64"}
				}
			}
		}
	case "darwin":
		cpu := func(t uint32) string {
			switch t {
			case 0x0100000c:
				return "arm64"
			case 0x01000007:
				return "amd64"
			}
			return ""
		}
		if len(head) >= 8 {
			magic := binary.LittleEndian.Uint32(head)
			if magic == 0xfeedfacf {
				if a := cpu(binary.LittleEndian.Uint32(head[4:])); a != "" {
					return []string{a}
				}
			} else if binary.BigEndian.Uint32(head) == 0xcafebabe {
				cnt := int(binary.BigEndian.Uint32(head[4:]))
				var archs []string
				for i := 0; i < cnt && 8+i*20+4 <= len(head); i++ {
					if a := cpu(binary.BigEndian.Uint32(head[8+i*20:])); a != "" {
						archs = append(archs, a)
					}
				}
				return archs
			}
		}
	}
	return nil
}

// helperFor picks the helper binary that can load this driver (a 64-bit helper cannot load a 32-bit driver).
func helperFor(lib string) (string, string) {
	self, _ := os.Executable()
	archs := libArch(lib)
	if len(archs) == 0 {
		return self, ""
	}
	for _, a := range archs {
		if a == runtime.GOARCH {
			return self, ""
		}
	}
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	for _, a := range archs {
		p := filepath.Join(exeDir(), "cadesk-dsc-host-"+runtime.GOOS+"-"+a+ext)
		if _, err := os.Stat(p); err == nil {
			return p, ""
		}
	}
	return "", "needs the " + strings.Join(archs, "/") + " helper, which is not installed"
}

func probeInChild(lib string) ([]rawToken, string, string) {
	bin, why := helperFor(lib)
	if bin == "" {
		return nil, "skipped", why
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "--probe", lib)
	hideWindow(cmd)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil && out.Len() == 0 {
		if ctx.Err() != nil {
			return nil, "error", "driver did not answer in 15 seconds"
		}
		return nil, "error", "driver failed to load"
	}
	var po probeOut
	if err := json.Unmarshal(out.Bytes(), &po); err != nil {
		return nil, "error", "unreadable answer from driver"
	}
	if po.Error != "" {
		return nil, "error", po.Error
	}
	var toks []rawToken
	for _, t := range po.Tokens {
		rt := rawToken{Label: t.Label, Manufacturer: t.Manufacturer, Model: t.Model, Serial: t.Serial}
		for _, c := range t.Certs {
			if d, err := base64.StdEncoding.DecodeString(c); err == nil {
				rt.Certs = append(rt.Certs, d)
			}
		}
		toks = append(toks, rt)
	}
	if len(toks) == 0 {
		return nil, "no-token", ""
	}
	return toks, "token", ""
}

func scanAll() map[string]any {
	var certs []CertOut
	var tried []Tried
	seen := map[string]bool{}
	for _, lib := range candidates() {
		toks, status, detail := probeInChild(lib)
		tried = append(tried, Tried{Lib: lib, Status: status, Detail: detail})
		for _, t := range toks {
			for _, der := range t.Certs {
				if c, ok := describe(der, t, lib); ok && !seen[c.Thumbprint] {
					seen[c.Thumbprint] = true
					certs = append(certs, c)
				}
			}
		}
	}
	for _, c := range storeCerts() { // Windows: tokens that register themselves in the Windows certificate store
		if !seen[c.Thumbprint] {
			seen[c.Thumbprint] = true
			certs = append(certs, c)
		}
	}
	if certs == nil {
		certs = []CertOut{}
	}
	return map[string]any{"ok": true, "version": version, "os": runtime.GOOS, "arch": runtime.GOARCH, "certs": certs, "tried": tried}
}

// --probe <lib>: runs in a separate process so a misbehaving driver can never take the helper down.
func probeMain(lib string) {
	toks, err := probeLib(lib)
	var po probeOut
	if err != nil {
		po.Error = err.Error()
	}
	for _, t := range toks {
		x := struct {
			Label, Manufacturer, Model, Serial string
			Certs                              []string
		}{Label: t.Label, Manufacturer: t.Manufacturer, Model: t.Model, Serial: t.Serial}
		for _, c := range t.Certs {
			x.Certs = append(x.Certs, base64.StdEncoding.EncodeToString(c))
		}
		po.Tokens = append(po.Tokens, x)
	}
	json.NewEncoder(os.Stdout).Encode(po)
}
