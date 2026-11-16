// Runs in the page's own JS world so it can see the portal's jQuery AJAX traffic.
// Forwards calendar (days) and time-slot (entries) responses to content.js via postMessage.
(() => {
  // May be injected again by background.js into an already-open tab.
  if (window.__slotWatcherHook) return;
  window.__slotWatcherHook = true;
  const TAG = 'SLOT_WATCHER_HOOK';
  const DAYS = /schedule-group\/get-family-(?:ofc(?:-emergency)?|consular)-schedule-days/i;
  const ENTRIES = /schedule-group\/.*schedule-entries/i;

  // onClickSubmit() posts here (schedule-ofc-... / reschedule-consular-... etc.).
  const BOOK = /schedule-group\/(?:re)?schedule-(?:ofc|consular)-appointments-for-family/i;

  const kindOf = (url) => (DAYS.test(url) ? 'days' : ENTRIES.test(url) ? 'entries' : BOOK.test(url) ? 'book' : null);
  const post = (msg) => window.postMessage({ source: TAG, ...msg }, location.origin);

  // Kept for the popup's "Capture page" snapshot: recent portal calls and last responses.
  const recent = (window.__slotWatcherRecent = []);
  const last = (window.__slotWatcherLast = {});

  function attach($) {
    $(document).on('ajaxSend', (_e, _xhr, settings) => {
      const url = String(settings.url || '');
      const kind = kindOf(url);
      if (kind) post({ type: 'sent', kind });
      if (/schedule|appointment/i.test(url)) {
        recent.push({ at: new Date().toISOString(), method: settings.type, url, data: String(settings.data || '').slice(0, 3000) });
        if (recent.length > 25) recent.shift();
      }
    });
    // ajaxComplete fires for both success and error responses.
    $(document).on('ajaxComplete', (_e, xhr, settings) => {
      const kind = kindOf(String(settings.url || ''));
      if (!kind) return;
      // Parse the raw text: the portal's success callback (populateCalendar) has already
      // replaced ScheduleDays[].Date strings in responseJSON with Date objects by now.
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = xhr.responseJSON ?? null; }
      const text = data ? '' : String(xhr.responseText || '').slice(0, 3000);
      last[kind] = { at: new Date().toISOString(), url: String(settings.url || ''), status: Number(xhr.status), data, text };
      // "challenge" = Cloudflare wants the checkbox (the portal's own code checks this header).
      let cf = '';
      try { cf = xhr.getResponseHeader('cf-mitigated') || ''; } catch {}
      post({ type: 'done', kind, status: Number(xhr.status), data, text, cf });
    });
  }

  // The page loads jQuery after this script runs at document_start.
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (typeof window.jQuery === 'function') {
      clearInterval(timer);
      attach(window.jQuery);
    } else if (Date.now() - startedAt > 15000) {
      clearInterval(timer);
    }
  }, 100);
})();
