//go:build windows

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os/exec"
	"strings"
)

// Tokens whose driver registers keys with Windows (CSP / minidriver) show up in the Windows certificate store while plugged in.
// This finds those even when we do not know the driver's file name. Software certificates (Microsoft providers) are skipped.
const psScript = `$ErrorActionPreference='SilentlyContinue'
$r=@(); Get-ChildItem Cert:\CurrentUser\My | ForEach-Object {
 $p=''; try{ $p=$_.PrivateKey.CspKeyContainerInfo.ProviderName }catch{}
 if(-not $p){ try{ $p=$_.PrivateKey.Key.Provider.Provider }catch{} }
 if(-not $p){ try{ $k=[System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($_); $p=$k.Key.Provider.Provider }catch{} }
 $r += [pscustomobject]@{ der=[Convert]::ToBase64String($_.RawData); prov=[string]$p }
}
ConvertTo-Json -InputObject @($r) -Compress`

func storeCerts() []CertOut {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript)
	hideWindow(cmd)
	var out bytes.Buffer
	cmd.Stdout = &out
	if cmd.Run() != nil {
		return nil
	}
	var rows []struct{ Der, Prov string }
	b := bytes.TrimSpace(out.Bytes())
	if len(b) == 0 || json.Unmarshal(b, &rows) != nil {
		return nil
	}
	var res []CertOut
	for _, r := range rows {
		p := strings.ToLower(r.Prov)
		if p == "" || (strings.HasPrefix(p, "microsoft") && !strings.Contains(p, "smart card")) {
			continue
		}
		der, err := base64.StdEncoding.DecodeString(r.Der)
		if err != nil {
			continue
		}
		if c, ok := describe(der, rawToken{Label: r.Prov, Model: r.Prov}, "Windows certificate store ("+r.Prov+")"); ok {
			res = append(res, c)
		}
	}
	return res
}
