// Runs on the schedule page. Performs one check when background.js asks, and autobooks a match.
(() => {
  // May be injected again by background.js into an already-open tab.
  if (globalThis.__slotWatcherContent) return;
  globalThis.__slotWatcherContent = true;
  const C = globalThis.SLOT_CONFIG;
  const HOOK = 'SLOT_WATCHER_HOOK';
  // Which schedule page this is: OFC (/ofc-schedule) or consular (/schedule). Same layout on both.
  const PAGE = /\/ofc-schedule/i.test(location.pathname) ? 'OFC' : 'CONSULAR';
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december'];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // After the extension is reloaded, this copy is orphaned and chrome.runtime calls throw.
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const send = (msg) => {
    if (!alive()) return;
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {}
  };
  const waiters = [];
  let queue = Promise.resolve();

  // Cancel support ("Stop" in the popup). Each job remembers the generation it was queued in;
  // CANCEL bumps the generation, so the running job stops at its next step and queued ones skip.
  let cancelGen = 0;
  let activeGen = -1;
  let running = false;
  let waiting = 0; // jobs queued behind the running one
  // Keep-alive runs can be cut short (time limit, or a scheduled check coming due) without
  // touching the jobs queued behind them, so that is a flag of its own, not a cancelGen bump.
  let runningKeepAlive = false;
  let inBooking = false; // a keep-alive that found dates is booking: never cut that short
  let keepAliveAbort = false;
  let scheduledQueued = false; // one scheduled check may wait in line
  const cancelled = () => activeGen !== cancelGen || keepAliveAbort;
  function abortKeepAlive(why) {
    if (!running || !runningKeepAlive || inBooking || keepAliveAbort) return false;
    keepAliveAbort = true;
    send({ type: 'NOTE', text: `Keep-alive cut short - ${why}` });
    for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.resolve(null); }
    return true;
  }

  // ---- traffic from page-hook.js ----

  window.addEventListener('message', function onHookMessage(ev) {
    if (!alive()) return window.removeEventListener('message', onHookMessage);
    if (ev.source !== window || ev.origin !== location.origin || ev.data?.source !== HOOK) return;
    const m = ev.data;
    if (m.type === 'sent' && m.kind === 'days') send({ type: 'DAYS_REQUEST' });
    if (m.type === 'alert') send({ type: 'NOTE', text: `Portal pop-up dismissed automatically: ${m.text}` });
    if (m.type !== 'done') return;
    const blocked = blockReason(m);
    if (blocked) {
      // 403 / challenge page = Cloudflare wants a human check; 429 / 1015 = slow down.
      send({ type: 'BLOCKED', reason: blocked, challenge: /403|non-JSON/.test(blocked), detail: responseDetail(m) });
    } else if (m.kind === 'days' && m.status >= 200 && m.status < 300 && m.data) {
      send({ type: 'DAYS_OK', city: document.querySelector(C.selectors.citySelect)?.selectedOptions?.[0]?.text?.trim() || '',
        dayCount: (m.data.ScheduleDays || []).length });
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].kind === m.kind) {
        clearTimeout(waiters[i].timer);
        waiters.splice(i, 1)[0].resolve(m);
      }
    }
  });

  function waitFor(kind, ms) {
    return new Promise((resolve) => {
      const w = { kind, resolve, timer: setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        resolve(null);
      }, ms) };
      waiters.push(w);
    });
  }

  // Anything that looks like the portal or Cloudflare pushing back. Background pauses for the day.
  function blockReason(m) {
    if (m.status === 429) return 'HTTP 429 - too many checks';
    if (m.status === 403) return m.cf === 'challenge' ? 'HTTP 403 - Cloudflare checkbox challenge' : 'HTTP 403 - Cloudflare check';
    if (/error\s*(code)?\s*:?\s*1015|you are being rate limited/i.test(m.text)) return 'Cloudflare 1015 - rate limited';
    if (m.kind === 'days' && m.status >= 200 && m.status < 300 && !m.data) return 'Calendar returned a non-JSON page (likely a challenge)';
    return null;
  }

  // One line for the log about a refused response: what it was, who answered (server "cloudflare"
  // vs the portal's own), whether Cloudflare flagged it as a checkbox challenge, and what the body
  // said - to tell a Cloudflare checkbox, a Cloudflare firewall block and a portal refusal apart.
  function responseDetail(m) {
    const i = m.info || {};
    const body = m.data ? JSON.stringify(m.data) : String(m.text || '');
    const title = (body.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || '';
    const words = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const city = document.querySelector(C.selectors.citySelect)?.selectedOptions?.[0]?.text?.trim() || '?';
    return [
      `${m.kind} request (${city}) -> HTTP ${m.status}${i.statusText ? ` ${i.statusText}` : ''}`,
      `cf-mitigated: ${m.cf || 'none'}`,
      `server: ${i.server || '?'}`,
      i.ray && `cf-ray ${i.ray}`,
      `body: ${i.type || '?'}, ${body.length} chars`,
      title && `title "${title.slice(0, 80)}"`,
      words && `text "${words.slice(0, 200)}"`,
      i.ms != null && `${i.ms} ms`,
    ].filter(Boolean).join(' | ');
  }

  // ---- dates ----

  function localIso(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // ScheduleDays[].Date is normally "2027-01-05T00:00:00"; accept a Date object too.
  function dayIso(v) {
    if (v instanceof Date) return isNaN(v) ? null : localIso(v);
    const s = String(v ?? '');
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    return s && !isNaN(d) ? localIso(d) : null;
  }

  function earliestAllowed() {
    const d = new Date();
    d.setDate(d.getDate() + C.minDaysFromToday);
    return localIso(d);
  }

  // ---- one check ----

  const portalError = (data) =>
    String(data?.Errors?.m_StringValue || data?.ErrorString || 'unknown').replace(/<[^>]+>/g, ' ').trim() || 'unknown';

  // The portal counts page views (schedulePageViews) and removes the form past the daily limit.
  function pageViewLimit() {
    const text = document.getElementById('error_row')?.textContent || '';
    if (/exceeded the limit for viewing this page/i.test(text)) return 'exceeded';
    if (/approaching the maximum number of times you may view this page/i.test(text)) return 'approaching';
    return null;
  }

  async function runCheck(city, manual, { rehearse = false, ranges = {}, noOfc = false } = {}) {
    const sel = document.querySelector(C.selectors.citySelect);
    if (!sel) {
      if (pageViewLimit() === 'exceeded') {
        send({ type: 'PAGE_LIMIT', level: 'exceeded' });
        return { city, error: 'Portal page-view limit exceeded - the booking form was removed', blocked: true };
      }
      return { city, error: 'City dropdown not found - are you logged in on the schedule page?' };
    }
    // Background notes it once per 24 h.
    if (pageViewLimit() === 'approaching') send({ type: 'PAGE_LIMIT', level: 'approaching' });
    const opt = [...sel.options].find((o) => o.text.toUpperCase().includes(city.toUpperCase()));
    if (!opt) return { city, error: `No "${city}" option in the city dropdown` };

    if (!manual) {
      const [lo, hi] = C.jitterSeconds;
      await sleep((lo + Math.random() * (hi - lo)) * 1000);
    }

    if (cancelled()) return { city, cancelled: true, notStarted: true };
    const pending = waitFor('days', C.responseTimeoutMs);
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const res = await pending;
    if (cancelled()) return { city, cancelled: true };
    if (!res) return { city, error: 'Calendar did not respond in time' };
    if (blockReason(res)) return { city, error: blockReason(res), blocked: true };
    if (res.status >= 400 || res.status === 0) return { city, error: `Calendar request failed (HTTP ${res.status})` };

    if (res.data?.HasError) return { city, error: `Portal error: ${portalError(res.data)}` };
    const dates = (res.data?.ScheduleDays || []).map((d) => dayIso(d?.Date)).filter(Boolean).sort();
    // Only dates inside this page's ranges (background: config dateWindows, and on the consular
    // page OFC date .. OFC + N weeks) - Book now too.
    const from = earliestAllowed();
    const inRange = (d) => d >= from && (ranges[PAGE] || []).some((r) => d >= r.from && d <= r.to);
    // Dates you've ruled out for this page (OFC / consular) and city (config skipDates) are never booked.
    const skip = new Set(((C.skipDates || {})[PAGE] || {})[city.toUpperCase()] || []);
    const skipped = dates.filter((d) => skip.has(d));
    const candidates = dates.filter((d) => inRange(d) && !skip.has(d));
    if (!candidates.length) return { city, earliest: dates[0] || null, match: null, ...(skipped.length ? { skipped } : {}) };

    send({ type: 'NOTE', text: `${city}: dates found - in range: ${candidates.join(', ')} | all returned (${dates.length}): ${dates.join(', ')}` });
    send({ type: 'SLOT_FOUND', city, date: candidates[0] });
    if (cancelled()) return { city, cancelled: true, earliest: dates[0], match: candidates[0] };
    if (noOfc) return { city, earliest: dates[0], match: candidates[0], noOfc: true };
    if (!C.autoSubmit) return { city, earliest: dates[0], match: candidates[0] };
    inBooking = true;
    const booking = await book(candidates, city);
    return { city, earliest: dates[0], match: booking.date || candidates[0], ...booking, ...(skipped.length ? { skipped } : {}) };
  }

  // Which page elements autobook relies on can be found right now (before any request).
  function elementReport() {
    const sel = document.querySelector(C.selectors.citySelect);
    return {
      cityDropdown: !!sel,
      cityOptions: sel ? [...sel.options].map((o) => o.text.trim()).filter(Boolean) : [],
      datePicker: !!document.querySelector(C.selectors.datepicker),
      timeDropdown: !!document.querySelector(C.selectors.timeSelect),
      submitButton: !!findSubmit(),
    };
  }

  // ---- autobook ----

  function shownMonth(dp) {
    const m = dp.querySelector('.ui-datepicker-month');
    const y = dp.querySelector('.ui-datepicker-year');
    if (!m || !y) return null;
    const month = m.tagName === 'SELECT' ? Number(m.value) : MONTHS.indexOf(m.textContent.trim().toLowerCase());
    const year = Number(y.tagName === 'SELECT' ? y.value : y.textContent.trim());
    return month < 0 || !year ? null : year * 12 + month;
  }

  // The portal's jQuery UI datepicker is inline, shows 2 months, and has month/year <select>s.
  // Available days are <td class="greenday" data-handler="selectDay" data-month data-year><a data-date="5">.
  const dayCell = (dp, y, m, d) => [...dp.querySelectorAll(`td[data-handler="selectDay"][data-year="${y}"][data-month="${m - 1}"], td[data-year="${y}"][data-month="${m - 1}"]`)]
    .find((td) => Number(td.querySelector('a')?.getAttribute('data-date') || td.textContent.trim()) === d);

  // Jump straight to the month with the header dropdowns (one re-render instead of many "Next" clicks).
  async function jumpToMonth(dp, y, m) {
    const ySel = dp.querySelector('select.ui-datepicker-year');
    if (ySel && [...ySel.options].some((o) => Number(o.value) === y) && Number(ySel.value) !== y) {
      ySel.value = String(y);
      ySel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(50);
    }
    const mSel = dp.querySelector('select.ui-datepicker-month');
    if (mSel && Number(mSel.value) !== m - 1) {
      mSel.value = String(m - 1);
      mSel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(50);
    }
  }

  async function clickDate(iso) {
    const dp = document.querySelector(C.selectors.datepicker);
    if (!dp) return { error: `Date picker "${C.selectors.datepicker}" not found` };
    const [y, m, d] = iso.split('-').map(Number);
    const target = y * 12 + (m - 1);
    let cell = dayCell(dp, y, m, d);
    if (!cell) {
      await jumpToMonth(dp, y, m);
      cell = dayCell(dp, y, m, d);
    }
    // Fallback: step with "Next" if the dropdowns didn't get us there.
    for (let step = 0; !cell && step < 40; step++) {
      const shown = shownMonth(dp);
      if (shown !== null && shown >= target) return { error: `${iso} is not clickable in the calendar` };
      const next = dp.querySelector('.ui-datepicker-next:not(.ui-state-disabled)');
      if (!next) return { error: `Could not navigate the calendar to ${iso}` };
      next.click();
      await sleep(100);
      cell = dayCell(dp, y, m, d);
    }
    if (!cell) return { error: `Could not navigate the calendar to ${iso}` };
    // Start waiting for the time slots only now, so month navigation doesn't eat the timeout.
    const pending = waitFor('entries', C.responseTimeoutMs);
    (cell.querySelector('a') || cell).click(); // jQuery UI "selectDay" -> onSelect -> getScheduleEntries
    return { pending };
  }

  // Times are radios in the #time_select table: <input type="radio" name="schedule-entries"
  // value="<Num>" data-slots="9" onclick="onSelectScheduleEntry(this)">.
  const timeRadios = () => [...document.querySelectorAll(`${C.selectors.timeSelect} input[type="radio"][name="schedule-entries"]`)];
  const radioTime = (r) => (r.closest('tr')?.children[1]?.textContent || '').trim();

  function findSubmit() {
    const byConfig = document.querySelector(C.selectors.submit);
    if (byConfig) return byConfig;
    return [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')]
      .find((b) => b.offsetParent !== null && /^\s*(submit|schedule|book)/i.test(b.textContent || b.value)) || null;
  }

  async function waitEnabled(el, ms) {
    for (let t = 0; el.disabled && t < ms; t += 100) await sleep(100);
    return !el.disabled;
  }

  // The portal writes the radios in the same callback that delivered the response; allow a moment.
  // Most available slots first (data-slots, descending); ties keep the page's time order.
  async function openRadios() {
    for (let i = 0; i < 5; i++) {
      const radios = timeRadios().filter((r) => !r.disabled && Number(r.dataset.slots) >= 1)
        .sort((a, b) => Number(b.dataset.slots) - Number(a.dataset.slots));
      if (radios.length) return radios;
      await sleep(100);
    }
    return [];
  }

  // Every time row the portal drew for the clicked date, open or not, for the log.
  const timesSummary = () => timeRadios()
    .map((r) => `${radioTime(r) || `slot ${r.value}`} (${r.dataset.slots ?? '?'} slots${r.disabled ? ', disabled' : ''})`)
    .join(', ') || 'none';

  // Tries every open time on the earliest date, then the next dates. A slot is skipped when its
  // Submit stays greyed, the portal rejects it ("processing too many requests", PSE0601...), or
  // no answer comes back in time. Stops on a confirmed booking or a Cloudflare/rate-limit block.
  // Each date's times are logged. With no Submit button the dates are still opened, so their
  // times get logged and the button gets another look once a time table has loaded.
  async function book(datesToTry, city) {
    const B = C.booking;
    const attempts = [];
    // The button can be missing for a moment (seen in a tab opened by the automatic sign-in):
    // look again for submitFindWaitMs first.
    let submit = findSubmit();
    const findWait = B.submitFindWaitMs ?? 5000;
    let waited = 0;
    for (; !submit && waited < findWait && !cancelled(); waited += 250) {
      await sleep(250);
      submit = findSubmit();
    }
    if (cancelled()) return { cancelled: true, attempts };
    const noSubmit = `Submit button not found after waiting ${findWait / 1000} s on ${location.pathname} - check selectors.submit`;
    if (!submit) send({ type: 'NOTE', text: `${city}: ${noSubmit} - still opening the dates to log their times` });
    else if (waited) send({ type: 'NOTE', text: `Submit button appeared after ${(waited / 1000).toFixed(2)} s - booking` });

    for (const iso of datesToTry) {
      if (cancelled()) return { cancelled: true, attempts };
      const clicked = await clickDate(iso);
      if (clicked.error) { attempts.push(`${iso}: ${clicked.error}`); continue; }
      const entries = await clicked.pending;
      if (cancelled()) return { cancelled: true, attempts };
      if (!entries) { attempts.push(`${iso}: times did not load`); continue; }
      if (blockReason(entries)) return { bookError: blockReason(entries), blocked: true, attempts };
      if (entries.data?.HasError) { attempts.push(`${iso}: ${portalError(entries.data)}`); continue; }
      const radios = await openRadios();
      send({ type: 'NOTE', text: `${city} ${iso}: times - ${timesSummary()}` });
      if (!submit) {
        submit = findSubmit();
        if (submit) send({ type: 'NOTE', text: `${city}: Submit button appeared once ${iso}'s times loaded - booking` });
        else { attempts.push(`${iso}: Submit button still missing - not booked`); continue; }
      }
      if (!radios.length) { attempts.push(`${iso}: no open times`); continue; }

      for (const radio of radios) {
        if (cancelled()) return { cancelled: true, attempts };
        if (!radio.isConnected) continue; // table was rebuilt
        const time = radioTime(radio) || `slot ${radio.value}`;
        radio.click(); // onSelectScheduleEntry -> jsdata.Num = value -> toggleSubmit()
        if (!(await waitEnabled(submit, B.submitEnableWaitMs))) {
          attempts.push(`${iso} ${time}: Submit greyed - next slot`);
          continue;
        }
        if (C.testMode) return { booked: false, testMode: true, date: iso, time, attempts };
        if (!alive()) return { bookError: 'Extension was reloaded mid-booking - not submitting', attempts };

        // onClickSubmit() posts schedule-ofc- / schedule-consular-appointments-for-family; AllScheduled -> redirect.
        // On a rejection the consular page leaves Submit greyed; the next radio click re-enables it.
        if (cancelled()) return { cancelled: true, attempts };
        const pendingBook = waitFor('book', B.responseWaitMs);
        submit.click();
        const res = await pendingBook;
        // Submit already went out; a cancel now only stops further attempts.
        if (cancelled() && !res) return { cancelled: true, attempts, note: `Submit for ${iso} ${time} was already sent - check the page` };
        if (!res) {
          attempts.push(`${iso} ${time}: no answer to Submit in ${Math.round(B.responseWaitMs / 1000)}s - next slot`);
          continue;
        }
        if (blockReason(res)) return { bookError: `Booking request blocked: ${blockReason(res)}`, blocked: true, date: iso, time, attempts };
        if (res.status >= 400 || res.status === 0) {
          attempts.push(`${iso} ${time}: HTTP ${res.status} - next slot`);
        } else if (res.data?.HasError) {
          attempts.push(`${iso} ${time}: ${portalError(res.data)} - next slot`);
        } else if (res.data?.AllScheduled) {
          return { booked: 'confirmed', date: iso, time, attempts };
        } else {
          return { booked: 'submitted', date: iso, time, attempts, note: 'portal accepted but did not report AllScheduled (more applicants to schedule?)' };
        }
        await sleep(B.retryGapMs);
      }
    }
    return { bookError: submit ? `could not book any slot (${attempts.length} tried)` : noSubmit, attempts };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'PING') return reply({ ok: true, busy: running || waiting > 0 || scheduledQueued });
    if (msg?.type === 'CANCEL') {
      const wasRunning = running;
      cancelGen++;
      // Release anything waiting on the portal so the running job notices right away.
      for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.resolve(null); }
      return reply({ wasRunning });
    }
    if (msg?.type !== 'RUN_CHECK') return;
    // Queue behind any check already running (e.g. Book now during a scheduled check).
    const opts = { manual: msg.manual === true, rehearse: msg.rehearse === true, fallback: msg.fallback || [],
      ranges: msg.ranges || {},
      // Consular page with no known OFC date: look, but never book.
      noOfc: PAGE === 'CONSULAR' && msg.hasOfcDate !== true };
    // A scheduled check that comes due while another run is still going waits in line (one at
    // a time, and dropped if it waited longer than queuedCheckMaxSeconds), so 5-minute windows
    // can't pile up behind a slow calendar. A running keep-alive is cut short to make room.
    // Follow-up checks never queue and never run alongside anything: if a check or a booking
    // (date found, Submit in progress) is still going, or another run is waiting, drop this one.
    if (msg.followUp === true && (running || waiting > 0 || scheduledQueued)) {
      send({ type: 'NOTE', text: `Follow-up check skipped - ${inBooking ? 'a booking is in progress' : 'a check is still running'}` });
      return;
    }
    const scheduled = msg.skipIfBusy === true;
    const queuedAt = Date.now();
    if (scheduled) {
      if (scheduledQueued) {
        send({ type: 'NOTE', text: 'Skipped scheduled check - another scheduled check is already waiting' });
        return;
      }
      if (running || waiting > 0) {
        const cut = abortKeepAlive('a scheduled check is due');
        send({ type: 'NOTE', text: `Scheduled check queued - the previous run is still going${cut ? ' (keep-alive cut short)' : ''}` });
      }
      scheduledQueued = true;
    }
    const gen = cancelGen;
    waiting++;
    queue = queue.then(async () => {
      waiting--;
      if (scheduled) scheduledQueued = false;
      if (gen !== cancelGen) return; // cancelled while waiting in line
      if (scheduled) {
        const waited = Math.round((Date.now() - queuedAt) / 1000);
        if (waited > (C.queuedCheckMaxSeconds ?? 60)) {
          send({ type: 'NOTE', text: `Dropped queued scheduled check - waited ${waited} s, too old to run` });
          return;
        }
        if (waited >= 1) send({ type: 'NOTE', text: `Running the queued scheduled check (waited ${waited} s)` });
      }
      activeGen = gen;
      running = true;
      runningKeepAlive = msg.keepAlive === true;
      inBooking = false;
      keepAliveAbort = false;
      const limit = runningKeepAlive && C.keepAlive?.maxSeconds
        ? setTimeout(() => abortKeepAlive(`over ${C.keepAlive.maxSeconds} s`), C.keepAlive.maxSeconds * 1000) : null;
      try { await runCities(msg.cities, opts); } finally {
        clearTimeout(limit);
        running = false; runningKeepAlive = false; inBooking = false; keepAliveAbort = false;
      }
    }).catch(() => {});
  });

  // Checks cities in order, pausing between them. Stops at a booking or a block. If a city had
  // dates but none could be booked, goes on to the `fallback` cities (once).
  async function runCities(cities, { manual, rehearse = false, fallback = [], ranges = {}, noOfc = false }) {
    const todo = [...cities];
    const tried = new Set();
    let fellBack = false;
    for (let i = 0; todo.length; i++) {
      if (!alive() || cancelled()) return send({ type: 'NOTE', text: `Stopped - left the city dropdown alone${todo.length ? ` (skipped ${todo.join(', ')})` : ''}` });
      const city = todo.shift();
      tried.add(city);
      if (i > 0) {
        const [lo, hi] = C.cityGapSeconds;
        await sleep((lo + Math.random() * (hi - lo)) * 1000);
      }
      const elements = rehearse && i === 0 ? elementReport() : null;
      const result = await runCheck(city, manual || rehearse, { rehearse, ranges, noOfc })
        .catch((e) => ({ city, error: String(e?.message || e) }));
      if (result.cancelled) {
        const skipped = result.notStarted ? [city, ...todo] : todo;
        const rest = skipped.length ? ` (skipped ${skipped.join(', ')})` : '';
        const where = result.notStarted ? `before ${city}` : `during ${city}`;
        return send({ type: 'NOTE', text: `Stopped ${where}${result.note ? ` - ${result.note}` : ''} - left the city dropdown alone${rest}` });
      }
      // A Cloudflare challenge: report what's left so it can be re-run after you pass the check.
      const resumeInfo = result.blocked && /403|non-JSON/.test(`${result.error || ''} ${result.bookError || ''}`)
        ? { challenge: true, resumeCities: [city, ...todo], manual } : {};
      send({ type: 'RESULT', result: { ...result, page: PAGE, ...resumeInfo, ...(rehearse ? { rehearse: true, elements } : {}) } });
      if (result.blocked || result.booked || result.testMode || result.noOfc) return;
      if (result.match && !fellBack && C.booking.tryOtherCitiesOnFail) {
        fellBack = true;
        todo.push(...fallback.filter((c) => !tried.has(c) && !todo.includes(c)));
      }
    }
  }

  // Tell background the page is usable once the portal has filled the city dropdown (it loads the
  // posts with a request after the page opens). After an OFC booking the portal goes straight to
  // the consular page, and background checks it right away on this message.
  // Also reports the portal's page-view banner ("approaching" / "exceeded") as soon as it shows.
  (async () => {
    let limitSent = false;
    for (let t = 0; t < 60000; t += 500) {
      const limit = pageViewLimit();
      if (limit && !limitSent) { limitSent = true; send({ type: 'PAGE_LIMIT', level: limit }); }
      const sel = document.querySelector(C.selectors.citySelect);
      if (sel && [...sel.options].some((o) => o.value)) return send({ type: 'PAGE_READY', page: PAGE });
      await sleep(500);
    }
  })();
})();
