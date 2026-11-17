package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"runtime"
)

// Chrome native messaging: each message is a 4-byte little-endian length followed by JSON.
func readMsg(r io.Reader) (map[string]any, error) {
	var n uint32
	if err := binary.Read(r, binary.LittleEndian, &n); err != nil {
		return nil, err
	}
	if n == 0 || n > 1<<20 {
		return nil, io.ErrUnexpectedEOF
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, err
	}
	m := map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return m, nil
}
func writeMsg(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, uint32(len(b))); err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}

func nativeLoop() {
	for {
		m, err := readMsg(os.Stdin)
		if err != nil {
			return
		}
		switch m["cmd"] {
		case "ping":
			writeMsg(os.Stdout, map[string]any{"ok": true, "version": version, "os": runtime.GOOS, "arch": runtime.GOARCH})
		case "read":
			writeMsg(os.Stdout, scanAll())
		default:
			writeMsg(os.Stdout, map[string]any{"ok": false, "error": "unknown command"})
		}
	}
}
