// Reads text from PDFs/images (pdf.js for digital PDFs, Tesseract OCR for scans/photos)
// and pulls master-data fields out of it. Everything runs in the browser; documents never
// leave the user's computer for OCR.

export const STATE_CODES = {
  '01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand','06':'Haryana',
  '07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh','13':'Nagaland',
  '14':'Manipur','15':'Mizoram','16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal','20':'Jharkhand',
  '21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh','24':'Gujarat','25':'Daman and Diu','26':'Dadra and Nagar Haveli and Daman and Diu',
  '27':'Maharashtra','29':'Karnataka','30':'Goa','31':'Lakshadweep','32':'Kerala','33':'Tamil Nadu','34':'Puducherry',
  '35':'Andaman and Nicobar Islands','36':'Telangana','37':'Andhra Pradesh','38':'Ladakh'
};
const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
  january:1,february:2,march:3,april:4,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };

// "Twenty-first day of September Two thousand twenty-two" → 2022-09-21 (Certificates of Incorporation write dates in words)
const UNITS = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19 };
const TENS = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
const ORD = { first:1, second:2, third:3, fourth:4, fifth:5, sixth:6, seventh:7, eighth:8, ninth:9, tenth:10, eleventh:11, twelfth:12, thirteenth:13, fourteenth:14, fifteenth:15, sixteenth:16, seventeenth:17, eighteenth:18, nineteenth:19, twentieth:20, thirtieth:30 };
function wordsToNum(w) {
  let total = 0, cur = 0;
  for (const x of w.toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean)) {
    if (x === 'and') continue;
    if (x in UNITS) cur += UNITS[x]; else if (x in TENS) cur += TENS[x]; else if (x in ORD) cur += ORD[x];
    else if (x === 'hundred') cur *= 100; else if (x === 'thousand') { total += cur * 1000; cur = 0; } else return NaN;
  }
  return total + cur;
}
export function wordDate(text) {
  const m = String(text || '').replace(/\s+/g, ' ').match(/\b((?:twenty|thirty)?[\s-]?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth))\s+day\s+of\s+([A-Za-z]+)\s*,?\s+((?:(?:one|two)\s+thousand|nineteen|twenty)[A-Za-z\s-]*?)(?=\s+(?:under|at|given|$)|[.,;]|$)/i);
  if (!m) return '';
  const d = wordsToNum(m[1]), mo = MONTHS[m[2].toLowerCase()];
  let y = m[3].trim().toLowerCase();
  y = /thousand/.test(y) ? wordsToNum(y) : /^nineteen\s+/.test(y) ? 1900 + wordsToNum(y.replace(/^nineteen\s+/, '')) : /^twenty\s+/.test(y) && !/twenty\s*$/.test(y) ? 2000 + wordsToNum(y.replace(/^twenty\s+/, '')) : NaN;
  if (!d || !mo || !(y > 1900 && y < 2100)) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// State from free text (address) — the last state name mentioned wins
const STATE_ALIASES = { 'new delhi': 'Delhi', 'nct of delhi': 'Delhi', 'orissa': 'Odisha', 'pondicherry': 'Puducherry', 'uttaranchal': 'Uttarakhand', 'tamilnadu': 'Tamil Nadu', 'u.p.': 'Uttar Pradesh', 'jammu & kashmir': 'Jammu and Kashmir' };
export function stateFromText(t) {
  const s = ' ' + String(t || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  let best = '', at = -1;
  for (const n of [...Object.values(STATE_CODES), ...Object.keys(STATE_ALIASES)]) {
    const i = s.lastIndexOf(n.toLowerCase().replace(/ and /g, ' and '));
    if (i > at && /[^a-z]/.test(s[i - 1] || ' ') && /[^a-z]/.test(s[i + n.length] || ' ')) { at = i; best = STATE_ALIASES[n.toLowerCase()] || n; }
  }
  return best;
}
// CIN characters 7–8 are the state of the registered office (e.g. U72900DL2020PTC123456 → DL)
const CIN_STATE = { AN: 'Andaman and Nicobar Islands', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar', CH: 'Chandigarh', CT: 'Chhattisgarh', CG: 'Chhattisgarh', DL: 'Delhi', DN: 'Dadra and Nagar Haveli and Daman and Diu', DD: 'Dadra and Nagar Haveli and Daman and Diu', GA: 'Goa', GJ: 'Gujarat', HR: 'Haryana', HP: 'Himachal Pradesh', JK: 'Jammu and Kashmir', JH: 'Jharkhand', KA: 'Karnataka', KL: 'Kerala', LA: 'Ladakh', LD: 'Lakshadweep', MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur', ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OR: 'Odisha', OD: 'Odisha', PY: 'Puducherry', PB: 'Punjab', RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TG: 'Telangana', TS: 'Telangana', TR: 'Tripura', UP: 'Uttar Pradesh', UR: 'Uttarakhand', UK: 'Uttarakhand', WB: 'West Bengal' };
export const stateFromCIN = cin => /^[LU]\d{5}[A-Z]{2}/.test(cin || '') ? CIN_STATE[cin.slice(6, 8)] || '' : '';

export function toISO(s) {
  if (!s) return '';
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
  m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  m = s.match(/(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/,]+(\d{4})/) || s.match(/(\d{1,2})(?:st|nd|rd|th)?\s*(?:day\s+of\s+)?([A-Za-z]{3,9}),?\s*(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return '';
}

function constitutionFrom(s) {
  s = (s || '').toLowerCase();
  if (/limited liability partnership|\bllp\b/.test(s)) return 'LLP';
  if (/one person/.test(s)) return 'OPC';
  if (/private limited/.test(s)) return 'Private Ltd';
  if (/public limited/.test(s)) return 'Public Ltd';
  if (/partnership/.test(s)) return 'Partnership Firm';
  if (/propriet/.test(s)) return 'Proprietorship';
  if (/hindu undivided|\bhuf\b/.test(s)) return 'HUF';
  if (/trust/.test(s)) return 'Trust';
  if (/society/.test(s)) return 'Society';
  return '';
}
const constitutionFromPAN = pan => ({ P:'Proprietorship', F:'Partnership Firm', C:'Private Ltd', H:'HUF', T:'Trust', A:'AOP/BOI', B:'AOP/BOI' })[(pan||'')[3]] || '';

export function detectType(t) {
  const u = t.toUpperCase();
  if (/MASTER DATA|ROC\s*(?:NAME|\(|CODE)|REGISTRATION NUMBER[\s\S]{0,200}DATE OF INCORPORATION|DIRECTOR\/SIGNATORY|DIRECTORS?\s*\/?\s*SIGNATORY DETAILS|DESIGNATED PARTNER DETAILS/.test(u) && /DATE OF INCORPORATION|DATE OF APPOINTMENT|BEGIN DATE/.test(u)) return 'MCA Master Data';
  if (/REG-0?6|REGISTRATION CERTIFICATE|GOODS AND SERVICES TAX/.test(u)) return 'GST Certificate';
  if (/CERTIFICATE OF INCORPORATION/.test(u)) return /LIMITED LIABILITY PARTNERSHIP|LLPIN/.test(u) ? 'LLP Incorporation' : 'Certificate of Incorporation';
  if (/TAX DEDUCTION (AND COLLECTION )?ACCOUNT NUMBER|\bTAN\b.*ALLOT/.test(u)) return 'TAN Allotment';
  if (/PARTNERSHIP DEED|DEED OF PARTNERSHIP|LLP AGREEMENT/.test(u)) return 'Partnership Deed / LLP Agreement';
  if (/AADHAAR|UNIQUE IDENTIFICATION/.test(u)) return 'Aadhaar';
  if (/PERMANENT ACCOUNT NUMBER|INCOME TAX DEPARTMENT|INCOMETAX DEPARTMENT/.test(u)) return 'PAN Card';
  return 'Other';
}

export function parse(text) {
  const t = String(text || '').replace(/\r/g, '');
  const U = t.toUpperCase();
  const lines = t.split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const type = detectType(t);
  const f = {};

  const after = re => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) {
        let v = lines[i].slice(m.index + m[0].length).replace(/^[\s:.\-–|]+/, '').trim();
        if (!v && lines[i + 1]) v = lines[i + 1];
        return v;
      }
    }
    return '';
  };
  // collect a multi-line block after a label until a stop pattern
  const block = (re, stop, max = 4) => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      const parts = [];
      const first = lines[i].slice(m.index + m[0].length).replace(/^[\s:.\-–|]+/, '').trim();
      if (first) parts.push(first);
      for (let j = i + 1; j < lines.length && parts.length < max; j++) {
        if (stop.test(lines[j])) break;
        parts.push(lines[j]);
      }
      return parts.join(', ').replace(/\s*,\s*,/g, ',').trim();
    }
    return '';
  };

  // Identifiers (regex on the whole text)
  const gstin = U.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/);
  if (gstin) { f.gstin = gstin[0]; f.pan = gstin[0].slice(2, 12); f.state = STATE_CODES[gstin[0].slice(0, 2)] || ''; }
  if (!f.pan) { const p = U.match(/\b[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z]\b/); if (p) f.pan = p[0]; }
  const tan = U.match(/\b[A-Z]{4}\d{5}[A-Z]\b/); if (tan) f.tan = tan[0];
  const cin = U.match(/\b[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}\b/); if (cin) f.cin = cin[0];
  if (!f.cin && /LLPIN|LIMITED LIABILITY PARTNERSHIP/.test(U)) { const l = U.match(/\b[A-Z]{3}-\d{4}\b/); if (l) f.cin = l[0]; }
  if (type === 'Aadhaar') { const a = t.match(/\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/); if (a) f.aadhaar = a[0].replace(/\s/g, ''); }
  const email = t.match(/[\w.+-]+@[\w-]+\.[\w.]+/); if (email) f.email = email[0].toLowerCase();
  const mob = t.match(/(?:\+91[\s-]?)?\b[6-9]\d{9}\b/); if (mob) f.mobile = mob[0].replace(/\D/g, '').slice(-10);

  if (type === 'GST Certificate') {
    const v = after(/legal name(?: of (?:the )?business)?/i); if (v) f.name = v;
    const tn = after(/trade name(?:,? if any)?/i); if (tn && !/^\d+\.|^constitution/i.test(tn)) f.tradeName = tn;
    const cons = constitutionFrom(after(/constitution of business/i)); if (cons) f.constitution = cons;
    const addr = block(/address of principal place of\s*(?:business)?/i, /^\s*\d{1,2}\s*[.)]|date of liability|period of validity|type of registration/i);
    if (addr) f.address = addr.replace(/^business\s*,?\s*/i, '');
    const dl = toISO(after(/date of liability/i)); if (dl) f.gstRegDate = dl;
    const typ = after(/type of registration/i); if (/composition/i.test(typ)) f.gstFreq = 'Composition';
    // Annexure B — partners / directors
    const people = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^name\b/i.test(lines[i]) && i + 1 < lines.length) {
        const nm = lines[i].replace(/^name\s*[:\-]?\s*/i, '').trim() || lines[i + 1];
        const near = [];
        for (let j = i + 1; j < Math.min(i + 4, lines.length) && !/^name\b/i.test(lines[j]); j++) near.push(lines[j]);
        const des = near.join(' ').match(/designation\s*\/?\s*status\s*[:\-]?\s*([A-Za-z ]+)/i);
        if (nm && nm.length < 80 && !/legal name|trade name/i.test(nm)) people.push(des ? `${nm} (${des[1].trim()})` : nm);
      }
    }
    if (people.length) f.people = [...new Set(people)].join('\n');
  }

  if (type === 'Certificate of Incorporation' || type === 'LLP Incorporation') {
    const m = t.replace(/\n/g, ' ').match(/certify that\s+(.+?)\s+is\s+incorporated/i);
    if (m) f.name = m[1].replace(/\s+/g, ' ').trim();
    const d = t.replace(/\n/g, ' ').match(/(?:on this|on)\s+(\d{1,2}(?:st|nd|rd|th)?\s*(?:day\s+of\s+)?[A-Za-z]+,?\s*\d{4}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i);
    if (d) f.doi = toISO(d[1]);
    if (!f.doi) f.doi = wordDate(t);
    if (!f.doi) { const n = t.match(/\b\d{2}[\/\-.]\d{2}[\/\-.]\d{4}\b/); if (n) f.doi = toISO(n[0]); }
    // newer certificates print the registered office: "Mailing Address as per record available in Registrar of Companies office:"
    const ma = block(/mailing address as per record available in registrar of companies office\s*:?/i, /^\*|^note|digitally signed|^signature|^registrar of companies|^dated|^given under/i, 6);
    if (ma) {
      let parts = ma.split(/\s*,\s*/);
      if (f.name && parts[0] && parts[0].replace(/\W/g, '').toUpperCase() === f.name.replace(/\W/g, '').toUpperCase()) parts = parts.slice(1);
      f.address = parts.join(', ').replace(/^,\s*/, '');
    }
    if (f.cin && !f.state) f.state = stateFromCIN(f.cin);
    const cons = constitutionFrom(t); if (cons) f.constitution = cons;
    else if (type === 'LLP Incorporation') f.constitution = 'LLP';
  }

  if (type === 'Aadhaar') {
    const dob = t.match(/(?:DOB|Date of Birth|जन्म तिथि)[^0-9]{0,12}(\d{2}[\/\-.]\d{2}[\/\-.]\d{4})/i); if (dob) f.doi = toISO(dob[1]);
    const ad = block(/^address\s*:?|पता\s*:?/i, /\b\d{4}\s\d{4}\s\d{4}\b|^vid|help@|www\.|uidai/i, 5);
    if (ad) f.address = ad.replace(/^(s\/o|d\/o|w\/o|c\/o)[^,]*,\s*/i, '');
  }

  if (type === 'PAN Card') {
    const nm = after(/^(?:name|नाम\s*\/\s*name)\b/i) || after(/\/\s*name\b/i);
    if (nm && !/father/i.test(nm)) f.name = nm;
    const d = t.match(/\b\d{2}\/\d{2}\/\d{4}\b/); if (d) f.doi = toISO(d[0]);
  }

  if (type === 'TAN Allotment') {
    const nm = after(/name of (?:the )?deductor/i) || after(/^name\b/i); if (nm) f.name = nm;
  }

  if (!f.constitution && f.pan) f.constitution = constitutionFromPAN(f.pan);
  if (type === 'MCA Master Data') Object.assign(f, parseMasterData(t).fields);
  if (f.address && !f.pincode) { const pins = f.address.replace(/\s(?=\d{3}\b)/g, '').match(/\b[1-9]\d{5}\b/g); if (pins) f.pincode = pins[pins.length - 1]; }
  if (f.address && !f.state) f.state = stateFromText(f.address);
  if (!f.state && f.cin) f.state = stateFromCIN(f.cin);
  for (const k of Object.keys(f)) if (!f[k]) delete f[k];
  const out = { type, fields: f, text: t };
  if (type === 'MCA Master Data') out.directors = parseMasterData(t).directors;
  return out;
}

/* ---------- MCA "Company / LLP Master Data" (PDF print, saved web page, or text copied from the page) ---------- */
const DESIG = /(managing director|whole[\s-]?time director|additional director|alternate director|nominee director|independent director|designated partner|nominee for body corporate|director|partner|company secretary|chief financial officer|\bcfo\b|\bceo\b|manager|wholetime director)/i;
const DATE_RE = /\b\d{1,2}[\/\-.](?:\d{1,2}|[A-Za-z]{3})[\/\-.]\d{4}\b/g;
export function parseMasterData(input) {
  // input: plain text, or rows of cells [[...], ...] from an HTML table
  const text = Array.isArray(input) ? input.map(r => r.join('\t')).join('\n') : String(input || '');
  const lines = text.replace(/\r/g, '').split('\n').map(s => s.replace(/[ \u00a0]+/g, ' ').trim()).filter(Boolean);
  const f = {};
  const val = re => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re); if (!m) continue;
      let v = lines[i].slice(m.index + m[0].length).replace(/^\s*\((?:rs\.?|in rs\.?|₹|inr)\)/i, '').replace(/^[\s:\t|\-–]+/, '').trim();
      if (!v && lines[i + 1]) v = lines[i + 1];
      return v.split('\t')[0].trim();
    }
    return '';
  };
  const cin = text.toUpperCase().match(/\b[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}\b/) || text.toUpperCase().match(/\b[A-Z]{3}-\d{4}\b/);
  if (cin) f.cin = cin[0];
  const name = val(/^(?:company|llp)\s*name/i); if (name && !/^date/i.test(name)) f.name = name.toUpperCase();
  const doi = toISO(val(/^date of incorporation/i)); if (doi) f.doi = doi;
  const em = val(/^email\s*(?:id|address)?/i).match(/[\w.+-]+@[\w-]+\.[\w.]+/); if (em) f.email = em[0].toLowerCase();
  // registered address can run over several lines until the next label
  const ai = lines.findIndex(l => /^registered (?:office )?address/i.test(l));
  if (ai >= 0) {
    const parts = [lines[ai].replace(/^registered (?:office )?address\s*[:\t|\-–]*/i, '')];
    for (let j = ai + 1; j < Math.min(ai + 5, lines.length); j++) { if (/^(address at which|listed|email|category|whether|roc|date of|class|sub ?category|company status|authori[sz]ed|paid up|main division|active compliance|\*)/i.test(lines[j])) break; parts.push(lines[j]); }
    f.address = parts.join(', ').replace(/\t/g, ' ').replace(/\s*,\s*,/g, ',').replace(/^,\s*|,\s*$/g, '').trim();
  }
  const cls = val(/^class of company/i), cat = val(/^category of company/i), sub = val(/^sub\s?-?category/i);
  if (/llp/i.test(text.slice(0, 400)) && /^[A-Z]{3}-\d{4}$/.test(f.cin || '')) f.constitution = 'LLP';
  else if (/private/i.test(cls)) f.constitution = /one person/i.test(cls + cat + sub + text.slice(0, 2000)) ? 'OPC' : 'Private Ltd';
  else if (/public/i.test(cls)) f.constitution = 'Public Ltd';
  const st = val(/^(?:company|llp)\s*status/i); if (st) f.mcaStatus = st;
  const agm = toISO(val(/date of last agm/i)); if (agm) f.lastAgm = agm;
  const bs = toISO(val(/date of (?:latest )?balance sheet/i)); if (bs) f.lastBs = bs;
  const auth = val(/^authori[sz]ed capital/i).replace(/[^\d.]/g, ''); if (auth) f.authCap = auth;
  const paid = val(/^paid\s*up capital|^total obligation of contribution/i).replace(/[^\d.]/g, ''); if (paid) f.paidCap = paid;
  const roc = val(/^roc\s*(?:name|code)?/i); if (roc && roc.length < 40) f.roc = roc;
  if (f.address) { const pins = f.address.replace(/\s(?=\d{3}\b)/g, '').match(/\b[1-9]\d{5}\b/g); if (pins) f.pincode = pins[pins.length - 1]; f.state = stateFromText(f.address) || stateFromCIN(f.cin); }
  else if (f.cin) f.state = stateFromCIN(f.cin);
  // directors / designated partners: rows carrying an 8-digit DIN/DPIN (or a PAN for KMP)
  const start = lines.findIndex(l => /director|signatory|designated partner|partner details/i.test(l) && /detail|signator/i.test(l));
  const rows = [];
  let cur = null;
  const body = start >= 0 ? lines.slice(start + 1) : lines;
  for (const l of body) {
    if (/^(charges|index of charges|establishment|company status|\*|note|disclaimer)/i.test(l) && rows.length) break;
    const id = l.match(/\b\d{8}\b/) || l.toUpperCase().match(/\b[A-Z]{5}\d{4}[A-Z]\b/);
    if (id && !/^(cin|llpin|registration|roc)/i.test(l)) { cur = { raw: l, id: id[0].toUpperCase() }; rows.push(cur); }
    else if (cur && !/din\s*\/?\s*pan|^s\.?\s*no|^sl\.?\s*no|designation|date of appointment/i.test(l)) cur.raw += '\t' + l;
  }
  const directors = [];
  for (const r of rows) {
    const dates = (r.raw.match(DATE_RE) || []).map(toISO).filter(Boolean);
    const des = (r.raw.match(DESIG) || [])[1] || '';
    let nm = r.raw.replace(r.id, ' ').replace(DATE_RE, ' ').replace(DESIG, ' ').replace(/\b(promoter|professional|independent|nominee|executive|non[- ]executive|ministry of corporate affairs|mca services|page \d+ of \d+|\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?)\b/gi, ' ').replace(/\b(yes|no|-|na|n\/a|whole|time)\b/gi, ' ').replace(/^\s*\d{1,3}[.)]?\s/, ' ').replace(/\b\d+\b/g, ' ');
    nm = nm.split('\t').map(x => x.replace(/[^A-Za-z .'-]/g, ' ').replace(/\s+/g, ' ').trim()).filter(x => x.length > 2).sort((a, b) => b.length - a.length)[0] || '';
    if (!nm) continue;
    directors.push({ name: nm.toUpperCase(), din: /^\d{8}$/.test(r.id) ? r.id : '', pan: /^\d{8}$/.test(r.id) ? '' : r.id, designation: des ? des.replace(/\b\w/g, c => c.toUpperCase()) : '', appointed: dates[0] || '', ceased: dates[1] || '' });
  }
  const seen = new Set();
  return { fields: f, directors: directors.filter(d => { const k = d.din || d.pan || d.name; if (seen.has(k)) return false; seen.add(k); return true; }) };
}
// a saved MCA web page (.html): read its tables cell by cell
export function masterDataFromHtml(html) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  const rows = [...d.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('th,td')].map(c => c.textContent.replace(/\s+/g, ' ').trim()));
  const extra = rows.length ? '' : d.body?.innerText || d.body?.textContent || '';
  return parseMasterData(rows.length ? rows.map(r => r.join('\t')).join('\n') + '\n' + extra : extra);
}

/* ---------- browser-only text extraction ---------- */

async function ocr(img, onProgress) {
  const res = await window.Tesseract.recognize(img, 'eng', {
    logger: m => m.status === 'recognizing text' && onProgress && onProgress(`Reading text… ${Math.round(m.progress * 100)}%`)
  });
  return res.data.text;
}

export async function extractText(file, onProgress = () => {}, opts = {}) {
  const maxOcr = opts.maxOcrPages ?? 4;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) {
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    onProgress('Opening PDF…');
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = '';
    for (let i = 1; i <= Math.min(pdf.numPages, opts.maxTextPages ?? 999); i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      // rebuild lines from y-positions
      let lastY = null;
      for (const it of tc.items) {
        const y = Math.round(it.transform[5]);
        if (lastY !== null && Math.abs(y - lastY) > 3) text += '\n'; else if (lastY !== null) text += ' ';
        text += it.str; lastY = y;
        if (it.hasEOL) { text += '\n'; lastY = null; }
      }
      text += '\n';
    }
    if (text.replace(/\s/g, '').length > 60) return text;
    // scanned PDF → OCR the first pages
    let out = '';
    if (!maxOcr) return text;
    for (let i = 1; i <= Math.min(pdf.numPages, maxOcr); i++) {
      onProgress(`Scanning page ${i}…`);
      const pg = await pdf.getPage(i);
      const vp = pg.getViewport({ scale: 2.2 });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      out += await ocr(c, onProgress) + '\n';
    }
    return out;
  }
  if (file.type.startsWith('image/')) return ocr(file, onProgress);
  if (/\.(txt|csv)$/i.test(file.name) || file.type.startsWith('text/plain')) return file.text();
  if (/\.(html?|mht)$/i.test(file.name) || file.type === 'text/html') { const d = new DOMParser().parseFromString(await file.text(), 'text/html'); return [...d.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('th,td')].map(c => c.textContent.replace(/\s+/g, ' ').trim()).join('\t')).join('\n') + '\n' + (d.body?.textContent || ''); }
  throw new Error('Upload a PDF or an image (JPG/PNG).');
}

export async function extractFromFile(file, onProgress) {
  const text = await extractText(file, onProgress);
  return parse(text);
}

/* ---------- MCA master data PDF: read the director table by column position ----------
   Printed MCA pages wrap names over several lines and centre other cells vertically, so plain
   text loses which name goes with which DIN. Here every word keeps its x/y on the page:
   columns come from the header (DIN/PAN, Name, Designation, Category, Date of Appointment, Cessation),
   rows from each DIN, and every other word goes to the nearest DIN row in its column. */
const COLDEF = [['din', /^(din|dpin)\s*\/?\s*(pan)?$|^din\/pan$|^din$/i], ['name', /^(full\s*)?name$/i], ['desig', /^designation$/i], ['cat', /^category$/i],
  ['appt', /appointment|^begin|^date of$/i], ['cess', /cessation|^end\s*date/i], ['sign', /^signatory$|^surrendered/i]];
export async function mcaDirectorsFromPdf(file) {
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = []; let cols = null;
  for (let p = 1; p <= pdf.numPages; p++) {
    const items = (await (await pdf.getPage(p)).getTextContent()).items.map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width })).filter(i => i.s);
    // header of the director table on this page
    const sec = items.filter(i => /director|signatory|designated partner/i.test(i.s) && /detail|signator/i.test(i.s)).sort((a, b) => b.y - a.y)[0];
    const dinH = items.filter(i => /^(din|dpin)\b/i.test(i.s) && (!sec || i.y <= sec.y)).sort((a, b) => b.y - a.y)[0];
    let top = Infinity;
    if (dinH) {
      const hy = dinH.y, hs = items.filter(i => Math.abs(i.y - hy) <= 14);
      cols = [];
      for (const h of hs) { const d = COLDEF.find(([, re]) => re.test(h.s)); if (d && !cols.some(c => c.k === d[0])) cols.push({ k: d[0], x: h.x }); }
      if (!cols.some(c => c.k === 'din')) cols.push({ k: 'din', x: dinH.x });
      cols.sort((a, b) => a.x - b.x);
      top = Math.min(...hs.map(i => i.y)) - 2;
    } else if (!cols) continue;
    const colOf = x => { let k = cols[0].k; for (let i = 0; i < cols.length; i++) { const lo = i ? (cols[i - 1].x + cols[i].x) / 2 - 2 : -1e9; if (x >= lo) k = cols[i].k; } return k; };
    const body = items.filter(i => i.y < top);
    const anchors = body.filter(i => colOf(i.x) === 'din' && (/^\d{8}$/.test(i.s) || /^[A-Z]{5}\d{4}[A-Z]$/.test(i.s))).sort((a, b) => b.y - a.y);
    if (!anchors.length) { if (dinH) cols = cols; continue; }
    const gap = anchors.length > 1 ? Math.min(...anchors.slice(1).map((a, i) => anchors[i].y - a.y)) : 40;
    const half = Math.max(12, gap / 2 + 1), lowest = anchors[anchors.length - 1].y - half;
    const rows = anchors.map(a => ({ a, cells: {} }));
    for (const it of body) {
      if (it.y < lowest || it.y > anchors[0].y + half) continue;
      if (rows.some(r => r.a === it)) continue;
      const k = colOf(it.x), r = rows.reduce((b, r) => Math.abs(r.a.y - it.y) < Math.abs(b.a.y - it.y) ? r : b, rows[0]);
      if (Math.abs(r.a.y - it.y) > half) continue;
      (r.cells[k] ||= []).push(it);
    }
    for (const r of rows) {
      const txt = k => (r.cells[k] || []).sort((a, b) => b.y - a.y || a.x - b.x).map(i => i.s).join(' ').replace(/\s+/g, ' ').trim();
      const date = k => toISO((txt(k).match(/\d{1,2}[\/\-.](?:\d{1,2}|[A-Za-z]{3})[\/\-.]\d{4}/) || [''])[0]);
      const name = txt('name').replace(/[^A-Za-z .'-]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!name) continue;
      out.push({ name: name.toUpperCase(), din: /^\d{8}$/.test(r.a.s) ? r.a.s : '', pan: /^\d{8}$/.test(r.a.s) ? '' : r.a.s, designation: txt('desig').replace(/\s+/g, ' '), category: txt('cat'), appointed: date('appt'), ceased: date('cess') });
    }
  }
  const seen = new Set();
  return out.filter(d => { const k = d.din || d.pan || d.name; if (seen.has(k)) return false; seen.add(k); return true; });
}
