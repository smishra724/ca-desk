// Statutory due-date engine. Dates are the standard statutory dates; government extensions
// (CBDT / CBIC / MCA notifications) are not applied automatically.

import { STATE_CODES } from './extract.js';
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// States whose QRMP GSTR-3B is due on the 22nd (rest: 24th)
const QRMP_22 = new Set(['22','23','24','25','26','27','29','30','31','32','33','34','35','36','37']);
const pad = n => String(n).padStart(2, '0');
const fyLabel = fy => `FY ${fy}-${String(fy + 1).slice(2)}`;
const qName = m => ({ 2: 'Q4', 5: 'Q1', 8: 'Q2', 11: 'Q3' })[m];

export function entityKind(c) {
  const k = (c.constitution || '').toLowerCase();
  if (/llp|limited liability/.test(k)) return 'llp';
  if (/private|public|opc|one person|company|ltd/.test(k)) return 'company';
  if (/partnership/.test(k)) return 'firm';
  if (/huf/.test(k)) return 'huf';
  if (/trust|society/.test(k)) return 'trust';
  if (/individual|propriet/.test(k)) return 'individual';
  const p = (c.pan || '').toUpperCase()[3];
  return ({ C: 'company', F: 'firm', H: 'huf', T: 'trust', P: 'individual' })[p] || 'other';
}

// GST registrations of a client. Older records hold a single GSTIN on the client itself;
// that one is returned as a "legacy" registration so its existing filing records still match.
export function regsOf(c) {
  if (Array.isArray(c?.gstRegs)) return c.gstRegs;
  if (c?.gstin) return [{ id: 'main', legacy: true, gstin: c.gstin, state: STATE_CODES[c.gstin.slice(0, 2)] || c.state || '', tradeName: c.tradeName || '',
    address: c.address || '', gstFreq: c.gstFreq || 'Monthly', regDate: c.gstRegDate || '', status: 'Active' }];
  return [];
}
export const activeRegs = c => regsOf(c).filter(r => r.gstin && r.status !== 'Cancelled' && !/not/i.test(r.gstFreq || ''));
// filing record for an item: new per-GSTIN key, or the old single-GSTIN key for the legacy registration
export const filingFor = (map, it, prefix = '') => map[prefix + it.key] || (it.altKey ? map[prefix + it.altKey] : undefined);

// "ITR only" clients (individuals filing just the yearly return): explicit category, or an
// individual with no GST registration when no category has been chosen yet.
export function isItrOnly(c) {
  if (c?.category) return c.category === 'itr';
  return (c?.constitution === 'Individual' || (!c?.constitution && (c?.pan || '')[3] === 'P')) && !activeRegs(c).length;
}

// Compliance code from a due-item key: "GSTR1-2026-10@09AB…" → "GSTR1", "ADV2-2025" → "ADV", "MSME1H1-2025" → "MSME1"
export const codeOf = key => { const p = key.split('@')[0].split('-')[0]; return /^ADV\d$/.test(p) ? 'ADV' : p.replace(/H\d$/, ''); };

export function dueItems(c, from, to) {
  const out = [];
  if (isItrOnly(c)) c = { ...c, gstRegs: [], gstin: '', tds: false, pfesic: false, constitution: c.constitution || 'Individual', _itr: true };
  const add = (key, form, period, due, note = '') => {
    if (due >= from && due <= to) out.push({ key, form, period, due, note });
  };
  const kind = c._itr ? 'individual' : entityKind(c);
  const regs = activeRegs(c), multi = regs.length > 1;
  // GST items are added once per registration; key gets "@GSTIN", label gets the state when there are several
  const gstAdd = (r, key, form, period, due, note) => {
    if (due < from || due > to) return;
    out.push({ key: `${key}@${r.gstin}`, altKey: r.legacy ? key : undefined, gstin: r.gstin, state: r.state || STATE_CODES[r.gstin.slice(0, 2)] || '',
      form: multi ? `${form} — ${r.state || STATE_CODES[r.gstin.slice(0, 2)] || r.gstin.slice(0, 2)}` : form, period, due, note: note || '' });
  };

  // Monthly / quarterly items, by tax period
  for (let pm = new Date(from.getFullYear(), from.getMonth() - 3, 1); pm <= to;
       pm = new Date(pm.getFullYear(), pm.getMonth() + 1, 1)) {
    const y = pm.getFullYear(), m = pm.getMonth();
    const per = `${MON[m]} ${y}`, id = `${y}-${pad(m + 1)}`;
    const nx = day => new Date(y, m + 1, day);
    const qEnd = m % 3 === 2;
    const qLabel = `${qName(m)} ${fyLabel(m < 3 ? y - 1 : y)}`;

    for (const r of regs) {
      const freq = (r.gstFreq || 'Monthly').toLowerCase();
      if (r.regDate && new Date(y, m + 1, 0) < new Date(r.regDate)) continue; // period before registration
      if (freq === 'composition') {
        if (qEnd) gstAdd(r, `CMP08-${id}`, 'CMP-08', qLabel, nx(18));
      } else if (freq === 'qrmp') {
        if (qEnd) {
          gstAdd(r, `GSTR1-${id}`, 'GSTR-1 (QRMP)', qLabel, nx(13));
          gstAdd(r, `GSTR3B-${id}`, 'GSTR-3B (QRMP)', qLabel, nx(QRMP_22.has(r.gstin.slice(0, 2)) ? 22 : 24));
        } else {
          gstAdd(r, `IFF-${id}`, 'IFF', per, nx(13), 'Optional');
          gstAdd(r, `PMT06-${id}`, 'PMT-06 tax payment', per, nx(25));
        }
      } else {
        gstAdd(r, `GSTR1-${id}`, 'GSTR-1', per, nx(11));
        gstAdd(r, `GSTR3B-${id}`, 'GSTR-3B', per, nx(20));
      }
    }
    if (c.tds) add(`TDSPAY-${id}`, 'TDS/TCS payment', per, m === 2 ? new Date(y, 3, 30) : nx(7));
    if (c.pfesic) {
      add(`EPF-${id}`, 'EPF ECR & payment', per, nx(15));
      add(`ESIC-${id}`, 'ESIC contribution', per, nx(15));
    }
  }

  // Annual / quarterly items, by financial year (fy = starting calendar year)
  for (let fy = from.getFullYear() - 2; fy <= to.getFullYear(); fy++) {
    const L = fyLabel(fy), ay = fy + 1;
    if (c.tds) {
      add(`TDSRET-Q1-${fy}`, 'TDS/TCS returns', `Q1 ${L}`, new Date(fy, 6, 31));
      add(`TDSRET-Q2-${fy}`, 'TDS/TCS returns', `Q2 ${L}`, new Date(fy, 9, 31));
      add(`TDSRET-Q3-${fy}`, 'TDS/TCS returns', `Q3 ${L}`, new Date(fy + 1, 0, 31));
      add(`TDSRET-Q4-${fy}`, 'TDS/TCS returns', `Q4 ${L}`, new Date(fy + 1, 4, 31));
    }
    if (c.advTax) {
      add(`ADV1-${fy}`, 'Advance tax (15%)', L, new Date(fy, 5, 15));
      add(`ADV2-${fy}`, 'Advance tax (45%)', L, new Date(fy, 8, 15));
      add(`ADV3-${fy}`, 'Advance tax (75%)', L, new Date(fy, 11, 15));
      add(`ADV4-${fy}`, 'Advance tax (100%)', L, new Date(fy + 1, 2, 15));
    }
    const late = kind === 'company' || !!c.audit;
    add(`ITR-${fy}`, 'Income tax return', `${L} (AY ${ay}-${String(ay + 1).slice(2)})`, new Date(ay, late ? 9 : 6, 31));
    if (c.audit) add(`3CD-${fy}`, 'Tax audit report', L, new Date(ay, 8, 30));
    for (const r of regs) {
      if (r.regDate && new Date(ay, 2, 31) < new Date(r.regDate)) continue;
      if (/composition/i.test(r.gstFreq || '')) gstAdd(r, `GSTR4-${fy}`, 'GSTR-4 annual return', L, new Date(ay, 3, 30));
      else gstAdd(r, `GSTR9-${fy}`, 'GSTR-9 annual return', L, new Date(ay, 11, 31));
    }
    if (kind === 'company') {
      add(`DPT3-${fy}`, 'DPT-3', L, new Date(ay, 5, 30));
      add(`DIR3-${fy}`, 'DIR-3 KYC (directors)', L, new Date(ay, 8, 30));
      add(`AOC4-${fy}`, 'AOC-4 (financials)', L, new Date(ay, 9, 30), '30 days from AGM');
      add(`MGT7-${fy}`, 'MGT-7 / 7A (annual return)', L, new Date(ay, 10, 29), '60 days from AGM');
      add(`MSME1H1-${fy}`, 'MSME-1 (Apr–Sep)', L, new Date(fy, 9, 31), 'If MSME dues >45 days');
      add(`MSME1H2-${fy}`, 'MSME-1 (Oct–Mar)', L, new Date(ay, 3, 30), 'If MSME dues >45 days');
    }
    if (kind === 'llp') {
      add(`LLP11-${fy}`, 'LLP Form 11', L, new Date(ay, 4, 30));
      add(`LLP8-${fy}`, 'LLP Form 8', L, new Date(ay, 9, 30));
      add(`DIR3-${fy}`, 'DIR-3 KYC (partners)', L, new Date(ay, 8, 30));
    }
  }
  const off = new Set(c.off || []); // compliances switched off for this client on the Compliances page
  return out.filter(i => !off.has(codeOf(i.key))).sort((a, b) => a.due - b.due || a.form.localeCompare(b.form));
}

export const fmtDate = d => d ? `${pad(d.getDate())}-${MON[d.getMonth()]}-${d.getFullYear()}` : '';
