// Runs on web.whatsapp.com. Watches the open group chat for fresh messages naming a city
// and tells background.js, which checks that city. Reads the page only; never sends anything.
(() => {
  if (globalThis.__slotWatcherWA) return;
  globalThis.__slotWatcherWA = true;
  const W = globalThis.SLOT_CONFIG?.whatsapp;
  if (!W?.enabled) return;

  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const send = (msg) => {
    if (!alive()) return;
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {}
  };

  const seen = new Set();
  const ignore = new RegExp(W.ignorePattern, 'i');
  const aliases = Object.entries(W.cityAliases).map(([city, words]) =>
    [city, new RegExp(`\\b(?:${words.join('|')})\\b`, 'i')]);

  function groupIsOpen() {
    const header = document.querySelector('#main header');
    return !!header && header.textContent.toLowerCase().includes(W.groupName.toLowerCase());
  }

  // data-pre-plain-text looks like "[10:54 AM, 10/19/2026] Name: " (format follows your locale).
  function parseStamp(pre) {
    const m = pre.match(/\[(\d{1,2}):(\d{2})\s*([AP]\.?M\.?)?,\s*(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})\]/i);
    if (!m) return null;
    let h = Number(m[1]);
    const ap = (m[3] || '').replace(/\./g, '').toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    const now = new Date();
    const [a, b, c] = [Number(m[4]), Number(m[5]), Number(m[6])];
    const mo = now.getMonth() + 1, d = now.getDate(), y = now.getFullYear();
    const yr = (n) => (n < 100 ? 2000 + n : n);
    const isToday =
      (yr(c) === y && ((a === mo && b === d) || (a === d && b === mo))) || // M/D/Y or D/M/Y
      (yr(a) === y && b === mo && c === d);                              // Y-M-D
    if (!isToday) return null;
    const t = new Date(now);
    t.setHours(h, Number(m[2]), 0, 0);
    return t.getTime();
  }

  const readNode = (node) => ({
    pre: node.getAttribute('data-pre-plain-text') || '',
    text: (node.innerText || node.textContent || '').trim(),
  });

  // Decides what a message means; verdict 'TRIGGER' sends an alert.
  function evaluate(pre, text) {
    const at = parseStamp(pre);
    const age = at === null ? Infinity : Date.now() - at;
    const cities = aliases.filter(([, re]) => re.test(text)).map(([city]) => city);
    let verdict = 'TRIGGER';
    if (!cities.length) verdict = 'no watched city';
    else if (ignore.test(text)) verdict = 'ignored (says no slots / gone)';
    else if (at === null) verdict = 'too old (not today)';
    else if (age > W.freshMinutes * 60000) verdict = `too old (${Math.round(age / 60000)} min ago)`;
    else if (age < -120000) verdict = 'bad timestamp';
    return { at, cities, verdict };
  }

  function scan(root) {
    if (!alive()) return observer.disconnect();
    if (!groupIsOpen()) return;
    const nodes = root.matches('[data-pre-plain-text]') ? [root] : root.querySelectorAll('[data-pre-plain-text]');
    for (const node of nodes) {
      const { pre, text } = readNode(node);
      const key = pre + text;
      if (!text || seen.has(key)) continue;
      seen.add(key);
      const { at, cities, verdict } = evaluate(pre, text);
      if (verdict === 'TRIGGER') send({ type: 'COMMUNITY_ALERT', cities, at, text: text.slice(0, 200) });
    }
  }

  // "Test WhatsApp" button in the popup: report on the last few messages, trigger nothing.
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== 'WA_SCAN') return;
    if (!groupIsOpen()) return reply({ error: `open the "${W.groupName}" chat in WhatsApp Web first` });
    const nodes = [...document.querySelectorAll('#main [data-pre-plain-text]')].slice(-(msg.count || 8));
    if (!nodes.length) return reply({ error: 'no messages visible in the open chat (WhatsApp page layout may have changed)' });
    reply({ results: nodes.map((node) => {
      const { pre, text } = readNode(node);
      const { cities, verdict } = evaluate(pre, text);
      return { when: (pre.match(/\[([^\]]+)\]/) || [])[1] || '?', text: text.replace(/\s+/g, ' ').slice(0, 90), cities, verdict };
    }) });
  });

  const observer = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
