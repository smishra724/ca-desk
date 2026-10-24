// Statutory due-date engine. Dates are the standard statutory dates; government extensions
// (CBDT / CBIC / MCA notifications) are not applied automatically.

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

export function dueItems(c, from, to) {
  const out = [];
  const add = (key, form, period, due, note = '') => {
    if (due >= from && due <= to) out.push({ key, form, period, due, note });
  };
  const kind = entityKind(c);
  const freq = (c.gstFreq || 'Monthly').toLowerCase();
  const gst = !!c.gstin && !/not/.test(freq);
  const qrmp = freq === 'qrmp', comp = freq === 'composition';
  const day3B = QRMP_22.has((c.gstin || '').slice(0, 2)) ? 22 : 24;

  // Monthly / quarterly items, by tax period
  for (let pm = new Date(from.getFullYear(), from.getMonth() - 3, 1); pm <= to;
       pm = new Date(pm.getFullYear(), pm.getMonth() + 1, 1)) {
    const y = pm.getFullYear(), m = pm.getMonth();
    const per = `${MON[m]} ${y}`, id = `${y}-${pad(m + 1)}`;
    const nx = day => new Date(y, m + 1, day);
    const qEnd = m % 3 === 2;
    const qLabel = `${qName(m)} ${fyLabel(m < 3 ? y - 1 : y)}`;

    if (gst) {
      if (comp) {
        if (qEnd) add(`CMP08-${id}`, 'CMP-08', qLabel, nx(18));
      } else if (qrmp) {
        if (qEnd) {
          add(`GSTR1-${id}`, 'GSTR-1 (QRMP)', qLabel, nx(13));
          add(`GSTR3B-${id}`, 'GSTR-3B (QRMP)', qLabel, nx(day3B));
        } else {
          add(`IFF-${id}`, 'IFF', per, nx(13), 'Optional');
          add(`PMT06-${id}`, 'PMT-06 tax payment', per, nx(25));
        }
      } else {
        add(`GSTR1-${id}`, 'GSTR-1', per, nx(11));
        add(`GSTR3B-${id}`, 'GSTR-3B', per, nx(20));
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
    if (gst && !comp) add(`GSTR9-${fy}`, 'GSTR-9 annual return', L, new Date(ay, 11, 31));
    if (gst && comp) add(`GSTR4-${fy}`, 'GSTR-4 annual return', L, new Date(ay, 3, 30));
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
  return out.sort((a, b) => a.due - b.due);
}

export const fmtDate = d => d ? `${pad(d.getDate())}-${MON[d.getMonth()]}-${d.getFullYear()}` : '';
