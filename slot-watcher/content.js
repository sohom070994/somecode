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
  const cancelled = () => activeGen !== cancelGen;

  // ---- traffic from page-hook.js ----

  window.addEventListener('message', function onHookMessage(ev) {
    if (!alive()) return window.removeEventListener('message', onHookMessage);
    if (ev.source !== window || ev.origin !== location.origin || ev.data?.source !== HOOK) return;
    const m = ev.data;
    if (m.type === 'sent' && m.kind === 'days') send({ type: 'DAYS_REQUEST' });
    if (m.type !== 'done') return;
    const blocked = blockReason(m);
    if (blocked) {
      // 403 / challenge page = Cloudflare wants a human check; 429 / 1015 = slow down.
      send({ type: 'BLOCKED', reason: blocked, challenge: /403|non-JSON/.test(blocked) });
    } else if (m.kind === 'days' && m.status >= 200 && m.status < 300 && m.data) {
      send({ type: 'DAYS_OK' });
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

  async function runCheck(city, manual, { rehearse = false, consularLatest = null } = {}) {
    const sel = document.querySelector(C.selectors.citySelect);
    if (!sel) {
      if (pageViewLimit() === 'exceeded') {
        send({ type: 'BLOCKED', reason: 'Portal page-view limit exceeded for today', untilMidnight: true });
        return { city, error: 'Portal page-view limit exceeded for today - the booking form was removed', blocked: true };
      }
      return { city, error: 'City dropdown not found - are you logged in on the schedule page?' };
    }
    if (pageViewLimit() === 'approaching') send({ type: 'NOTE', text: 'Portal warns: approaching the page-view limit - avoid reloading the schedule page' });
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
    // "Book now" takes any available date regardless of the configured range.
    const from = earliestAllowed();
    // Dates you've ruled out for this page (OFC / consular) and city (config skipDates) are never booked.
    const skip = new Set(((C.skipDates || {})[PAGE] || {})[city.toUpperCase()] || []);
    const skipped = dates.filter((d) => skip.has(d));
    // On the consular page, only dates up to OFC date + N weeks (popup setting) - Book now too.
    const capDate = PAGE === 'CONSULAR' ? consularLatest : null;
    const candidates = (rehearse ? dates : dates.filter((d) => d >= from && d <= C.latestDate))
      .filter((d) => !skip.has(d) && (!capDate || d <= capDate));
    if (!candidates.length) return { city, earliest: dates[0] || null, match: null, ...(skipped.length ? { skipped } : {}) };

    send({ type: 'SLOT_FOUND', city, date: candidates[0] });
    if (cancelled()) return { city, cancelled: true, earliest: dates[0], match: candidates[0] };
    if (!C.autoSubmit) return { city, earliest: dates[0], match: candidates[0] };
    const booking = await book(candidates);
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
    for (let i = 0; i < 25; i++) {
      const radios = timeRadios().filter((r) => !r.disabled && Number(r.dataset.slots) >= 1)
        .sort((a, b) => Number(b.dataset.slots) - Number(a.dataset.slots));
      if (radios.length) return radios;
      await sleep(100);
    }
    return [];
  }

  // Tries every open time on the earliest date, then the next dates. A slot is skipped when its
  // Submit stays greyed, the portal rejects it ("processing too many requests", PSE0601...), or
  // no answer comes back in time. Stops on a confirmed booking or a Cloudflare/rate-limit block.
  async function book(datesToTry) {
    const B = C.booking;
    const attempts = [];
    let tries = 0;
    const submit = findSubmit();
    if (!submit) return { bookError: 'Submit button not found - check selectors.submit', attempts };

    for (const iso of datesToTry.slice(0, B.maxDatesPerCity)) {
      if (cancelled()) return { cancelled: true, attempts };
      const clicked = await clickDate(iso);
      if (clicked.error) { attempts.push(`${iso}: ${clicked.error}`); continue; }
      const entries = await clicked.pending;
      if (cancelled()) return { cancelled: true, attempts };
      if (!entries) { attempts.push(`${iso}: times did not load`); continue; }
      if (blockReason(entries)) return { bookError: blockReason(entries), blocked: true, attempts };
      if (entries.data?.HasError) { attempts.push(`${iso}: ${portalError(entries.data)}`); continue; }
      const radios = await openRadios();
      if (!radios.length) { attempts.push(`${iso}: no open times`); continue; }

      for (const radio of radios) {
        if (cancelled()) return { cancelled: true, attempts };
        if (!radio.isConnected) continue; // table was rebuilt
        if (tries >= B.maxSubmitAttempts) return { bookError: `gave up after ${tries} Submit attempts`, attempts };
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
        tries++;
        if (cancelled()) return { cancelled: true, attempts };
        const pendingBook = waitFor('book', B.responseWaitMs);
        submit.click();
        const res = await pendingBook;
        // Submit already went out; a cancel now only stops further attempts.
        if (cancelled() && !res) return { cancelled: true, attempts, note: `Submit for ${iso} ${time} was already sent - check the page` };
        if (!res) {
          attempts.push(`${iso} ${time}: no answer in ${Math.round(B.responseWaitMs / 1000)}s (Submit greyed) - next slot`);
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
    return { bookError: `could not book any slot (${attempts.length} tried)`, attempts };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'PING') return reply({ ok: true });
    if (msg?.type === 'CANCEL') {
      const wasRunning = running;
      cancelGen++;
      // Release anything waiting on the portal so the running job notices right away.
      for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.resolve(null); }
      return reply({ wasRunning });
    }
    if (msg?.type !== 'RUN_CHECK') return;
    // Queue behind any check already running (e.g. a WhatsApp alert during a scheduled check).
    const opts = { manual: msg.manual === true, rehearse: msg.rehearse === true, fallback: msg.fallback || [], resetAfter: msg.resetAfter === 'always' ? 'always' : msg.resetAfter === true,
      consularLatest: msg.consularLatest || null };
    // A scheduled check that comes due while another run is still going (or waiting) is skipped,
    // so 5-minute windows can't pile up behind a slow calendar.
    if (msg.skipIfBusy && (running || waiting > 0)) {
      send({ type: 'NOTE', text: 'Skipped scheduled check - the previous run is still going' });
      return;
    }
    const gen = cancelGen;
    waiting++;
    queue = queue.then(async () => {
      waiting--;
      if (gen !== cancelGen) return; // cancelled while waiting in line
      activeGen = gen;
      running = true;
      try { await runCities(msg.cities, opts); } finally { running = false; }
    }).catch(() => {});
  });

  // Checks cities in order, pausing between them. Stops at a booking or a block. If a city had
  // dates but none could be booked, goes on to the `fallback` cities (once).
  // Back to the blank city option. The portal's onPostChange() then clears the calendar and,
  // with no post selected, sends no request - so this costs nothing from the daily budget.
  function resetCity() {
    const sel = document.querySelector(C.selectors.citySelect);
    const blank = sel && [...sel.options].find((o) => o.value === '');
    if (!blank || sel.value === '') return false;
    sel.value = '';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async function runCities(cities, { manual, rehearse = false, fallback = [], resetAfter = false, consularLatest = null }) {
    const todo = [...cities];
    const tried = new Set();
    let fellBack = false;
    let anyDates = false;
    for (let i = 0; todo.length; i++) {
      if (!alive() || cancelled()) return send({ type: 'NOTE', text: `Stopped - left the city dropdown alone${todo.length ? ` (skipped ${todo.join(', ')})` : ''}` });
      const city = todo.shift();
      tried.add(city);
      if (i > 0) {
        const [lo, hi] = C.cityGapSeconds;
        await sleep((lo + Math.random() * (hi - lo)) * 1000);
      }
      const elements = rehearse && i === 0 ? elementReport() : null;
      const result = await runCheck(city, manual || rehearse, { rehearse, consularLatest })
        .catch((e) => ({ city, error: String(e?.message || e) }));
      if (result.cancelled) {
        const skipped = result.notStarted ? [city, ...todo] : todo;
        const rest = skipped.length ? ` (skipped ${skipped.join(', ')})` : '';
        const where = result.notStarted ? `before ${city}` : `during ${city}`;
        return send({ type: 'NOTE', text: `Stopped ${where}${result.note ? ` - ${result.note}` : ''} - left the city dropdown alone${rest}` });
      }
      // A Cloudflare challenge: report what's left so it can be re-run after you pass the check.
      const resumeInfo = result.blocked && /403|non-JSON/.test(`${result.error || ''} ${result.bookError || ''}`)
        ? { challenge: true, resumeCities: [city, ...todo], resetAfter, manual } : {};
      send({ type: 'RESULT', result: { ...result, page: PAGE, ...resumeInfo, ...(rehearse ? { rehearse: true, elements } : {}) } });
      if (result.blocked || result.booked || result.testMode) return;
      if (result.match) anyDates = true;
      if (result.match && !fellBack && C.booking.tryOtherCitiesOnFail) {
        fellBack = true;
        todo.push(...fallback.filter((c) => !tried.has(c) && !todo.includes(c)));
      }
    }
    // Reaching here means nothing was booked (booked / blocked / test mode return above).
    //  resetAfter true:     back to blank only if no city had dates (Check now keeps unbookable
    //                       dates on screen so you can try by hand).
    //  resetAfter 'always': back to blank regardless (Book now, keep-alive).
    const reset = resetAfter === 'always' || (resetAfter && !anyDates);
    if (reset && alive() && resetCity()) {
      send({ type: 'NOTE', text: `${anyDates ? 'Nothing booked' : 'No dates'} - city dropdown reset to blank` });
    }
  }

  // Tell background the page is usable once the portal has filled the city dropdown (it loads the
  // posts with a request after the page opens). After an OFC booking the portal goes straight to
  // the consular page, and background checks it right away on this message.
  (async () => {
    for (let t = 0; t < 60000; t += 500) {
      const sel = document.querySelector(C.selectors.citySelect);
      if (sel && [...sel.options].some((o) => o.value)) return send({ type: 'PAGE_READY', page: PAGE });
      await sleep(500);
    }
  })();
})();
