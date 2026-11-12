// One-click update of the CA Desk Helper extension.
// Chrome does not let a website install extensions, but the helper is loaded "unpacked" from a folder on this computer.
// The first time, you pick that folder (Chrome asks once to allow editing it); after that CA Desk writes the new files
// into it and tells the extension to restart itself. With "Allow on every visit", updates then happen on their own.
const DB = 'cadesk-ext', STORE = 'h', KEY = 'folder';
const idb = () => new Promise((ok, bad) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
const idbGet = async () => { try { const d = await idb(); return await new Promise(ok => { const q = d.transaction(STORE).objectStore(STORE).get(KEY); q.onsuccess = () => ok(q.result || null); q.onerror = () => ok(null); }); } catch { return null; } };
const idbSet = async v => { try { const d = await idb(); await new Promise(ok => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, KEY); t.oncomplete = ok; t.onerror = ok; }); } catch { /* private mode */ } };
export const newer = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
export const canUpdate = () => 'showDirectoryPicker' in window;

async function helperDir(dir) {
  const isHelper = async d => { try { const m = JSON.parse(await (await (await d.getFileHandle('manifest.json')).getFile()).text()); return /CA Desk/i.test(m.name || ''); } catch { return false; } };
  if (await isHelper(dir)) return dir;
  for await (const [, h] of dir.entries()) if (h.kind === 'directory' && await isHelper(h)) return h; // zip unpacked one level down
  return null;
}
export async function linkedFolder() { return idbGet(); }
export async function permission(h, ask) {
  if (!h) return 'none';
  if (typeof h.queryPermission !== 'function') return 'granted';
  const o = { mode: 'readwrite' };
  let p = await h.queryPermission(o);
  if (p !== 'granted' && ask) p = await h.requestPermission(o);
  return p;
}
// pick (first time) and write the latest files; returns the new version
export async function updateExtension({ pick = false, onStep = () => {} } = {}) {
  if (!canUpdate()) throw new Error('This browser cannot update the extension folder. Use Chrome or Edge on a computer.');
  let h = pick ? null : await idbGet();
  if (!h) {
    onStep('Choose the CA Desk Helper folder…');
    const d = await window.showDirectoryPicker({ id: 'cadesk-helper', mode: 'readwrite' });
    h = await helperDir(d);
    if (!h) throw new Error('That folder does not contain CA Desk Helper. Choose the folder you selected in chrome://extensions → Load unpacked (it has manifest.json inside).');
    await idbSet(h);
  }
  if (await permission(h, true) !== 'granted') throw new Error('Chrome did not allow CA Desk to update the extension folder. Click Update again and choose “Allow” (or “Allow on every visit”).');
  onStep('Downloading the latest extension…');
  const list = await (await fetch('ext-files.json', { cache: 'reload' })).json();
  for (const f of list.files) {
    const body = await (await fetch(`extension/${f}`, { cache: 'reload' })).arrayBuffer();
    const w = await (await h.getFileHandle(f, { create: true })).createWritable();
    await w.write(body); await w.close();
  }
  onStep('Restarting the extension…');
  window.postMessage({ type: 'CAPM_RELOAD' }, location.origin);
  return list.version;
}
