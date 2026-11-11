// Runs in the GST portal page itself: when the portal hands a PDF to the browser as a download,
// a copy is passed to CA Desk Helper so the filed return can be saved in CA Desk.
(() => {
  const orig = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    try {
      if (obj instanceof Blob && obj.size > 500 && obj.size < 15e6 && (/pdf/i.test(obj.type) || !obj.type || /octet/i.test(obj.type))) {
        obj.slice(0, 5).text().then(h => {
          if (!h.startsWith('%PDF')) return;
          const r = new FileReader();
          r.onload = () => window.postMessage({ type: 'CAPM_PDF', b64: String(r.result).split(',')[1] || '' }, location.origin);
          r.readAsDataURL(obj);
        }).catch(() => {});
      }
    } catch { /* never break the portal */ }
    return orig.apply(this, arguments);
  };
})();
