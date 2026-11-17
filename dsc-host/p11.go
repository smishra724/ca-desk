package main

// Minimal read-only PKCS#11 client: lists tokens and their X.509 certificates.
// No login and no PIN are ever used; certificates are public objects.
// Struct layouts differ by platform (Windows packs 1-byte and CK_ULONG is 32-bit), so buffers are built by hand.

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"unsafe"
)

const (
	ckrOK                 = 0
	ckrAlreadyInitialized = 0x191
	ckfSerialSession      = 0x4
	ckaClass              = 0x0
	ckaValue              = 0x11
	ckoCertificate        = 0x1
	maxObjects            = 64
)

var ptrSize = int(unsafe.Sizeof(uintptr(0)))

type rawToken struct {
	Label, Manufacturer, Model, Serial string
	Certs                              [][]byte
}

type libFns interface {
	call(name string, args ...uintptr) (uint32, error)
	close()
}

func put(b []byte, off, size int, v uint64) {
	for i := 0; i < size; i++ {
		b[off+i] = byte(v >> (8 * i))
	}
}
func get(b []byte, off, size int) uint64 {
	var v uint64
	for i := 0; i < size; i++ {
		v |= uint64(b[off+i]) << (8 * i)
	}
	return v
}
func ptrOf(b []byte) uintptr {
	if len(b) == 0 {
		return 0
	}
	return uintptr(unsafe.Pointer(&b[0]))
}
func trimField(b []byte) string { return strings.TrimSpace(strings.Trim(string(b), "\x00")) }

func rvErr(fn string, rv uint32) error { return fmt.Errorf("%s failed (0x%X)", fn, rv) }

// probeLib loads one PKCS#11 module and returns every token that is plugged in, with its certificates.
func probeLib(path string) (toks []rawToken, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("driver crashed: %v", r)
		}
	}()
	lib, err := openLib(path)
	if err != nil {
		return nil, err
	}
	defer lib.close()
	ul := ulSize()
	rv, err := lib.call("C_Initialize", 0)
	if err != nil {
		return nil, err
	}
	if rv != ckrOK && rv != ckrAlreadyInitialized {
		return nil, rvErr("C_Initialize", rv)
	}
	defer lib.call("C_Finalize", 0)

	cnt := make([]byte, 8)
	if rv, err = lib.call("C_GetSlotList", 1, 0, ptrOf(cnt)); err != nil {
		return nil, err
	} else if rv != ckrOK {
		return nil, rvErr("C_GetSlotList", rv)
	}
	n := int(get(cnt, 0, ul))
	if n == 0 {
		return nil, nil
	}
	if n > 64 {
		n = 64
	}
	slots := make([]byte, (n+1)*ul)
	put(cnt, 0, ul, uint64(n))
	if rv, err = lib.call("C_GetSlotList", 1, ptrOf(slots), ptrOf(cnt)); err != nil {
		return nil, err
	} else if rv != ckrOK {
		return nil, rvErr("C_GetSlotList", rv)
	}
	n = int(get(cnt, 0, ul))
	for i := 0; i < n && i < 64; i++ {
		slot := uintptr(get(slots, i*ul, ul))
		t := rawToken{}
		info := make([]byte, 512)
		if rv, err = lib.call("C_GetTokenInfo", slot, ptrOf(info)); err == nil && rv == ckrOK {
			t.Label, t.Manufacturer, t.Model, t.Serial = trimField(info[0:32]), trimField(info[32:64]), trimField(info[64:80]), trimField(info[80:96])
		}
		certs, e := readCerts(lib, slot)
		if e != nil {
			err = e // keep going: another slot may work
			continue
		}
		t.Certs = certs
		toks = append(toks, t)
	}
	if len(toks) > 0 {
		err = nil
	}
	return toks, err
}

func readCerts(lib libFns, slot uintptr) (certs [][]byte, err error) {
	ul := ulSize()
	attrSz := ul + ptrSize + ul // type, pointer, length — no padding (packed on Windows, equal sizes on unix)
	hs := make([]byte, 8)
	rv, err := lib.call("C_OpenSession", slot, ckfSerialSession, 0, 0, ptrOf(hs))
	if err != nil {
		return nil, err
	}
	if rv != ckrOK {
		return nil, rvErr("C_OpenSession", rv)
	}
	h := uintptr(get(hs, 0, ul))
	defer lib.call("C_CloseSession", h)

	cls := make([]byte, 8)
	put(cls, 0, ul, ckoCertificate)
	tmpl := make([]byte, attrSz)
	put(tmpl, 0, ul, ckaClass)
	put(tmpl, ul, ptrSize, uint64(ptrOf(cls)))
	put(tmpl, ul+ptrSize, ul, uint64(ul))
	if rv, err = lib.call("C_FindObjectsInit", h, ptrOf(tmpl), 1); err != nil {
		return nil, err
	} else if rv != ckrOK {
		return nil, rvErr("C_FindObjectsInit", rv)
	}
	objs := make([]byte, maxObjects*ul)
	nb := make([]byte, 8)
	rv, err = lib.call("C_FindObjects", h, ptrOf(objs), maxObjects, ptrOf(nb))
	lib.call("C_FindObjectsFinal", h)
	runtime.KeepAlive(cls)
	runtime.KeepAlive(tmpl)
	if err != nil {
		return nil, err
	}
	if rv != ckrOK {
		return nil, rvErr("C_FindObjects", rv)
	}
	n := int(get(nb, 0, ul))
	if n > maxObjects {
		n = maxObjects
	}
	for i := 0; i < n; i++ {
		obj := uintptr(get(objs, i*ul, ul))
		a := make([]byte, attrSz)
		put(a, 0, ul, ckaValue)
		if rv, err = lib.call("C_GetAttributeValue", h, obj, ptrOf(a), 1); err != nil {
			return nil, err
		}
		if rv != ckrOK {
			continue
		}
		ln := int(get(a, ul+ptrSize, ul))
		if ln <= 0 || ln > 1<<20 {
			continue
		}
		val := make([]byte, ln)
		put(a, ul, ptrSize, uint64(ptrOf(val)))
		put(a, ul+ptrSize, ul, uint64(ln))
		rv, err = lib.call("C_GetAttributeValue", h, obj, ptrOf(a), 1)
		runtime.KeepAlive(val)
		if err != nil {
			return nil, err
		}
		if rv == ckrOK {
			got := int(get(a, ul+ptrSize, ul))
			if got > 0 && got <= ln {
				certs = append(certs, val[:got])
			}
		}
	}
	return certs, nil
}

var errNoSymbol = errors.New("not a PKCS#11 driver (C_Initialize not found)")
