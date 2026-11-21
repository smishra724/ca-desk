// Reading DSC certificates: from the CA Desk DSC reader (plugged-in tokens, via the extension) or from an exported
// certificate file (.cer / .crt / .pem) — and turning one into a DSC register entry.

// tiny DER reader for X.509 certificates
function tlv(b, i) {
  const tag = b[i]; let len = b[i + 1], o = i + 2;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let k = 0; k < n; k++) len = len * 256 + b[o + k]; o += n; }
  return { tag, start: o, end: o + len, next: o + len };
}
const kids = (b, t) => { const out = []; for (let i = t.start; i < t.end;) { const c = tlv(b, i); out.push(c); i = c.next; } return out; };
const oid = (b, t) => { const v = b.subarray(t.start, t.end), out = [Math.floor(v[0] / 40), v[0] % 40]; let n = 0; for (let i = 1; i < v.length; i++) { n = n * 128 + (v[i] & 0x7f); if (!(v[i] & 0x80)) { out.push(n); n = 0; } } return out.join('.'); };
const str = (b, t) => new TextDecoder(t.tag === 0x1e ? 'utf-16be' : 'utf-8').decode(b.subarray(t.start, t.end));
const NAMES = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.8': 'S', '2.5.4.17': 'PostalCode', '2.5.4.6': 'C', '2.5.4.65': 'pseudonym' };
function name(b, t) { const o = {}; for (const set of kids(b, t)) for (const seq of kids(b, set)) { const [k, v] = kids(b, seq); const key = NAMES[oid(b, k)]; if (key) o[key] = str(b, v); } return o; }
function time(b, t) { const s = str(b, t); const y = t.tag === 0x17 ? (+s.slice(0, 2) < 50 ? '20' : '19') + s.slice(0, 2) : s.slice(0, 4), r = t.tag === 0x17 ? s.slice(2) : s.slice(4); return `${y}-${r.slice(0, 2)}-${r.slice(2, 4)}`; }
export async function parseCertFile(file) {
  let b = new Uint8Array(await file.arrayBuffer());
  const txt = new TextDecoder().decode(b.slice(0, 64));
  if (/-----BEGIN/.test(new TextDecoder().decode(b))) { const p = new TextDecoder().decode(b).match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/); if (!p) throw new Error('No certificate in this file.'); b = Uint8Array.from(atob(p[1].replace(/\s+/g, '')), c => c.charCodeAt(0)); }
  else if (/^MII/.test(txt)) b = Uint8Array.from(atob(new TextDecoder().decode(b).replace(/\s+/g, '')), c => c.charCodeAt(0));
  const cert = tlv(b, 0), [tbs] = kids(b, cert); let f = kids(b, tbs);
  if (f[0].tag === 0xa0) f = f.slice(1);
  const serial = [...b.subarray(f[0].start, f[0].end)].map(x => x.toString(16).padStart(2, '0')).join('').replace(/^00/, '').toUpperCase();
  const issuer = name(b, f[2]), [nb, na] = kids(b, f[3]), subject = name(b, f[4]);
  const thumb = [...new Uint8Array(await crypto.subtle.digest('SHA-1', b.subarray(0, cert.next)))].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { thumb, serial, cn: subject.CN || '', o: subject.O || '', ou: subject.OU || '', st: subject.S || '', pin: subject.PostalCode || '', icn: issuer.CN || '', io: issuer.O || '', from: time(b, nb), to: time(b, na), provider: '', onToken: false, fromFile: true };
}

// certificate → DSC register fields
export function certToDsc(c) {
  const iss = `${c.io} ${c.icn}`;
  const issuer = /mudhra/i.test(iss) ? 'eMudhra' : /capricorn/i.test(iss) ? 'Capricorn' : /verasys|vsign/i.test(iss) ? 'Vsign (Verasys)' : /panta/i.test(iss) ? 'Pantasign' : /xtra/i.test(iss) ? 'XtraTrust' : /idsign/i.test(iss) ? 'IDSign' : /sify|safescrypt/i.test(iss) ? 'Sify' : /nsdl|protean/i.test(iss) ? 'NSDL' : 'Other';
  const p = c.provider || '';
  const token = /epass/i.test(p) ? 'ePass 2003' : /watchdata|proxkey/i.test(p) ? 'WD ProxKey' : /mtoken/i.test(p) ? 'mToken' : /hyper/i.test(p) ? 'HyperSecu' : /trust/i.test(p) ? 'Trust Key' : p ? 'Other' : '';
  const org = c.o && !/^personal$/i.test(c.o) && !/^(individual|na)$/i.test(c.o);
  const cls = /dgft/i.test(iss + c.ou) ? 'Class 3 – DGFT' : org ? 'Class 3 – Organisation' : /encrypt/i.test(iss + c.ou) ? 'Class 3 – Signing & Encryption' : 'Class 3 – Signing';
  return { holder: c.cn.toUpperCase(), issuer, token, cls, validFrom: c.from, validTo: c.to, certThumb: c.thumb, certSerial: c.serial, certOrg: org ? c.o : '' };
}
