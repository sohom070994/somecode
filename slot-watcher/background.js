// Schedules check windows, enforces the daily budget, pauses on rate limits, and raises alerts.
importScripts('config.js');
const C = self.SLOT_CONFIG;

const SCHEDULE_URLS = [
  'https://www.usvisascheduling.com/*/schedule*',
  'https://www.usvisascheduling.com/*/ofc-schedule*',
];

// ---- state (chrome.storage.local, reset daily) ----

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function getState() {
  const { state } = await chrome.storage.local.get('state');
  const s = { enabled: true, booked: false, pausedUntil: 0, count: 0, log: [], ...state };
  if (s.day !== dayKey()) Object.assign(s, { day: dayKey(), count: 0 });
  return s;
}

// All state writes go through one queue: each read-merge-write finishes before the next starts,
// so two writes at the same moment (e.g. the next check time and a log line) can't undo each
// other. `patch` can be an object, or a function of the current state that returns one.
let stateChain = Promise.resolve();
function patchState(patch) {
  const run = stateChain.then(async () => {
    const cur = await getState();
    const s = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
    await chrome.storage.local.set({ state: s });
    return s;
  });
  stateChain = run.catch(() => {});
  return run;
}

// Writes are queued so lines logged at the same moment can't overwrite each other.
let logChain = Promise.resolve();
function log(text) {
  logChain = logChain.then(() => writeLog(text)).catch(() => {});
  return logChain;
}

async function writeLog(text) {
  const now = new Date();
  await patchState((s) => ({ log: [`${now.toLocaleTimeString()}  ${text}`, ...s.log].slice(0, 40) }));
  // Every line is also kept until the next log-file save (saveLogFiles).
  if (C.logFiles?.enabled) {
    const { logPending = [] } = await chrome.storage.local.get('logPending');
    logPending.push({ day: dayKey(now), line: `${dayKey(now)} ${now.toTimeString().slice(0, 8)}  ${text}` });
    await chrome.storage.local.set({ logPending: logPending.slice(-50000) });
  }
}

// ---- log files: <slot-watcher>/logs/YYYY-MM-DD.log, appended every 2 hours ----
// Written directly to disk by a small local helper (native/logger.js, registered with Chrome by
// native/install.bat) - no save dialog, nothing goes through Chrome's downloads.

const LOG_HOST = 'com.slotwatcher.logger';

async function saveLogFiles() {
  await logChain; // let lines logged just now land first
  const { logPending = [] } = await chrome.storage.local.get('logPending');
  if (!logPending.length) return { written: 0 };
  let res;
  try {
    res = await chrome.runtime.sendNativeMessage(LOG_HOST, { action: 'append', entries: logPending });
  } catch (e) {
    res = { ok: false, error: e?.message || String(e) };
  }
  if (!res?.ok) {
    await log(`Log files: could not save (${res?.error || 'no answer'}) - lines kept for the next try. Run slot-watcher\\native\\install.bat once if this keeps happening.`);
    return { error: res?.error };
  }
  // Drop only what was saved; lines logged meanwhile stay for next time.
  const { logPending: now = [] } = await chrome.storage.local.get('logPending');
  await chrome.storage.local.set({ logPending: now.slice(logPending.length) });
  await log(`Saved ${res.written} log lines to ${res.dir}`);
  return { written: res.written, dir: res.dir };
}

async function ensureLogSaveAlarm() {
  const every = C.logFiles?.everyMinutes || 120;
  const a = await chrome.alarms.get('logsave');
  if (!C.logFiles?.enabled) { if (a) await chrome.alarms.clear('logsave'); return; }
  if (!a || a.periodInMinutes !== every) chrome.alarms.create('logsave', { periodInMinutes: every, delayInMinutes: every });
}

// Clean up after the removed log-file feature: its once-a-minute alarm and stored copies.
async function removeOldLogFileData() {
  await chrome.alarms.clear('logflush');
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('logfile_') || k === 'logDirty');
  if (keys.length) await chrome.storage.local.remove(keys);
}

// Off by default (config dailyCapOn: false); the popup checkbox flips it and the choice sticks.
// Rate-limit / Cloudflare pauses apply either way.
const capIsOff = (s) => (typeof s.capOff === 'boolean' ? s.capOff : !C.dailyCapOn);
const effectiveCap = (s) => (capIsOff(s) ? Infinity : C.dailyCap);

// ---- alerts ----

// Spoken alert + a "!" badge on the toolbar icon (cleared when the popup opens). Chrome pop-up
// notifications only if desktopNotifications is on - they cover the booking page.
function alertUser(title, message, speak = true) {
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
  chrome.action.setTitle({ title: `${title}: ${message}` });
  if (C.desktopNotifications) {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title, message, priority: 2 });
  }
  if (speak) chrome.tts.speak(`${title}. ${message}`, { rate: 1.0 });
}

// One log line per booking attempt (oldest first, so the summary that follows sits on top).
async function logAttempts(r) {
  for (const a of (r.attempts || []).slice(-10)) await log(`  ${r.city} ${a}`);
}

// ---- scheduling ----

// Next window (inside activeHours), plus the start delay - e.g. 10:55:40.
// The countdown, the "Starting" log line and the check itself all use this time.
// Start delay range [min, max] s: the popup's setting if you changed it, else config startDelaySeconds.
// A single number (older saved setting / config) means [n, n].
const delayRange = (v) => (Array.isArray(v) ? [v[0], v[1]] : Number.isFinite(v) ? [v, v] : null);
const startDelayOf = (s) => delayRange(s?.startDelaySeconds) || delayRange(C.startDelaySeconds) || [0, 0];
// Uniform random delay in the range, in seconds (fractional), re-picked for every scheduled check.
const pickStartDelay = ([lo, hi]) => lo + Math.random() * (hi - lo);
const fmtDelay = ([lo, hi]) => (lo === hi ? `${lo} s` : `${lo}-${hi} s random`);

// Extra windows (every 5 min) on unless you untick them in the popup (default from config).
const extraWindowsOn = (s) => (typeof s?.extraWindows === 'boolean' ? s.extraWindows : C.extraWindowsOn !== false);
// windowMinutes off the 5-minute grid (:02 :14 :27 ...) on unless you untick them in the popup.
const offGridWindowsOn = (s) => (typeof s?.offGridWindows === 'boolean' ? s.offGridWindows : C.offGridWindowsOn !== false);
const mainMinutesOf = (s) => C.windowMinutes.filter((m) => m % 5 === 0 || offGridWindowsOn(s));
// Active window minutes, sorted: [25, 55], plus the off-grid and extra minutes when they're on.
const windowMinutesOf = (s) => [...new Set([...mainMinutesOf(s), ...(extraWindowsOn(s) ? C.extraWindowMinutes || [] : [])])].sort((a, b) => a - b);
const fmtMinutes = (mins) => (mins.length === 12 && mins.every((m, i) => m === i * 5)
  ? 'every 5 min (:00, :05 ... :55)'
  : mins.map((m) => `:${String(m).padStart(2, '0')}`).join('/'));

// The delay can be longer than a minute (e.g. 90 s: the :55 window starts at :56:30), so the
// search starts `delay` back from `from`. `notBefore`: earliest window minute allowed.
function nextWindowAt(from = Date.now(), delaySeconds = 0, minutes = C.windowMinutes, notBefore = 0) {
  const delay = delaySeconds * 1000;
  const t = new Date(Math.max(from - delay, notBefore));
  t.setSeconds(0, 0);
  for (let i = 0; i <= 2 * 24 * 60; i++) {
    if (i > 0) t.setMinutes(t.getMinutes() + 1);
    const h = t.getHours();
    if (minutes.includes(t.getMinutes()) && h >= C.activeHours.start && h < C.activeHours.end
      && t.getTime() >= notBefore && t.getTime() + delay > from) {
      return t.getTime() + delay;
    }
  }
  return null;
}

// `notBefore`: earliest window minute allowed. After a scheduled check it's the minute after that
// check's window, so a fresh random delay can't reuse the same window (:55:37 then :55:45).
async function scheduleNext(notBefore = 0) {
  const s = await getState();
  await chrome.alarms.clear('window');
  if (!s.enabled || s.booked) return patchState({ nextRunAt: null, nextWindowStart: null });
  const delay = pickStartDelay(startDelayOf(s));
  const when = nextWindowAt(Date.now(), delay, windowMinutesOf(s), notBefore);
  if (when) chrome.alarms.create('window', { when });
  await patchState({ nextRunAt: when, nextWindowStart: when ? when - delay * 1000 : null });
}

function nextMidnight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// Consular limit: latest consular date allowed = OFC date + N weeks (null when off or no OFC date).
const consularWeeksOf = (s) => (Number.isInteger(s?.consularWeeks) ? s.consularWeeks : C.consularMaxWeeksAfterOfc || 0);
function consularLatestOf(s) {
  const weeks = consularWeeksOf(s);
  if (!weeks || !/^\d{4}-\d{2}-\d{2}$/.test(s.ofcDate || '')) return null;
  const d = new Date(`${s.ofcDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

// Cities ticked in the popup (all by default), always in config priority order.
const selectedCities = (s) => (Array.isArray(s.selectedCities) ? C.cities.filter((c) => s.selectedCities.includes(c)) : C.cities);

// Returns a short status for the popup. Manual checks skip the jitter and the enabled flag,
// but still respect the daily cap, rate-limit pause, and booked stop.
// `only` (from a WhatsApp alert) checks just those cities, without jitter.
// `resume` re-runs the cities a Cloudflare challenge interrupted (with that run's resetAfter).
// `resetAfter` (when given) overrides the default reset rule: true = back to blank if no city had
// dates; 'always' = back to blank unless something was booked.
async function runWindow({ manual = false, only = null, rehearse = false, resume = false, keepAlive = false, label = '', resetAfter: resetOverride } = {}) {
  const s = await getState();
  if (s.booked) return 'Already booked - checks stopped';
  if (!s.enabled && !manual) return 'Off';
  const skip = async (why) => { await log(`Skipped: ${why}`); return why; };
  if (Date.now() < s.pausedUntil) {
    return skip(s.pauseForChallenge
      ? 'paused for Cloudflare check - reload the schedule page, pass the check, load the calendar (or click Clear pause)'
      : `paused after a rate limit until ${new Date(s.pausedUntil).toLocaleTimeString()} (Clear pause to override)`);
  }
  const cap = effectiveCap(s);
  if (s.count >= cap) return skip(`daily cap reached (${s.count}/${cap}) - tick "Ignore daily cap" to continue`);

  // Never use the Cloudflare recovery window as the schedule tab.
  const tabs = (await chrome.tabs.query({ url: SCHEDULE_URLS })).filter((t) => !s.recovery || t.windowId !== s.recovery.windowId);
  if (!tabs.length) {
    if (!manual) alertUser('Visa slot watcher', 'Log in and leave the schedule page open so checks can run.', false);
    return skip('no schedule page open');
  }
  const tabId = await findReadyTab(tabs);
  if (!tabId) return skip('schedule tab did not respond - reload it (F5)');
  // Order is always C.cities: Chennai, Hyderabad, Kolkata, Mumbai, New Delhi.
  let cities, why = '';
  if (only) {
    cities = C.cities.filter((c) => only.includes(c)).concat(only.filter((c) => !C.cities.includes(c))).slice(0, cap - s.count);
    why = rehearse ? ' (BOOK NOW - earliest date, will submit)'
      : resume ? ' (resumed after Cloudflare check)'
      : keepAlive ? ' (keep-alive: no calendar load for a while)'
      : ' (WhatsApp alert)';
  } else if (manual) {
    // Cities ticked in the popup, in priority order, trimmed to budget.
    const picked = selectedCities(s);
    if (!picked.length) return skip('no cities ticked in the popup');
    cities = picked.slice(0, cap - s.count);
    why = ' (manual)';
  } else {
    // Scheduled: the cities ticked in the popup (same as Check now), in priority order.
    const picked = selectedCities(s);
    if (!picked.length) return skip('no cities ticked in the popup');
    cities = picked.slice(0, cap - s.count);
    why = ` (${label || 'scheduled'})`;
  }
  const names = cities.join(', ');
  await log(`Checking ${names}${why}`);
  const fast = manual || !!only;
  // If a city's dates can't be booked, content.js goes on to these (in priority order).
  // Keep-alive only touches its one city; otherwise unbookable dates fall back to the other cities.
  // Fallback: Check now and scheduled stay within the ticked cities; WhatsApp alerts and
  // resumed runs may fall back to any city.
  const fallback = keepAlive ? [] : (only ? C.cities : selectedCities(s)).filter((c) => !cities.includes(c));
  // Every run goes back to the blank city option when no city had dates (Check now, scheduled,
  // WhatsApp). Book now and keep-alive pass 'always' (blank unless booked).
  const resetAfter = resetOverride !== undefined ? resetOverride : true;
  // Scheduled checks are skipped (not queued) if a previous run is still going.
  const skipIfBusy = !manual && !only;
  const consularLatest = consularLatestOf(s);
  chrome.tabs.sendMessage(tabId, { type: 'RUN_CHECK', cities, manual: fast, rehearse, fallback, resetAfter, skipIfBusy, consularLatest }).catch(() => log('Schedule tab did not respond - reload it (F5)'));
  return `Checking ${names}...`;
}

const ping = (tabId) => chrome.tabs.sendMessage(tabId, { type: 'PING' }).then((r) => r?.ok === true, () => false);

// Tabs opened before the extension was installed/reloaded have no content script; inject it.
async function findReadyTab(tabs) {
  for (const tab of tabs) if (await ping(tab.id)) return tab.id;
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page-hook.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['config.js', 'content.js'] });
      if (await ping(tab.id)) {
        await log('Attached to an already-open schedule tab');
        return tab.id;
      }
    } catch (e) {
      await log(`Could not attach to tab: ${e?.message || e}`);
    }
  }
  return null;
}

// Runs inside the schedule page (MAIN world) and returns what autobook needs to learn:
// sanitized page HTML, jQuery handlers/datepicker settings, recent portal calls and responses.
function collectPageSnapshot(selectors) {
  const $ = window.jQuery;
  const fnText = (f) => (typeof f === 'function' ? String(f).slice(0, 6000) : f);
  const safe = (fn) => { try { return fn(); } catch (e) { return `error: ${e.message}`; } };
  const handlersOf = (el) => safe(() => {
    if (!el || !$) return null;
    const ev = $._data(el, 'events') || {};
    return Object.fromEntries(Object.entries(ev).map(([type, list]) =>
      [type, list.map((h) => ({ selector: h.selector || '', handler: fnText(h.handler) }))]));
  });
  const describe = (el) => el && { tag: el.tagName, id: el.id, name: el.getAttribute('name'), cls: el.className, disabled: !!el.disabled, html: el.outerHTML.slice(0, 20000) };

  const dp = document.querySelector(selectors.datepicker);
  const elements = {
    citySelect: document.querySelector(selectors.citySelect),
    datepicker: dp,
    timeSelect: document.querySelector(selectors.timeSelect),
    submit: document.querySelector(selectors.submit),
  };

  // Page HTML without scripts, styles, or hidden security tokens.
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script, style, svg, noscript, link, meta, iframe').forEach((n) => n.remove());
  clone.querySelectorAll('input[type="hidden"]').forEach((n) => n.setAttribute('value', '[removed]'));

  return {
    capturedAt: new Date().toISOString(),
    url: location.href,
    title: document.title,
    jqueryVersion: $?.fn?.jquery || null,
    jqueryUi: !!$?.ui,
    elements: Object.fromEntries(Object.entries(elements).map(([k, el]) => [k, describe(el)])),
    handlers: Object.fromEntries(Object.entries(elements).map(([k, el]) => [k, handlersOf(el)])),
    delegatedOnDocument: handlersOf(document),
    datepickerOptions: safe(() => {
      if (!dp || !$?.fn?.datepicker) return null;
      const o = $(dp).datepicker('option');
      return Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, fnText(v)]));
    }),
    allSelects: [...document.querySelectorAll('select')].map((s) => ({ id: s.id, name: s.getAttribute('name'), options: [...s.options].map((o) => `${o.value} = ${o.text.trim()}`).slice(0, 60) })),
    allButtons: [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn')].map((b) => ({ tag: b.tagName, id: b.id, text: (b.textContent || b.value || '').trim().slice(0, 60), disabled: !!b.disabled, onclick: b.getAttribute('onclick') })),
    pageFunctions: Object.keys(window).filter((k) => /sched|appoint|book|slot|calend|date|submit|post/i.test(k) && typeof window[k] === 'function').slice(0, 60).map((k) => ({ name: k, source: fnText(window[k]) })),
    recentRequests: window.__slotWatcherRecent || 'reload the schedule tab (F5) once to record requests',
    lastResponses: window.__slotWatcherLast || null,
    html: clone.outerHTML.slice(0, 600000),
  };
}

async function capturePage() {
  const tabs = await chrome.tabs.query({ url: SCHEDULE_URLS });
  if (!tabs.length) return log('Capture: no schedule page open');
  let snap;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id }, world: 'MAIN', func: collectPageSnapshot, args: [C.selectors],
    });
    snap = res?.result;
  } catch (e) {
    return log(`Capture failed: ${e?.message || e}`);
  }
  if (!snap) return log('Capture failed: page returned nothing');
  const json = JSON.stringify(snap, null, 2);
  await chrome.downloads.download({
    url: `data:application/json;charset=utf-8,${encodeURIComponent(json)}`,
    filename: 'slot-watcher/page-snapshot.json',
    conflictAction: 'overwrite',
    saveAs: false,
  });
  await log(`Captured page (${Math.round(json.length / 1024)} KB) to Downloads/slot-watcher/page-snapshot.json`);
}

// Dry run: log how the last few messages in the open WhatsApp group would be handled.
async function testWhatsApp() {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!tabs.length) return log('WhatsApp test: no web.whatsapp.com tab open');
  const scan = () => chrome.tabs.sendMessage(tabs[0].id, { type: 'WA_SCAN', count: 8 }).catch(() => null);
  let res = await scan();
  if (!res) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['config.js', 'whatsapp.js'] });
      res = await scan();
    } catch {}
  }
  if (!res) return log('WhatsApp test: tab did not respond - press F5 on the WhatsApp tab');
  if (res.error) return log(`WhatsApp test: ${res.error}`);
  // Oldest first, so the newest message ends up at the top of the log.
  for (const r of res.results) {
    const cities = r.cities.length ? ` ${r.cities.join('+')}` : '';
    await log(`  [${r.when}] ${r.verdict}${cities} - "${r.text}"`);
  }
  await log(`WhatsApp test (dry run, no checks made): last ${res.results.length} messages`);
}

// ---- messages ----

async function onRehearsal(r) {
  const e = r.elements || {};
  const mark = (ok) => (ok ? 'found' : 'NOT FOUND');
  const tag = `BOOK NOW ${r.city}`;
  // Logged oldest-first so the verdict ends up on top.
  if (r.elements) {
    await log(`${tag}: elements - city dropdown ${mark(e.cityDropdown)}, date picker ${mark(e.datePicker)} (${C.selectors.datepicker}), ` +
      `time table ${e.timeDropdown ? 'found' : 'not visible yet'}, Submit ${e.submitButton ? 'found' : 'not visible yet'}`);
  }
  await logAttempts(r);
  let verdict;
  if (r.error) verdict = `could not run - ${r.error}`;
  else if (!r.match) verdict = 'no dates available for this city right now';
  else if (r.bookError) verdict = `FAILED at ${r.match} - ${r.bookError}`;
  else if (r.booked === 'confirmed') verdict = `BOOKED ${r.match} ${r.time} - portal confirmed`;
  else if (r.booked === 'submitted') verdict = `SUBMITTED ${r.match} ${r.time}${r.note ? ` - ${r.note}` : ''}`;
  else if (r.testMode) verdict = `ready: ${r.match} ${r.time} selected, NOT submitted because testMode is on in config.js`;
  else verdict = 'unexpected result';
  await log(`${tag}: ${verdict}`);
  if (!r.match) return;
  if (r.bookError) alertUser('Could not book', `${r.city} ${r.match}: ${r.bookError}`);
  else if (r.booked === 'confirmed') await markBooked(`${r.city} ${r.match} ${r.time}`, r.page, r.match);
  else if (r.booked === 'submitted') alertUser('Booking submitted', `${r.city} ${r.match} ${r.time} - check the page`);
}

async function onResult(r) {
  // Remember what a Cloudflare challenge interrupted, so it can be re-run once the check is passed.
  if (r.blocked && r.challenge && r.resumeCities?.length) {
    await patchState({ resume: { cities: r.resumeCities, resetAfter: r.resetAfter ?? false, manual: !!r.manual } });
  }
  if (r.skipped?.length) await log(`${r.city}: skipped ${r.skipped.join(', ')} (in skipDates)`);
  if (r.rehearse) return onRehearsal(r);
  if (r.error) return log(`${r.city}: ${r.error}`);
  if (!r.match) return log(`${r.city}: nothing in range (earliest ${r.earliest || 'none'})`);
  await logAttempts(r);
  if (r.bookError) {
    await log(`${r.city}: ${r.match} found, autobook failed - ${r.bookError}`);
    return alertUser('Could not book', `${r.city} ${r.match}: ${r.bookError}`);
  }
  if (r.testMode) {
    await log(`${r.city}: TEST MODE - would have booked ${r.match} ${r.time}`);
    return alertUser('Test mode: ready to submit', `${r.city} ${r.match} ${r.time}. Click Submit yourself if you want it.`);
  }
  if (r.booked === 'confirmed') return markBooked(`${r.city} ${r.match} ${r.time}`, r.page, r.match);
  if (r.booked) await log(`${r.city}: submitted ${r.match} ${r.time}${r.note ? ` - ${r.note}` : ''}`);
}

// ---- Cloudflare challenge handling ----
// Reported by content.js (a failed calendar/times/booking request) and by the response watcher
// below (any portal response with "cf-mitigated: challenge"). Queued so two reports of the same
// challenge can't open two windows.

let challengeChain = Promise.resolve();
function handleChallenge(reason) {
  challengeChain = challengeChain.then(() => doHandleChallenge(reason)).catch(() => {});
  return challengeChain;
}

async function doHandleChallenge(reason) {
  const s = await getState();
  const RWc = C.recoveryWindow || {};
  if (s.recovery && !s.recovery.proactive) {
    // Already waiting for you in the recovery window: just bring it forward.
    try { await chrome.windows.update(s.recovery.windowId, { focused: true, drawAttention: true }); } catch {}
    return;
  }
  // Measurement: how long after the last pass did this challenge come, vs. the cookie's expiry?
  if (s.clearance?.setAt) {
    const mins = ((Date.now() - s.clearance.setAt) / 60000).toFixed(1);
    const exp = s.clearance.expiresAt ? `cookie said valid until ${new Date(s.clearance.expiresAt).toLocaleTimeString()}` : 'cookie had no expiry';
    await log(`Cloudflare: challenged ${mins} min after the last pass (${exp})`);
  }
  if (s.lastChallengePassAt && Date.now() - s.lastChallengePassAt < (RWc.repeatMinutes || 5) * 60000) {
    // Challenged again right after passing: the portal wants us to slow down.
    const until = Date.now() + (RWc.cooldownMinutes || 30) * 60000;
    await patchState({ pausedUntil: until, pauseForChallenge: false });
    await log(`PAUSED until ${new Date(until).toLocaleTimeString()}: Cloudflare challenged again within ${RWc.repeatMinutes || 5} min of passing`);
    alertUser('Visa checks paused', `Cloudflare challenged again soon after the last check. Resuming at ${new Date(until).toLocaleTimeString()}.`);
    return;
  }
  // Lifted by recoveryPassed() (or the next successful calendar load, DAYS_OK).
  await patchState({ pausedUntil: nextMidnight(), pauseForChallenge: true });
  let opened = false;
  if (RWc.enabled) {
    try { await openRecovery(reason); opened = true; } catch (e) { await log(`Cloudflare: could not open recovery window (${e?.message || e})`); }
  }
  if (!opened) {
    await log(`PAUSED: ${reason} - reload the schedule page and complete the check to resume`);
    alertUser('Cloudflare check needed', 'Reload the schedule page, complete the check, and load the calendar once. Checks resume automatically.');
  }
}

// Response watcher: any portal response flagged by Cloudflare as a checkbox challenge, from any
// request in the schedule tab (your clicks, keep-alive, the extension's checks). Observe-only.
chrome.webRequest?.onHeadersReceived.addListener((details) => {
  if (!C.cloudflare?.watchResponses) return;
  const flagged = (details.responseHeaders || []).some((h) => h.name.toLowerCase() === 'cf-mitigated' && /challenge/i.test(h.value || ''));
  if (!flagged) return;
  (async () => {
    const s = await getState();
    if (s.recovery && details.tabId === s.recovery.tabId) return; // the recovery window itself
    let where = '';
    try { where = new URL(details.url).searchParams.get('route') || new URL(details.url).pathname; } catch {}
    await handleChallenge(`Cloudflare challenge seen on ${where || 'a portal request'}`);
  })().catch(() => {});
}, { urls: ['https://www.usvisascheduling.com/*'] }, ['responseHeaders']);

// ---- Cloudflare clearance timer (proactive) ----
// When you pass the check, Cloudflare sets cf_clearance with an expiry. We log it (to compare with
// when challenges really happen) and, shortly before it runs out with a check coming up, open the
// recovery window early so you can tick the box before the check fails.

async function recordClearance(cookie) {
  const expiresAt = cookie.expirationDate ? Math.round(cookie.expirationDate * 1000) : null;
  await patchState({ clearance: { setAt: Date.now(), expiresAt, prompted: false } });
  const left = expiresAt ? ` - valid until ${new Date(expiresAt).toLocaleTimeString()} (${Math.round((expiresAt - Date.now()) / 60000)} min)` : ' - no expiry time given';
  await log(`Cloudflare clearance set${left}`);
}

// Next thing that will load the calendar: the scheduled check or the keep-alive.
function nextCalendarLoadAt(s) {
  const times = [];
  if (s.nextRunAt) times.push(s.nextRunAt);
  if (C.keepAlive?.enabled) times.push((s.lastActivityAt || 0) + (C.keepAlive.minutes || 14) * 60000);
  return times.length ? Math.min(...times) : null;
}

async function clearanceTick() {
  const CF = C.cloudflare || {};
  if (!CF.proactive || !C.recoveryWindow?.enabled) return;
  const s = await getState();
  const cl = s.clearance;
  if (!cl?.expiresAt || cl.prompted || s.recovery || !s.enabled || s.booked || Date.now() < s.pausedUntil) return;
  const now = Date.now();
  const nextLoad = nextCalendarLoadAt(s);
  const expiringSoon = cl.expiresAt - now <= (CF.leadSeconds || 90) * 1000;
  const loadSoon = nextLoad != null && nextLoad - now <= (CF.upcomingSeconds || 150) * 1000;
  if (!expiringSoon || !loadSoon) return;
  const tabs = (await chrome.tabs.query({ url: SCHEDULE_URLS }));
  if (!tabs.length) return;
  await patchState({ clearance: { ...cl, prompted: true } });
  const when = cl.expiresAt <= now ? 'expired' : `expires at ${new Date(cl.expiresAt).toLocaleTimeString()}`;
  await openRecovery(`clearance ${when}, next check at ${new Date(nextLoad).toLocaleTimeString()}`, { proactive: true });
}

async function ensureClearanceAlarm() {
  const a = await chrome.alarms.get('cfwatch');
  if (!C.cloudflare?.proactive) { if (a) await chrome.alarms.clear('cfwatch'); return; }
  if (!a) chrome.alarms.create('cfwatch', { periodInMinutes: 1, delayInMinutes: 1 });
}

// ---- Cloudflare recovery window ----
// On a Cloudflare checkbox challenge: open a small window on the portal so YOU can tick the box,
// notice when it's passed (cf_clearance cookie, or the window's page loading normally after the
// challenge), close the window, lift the pause and re-run what the challenge interrupted.
// The extension never clicks the checkbox itself.

const RW = () => C.recoveryWindow || {};
const isChallengeTitle = (t = '') => /just a moment|attention required|verify you are human|checking your browser|security check/i.test(t);

// proactive: opened early because the clearance is about to run out (no challenge yet). If the
// window shows no checkbox, the clearance is still accepted and the window just closes.
async function openRecovery(reason, { proactive = false } = {}) {
  const s = await getState();
  if (s.recovery?.windowId != null) {
    try {
      await chrome.windows.update(s.recovery.windowId, { focused: true, drawAttention: true });
      // A real challenge while an early window is open: it's now a real recovery.
      if (!proactive && s.recovery.proactive) await patchState({ recovery: { ...s.recovery, proactive: false } });
      if (!proactive) await log('Cloudflare: recovery window already open - brought to front');
      return;
    } catch { /* it was closed; open a new one */ }
  }
  const url = RW().urls[0];
  const win = await chrome.windows.create({ url, type: 'popup', focused: true, width: RW().width || 520, height: RW().height || 680 });
  const tabId = win.tabs?.[0]?.id ?? null;
  await patchState({ recovery: { windowId: win.id, tabId, openedAt: Date.now(), urlIdx: 0, sawChallenge: false, proactive } });
  chrome.alarms.create('recoveryTimeout', { when: Date.now() + (RW().timeoutMinutes || 10) * 60000 });
  if (proactive) {
    await log(`Cloudflare: ${reason} - recovery window opened early on ${url}: tick the box if it shows one`);
    alertUser('Cloudflare check coming up', 'Tick the box in the window that just opened, before the next check runs.');
  } else {
    await log(`Cloudflare check needed (${reason}) - recovery window opened on ${url}: tick the box there`);
    alertUser('Cloudflare check needed', 'Tick the box in the window that just opened. Checks resume by themselves.');
  }
}

let passing = false;
async function recoveryPassed(how) {
  if (passing) return;
  passing = true;
  try {
    const s = await getState();
    const rw = s.recovery;
    if (!rw) return;
    await patchState({ recovery: null, pausedUntil: 0, pauseForChallenge: false, lastChallengePassAt: Date.now() });
    await chrome.alarms.clear('recoveryTimeout');
    try { await chrome.windows.remove(rw.windowId); } catch {}
    await log(`Cloudflare check passed (${how}) - window closed, checks resumed`);
    chrome.action.setBadgeText({ text: '' });
    chrome.tts.speak('Cloudflare passed. Resuming.', { rate: 1.0 });
    const resume = s.resume;
    await patchState({ resume: null });
    if (RW().retryAfterPass && resume?.cities?.length) {
      await runWindow({ manual: resume.manual, only: resume.cities, resume: true, resetAfter: resume.resetAfter });
    }
  } finally {
    passing = false;
  }
}

// The page on this URL showed no checkbox: try the next configured URL, or resume anyway.
async function nextRecoveryUrl(tabId) {
  const s = await getState();
  const rw = s.recovery;
  if (!rw || rw.tabId !== tabId || rw.sawChallenge) return;
  if (rw.proactive) {
    // Opened early and no checkbox: the clearance is still accepted. Close quietly (no
    // schedule-page fallback, which would cost a page view) and leave checks as they were.
    await patchState({ recovery: null });
    await chrome.alarms.clear('recoveryTimeout');
    try { await chrome.windows.remove(rw.windowId); } catch {}
    const exp = s.clearance?.expiresAt ? ` (cookie said ${new Date(s.clearance.expiresAt).toLocaleTimeString()})` : '';
    await log(`Cloudflare: no checkbox needed yet - clearance still accepted${exp}; early window closed`);
    return;
  }
  const next = rw.urlIdx + 1;
  if (next < RW().urls.length) {
    await patchState({ recovery: { ...rw, urlIdx: next } });
    await log(`Cloudflare: no checkbox on ${RW().urls[rw.urlIdx]} - trying ${RW().urls[next]}`);
    try { await chrome.tabs.update(tabId, { url: RW().urls[next] }); } catch {}
    return;
  }
  await recoveryPassed('no checkbox appeared in the recovery window - trying again');
}

async function recoveryTimedOut() {
  const s = await getState();
  if (!s.recovery) return;
  await log(`Cloudflare check not done after ${RW().timeoutMinutes || 10} min - checks stay paused; the window is still open`);
  alertUser('Cloudflare check still waiting', 'Tick the box in the recovery window to resume checks.');
}

// Main pass signal: Cloudflare sets cf_clearance when the check is passed.
chrome.cookies?.onChanged.addListener(async ({ removed, cookie }) => {
  if (removed || cookie?.name !== 'cf_clearance' || !/(^|\.)usvisascheduling\.com$/.test(cookie.domain || '')) return;
  await recordClearance(cookie); // every pass, wherever you ticked the box
  const s = await getState();
  if (s.recovery) await recoveryPassed('Cloudflare clearance cookie set');
});

// Backup signal + "no checkbox here" detection, from the recovery tab's title / load state.
chrome.tabs.onUpdated?.addListener(async (tabId, info, tab) => {
  const s = await getState();
  const rw = s.recovery;
  if (!rw || tabId !== rw.tabId) return;
  const title = info.title ?? tab?.title ?? '';
  if (isChallengeTitle(title)) {
    if (!rw.sawChallenge) {
      await patchState({ recovery: { ...rw, sawChallenge: true } });
      await log('Cloudflare: checkbox showing in the recovery window');
    }
    return;
  }
  if (info.status !== 'complete') return;
  if (rw.sawChallenge) return recoveryPassed('recovery page loaded normally after the check');
  // Give the challenge a few seconds to appear before deciding this URL has none.
  setTimeout(() => nextRecoveryUrl(tabId).catch(() => {}), (RW().noChallengeWaitSeconds || 6) * 1000);
});

// You closed the window yourself without passing.
chrome.windows?.onRemoved.addListener(async (windowId) => {
  const s = await getState();
  if (s.recovery?.windowId !== windowId) return;
  await patchState({ recovery: null });
  await chrome.alarms.clear('recoveryTimeout');
  await log('Cloudflare: recovery window closed before the check passed - still paused (reload the schedule page or click Clear pause)');
});

// ---- session keep-alive ----
// The portal logs you out after ~15 min without activity; a calendar load counts as activity.
// Checked once a minute: if no calendar has loaded for keepAlive.minutes, check the keep-alive
// city (book if it can), then go back to the blank city option unless something was booked.

async function ensureKeepAliveAlarm() {
  const a = await chrome.alarms.get('keepalive');
  if (!C.keepAlive?.enabled) { if (a) await chrome.alarms.clear('keepalive'); return; }
  if (!a) chrome.alarms.create('keepalive', { periodInMinutes: 1, delayInMinutes: 1 });
}

async function keepAliveTick() {
  const K = C.keepAlive || {};
  if (!K.enabled) return;
  const s = await getState();
  if (!s.enabled || s.booked || Date.now() < s.pausedUntil) return;
  if (Date.now() - (s.lastActivityAt || 0) < (K.minutes || 14) * 60000) return;
  // Only when the schedule page is open (no "no schedule page" log every minute otherwise).
  const tabs = (await chrome.tabs.query({ url: SCHEDULE_URLS })).filter((t) => !s.recovery || t.windowId !== s.recovery.windowId);
  if (!tabs.length) return;
  await patchState({ lastActivityAt: Date.now() }); // don't fire again next minute if this one fails
  await log(`Keep-alive: no calendar load for ${K.minutes || 14} min - checking ${K.city} to keep the session active`);
  await runWindow({ only: [K.city], keepAlive: true, resetAfter: 'always' });
}

// The portal answered AllScheduled (or the confirmation page loaded): stop everything.
// An OFC booking doesn't stop anything: the portal goes straight to the consular page, which is
// checked as soon as it opens (PAGE_READY) and then on the usual timer. A consular booking (or the
// confirmation page) stops all automatic checks.
async function markBooked(what, page, date) {
  const s = await getState();
  if (s.booked) return;
  if (page === 'OFC') {
    // The OFC date sets the consular limit (popup "Consular within N weeks of OFC").
    await patchState({ consularNext: true, ...(date ? { ofcDate: date } : {}) });
    await log(`OFC BOOKED ${what} - checking the consular page as soon as it opens, then on the usual timer`);
    alertUser('OFC appointment booked', `${what}. Now looking for a consular slot.`);
    return;
  }
  await patchState({ booked: true, bookedPage: page || 'CONFIRMATION' });
  await log(`BOOKED ${what} - automatic checks stopped`);
  alertUser('Appointment booked', `${what}. Automatic checks are now off.`);
  await scheduleNext();
}

// A "booked" stop saved before OFC bookings stopped counting (no bookedPage) came from the OFC
// booking, so lift it: the consular page still needs checking.
async function clearLegacyOfcStop() {
  const s = await getState();
  if (!s.booked || s.bookedPage) return;
  await patchState({ booked: false });
  await log('Lifted the "booked" stop left by the OFC booking - checks run on the consular page now');
  await scheduleNext();
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    switch (msg?.type) {
      case 'DAYS_REQUEST': {
        // Any calendar load (yours or the extension's) counts as session activity for keep-alive.
        await patchState((s) => ({ count: s.count + 1, lastActivityAt: Date.now() }));
        break;
      }
      case 'NOTE':
        await log(msg.text);
        break;
      case 'PAGE_READY': {
        // First consular page load after an OFC booking: check it right away (once).
        const st = await getState();
        if (msg.page !== 'CONSULAR' || !st.consularNext) break;
        await patchState({ consularNext: false });
        await log('Consular page open after the OFC booking - checking now');
        await runWindow({ label: 'consular, right after OFC booking' });
        break;
      }
      case 'BLOCKED':
        if (msg.untilMidnight) {
          await patchState({ pausedUntil: nextMidnight(), pauseForChallenge: false });
          await log(`PAUSED until tomorrow: ${msg.reason}`);
          alertUser('Visa checks paused', `${msg.reason}. Checks resume tomorrow.`);
        } else if (msg.challenge) {
          await handleChallenge(msg.reason);
        } else {
          const until = Date.now() + C.rateLimitPauseMinutes * 60000;
          await patchState({ pausedUntil: until, pauseForChallenge: false });
          await log(`PAUSED until ${new Date(until).toLocaleTimeString()}: ${msg.reason}`);
          alertUser('Visa checks paused', `${msg.reason}. Resuming at ${new Date(until).toLocaleTimeString()}.`);
        }
        break;
      case 'DAYS_OK': {
        const s = await getState();
        if (s.recovery) {
          await recoveryPassed('calendar loaded again');
        } else if (s.pauseForChallenge && Date.now() < s.pausedUntil) {
          await patchState({ pausedUntil: 0, pauseForChallenge: false });
          await log('Calendar loaded again - Cloudflare check passed, checks resumed');
        }
        break;
      }
      case 'CAPTURE':
        await capturePage();
        break;
      case 'CANCEL': {
        // Stop the running check (and drop queued ones) so you can pick a city by hand.
        const tabs = await chrome.tabs.query({ url: SCHEDULE_URLS });
        let stopped = false;
        for (const tab of tabs) {
          const r = await chrome.tabs.sendMessage(tab.id, { type: 'CANCEL' }).catch(() => null);
          stopped = stopped || !!r?.wasRunning;
        }
        await log(stopped ? 'Stop requested - halting the running check' : 'Stop: no check was running');
        reply({ status: stopped ? 'Stopping…' : 'Nothing running' });
        return;
      }
      case 'WA_TEST':
        await testWhatsApp();
        break;
      case 'COMMUNITY_ALERT': {
        const W = C.whatsapp;
        const s = await getState();
        const cities = C.cities.filter((c) => (msg.cities || []).includes(c));
        if (!W?.enabled || !cities.length) break;
        await patchState({ alerts: [{ cities, at: msg.at }, ...(s.alerts || [])].slice(0, 20) });
        await log(`WhatsApp: ${cities.join(', ')} - "${String(msg.text || '').slice(0, 70)}"`);
        if (!W.triggerCheck) break;
        const last = { ...(s.lastTriggered || {}) };
        const due = cities.filter((c) => Date.now() - (last[c] || 0) > W.cityCooldownMinutes * 60000);
        if (!due.length) {
          await log(`WhatsApp: ${cities.join(', ')} checked recently - waiting for cooldown`);
          break;
        }
        for (const c of due) last[c] = Date.now();
        await patchState({ lastTriggered: last });
        await runWindow({ only: due });
        break;
      }
      case 'SLOT_FOUND':
        alertUser('Visa slot found', `${msg.city} on ${msg.date}`);
        break;
      case 'RESULT':
        await onResult(msg.result);
        break;
      case 'BOOKED':
        await markBooked('confirmation page reached');
        break;
      case 'GET_STATE': {
        const st = await getState();
        reply({ state: st, cap: C.dailyCap, capOff: capIsOff(st), testMode: C.testMode, cities: C.cities, skipDates: C.skipDates || {}, keepAlive: C.keepAlive || null, startDelaySeconds: startDelayOf(st),
          extraWindows: extraWindowsOn(st), extraWindowMinutes: C.extraWindowMinutes || [], windowMinutes: windowMinutesOf(st),
          mainWindowMinutes: C.windowMinutes, offGridWindows: offGridWindowsOn(st),
          consularWeeks: consularWeeksOf(st), ofcDate: st.ofcDate || '', consularLatest: consularLatestOf(st) });
        return;
      }
      case 'SET_SELECTED':
        await patchState({ selectedCities: C.cities.filter((c) => (msg.cities || []).includes(c)) });
        break;
      case 'SET_START_DELAY': {
        const num = (v) => { const raw = String(v ?? '').trim(); return raw === '' ? NaN : Math.round(Number(raw)); }; // empty box is not 0
        const lo = num(msg.min), hi = num(msg.max);
        const ok = (n) => Number.isFinite(n) && n >= 0 && n <= 600;
        if (!ok(lo) || !ok(hi)) { reply({ ok: false, error: 'Enter 0-600 seconds' }); return; }
        if (lo > hi) { reply({ ok: false, error: 'Min must be <= max' }); return; }
        await patchState({ startDelaySeconds: [lo, hi] });
        await scheduleNext(); // move the pending alarm (and the countdown) right away, with a fresh random delay
        await log(`Scheduled checks now start ${fmtDelay([lo, hi])} after ${fmtMinutes(windowMinutesOf(await getState()))}`);
        reply({ ok: true, seconds: [lo, hi] });
        return;
      }
      case 'SET_EXTRA_WINDOWS': {
        await patchState({ extraWindows: !!msg.on });
        await scheduleNext(); // countdown moves to the next active window right away
        const s = await getState();
        await log(`Scheduled checks at ${fmtMinutes(windowMinutesOf(s))} past each hour (+${fmtDelay(startDelayOf(s))})`);
        break;
      }
      case 'SET_OFFGRID_WINDOWS': {
        await patchState({ offGridWindows: !!msg.on });
        await scheduleNext();
        const s = await getState();
        await log(`Scheduled checks at ${fmtMinutes(windowMinutesOf(s))} past each hour (+${fmtDelay(startDelayOf(s))})`);
        break;
      }
      case 'SET_CONSULAR_LIMIT': {
        const weeks = Math.max(0, Math.round(Number(msg.weeks) || 0));
        // A half-typed year (0002-...) is not a date: keep the box empty instead.
        const ofcDate = /^20\d{2}-\d{2}-\d{2}$/.test(msg.ofcDate || '') ? msg.ofcDate : '';
        await patchState({ consularWeeks: weeks, ofcDate });
        const latest = consularLatestOf(await getState());
        await log(!weeks ? 'Consular limit off - any consular date can be booked'
          : !latest ? `Consular limit ${weeks} weeks after OFC - enter the OFC date in the popup to apply it`
          : `Consular dates limited to ${latest} or earlier (OFC ${ofcDate} + ${weeks} weeks)`);
        break;
      }
      case 'SET_CAP_OFF':
        await patchState({ capOff: !!msg.off });
        await log(msg.off ? 'Daily cap off' : `Daily cap on (${C.dailyCap}/day)`);
        break;
      case 'REHEARSE': {
        const city = String(msg.city || '').trim().toUpperCase();
        if (!city) { reply({ status: 'Type a city first' }); return; }
        // Back to the blank city option unless something gets booked.
        reply({ status: await runWindow({ manual: true, only: [city], rehearse: true, resetAfter: 'always' }) });
        return;
      }
      case 'CHECK_NOW':
        reply({ status: await runWindow({ manual: true }) });
        return;
      case 'SET_ENABLED':
        await patchState({ enabled: !!msg.enabled });
        await scheduleNext();
        break;
      case 'CLEAR_PAUSE':
        await patchState({ pausedUntil: 0, pauseForChallenge: false, booked: false, bookedPage: null });
        await scheduleNext();
        break;
    }
    reply({ ok: true });
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'recoveryTimeout') return recoveryTimedOut();
  if (alarm.name === 'logsave') return saveLogFiles().catch(() => {});
  if (alarm.name === 'keepalive') return keepAliveTick().catch(() => {});
  if (alarm.name === 'cfwatch') return clearanceTick().catch(() => {});
  if (alarm.name !== 'window') return;
  const s = await getState();
  await log(`Starting scheduled check (${selectedCities(s).join(' → ') || 'no cities ticked'})`);
  // Next check: a later window minute than this one (its minute start was saved when scheduled).
  const windowStart = s.nextWindowStart || Math.floor(alarm.scheduledTime / 60000) * 60000;
  try { await runWindow(); } finally { await scheduleNext(windowStart + 60000); }
});

chrome.runtime.onInstalled.addListener(() => scheduleNext());
chrome.runtime.onStartup.addListener(() => scheduleNext());
removeOldLogFileData().catch(() => {});
clearLegacyOfcStop().catch(() => {});
ensureLogSaveAlarm().catch(() => {});
ensureKeepAliveAlarm().catch(() => {});
ensureClearanceAlarm().catch(() => {});
