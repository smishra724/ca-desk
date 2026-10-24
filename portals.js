// Compliance portals. `short` is used for Excel import/export column names.
export const PORTALS = [
  { key: 'gst',    short: 'GST',    name: 'GST Portal',            url: 'https://services.gst.gov.in/services/login' },
  { key: 'it',     short: 'IT',     name: 'Income Tax e-Filing',   url: 'https://eportal.incometax.gov.in/iec/foservices/#/login' },
  { key: 'traces', short: 'TRACES', name: 'TRACES (TDS)',          url: 'https://www.tdscpc.gov.in/app/login.xhtml' },
  { key: 'mca',    short: 'MCA',    name: 'MCA V3',                url: 'https://www.mca.gov.in/content/mca/global/en/foportal/fologin.html' },
  { key: 'epf',    short: 'EPF',    name: 'EPFO Employer',         url: 'https://unifiedportal-emp.epfindia.gov.in/epfo/' },
  { key: 'esic',   short: 'ESIC',   name: 'ESIC Employer',         url: 'https://portal.esic.gov.in/EmployerPortal/ESICInsurancePortal/Portal_Loginnew.aspx' },
  { key: 'ewb',    short: 'EWB',    name: 'E-Way Bill',            url: 'https://ewaybillgst.gov.in/Login.aspx' },
  { key: 'einv',   short: 'EINV',   name: 'E-Invoice (IRP)',       url: 'https://einvoice1.gst.gov.in/' },
  { key: 'udyam',  short: 'UDYAM',  name: 'Udyam (MSME)',          url: 'https://udyamregistration.gov.in/' },
  { key: 'dgft',   short: 'DGFT',   name: 'DGFT (IEC)',            url: 'https://www.dgft.gov.in/CP/' },
  { key: 'pt',     short: 'PT',     name: 'Professional Tax',      url: '' },
  { key: 'other',  short: 'OTHER',  name: 'Other',                 url: '' },
];

export const portalByKey = k => PORTALS.find(p => p.key === k) || PORTALS[PORTALS.length - 1];
