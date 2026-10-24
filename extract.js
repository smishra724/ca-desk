// Reads text from PDFs/images (pdf.js for digital PDFs, Tesseract OCR for scans/photos)
// and pulls master-data fields out of it. Everything runs in the browser; documents never
// leave the user's computer for OCR.

const STATE_CODES = {
  '01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand','06':'Haryana',
  '07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh','13':'Nagaland',
  '14':'Manipur','15':'Mizoram','16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal','20':'Jharkhand',
  '21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh','24':'Gujarat','25':'Daman and Diu','26':'Dadra and Nagar Haveli and Daman and Diu',
  '27':'Maharashtra','29':'Karnataka','30':'Goa','31':'Lakshadweep','32':'Kerala','33':'Tamil Nadu','34':'Puducherry',
  '35':'Andaman and Nicobar Islands','36':'Telangana','37':'Andhra Pradesh','38':'Ladakh'
};
const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
  january:1,february:2,march:3,april:4,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };

export function toISO(s) {
  if (!s) return '';
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
  m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s*(?:day\s+of\s+)?([A-Za-z]{3,9}),?\s*(\d{4})/);
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
    if (!f.doi) { const n = t.match(/\b\d{2}[\/\-.]\d{2}[\/\-.]\d{4}\b/); if (n) f.doi = toISO(n[0]); }
    const cons = constitutionFrom(t); if (cons) f.constitution = cons;
    else if (type === 'LLP Incorporation') f.constitution = 'LLP';
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
  if (f.address && !f.pincode) { const pins = f.address.match(/\b\d{6}\b/g); if (pins) f.pincode = pins[pins.length - 1]; }
  for (const k of Object.keys(f)) if (!f[k]) delete f[k];
  return { type, fields: f, text: t };
}

/* ---------- browser-only text extraction ---------- */

async function ocr(img, onProgress) {
  const res = await window.Tesseract.recognize(img, 'eng', {
    logger: m => m.status === 'recognizing text' && onProgress && onProgress(`Reading text… ${Math.round(m.progress * 100)}%`)
  });
  return res.data.text;
}

export async function extractText(file, onProgress = () => {}) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) {
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    onProgress('Opening PDF…');
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
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
    for (let i = 1; i <= Math.min(pdf.numPages, 4); i++) {
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
  throw new Error('Upload a PDF or an image (JPG/PNG).');
}

export async function extractFromFile(file, onProgress) {
  const text = await extractText(file, onProgress);
  return parse(text);
}
