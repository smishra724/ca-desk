package main

import (
	"crypto/sha1"
	"crypto/x509"
	"encoding/hex"
	"strings"
	"time"
)

type CertOut struct {
	Holder     string `json:"holder"`
	Org        string `json:"org,omitempty"`
	Email      string `json:"email,omitempty"`
	IssuerName string `json:"issuerName"`       // issuer as written in the certificate
	Issuer     string `json:"issuer,omitempty"` // mapped to CA Desk's issuer list
	ValidFrom  string `json:"validFrom"`        // YYYY-MM-DD (India time)
	ValidTo    string `json:"validTo"`
	CertSerial string `json:"certSerial"`
	Thumbprint string `json:"thumbprint"`
	Usage      string `json:"usage"` // signing | encryption | both
	TokenLabel string `json:"tokenLabel,omitempty"`
	TokenSer   string `json:"tokenSerial,omitempty"`
	TokenModel string `json:"tokenModel,omitempty"`
	Token      string `json:"token,omitempty"` // mapped to CA Desk's token list
	Source     string `json:"source"`
	Expired    bool   `json:"expired"`
}

var ist = time.FixedZone("IST", 5*3600+1800)

var issuerMap = []struct{ key, name string }{
	{"emudhra", "eMudhra"}, {"capricorn", "Capricorn"}, {"vsign", "Vsign (Verasys)"}, {"verasys", "Vsign (Verasys)"}, {"(n)code", "Vsign (Verasys)"},
	{"pantasign", "Pantasign"}, {"xtratrust", "XtraTrust"}, {"xtra trust", "XtraTrust"}, {"idsign", "IDSign"}, {"sify", "Sify"}, {"nsdl", "NSDL"}, {"e-mudhra", "eMudhra"},
}
var tokenMap = []struct{ key, name string }{
	{"epass2003", "ePass 2003"}, {"epass 2003", "ePass 2003"}, {"epass", "ePass 2003"}, {"proxkey", "ProxKey"}, {"wd proxkey", "WD ProxKey"}, {"watchdata", "ProxKey"},
	{"mtoken", "mToken"}, {"longmai", "mToken"}, {"hypersecu", "HyperSecu"}, {"hyp2003", "HyperSecu"}, {"hyperpki", "HyperSecu"}, {"trustkey", "Trust Key"}, {"trust key", "Trust Key"},
	{"feitian", "ePass 2003"},
}

func mapName(list []struct{ key, name string }, in ...string) string {
	s := strings.ToLower(strings.Join(in, " "))
	for _, m := range list {
		if strings.Contains(s, m.key) {
			return m.name
		}
	}
	return ""
}

func describe(der []byte, t rawToken, source string) (CertOut, bool) {
	c, err := x509.ParseCertificate(der)
	if err != nil || c.IsCA {
		return CertOut{}, false // skip CA certificates and anything that is not X.509
	}
	h := sha1.Sum(der)
	o := CertOut{
		Holder:     c.Subject.CommonName,
		IssuerName: strings.TrimSpace(c.Issuer.CommonName),
		ValidFrom:  c.NotBefore.In(ist).Format("2006-01-02"),
		ValidTo:    c.NotAfter.In(ist).Format("2006-01-02"),
		CertSerial: strings.ToLower(c.SerialNumber.Text(16)),
		Thumbprint: hex.EncodeToString(h[:]),
		TokenLabel: t.Label, TokenSer: t.Serial, TokenModel: strings.TrimSpace(t.Manufacturer + " " + t.Model),
		Source:  source,
		Expired: time.Now().After(c.NotAfter),
	}
	if len(c.Subject.Organization) > 0 {
		o.Org = c.Subject.Organization[0]
	}
	if o.Holder == "" && o.Org != "" {
		o.Holder = o.Org
	}
	if len(c.EmailAddresses) > 0 {
		o.Email = c.EmailAddresses[0]
	}
	iss := append([]string{c.Issuer.CommonName}, c.Issuer.Organization...)
	o.Issuer = mapName(issuerMap, iss...)
	o.Token = mapName(tokenMap, t.Manufacturer, t.Model, t.Label)
	sig, enc := c.KeyUsage&x509.KeyUsageDigitalSignature != 0 || c.KeyUsage&x509.KeyUsageContentCommitment != 0, c.KeyUsage&(x509.KeyUsageKeyEncipherment|x509.KeyUsageDataEncipherment) != 0
	switch {
	case sig && enc:
		o.Usage = "both"
	case enc:
		o.Usage = "encryption"
	default:
		o.Usage = "signing"
	}
	return o, true
}
