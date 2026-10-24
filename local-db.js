// Local mode: a drop-in stand-in for the Firebase Auth + Firestore functions the app uses.
// Data is kept in this browser's IndexedDB. Used automatically until firebase-config.js is filled in.

const DBNAME = 'ca-desk-local', STORE = 'docs';
const D = new Map();
let idb;

function openIDB() {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(DBNAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}
const tx = (mode, fn) => new Promise((ok, bad) => {
  const t = idb.transaction(STORE, mode); const s = t.objectStore(STORE);
  fn(s); t.oncomplete = () => ok(); t.onerror = () => bad(t.error);
});
async function loadAll() {
  await new Promise((ok, bad) => {
    const t = idb.transaction(STORE, 'readonly'); const s = t.objectStore(STORE);
    const req = s.openCursor();
    req.onsuccess = () => { const c = req.result; if (c) { D.set(c.key, c.value); c.continue(); } else ok(); };
    req.onerror = () => bad(req.error);
  });
}
const persist = (path, val) => tx('readwrite', s => val === undefined ? s.delete(path) : s.put(val, path));

idb = await openIDB();
await loadAll();

export const LOCAL_USER = { uid: 'local-owner', email: 'Owner (this computer)' };
if (!D.has('meta/setup')) { D.set('meta/setup', { firmName: 'CA Desk' }); await persist('meta/setup', D.get('meta/setup')); }
if (!D.has('users/local-owner')) { const u = { role: 'admin', name: 'Owner', email: LOCAL_USER.email }; D.set('users/local-owner', u); await persist('users/local-owner', u); }

/* ---------- helpers ---------- */
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const mkRef = path => ({
  path, id: path.split('/').pop(),
  parent: { id: path.split('/').slice(-2)[0], parent: { id: path.split('/').slice(-3)[0] } },
});
const hydrate = v => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('__ts' in v) return { seconds: v.__ts / 1000, toDate: () => new Date(v.__ts) };
    const o = {}; for (const [k, x] of Object.entries(v)) o[k] = hydrate(x); return o;
  }
  if (Array.isArray(v)) return v.map(hydrate);
  return v;
};
const snap = path => ({ id: path.split('/').pop(), ref: mkRef(path), exists: () => D.has(path), data: () => hydrate(D.get(path)) });
const clean = d => JSON.parse(JSON.stringify(d)); // drop undefined, ensure cloneable

/* ---------- app / auth ---------- */
export const initializeApp = () => ({});
export const getAuth = () => ({});
export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb(LOCAL_USER), 0); return () => {}; };
export const signOut = async () => {};
export const signInWithEmailAndPassword = async () => {};
const needCloud = async () => { throw new Error('Logins switch on once Firebase is connected.'); };
export const createUserWithEmailAndPassword = needCloud;
export const sendPasswordResetEmail = needCloud;

/* ---------- firestore ---------- */
export const getFirestore = () => ({});
export const collection = (db, ...p) => ({ path: p.join('/'), coll: true });
export const collectionGroup = (db, name) => ({ group: name });
export const where = (field, op, value) => ({ field, op, value });
export const query = (c, ...filters) => ({ ...c, filters: filters.filter(Boolean) });
export const doc = (base, ...p) => mkRef(base && base.coll && !p.length ? `${base.path}/${rid()}` : p.join('/'));
export const serverTimestamp = () => ({ __ts: Date.now() });
export const arrayUnion = (...v) => ({ __union: v });

export const getDoc = async r => snap(r.path);
export const getDocs = async c => {
  let keys;
  if (c.group) keys = [...D.keys()].filter(k => { const s = k.split('/'); return s.length >= 2 && s[s.length - 2] === c.group; });
  else { const n = c.path.split('/').length; keys = [...D.keys()].filter(k => k.startsWith(c.path + '/') && k.split('/').length === n + 1); }
  for (const f of c.filters || []) if (f.op === '==') keys = keys.filter(k => D.get(k)?.[f.field] === f.value);
  const docs = keys.map(snap);
  return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
};
function applyMerge(path, data) {
  const o = { ...(D.get(path) || {}) };
  for (const [k, v] of Object.entries(data)) o[k] = v && v.__union ? [...(o[k] || []), ...v.__union] : v;
  return o;
}
export const setDoc = async (r, d, opt) => { const v = clean(opt?.merge ? applyMerge(r.path, d) : d); D.set(r.path, v); await persist(r.path, v); };
export const updateDoc = async (r, d) => {
  if (!D.has(r.path)) throw new Error('Record not found');
  const v = clean(applyMerge(r.path, d)); D.set(r.path, v); await persist(r.path, v);
};
export const addDoc = async (c, d) => { const r = doc(c); await setDoc(r, d); return r; };
export const deleteDoc = async r => { D.delete(r.path); await persist(r.path, undefined); };
export const writeBatch = () => {
  const ops = [];
  return {
    set: (r, d, o) => ops.push(() => setDoc(r, d, o)),
    update: (r, d) => ops.push(() => updateDoc(r, d)),
    delete: r => ops.push(() => deleteDoc(r)),
    commit: async () => { for (const o of ops) await o(); },
  };
};

/* ---------- backup / restore ---------- */
export function exportAll() { return JSON.stringify({ app: 'ca-desk', version: 1, exportedAt: new Date().toISOString(), docs: Object.fromEntries(D) }); }
export async function importAll(json) {
  const data = JSON.parse(json);
  if (data.app !== 'ca-desk' || !data.docs) throw new Error('This is not a CA Desk backup file.');
  await tx('readwrite', s => s.clear());
  D.clear();
  for (const [k, v] of Object.entries(data.docs)) D.set(k, v);
  await tx('readwrite', s => { for (const [k, v] of D) s.put(v, k); });
}
