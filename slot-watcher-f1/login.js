// Login helpers: run in the portal's sign-in tab (chrome.scripting.executeScript) when you click
// "Log in" or "Answer questions" in the popup. Self-contained - executeScript sends only this
// function's source, so everything it uses is defined inside it.
// mode 'login':     data = { username, password }
// mode 'questions': data = { qa: [{ q, a }], minScore }
// Returns what it did, never the values it typed.
function fillAuthPage(mode, data, submit) {
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const editable = (el) => visible(el) && !el.disabled && !el.readOnly;
  const textInputs = () => [...document.querySelectorAll('input')]
    .filter((el) => /^(text|email|password|tel|)$/i.test(el.getAttribute('type') || '') && editable(el));
  const describe = (el) => ({ tag: el.tagName.toLowerCase(), type: el.type || '', id: el.id || '', name: el.name || '',
    placeholder: el.placeholder || '', label: labelOf(el).slice(0, 120) });

  // Set the value the way typing would, so the page's own validation sees it.
  function setValue(el, value) {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    for (const t of ['input', 'change', 'keyup']) el.dispatchEvent(new Event(t, { bubbles: true }));
    el.blur();
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // Text the page shows for an input: its <label>, aria label, or the nearest block around it that
  // holds no other answer box (question text can also sit in a read-only input or a dropdown).
  function labelOf(el) {
    const parts = [];
    if (el.id) document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`).forEach((l) => parts.push(l.innerText));
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const t = document.getElementById(id);
      if (t) parts.push(t.innerText);
    }
    if (parts.join('').trim()) return parts.join(' ').trim();
    const shown = (x) => ((x.tagName === 'SELECT' ? x.selectedOptions[0]?.text : x.tagName === 'INPUT' ? x.value : x.innerText || x.textContent) || '').trim();
    // Sign-in (B2C) pages: answer box "kba1_response" goes with question element id "kba1" (or class "kba1").
    const base = el.id.replace(/_?(response|answer)$/i, '');
    if (base && base !== el.id) {
      const q = [document.getElementById(base), ...document.querySelectorAll(`.${CSS.escape(base)}`)]
        .find((x) => x && x !== el && !x.contains(el) && shown(x));
      if (q) return shown(q);
    }
    const others = textInputs().filter((x) => x !== el);
    for (let box = el.parentElement, i = 0; box && i < 5; box = box.parentElement, i++) {
      if (others.some((x) => box.contains(x))) break;
      const extra = [...box.querySelectorAll('input[readonly], input[disabled], select')].map(shown);
      const text = `${box.innerText || ''} ${extra.join(' ')}`.trim();
      if (text) return text;
    }
    // Last resort: the nearest text before the box that isn't another answer box's block.
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (others.some((x) => sib.contains(x))) return el.placeholder || '';
        if (shown(sib)) return shown(sib);
      }
      if (others.some((x) => node.parentElement?.contains(x))) break;
    }
    return el.placeholder || '';
  }

  function findSubmit(near) {
    const form = near?.form || near?.closest('form');
    const scopes = form ? [form, document] : [document];
    for (const scope of scopes) {
      const direct = [...scope.querySelectorAll('#continue, #next, button[type="submit"], input[type="submit"]')].find(visible);
      if (direct) return direct;
      const byText = [...scope.querySelectorAll('button, input[type="button"], a[role="button"]')]
        .find((b) => visible(b) && /sign ?in|log ?in|submit|continue|next|verify/i.test(b.innerText || b.value || ''));
      if (byText) return byText;
    }
    return null;
  }

  // A captcha needs you: leave it focused and don't submit.
  function captchaBox(skip) {
    const box = textInputs().find((el) => !skip.includes(el) && /captcha/i.test(`${el.id} ${el.name} ${el.placeholder} ${labelOf(el)}`));
    if (box) return box;
    const widget = document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], img[id*="captcha" i], img[src*="captcha" i]');
    return visible(widget) ? widget : null;
  }

  function finish(filled, near, extra = {}) {
    const captcha = captchaBox(filled);
    if (captcha) {
      if (captcha.tagName === 'INPUT') captcha.focus();
      return { ok: true, submitted: false, captcha: true, ...extra };
    }
    if (!submit) return { ok: true, submitted: false, ...extra };
    const btn = findSubmit(near);
    if (!btn) return { ok: true, submitted: false, problem: 'no Submit button found', ...extra };
    if (btn.disabled) return { ok: true, submitted: false, problem: 'Submit is greyed out', ...extra };
    btn.click();
    return { ok: true, submitted: true, button: (btn.innerText || btn.value || btn.id || '').trim().slice(0, 30), ...extra };
  }

  if (mode === 'login') {
    const pass = textInputs().find((el) => el.type === 'password');
    const user = document.querySelector('#signInName, #email, #username, #logonIdentifier')
      || textInputs().find((el) => el.type === 'email' || el.autocomplete === 'username' || /user|email|logon|signin/i.test(`${el.id} ${el.name}`))
      || textInputs().find((el) => el.type !== 'password' && (!pass || el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING));
    const filled = [];
    if (editable(user)) { setValue(user, data.username); filled.push(user); }
    if (pass) { setValue(pass, data.password); filled.push(pass); }
    if (!filled.length) return { ok: false, problem: 'no username or password box on this page', inputs: textInputs().map(describe) };
    return finish(filled, pass || user, { fields: filled.map((el) => (el === pass ? 'password' : 'username')) });
  }

  // mode 'questions': match each answer box's question text against the .env questions.
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
  function score(pageText, q) {
    const a = norm(pageText), b = norm(q);
    if (!b) return 0;
    if (a.includes(b)) return 1;
    const wa = words(a), wb = words(b);
    let hit = 0;
    for (const w of wb) if (wa.has(w)) hit++;
    return wb.size ? hit / wb.size : 0;
  }
  const boxes = textInputs();
  if (!boxes.length) return { ok: false, problem: 'no answer boxes on this page', inputs: [] };
  const found = boxes.map((el) => ({ el, text: labelOf(el) }));
  const used = new Set();
  const matched = [], unknown = [];
  for (const f of found) {
    let best = null;
    data.qa.forEach((p, i) => {
      if (used.has(i)) return;
      const sc = score(f.text, p.q);
      if (sc >= data.minScore && (!best || sc > best.sc)) best = { i, sc };
    });
    if (best) { used.add(best.i); matched.push({ f, i: best.i, sc: best.sc }); }
    else unknown.push(f.text.replace(/\s+/g, ' ').slice(0, 150));
  }
  if (unknown.length) {
    // Don't type anything unless every box has an answer - a wrong guess can lock the account.
    return { ok: false, problem: 'question(s) not in .env', unknown, inputs: boxes.map(describe) };
  }
  for (const m of matched) setValue(m.f.el, data.qa[m.i].a);
  return finish(matched.map((m) => m.f.el), matched[matched.length - 1].f.el,
    { answered: matched.map((m) => `Q${data.qa[m.i].n}`) });
}
