// Runs on government portals. Fills user ID / password (and TAN on TRACES) when CA Desk opened this tab.
// Never touches CAPTCHA or OTP fields and never clicks Sign in.
(async () => {
  let data;
  try { data = await chrome.runtime.sendMessage({ type: 'CAPM_GET' }); } catch { return; }
  if (!data) return;

  const USER = ['#username', '#panAdhaarUserId', '#userId', '#txtUserName', '#txtUsername', '#txt_username', '#UserName', '#userName',
    '#txtUserId', '#txtUserID', 'input[name=username]', 'input[name=userName]', 'input[name=userId]', 'input[name=user_name]', 'input[autocomplete=username]'];
  const PASS = ['#user_pass', '#loginPasswordField', '#psw', '#password', '#txtPassword', '#txt_password', 'input[type=password]'];
  const TAN = ['#tanpan', 'input[name=tanpan]'];

  const visible = el => el && el.offsetParent !== null && !el.disabled && !el.readOnly;
  const avoid = el => /captcha|otp|search|verif/i.test(`${el.id} ${el.name} ${el.placeholder} ${el.getAttribute('aria-label') || ''}`);
  const pick = sels => { for (const s of sels) for (const el of document.querySelectorAll(s)) if (visible(el) && !avoid(el)) return el; return null; };
  const setVal = (el, v) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus(); setter.call(el, v);
    for (const t of ['input', 'change', 'keyup', 'blur']) el.dispatchEvent(new Event(t, { bubbles: true }));
  };
  // a text field just before the password box, if no known selector matched
  const userNear = pass => {
    let cand = null;
    for (const i of document.querySelectorAll('input')) {
      if (!visible(i) || avoid(i) || !['text', 'email', 'tel', ''].includes(i.type)) continue;
      if (i.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING) cand = i;
    }
    return cand;
  };

  let userDone = false, passDone = false, tanDone = !data.extra?.tan;
  const banner = msg => {
    let b = document.getElementById('capm-banner');
    if (!b) {
      b = document.createElement('div'); b.id = 'capm-banner';
      b.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#0f5c4d;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:10px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.25);max-width:320px;cursor:pointer';
      b.title = 'Click to dismiss'; b.onclick = () => b.remove();
      document.body.appendChild(b);
    }
    b.textContent = 'CA Desk: ' + msg;
  };

  const tryFill = () => {
    const p = pick(PASS);
    let u = pick(USER);
    if (!u && p) u = userNear(p);
    if (!tanDone) { const t = pick(TAN); if (t) { setVal(t, data.extra.tan); tanDone = true; } }
    if (u && !userDone && data.u) { setVal(u, data.u); userDone = true; }
    if (p && !passDone && data.p) { setVal(p, data.p); passDone = true; }
    if (passDone) {
      chrome.runtime.sendMessage({ type: 'CAPM_DONE' });
      banner('User ID and password filled. Enter the CAPTCHA / OTP and sign in.');
      return true;
    }
    if (userDone) banner('User ID filled. Click Continue — the password will fill on the next step.');
    return false;
  };

  if (tryFill()) return;
  const obs = new MutationObserver(() => { if (tryFill()) obs.disconnect(); });
  obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  setTimeout(() => obs.disconnect(), 5 * 60 * 1000);
})();
