// CA Desk DSC helper — reads the certificate(s) on a plugged-in DSC token and hands them to the CA Desk Helper extension.
// It never asks for, reads or stores the token PIN.
package main

import (
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	a := os.Args[1:]
	switch {
	case len(a) >= 2 && a[0] == "--probe":
		probeMain(a[1])
	case len(a) >= 1 && a[0] == "--version":
		fmt.Println(version)
	case len(a) >= 1 && a[0] == "--scan": // for troubleshooting: run in a terminal / command prompt
		b, _ := json.MarshalIndent(scanAll(), "", "  ")
		fmt.Println(string(b))
	default:
		nativeLoop()
	}
}
