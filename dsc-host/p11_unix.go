//go:build darwin || linux

package main

import (
	"fmt"

	"github.com/ebitengine/purego"
)

func ulSize() int { return 8 } // CK_ULONG is 64-bit on macOS / Linux

type unixLib struct {
	h    uintptr
	syms map[string]uintptr
}

func openLib(path string) (libFns, error) {
	h, err := purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, err
	}
	l := &unixLib{h: h, syms: map[string]uintptr{}}
	if _, err := purego.Dlsym(h, "C_Initialize"); err != nil {
		return nil, errNoSymbol
	}
	return l, nil
}

func (l *unixLib) call(name string, args ...uintptr) (uint32, error) {
	fn, ok := l.syms[name]
	if !ok {
		var err error
		if fn, err = purego.Dlsym(l.h, name); err != nil {
			if name == "C_Finalize" || name == "C_CloseSession" || name == "C_FindObjectsFinal" {
				return 0, nil
			}
			return 0, fmt.Errorf("driver lacks %s", name)
		}
		l.syms[name] = fn
	}
	r, _, _ := purego.SyscallN(fn, args...)
	return uint32(r), nil
}
func (l *unixLib) close() {} // the helper process exits right after probing; unloading drivers can crash some of them
