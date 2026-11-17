//go:build windows

package main

import (
	"fmt"
	"syscall"
)

func ulSize() int { return 4 } // CK_ULONG is 32-bit on Windows (and structs are packed to 1 byte)

type winLib struct {
	h    syscall.Handle
	syms map[string]uintptr
}

func openLib(path string) (libFns, error) {
	h, err := syscall.LoadLibrary(path)
	if err != nil {
		return nil, err
	}
	l := &winLib{h: h, syms: map[string]uintptr{}}
	if _, err := syscall.GetProcAddress(h, "C_Initialize"); err != nil {
		return nil, errNoSymbol
	}
	return l, nil
}

func (l *winLib) call(name string, args ...uintptr) (uint32, error) {
	fn, ok := l.syms[name]
	if !ok {
		var err error
		if fn, err = syscall.GetProcAddress(l.h, name); err != nil {
			if name == "C_Finalize" || name == "C_CloseSession" || name == "C_FindObjectsFinal" {
				return 0, nil
			}
			return 0, fmt.Errorf("driver lacks %s", name)
		}
		l.syms[name] = fn
	}
	r, _, _ := syscall.SyscallN(fn, args...)
	return uint32(r), nil
}
func (l *winLib) close() {}
