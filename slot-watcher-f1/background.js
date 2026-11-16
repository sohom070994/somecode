// Schedules check windows, enforces the daily budget, pauses on rate limits, and raises alerts.
importScripts('config.js', 'login.js');
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
  if (s.day !== dayKey()) Object.assign(s, { day: dayKey(), count: 0, pageViews: 0 });
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
  await patchState((s) => ({ log: [`${dayKey(now).slice(5)} ${now.toLocaleTimeString()}  ${text}`, ...s.log].slice(0, 2000) }));
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

const LOG_HOST = 'com.slotwatcher.f1.logger';

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
    await log(`Log files: could not save (${res?.error || 'no answer'}) - lines kept for the next try. Run slot-watcher-f1\\native\\install.bat once if this keeps happening.`);
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
// `popup` forces a Chrome notification that stays until you close it.
function alertUser(title, message, speak = true, popup = false) {
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
  chrome.action.setTitle({ title: `${title}: ${message}` });
  if (C.desktopNotifications || popup) {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title, message, priority: 2, requireInteraction: popup });
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
  // Status tab check statusTab.leadSeconds before the check. Too close to now: the check runs it itself.
  await chrome.alarms.clear('preflight');
  const lead = (C.statusTab?.leadSeconds ?? 60) * 1000;
  if (when && C.statusTab?.enabled && when - lead > Date.now() + 1000) chrome.alarms.create('preflight', { when: when - lead });
  await patchState({ nextRunAt: when, nextWindowStart: when ? when - delay * 1000 : null });
}

// ---- follow-up checks: after a scheduled check, re-check every N s for the next M min ----
// Settings come only from config repeatChecks (the popup just displays them).
const repeatOf = (s) => ({
  on: !!C.repeatChecks?.enabled,
  everySec: C.repeatChecks?.everySeconds || 30,
  forMin: C.repeatChecks?.forMinutes || 5,
});

// Cities for follow-up checks: the popup's own ticks, else config repeatChecks.cities, else all
// cities. Always in config priority order; independent of the regular selectedCities.
const repeatCitiesOf = (s) => {
  const list = Array.isArray(C.repeatChecks?.cities) ? C.repeatChecks.cities : null;
  return list ? C.cities.filter((c) => list.includes(c)) : C.cities;
};

let repeatTimer = null;
async function stopRepeat(why) {
  clearTimeout(repeatTimer);
  repeatTimer = null;
  await chrome.alarms.clear('repeat');
  const s = await getState();
  if (s.repeatUntil || s.repeatNextAt) {
    await patchState({ repeatUntil: 0, repeatNextAt: 0 });
    if (why) await log(`Follow-up checks stopped: ${why}`);
  }
}

// Called when a scheduled check starts: (re)starts the follow-up span from now.
async function startRepeat() {
  const s = await getState();
  const r = repeatOf(s);
  if (!r.on || r.everySec < 1 || r.forMin < 1) return stopRepeat();
  const cities = repeatCitiesOf(s);
  if (!cities.length) return stopRepeat('no follow-up cities ticked');
  const until = Date.now() + r.forMin * 60000;
  await patchState({ repeatUntil: until });
  await log(`Follow-up checks: ${cities.join(', ')} every ${r.everySec} s until ${new Date(until).toLocaleTimeString()} (${r.forMin} min)`);
  return queueRepeat(r.everySec * 1000);
}

// Next follow-up in `ms`. setTimeout is exact; the alarm (Chrome's minimum is 30 s) is the backup if
// the service worker is stopped in between. repeatNextAt makes whichever fires second a no-op.
async function queueRepeat(ms) {
  const s = await getState();
  const at = Date.now() + ms;
  if (!s.repeatUntil || at > s.repeatUntil) return stopRepeat('span finished');
  clearTimeout(repeatTimer);
  await patchState({ repeatNextAt: at });
  repeatTimer = setTimeout(() => repeatTick().catch(() => {}), ms);
  await chrome.alarms.create('repeat', { when: Math.max(at, Date.now() + 30000) });
}

async function repeatTick() {
  const s = await getState();
  if (!s.repeatUntil || Date.now() < s.repeatNextAt - 1500) return; // stopped, or not due yet
  if (Date.now() > s.repeatUntil) return stopRepeat('span finished');
  if (!s.enabled) return stopRepeat('scheduled checks are off');
  if (s.booked) return stopRepeat('already booked');
  if (Date.now() < s.pausedUntil) return stopRepeat('checks are paused');
  const every = repeatOf(s).everySec * 1000;
  await patchState({ repeatNextAt: 0 });
  await runWindow({ label: 'follow-up' }); // skipped by the page if the previous run is still going
  await queueRepeat(every);
}

function nextMidnight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// Every automatic pause starts here, so the log always has one "AUTO-PAUSE started" line saying
// which kind, until when, why, and what ends it.
async function startAutoPause({ kind, reason, until, challenge = false, ends }) {
  await patchState({ pausedUntil: until, pauseForChallenge: challenge, pauseKind: kind });
  const mins = Math.round((until - Date.now()) / 60000);
  await log(`AUTO-PAUSE started [${kind}] until ${new Date(until).toLocaleTimeString()} (${mins} min) - why: ${reason} - ends: ${ends}`);
}

// Consular limit: latest consular date allowed = OFC date + N weeks (null when off or no OFC date).
const consularWeeksOf = (s) => (Number.isInteger(s?.consularWeeks) ? s.consularWeeks : C.consularMaxWeeksAfterOfc || 0);
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const ofcDateOf = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s?.ofcDate || '') ? s.ofcDate : null);
function consularLatestOf(s) {
  const weeks = consularWeeksOf(s);
  return weeks && ofcDateOf(s) ? addDays(s.ofcDate, weeks * 7) : null;
}

// Bookable ranges per page, from config dateWindows:
//  OFC:      each window, ending `weeks` before its end so the consular fits in the same window.
//  CONSULAR: each window, cut to OFC date .. OFC + `weeks` once the OFC date is known.
function dateRangesOf(s) {
  const weeks = consularWeeksOf(s);
  const windows = C.dateWindows || [];
  const ofcDate = ofcDateOf(s), latest = consularLatestOf(s);
  const keep = (r) => r.from <= r.to;
  // Never earlier than today + minDaysFromToday (same rule the calendar check applies).
  const t = new Date(); t.setDate(t.getDate() + (C.minDaysFromToday || 0));
  const p = (n) => String(n).padStart(2, '0');
  const earliest = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  const later = (a, b) => (a > b ? a : b);
  return {
    OFC: windows.map((w) => ({ from: later(w.from, earliest), to: addDays(w.to, -weeks * 7) })).filter(keep),
    CONSULAR: windows.map((w) => ({
      from: later(ofcDate && ofcDate > w.from ? ofcDate : w.from, earliest),
      to: latest && latest < w.to ? latest : w.to,
    })).filter(keep),
  };
}

// Cities ticked in the popup (all by default), always in config priority order.
const selectedCities = (s) => (Array.isArray(s.selectedCities) ? C.cities.filter((c) => s.selectedCities.includes(c)) : C.cities);

// Returns a short status for the popup. Manual checks skip the jitter and the enabled flag,
// but still respect the daily cap, rate-limit pause, and booked stop.
// `only` checks just those cities, without jitter (Book now, keep-alive, Cloudflare resume).
// `resume` re-runs the cities a Cloudflare challenge interrupted.
// The city dropdown is left on the last city checked (never switched back to blank).
async function runWindow({ manual = false, only = null, rehearse = false, resume = false, keepAlive = false, label = '' } = {}) {
  const s = await getState();
  if (s.booked) return 'Already booked - checks stopped';
  if (!s.enabled && !manual) return 'Off';
  const skip = async (why) => { await log(`Skipped: ${why}`); return why; };
  if (Date.now() < s.pausedUntil) {
    return skip(s.pauseForChallenge
      ? 'paused for Cloudflare check - tick the box in the small window (or click Clear pause)'
      : `paused (${s.pauseKind || 'automatic pause'}) until ${new Date(s.pausedUntil).toLocaleTimeString()} (Clear pause to override)`);
  }
  const cap = effectiveCap(s);
  if (s.count >= cap) return skip(`daily cap reached (${s.count}/${cap}) - tick "Ignore daily cap" to continue`);

  const tabs = await scheduleTabs(s);
  if (!tabs.length) {
    if (!manual) alertUser('Visa slot watcher', 'Log in and leave the schedule page open so checks can run.', false);
    // Say why: no matching tab at all, or tabs that were set aside (status tab / recovery window).
    const all = await chrome.tabs.query({ url: SCHEDULE_URLS });
    const why = all.map((t) => `tab ${t.id} ${t.url.replace(/^https:\/\/[^/]+/, '').slice(0, 40)} - ${
      t.id === s.statusTabId ? 'it is the saved STATUS tab' : 'it is in the Cloudflare recovery window'}`);
    return skip(all.length
      ? `no usable schedule page. Open schedule tabs set aside: ${why.join('; ')}. Close the status tab / recovery window, or Clear pause, then open the schedule page in a normal tab`
      : 'no schedule page open (no tab matches /schedule or /ofc-schedule in this Chrome profile)');
  }
  const tabId = await findReadyTab(tabs);
  if (!tabId) return skip('schedule tab did not respond - reload it (F5)');
  // A follow-up never starts while a check or a booking is still running in the schedule tab (checked
  // before the status-tab reload, so a busy tab isn't even disturbed).
  if (label === 'follow-up' && !manual && !only) {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' }).catch(() => null);
    if (pong?.busy) return skip('follow-up - a check or booking is still running');
  }
  // Order is always C.cities: Mumbai, Hyderabad, Chennai, New Delhi, Kolkata.
  let cities, why = '';
  if (only) {
    cities = C.cities.filter((c) => only.includes(c)).concat(only.filter((c) => !C.cities.includes(c))).slice(0, cap - s.count);
    why = rehearse ? ' (BOOK NOW - earliest date, will submit)'
      : resume ? ' (resumed after Cloudflare check)'
      : label === 'telegram' ? ' (Telegram request)'
      : ' (keep-alive: no calendar load for a while)';
  } else if (manual) {
    // Cities ticked in the popup, in priority order, trimmed to budget.
    const picked = selectedCities(s);
    if (!picked.length) return skip('no cities ticked in the popup');
    cities = picked.slice(0, cap - s.count);
    why = ' (manual)';
  } else {
    // Scheduled: the cities ticked in the popup (same as Check now), in priority order.
    // Follow-up checks use their own list (repeatCitiesOf), independent of the regular one.
    const picked = label === 'follow-up' ? repeatCitiesOf(s) : selectedCities(s);
    if (!picked.length) return skip('no cities ticked in the popup');
    cities = picked.slice(0, cap - s.count);
    why = ` (${label || 'scheduled'})`;
  }
  const names = cities.join(', ');
  // Session + Cloudflare first, in the status tab, so the schedule tab never has to be reloaded.
  // A check 'timeout' (status tab too slow) still runs: the schedule tab may be fine.
  const status = await ensureStatus(`before ${rehearse ? 'Book now' : manual ? 'Check now' : keepAlive ? 'keep-alive' : resume ? 'the resumed check' : 'the scheduled check'}`);
  if (status === 'challenge') {
    await patchState({ resume: { cities, manual: manual || !!only, rehearse } });
    return skip(`Cloudflare check in the status tab - ${names} runs once it's passed`);
  }
  if (status === 'signin-failed') return skip('could not sign in again in the status tab - see the log');
  if (status === 'toolong') return skip('portal says "request too long" even after clearing its cookies - see the log');
  await log(`Checking ${names}${why}`);
  const fast = manual || !!only;
  // If a city's dates can't be booked, content.js goes on to these (in priority order).
  // Keep-alive only touches its one city; otherwise unbookable dates fall back to the other cities.
  // Fallback: Check now and scheduled stay within the ticked cities; Cloudflare-
  // resumed runs may fall back to any city.
  const pool = label === 'follow-up' && !manual && !only ? repeatCitiesOf(s) : selectedCities(s);
  const fallback = keepAlive || label === 'telegram' ? [] : (only ? C.cities : pool).filter((c) => !cities.includes(c));
  // Scheduled checks are skipped (not queued) if a previous run is still going.
  const skipIfBusy = !manual && !only;
  const ranges = dateRangesOf(s);
  const hasOfcDate = !!ofcDateOf(s);
  chrome.tabs.sendMessage(tabId, { type: 'RUN_CHECK', cities, manual: fast, rehearse, fallback, skipIfBusy, keepAlive, ranges, hasOfcDate, followUp: label === 'follow-up' && !manual && !only }).catch(() => log('Schedule tab did not respond - reload it (F5)'));
  return `Checking ${names}...`;
}

// Tabs checks can run in: schedule pages, never the Cloudflare recovery window or the status tab.
async function scheduleTabs(s) {
  const found = await chrome.tabs.query({ url: SCHEDULE_URLS });
  // The saved status tab ended up on a schedule page (navigated there): it is a schedule tab now.
  // Forget it as the status tab (a fresh home-page status tab opens when needed) and use it here.
  if (s.statusTabId != null && found.some((t) => t.id === s.statusTabId)) {
    await log(`Status tab ${s.statusTabId} is on a schedule page - using it as the schedule tab; a new status tab opens on the next check`);
    await patchState({ statusTabId: null, statusOkAt: 0 });
    s = { ...s, statusTabId: null };
  }
  return found
    .filter((t) => (!s.recovery || t.windowId !== s.recovery.windowId) && t.id !== s.statusTabId);
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
  // Typed text never lands in the clone (it's not an attribute), but blank any value attribute anyway.
  clone.querySelectorAll('input:not([type="checkbox"]):not([type="radio"])').forEach((n) => n.hasAttribute('value') && n.setAttribute('value', '[removed]'));

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

// `tabId`: the tab the popup was opened over - captured instead when it's the sign-in page.
async function capturePage(tabId) {
  const here = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const onSchedule = /\/(ofc-)?schedule/i.test(here?.url || '');
  const tabs = here && onLoginHost(here.url) && !onSchedule ? [here] : await chrome.tabs.query({ url: SCHEDULE_URLS });
  if (!tabs.length) return log('Capture: no schedule or sign-in page open - open one and click Capture page over it');
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

// ---- login: "Log in" / "Answer questions" in the popup ----
// Credentials come from the .env file in this folder, read fresh on every click (edit it, no reload
// needed). They are only ever typed into a tab on config login.hosts, and never logged.

async function loadEnv() {
  let text;
  try {
    const res = await fetch(chrome.runtime.getURL('.env'), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    text = await res.text();
  } catch {
    throw new Error('could not read .env in the extension folder');
  }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

const onLoginHost = (url) => {
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  return host && (C.login?.hosts || []).some((h) => host === h || host.endsWith(`.${h}`)) ? host : null;
};

async function runAuth(mode, tabId) {
  const what = mode === 'login' ? 'Log in' : 'Answer questions';
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !onLoginHost(tab.url)) {
    let host = '';
    try { host = new URL(tab?.url).hostname; } catch {}
    await log(`${what}: this tab (${host || 'unknown site'}) is not the visa portal - open its sign-in page first` +
      (host ? ` (if it is, add ${host} to login.hosts in config.js)` : ''));
    return 'Not the login page';
  }
  let env;
  try { env = await loadEnv(); } catch (e) { await log(`${what}: ${e.message}`); return 'No .env'; }
  let data;
  if (mode === 'login') {
    data = { username: env.F1_PORTAL_USERNAME || '', password: env.F1_PORTAL_PASSWORD || '' };
    if (!data.username || !data.password) {
      await log(`${what}: fill in F1_PORTAL_USERNAME and F1_PORTAL_PASSWORD in .env`);
      return 'Fill in .env';
    }
  } else {
    const qa = [];
    for (let n = 1; n <= 9; n++) {
      const q = env[`F1_SECURITY_Q${n}`], a = env[`F1_SECURITY_A${n}`];
      if (q && a) qa.push({ n, q, a });
    }
    if (!qa.length) { await log(`${what}: fill in F1_SECURITY_Q1/A1 ... in .env`); return 'Fill in .env'; }
    data = { qa, minScore: C.login?.questionMatchMin ?? 0.6 };
  }
  let r;
  try {
    [{ result: r }] = await chrome.scripting.executeScript({ target: { tabId }, func: fillAuthPage, args: [mode, data, C.login?.submit !== false] });
  } catch (e) {
    await log(`${what}: could not run on this tab (${e.message}) - reload it and try again`);
    return 'Failed - see log';
  }
  if (!r?.ok) {
    // Logged oldest-first so the summary ends up on top; the box list helps fix the page matching.
    for (const i of r?.inputs || []) await log(`  box: ${i.type || 'text'} id="${i.id}" name="${i.name}" - "${i.label || i.placeholder}"`);
    for (const u of r?.unknown || []) await log(`  not in .env: "${u}"`);
    await log(`${what}: ${r?.problem || 'nothing happened'} - nothing was submitted`);
    return 'Failed - see log';
  }
  const done = mode === 'login' ? `filled ${r.fields.join(' + ')}` : `answered ${r.answered.join(', ')}`;
  if (r.captcha) { await log(`${what}: ${done} - type the captcha, then press Enter / Submit yourself`); return 'Type the captcha'; }
  if (r.problem) { await log(`${what}: ${done}, but ${r.problem} - click it yourself`); return 'Submit yourself'; }
  await log(`${what}: ${done}${r.submitted ? ` and clicked ${r.button || 'Submit'}` : ' (submit is off in config.js)'}`);
  return r.submitted ? 'Submitted' : 'Filled';
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

// ---- Telegram: one message per check saying what happened ----
// TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID come from .env (read fresh each send; never logged).
// City results that arrive together are sent as one message (6 s after the last one); a booking
// or a failed booking attempt is sent at once. Failing to send never affects the checks.
// TELEGRAM_CHAT_ID can list several chats separated by commas (status messages go to all of them).
// TELEGRAM_BOT_TOKEN can also list several bots separated by commas: every bot sends the status messages
// to every chat and answers the commands (log, next check, last slot, /check) in the chat that asked.
const tokensOf = (env) => String(env.TELEGRAM_BOT_TOKEN || '').split(',').map((x) => x.trim()).filter(Boolean);
const chatIdsOf = (env) => String(env.TELEGRAM_CHAT_ID || '').split(',').map((x) => x.trim()).filter(Boolean);
async function tgSendText(token, chat, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
}
const tgBuf = [];
let tgTimer = null;
let tgWarned = false;
async function tgFlush() {
  clearTimeout(tgTimer);
  tgTimer = null;
  const lines = tgBuf.splice(0);
  if (!lines.length) return;
  try {
    const env = await loadEnv();
    const tokens = tokensOf(env), chats = chatIdsOf(env);
    if (!tokens.length || !chats.length) {
      if (!tgWarned) { tgWarned = true; await log('Telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in .env - no messages sent'); }
      return;
    }
    const text = [new Date().toLocaleTimeString(), ...lines].join('\n');
    for (const [i, token] of tokens.entries()) for (const chat of chats) await tgSendText(token, chat, text).catch(async (e) => log(`Telegram: bot ${i + 1} could not send to ${chat} - ${String(e?.message || e).replace(/bot\d+:[\w-]+/g, 'bot<token>')}`));
    tgWarned = false;
  } catch (e) {
    await log(`Telegram: could not send - ${String(e?.message || e).replace(/bot\d+:[\w-]+/g, 'bot<token>')}`);
  }
}
function tgNote(line, urgent = false) {
  tgBuf.push(line);
  if (urgent) { tgFlush(); return; }
  clearTimeout(tgTimer);
  tgTimer = setTimeout(tgFlush, 6000);
}
// ---- "when was the last slot found?": the newest in-range slot, with its screenshot ----
// Saved in chrome.storage.local (lastSlot = details, lastSlotShot = the picture). The screenshot
// is taken ~1 s after the dates load and the result arrives later, so either can come first.
let lastTimesNote = null;   // { city, date, text } from the "times - ..." log note of the newest slot
let lastShot = null;        // { city, at, dataUrl } newest calendar screenshot
let pendingSlotAt = 0;      // a slot was recorded at this time and is still waiting for its picture
const sameCity = (a, b) => String(a || '').toUpperCase().includes(String(b || '').toUpperCase());
function noteTimes(text) {
  const m = String(text || '').match(/^(.+?) (\d{4}-\d{2}-\d{2}): times - (.+)$/);
  if (m) lastTimesNote = { city: m[1], date: m[2], text: m[3] };
}
function keepShot(label, dataUrl) {
  lastShot = { city: label, at: Date.now(), dataUrl };
  if (pendingSlotAt && Date.now() - pendingSlotAt < 120000) {
    pendingSlotAt = 0;
    chrome.storage.local.get('lastSlot').then(({ lastSlot }) => {
      if (lastSlot && sameCity(label, lastSlot.city)) chrome.storage.local.set({ lastSlotShot: dataUrl });
    }).catch(() => {});
  }
}
async function recordSlot(r) {
  const t = lastTimesNote && lastTimesNote.city === r.city && lastTimesNote.date === r.match ? lastTimesNote.text : '';
  let outcome;
  if (r.booked === 'confirmed') outcome = 'BOOKED - portal confirmed';
  else if (r.booked) outcome = `submitted${r.note ? ` - ${r.note}` : ''}`;
  else if (r.bookError) outcome = `could not be booked - error: ${r.bookError}`;
  else if (r.testMode) outcome = 'test mode - not submitted';
  else if (r.noOfc) outcome = 'not booked - no OFC date known';
  else outcome = 'found';
  await chrome.storage.local.set({ lastSlot: { at: Date.now(), city: r.city, date: r.match, times: t || r.time || '', outcome } });
  if (lastShot && Date.now() - lastShot.at < 120000 && sameCity(lastShot.city, r.city)) {
    await chrome.storage.local.set({ lastSlotShot: lastShot.dataUrl });
    pendingSlotAt = 0;
  } else {
    await chrome.storage.local.remove('lastSlotShot');
    pendingSlotAt = Date.now();
  }
}
async function replyLastSlot(token, chat) {
  // The log files are the record: save pending lines first, then have the helper read the newest find.
  await saveLogFiles().catch(() => {});
  let res;
  try { res = await chrome.runtime.sendNativeMessage(LOG_HOST, { action: 'lastSlot' }); }
  catch (e) { res = { ok: false, error: e?.message || String(e) }; }
  if (!res?.ok) return tgSendText(token, chat, `Could not read the logs (${res?.error || 'no answer'}). Run slot-watcher-f1\native\install.bat once if this keeps happening.`);
  if (!res.found) return tgSendText(token, chat, 'No in-range slot appears in the log files yet.');
  const when = new Date(res.at.replace(' ', 'T'));
  const text = `Last slot found: ${res.at} (${fmtLeft(Date.now() - when.getTime())} ago)\n` +
    `City: ${res.city}\nDates in range: ${res.dates.join(', ')}\n` +
    `Times: ${res.times.length ? res.times.join('; ') : 'not logged'}\n` +
    `${res.attempts.length ? `Attempts: ${res.attempts.join('; ')}\n` : ''}Result: ${res.outcome}`;
  if (!res.shot) return tgSendText(token, chat, `${text}\n(no screenshot was captured)`);
  const form = new FormData();
  form.append('chat_id', chat);
  form.append('caption', text.slice(0, 1000));
  form.append('photo', await (await fetch(`data:image/jpeg;base64,${res.shot}`)).blob(), 'slot.jpg');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

function tgResult(r) {
  if (r.rehearse) return;
  if (r.match) recordSlot(r).catch(() => {});
  if (r.noOfc) return tgNote(`${r.city}: slot ${r.match} found but NOT booked - no OFC date known`, true);
  if (r.error) return tgNote(`${r.city}: check failed - ${r.error}`);
  if (!r.match) return tgNote(`${r.city}: no slots found (earliest in range: ${r.earliest || 'none'})`);
  if (r.bookError) return tgNote(`${r.city}: slot found ${r.match} but could not be booked - error: ${r.bookError}`, true);
  if (r.testMode) return tgNote(`${r.city}: TEST MODE - slot ${r.match} ${r.time || ''} found, not submitted`, true);
  if (r.booked === 'confirmed') return tgNote(`${r.city}: BOOKED ${r.match} ${r.time || ''} - portal confirmed`, true);
  if (r.booked) return tgNote(`${r.city}: SUBMITTED ${r.match} ${r.time || ''}${r.note ? ` - ${r.note}` : ''} - check the page`, true);
  tgNote(`${r.city}: slot ${r.match} found, result unclear - check the page`, true);
}

// ---- Telegram: answer "how long till the next check?" ----
// getUpdates is polled every 30 s (an alarm, so it survives the service worker stopping). Only
// messages from TELEGRAM_CHAT_ID are answered. Any message containing next / when / how long /
// status / time (or the /next and /status commands) gets the countdown. "log" or "log 25"
// (or /log) gets the last 10 (or 25, max 50) log lines.
const fmtLeft = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return t >= 60 ? `${Math.floor(t / 60)} min ${t % 60} s` : `${t} s`;
};
async function nextCheckText() {
  const s = await getState();
  const now = Date.now();
  const clock = (at) => new Date(at).toLocaleTimeString();
  if (s.booked) return 'Already booked - automatic checks are stopped.';
  const lines = [];
  if (!s.enabled) lines.push('Scheduled checks are OFF.');
  if (s.pausedUntil > now) lines.push(`Paused until ${clock(s.pausedUntil)} (${fmtLeft(s.pausedUntil - now)} left).`);
  const cands = [];
  if (s.enabled && s.nextRunAt > now) cands.push(['Next scheduled check', s.nextRunAt]);
  if (s.repeatUntil > now && s.repeatNextAt > now && s.repeatNextAt <= s.repeatUntil) cands.push(['Next follow-up check', s.repeatNextAt]);
  cands.sort((a, b) => a[1] - b[1]);
  for (const [what, at] of cands) lines.push(`${what}: ${clock(at)} - in ${fmtLeft(at - now)}`);
  if (cands.length && cands[0][0] !== 'Next scheduled check' && s.nextRunAt > now) {
    lines.push(`Next scheduled check: ${clock(s.nextRunAt)} - in ${fmtLeft(s.nextRunAt - now)}`);
  }
  if (!lines.length) lines.push('No check is scheduled right now.');
  return lines.join('\n');
}

// Last n log lines (newest first, as in the popup), kept under Telegram's 4096-character limit.
async function recentLogText(n) {
  const s = await getState();
  n = Math.min(Math.max(n, 1), 50);
  let out = (s.log || []).slice(0, n).join('\n') || 'The log is empty.';
  if (out.length > 3800) out = `${out.slice(0, 3800)}\n...(cut)`;
  return `Last ${Math.min(n, (s.log || []).length)} log lines (newest first):\n${out}`;
}

let tgPolling = false;
let tgPollWarned = false;
async function tgPoll() {
  if (tgPolling) return;
  tgPolling = true;
  try {
    const env = await loadEnv();
    const tokens = tokensOf(env), chats = chatIdsOf(env);
    if (!tokens.length || !chats.length) return;
    for (const [i, token] of tokens.entries()) {
      try { await tgPollOne(token, i, chats); }
      catch (e) { if (!tgPollWarned) { tgPollWarned = true; await log(`Telegram: bot ${i + 1} could not check for messages - ${String(e?.message || e).replace(/bot\d+:[\w-]+/g, 'bot<token>')}`); } }
    }
    tgPollWarned = false;
  } catch (e) {
    // Offline or no .env: try again in 30 s. Logged once per streak so a real problem is visible.
    if (!tgPollWarned) { tgPollWarned = true; await log(`Telegram: could not check for messages - ${String(e?.message || e).replace(/bot\d+:[\w-]+/g, 'bot<token>')}`); }
    return;
  } finally { tgPolling = false; }
}
// One bot's pending messages. Offsets are kept per bot (by its numeric id), the first bot inheriting the old single offset.
async function tgPollOne(token, idx, chats) {
  {
    const key = token.split(':')[0];
    const st = await chrome.storage.local.get(['tgOffset', 'tgOffsets']);
    const offs = st.tgOffsets || {};
    const tgOffset = offs[key] ?? (idx === 0 ? st.tgOffset || 0 : 0);
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=0&offset=${tgOffset}`);
    if (!res.ok) return;
    const data = await res.json();
    let offset = tgOffset;
    for (const u of data.result || []) {
      offset = u.update_id + 1;
      const m = u.message;
      if (!m || !chats.includes(String(m.chat?.id))) continue;
      const reply = async (t) => tgSendText(token, m.chat.id, `${new Date().toLocaleTimeString()}
${t}`).catch(() => {}); // a failed reply must not block later messages
      const text = m.text || '';
      // "/check n" (or "check m"): n New Delhi, m Mumbai, c Chennai, h Hyderabad, k Kolkata - one check now.
      const ck = text.trim().match(/^\/?check(?:@\w+)?\s+([nmchk])\b/i);
      if (ck) {
        const city = { n: 'NEW DELHI', m: 'MUMBAI', c: 'CHENNAI', h: 'HYDERABAD', k: 'KOLKATA' }[ck[1].toLowerCase()];
        if (!C.cities.includes(city)) { await reply(`${city} is not in the config city list.`); continue; }
        await reply(`Checking ${city} now... the result follows.`);
        // Not awaited: the poll must not wait for the status tab / calendar. The result comes back through
        // the normal Telegram status message (and photo); a skip (paused, signed out...) is reported here.
        runWindow({ manual: true, only: [city], label: 'telegram' })
          .then((r) => { if (!/^Checking /.test(String(r))) return reply(`Check for ${city} did not run: ${r}`); })
          .catch((e) => reply(`Check for ${city} failed: ${String(e?.message || e).slice(0, 200)}`));
        continue;
      }
      const lg = text.match(/\blog\b\D{0,3}(\d+)?/i);
      if (lg) await reply(await recentLogText(Number(lg[1]) || 10));
      else if (/\b(slots?|found|find)\b/i.test(text) && /last|when|recent|previous|latest/i.test(text)) await replyLastSlot(token, m.chat.id).catch(() => reply('Could not fetch the last slot.'));
      else if (/next|when|how long|status|time|left/i.test(text)) await reply(await nextCheckText());
    }
    if (offset !== tgOffset) await chrome.storage.local.set({ tgOffsets: { ...((await chrome.storage.local.get('tgOffsets')).tgOffsets || {}), [key]: offset } });
  }
}
async function ensureTgPollAlarm() {
  if (!(await chrome.alarms.get('tgpoll'))) chrome.alarms.create('tgpoll', { periodInMinutes: 0.5, delayInMinutes: 0.1 });
}
ensureTgPollAlarm();

async function onResult(r) {
  // First check after signing in again in the status tab: if the old schedule page is no longer
  // accepted (login page instead of JSON, or a failed request), reload it once.
  if (r.blocked || r.error || r.bookError) {
    const st = await getState();
    if (st.verifySchedule && /non-JSON|HTTP (0|401)\b/.test(`${r.error || ''} ${r.bookError || ''}`)) {
      return reloadScheduleTab(`${r.city}: ${r.error || r.bookError} on the first check after signing in again`, r.resumeCities || [r.city]);
    }
  }
  // Remember what a Cloudflare challenge interrupted, so it can be re-run once the check is passed.
  if (r.blocked && r.challenge && r.resumeCities?.length) {
    await patchState({ resume: { cities: r.resumeCities, manual: !!r.manual } });
  }
  tgResult(r);
  if (r.skipped?.length) await log(`${r.city}: skipped ${r.skipped.join(', ')} (in skipDates)`);
  if (r.noOfc) {
    await log(`${r.city}: consular ${r.match} available - NOT booked: no OFC date known. Enter it in the popup's OFC date box.`);
    return alertUser('Consular slot not booked', `${r.city} ${r.match} is open, but there's no OFC date. Enter your OFC date in the popup so consular slots can be booked.`, true, true);
  }
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

// Which of our tabs something came from, for log lines.
async function tabLabel(tabId, s) {
  if (tabId == null || tabId < 0) return 'no tab (background request)';
  if (s.recovery?.tabId === tabId) return 'recovery window';
  if (s.statusTabId === tabId) return 'status tab';
  try {
    const t = await chrome.tabs.get(tabId);
    if (/\/(ofc-)?schedule/i.test(t.url || '')) return 'schedule tab';
    return `other tab (${(t.url || '').replace(/^https:\/\/[^/]+/, '').slice(0, 60) || 'no URL'})`;
  } catch { return 'a closed tab'; }
}

// What a tab is showing: "title" url.
async function describeTab(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return `"${t.title || ''}" ${(t.url || t.pendingUrl || 'no URL').slice(0, 120)}`;
  } catch { return 'tab gone'; }
}

let challengeChain = Promise.resolve();
function handleChallenge(reason) {
  challengeChain = challengeChain.then(() => doHandleChallenge(reason)).catch(() => {});
  return challengeChain;
}

async function doHandleChallenge(reason) {
  const s = await getState();
  const RWc = C.recoveryWindow || {};
  if (s.recovery) {
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
    // Challenged again right after passing: often the session is gone. Handled like any other
    // challenge; once it's passed, the status tab check signs back in if it has to.
    const sincePass = ((Date.now() - s.lastChallengePassAt) / 60000).toFixed(1);
    await log(`Cloudflare: challenged again ${sincePass} min after the last pass (within ${RWc.repeatMinutes || 5} min) - no cooldown; the status tab signs back in after the pass if needed`);
  }
  // A longer pause (page-view limit, rate limit) is already running: keep it - passing Cloudflare
  // must not end it, and checks can't run before it ends anyway.
  if (Date.now() < s.pausedUntil && !s.pauseForChallenge) {
    await log(`Cloudflare challenge (${reason}) during the ${s.pauseKind || 'automatic'} pause (until ${new Date(s.pausedUntil).toLocaleString()}) - keeping that pause; no recovery window`);
    return;
  }
  // Lifted by recoveryPassed() (or the next successful calendar load, DAYS_OK).
  await startAutoPause({
    kind: 'Cloudflare check',
    reason,
    until: nextMidnight(),
    challenge: true,
    ends: 'when you pass the check in the small window, at midnight, or Clear pause',
  });
  let opened = false;
  if (RWc.enabled) {
    try { await openRecovery(reason); opened = true; } catch (e) { await log(`Cloudflare: could not open recovery window (${e?.message || e})`); }
  }
  if (!opened) {
    await log('Cloudflare: no recovery window - tick the box in the status tab, then click Clear pause (don\'t reload the schedule page)');
    alertUser('Cloudflare check needed', 'Tick the box in the status tab, then click Clear pause. Don\'t reload the schedule page.');
  }
}

// Response watcher: any portal response flagged by Cloudflare as a checkbox challenge, from any
// tab (your clicks, keep-alive, the extension's checks, the status tab). Observe-only.
// Also notes which response set a new cf_clearance cookie (logged by recordClearance), so a pass can
// be traced to the tab that earned it.
let lastClearanceFrom = null;
chrome.webRequest?.onHeadersReceived.addListener((details) => {
  const headers = details.responseHeaders || [];
  const header = (name) => headers.find((h) => h.name.toLowerCase() === name)?.value || '';
  let where = '';
  try { where = new URL(details.url).searchParams.get('route') || new URL(details.url).pathname; } catch {}
  if (headers.some((h) => h.name.toLowerCase() === 'set-cookie' && /^\s*cf_clearance=/i.test(h.value || ''))) {
    lastClearanceFrom = { at: Date.now(), where, tabId: details.tabId };
  }
  if (!C.cloudflare?.watchResponses) return;
  const flagged = /challenge/i.test(header('cf-mitigated'));
  if (!flagged) return;
  (async () => {
    const s = await getState();
    if (s.recovery && details.tabId === s.recovery.tabId) return; // the recovery window itself
    const tab = await tabLabel(details.tabId, s);
    await log(`Cloudflare challenge response: ${details.type} ${where} in the ${tab} - HTTP ${details.statusCode}, cf-ray ${header('cf-ray') || '?'}`);
    await handleChallenge(`Cloudflare challenge seen on ${where || 'a portal request'} (${tab})`);
  })().catch(() => {});
}, { urls: ['https://www.usvisascheduling.com/*'] }, ['responseHeaders', 'extraHeaders']);

// ---- Cloudflare clearance log ----
// When you pass the check, Cloudflare sets cf_clearance. Logged to compare with when challenges
// really happen. (The early "clearance about to expire" window is gone: the cookie claims a year,
// and the status tab check before every check does that job.)

async function recordClearance(cookie) {
  const expiresAt = cookie.expirationDate ? Math.round(cookie.expirationDate * 1000) : null;
  await patchState({ clearance: { setAt: Date.now(), expiresAt } });
  const left = expiresAt ? ` - valid until ${new Date(expiresAt).toLocaleTimeString()} (${Math.round((expiresAt - Date.now()) / 60000)} min)` : ' - no expiry time given';
  // The response that set it, if seen in the last few seconds (else set by a page script).
  const src = lastClearanceFrom && Date.now() - lastClearanceFrom.at < 5000 ? lastClearanceFrom : null;
  const from = src ? ` - set by ${src.where} in the ${await tabLabel(src.tabId, await getState())}` : ' - source not seen';
  await log(`Cloudflare clearance set${left}${from}`);
}

// ---- Cloudflare recovery window ----
// On a Cloudflare checkbox challenge: open a small window on the portal so YOU can tick the box,
// notice when it's passed (cf_clearance cookie, or the window's page loading normally after the
// challenge), close the window, lift the pause and re-run what the challenge interrupted.
// The extension never clicks the checkbox itself.

const RW = () => C.recoveryWindow || {};
const isChallengeTitle = (t = '') => /just a moment|attention required|verify you are human|checking your browser|security check/i.test(t);

// Runs slot-watcher-f1\test.bat through the native helper (native/logger.js, action 'runBat').
// Called when the recovery window shows a Cloudflare page, and by the popup's "Test .bat" button.
async function runTestBat(why) {
  let res;
  try {
    res = await chrome.runtime.sendNativeMessage(LOG_HOST, { action: 'runBat' });
  } catch (e) {
    res = { ok: false, error: e?.message || String(e) };
  }
  await log(res?.ok ? `${why}: ran ${res.ran}` : `${why}: could not run test.bat (${res?.error || 'no answer'}) - run slot-watcher-f1\\native\\install.bat once`);
  return res?.ok ? 'Ran test.bat' : 'Failed - see log';
}

// The recovery tab is showing a Cloudflare page: note it, and run test.bat - once per window, and
// never for a window that only shows the normal portal.
const batWindows = new Set();
async function noteChallenge(tabId) {
  const rw = (await getState()).recovery;
  if (!rw || rw.tabId !== tabId) return;
  if (!rw.sawChallenge) {
    await patchState({ recovery: { ...rw, sawChallenge: true } });
    await log(`Cloudflare: checkbox showing in the recovery window (${await describeTab(tabId)})`);
  }
  if (batWindows.has(rw.windowId)) return;
  batWindows.add(rw.windowId);
  // Not awaited: a failure never blocks recovery. Once test.bat has run, note if the window is
  // still open stillOpenLogSeconds later (setTimeout, not an alarm: alarms can't fire under 30 s).
  const stillOpenSec = RW().stillOpenLogSeconds ?? 8;
  // batRun is kept in state so the close is still timed if the service worker restarts meanwhile.
  // Wait 1.5 s (config recoveryWindow.batDelayMs) so the checkbox is drawn before the click; skip if the window was closed meanwhile.
  (async () => {
    await sleep(RW().batDelayMs ?? 1500);
    try { await chrome.windows.get(rw.windowId); } catch { return null; }
    return runTestBat('Cloudflare page showing');
  })().then(async (ran) => {
    if (ran === null) return;
    await patchState({ batRun: { windowId: rw.windowId, at: Date.now() } });
    setTimeout(async () => {
      try { await chrome.windows.get(rw.windowId); } catch { return; } // already closed
      await log(`Cloudflare: window still open ${stillOpenSec} s after test.bat ran`);
    }, stillOpenSec * 1000);
  });
}

// A small popup window, not the status tab: test.bat clicks the checkbox at a fixed screen spot
// inside this window.
async function openRecovery(reason) {
  const s = await getState();
  if (s.recovery?.windowId != null) {
    try {
      await chrome.windows.update(s.recovery.windowId, { focused: true, drawAttention: true });
      await log('Cloudflare: recovery window already open - brought to front');
      return;
    } catch { /* it was closed; open a new one */ }
  }
  const url = RW().urls[0];
  const win = await chrome.windows.create({ url, type: 'popup', focused: true, width: RW().width || 520, height: RW().height || 680 });
  const tabId = win.tabs?.[0]?.id ?? null;
  await patchState({ recovery: { windowId: win.id, tabId, openedAt: Date.now(), urlIdx: 0, sawChallenge: false, reason } });
  // The challenge may already be showing before the state above was saved (the tab listener
  // ignores the tab until then), so look at the title once now too.
  try { if (isChallengeTitle((await chrome.tabs.get(tabId)).title)) await noteChallenge(tabId); } catch {}
  chrome.alarms.create('recoveryTimeout', { when: Date.now() + (RW().timeoutMinutes || 10) * 60000 });
  await log(`Cloudflare check needed (${reason}) - recovery window opened on ${url}: tick the box there`);
  alertUser('Cloudflare check needed', 'Tick the box in the window that just opened. Checks resume by themselves.');
}

let passing = false;
async function recoveryPassed(how) {
  if (passing) return;
  passing = true;
  try {
    const s = await getState();
    const rw = s.recovery;
    if (!rw) return;
    // What the window showed at the end, before it's closed: a pass with no checkbox ever seen
    // means there was nothing to tick there (the block wasn't a checkbox, or was already gone).
    const openSec = Math.round((Date.now() - rw.openedAt) / 1000);
    await log(`Cloudflare window at close: showing ${await describeTab(rw.tabId)} - checkbox seen: ${rw.sawChallenge ? 'yes' : 'NO'}, open ${openSec} s, trigger: ${rw.reason || '?'}`);
    // Only a Cloudflare pause ends here; a page-view-limit / rate-limit pause keeps running.
    await patchState((cur) => ({ recovery: null, lastChallengePassAt: Date.now(),
      ...(cur.pauseForChallenge || Date.now() >= cur.pausedUntil ? { pausedUntil: 0, pauseForChallenge: false } : {}) }));
    await chrome.alarms.clear('recoveryTimeout');
    try { await chrome.windows.remove(rw.windowId); } catch {}
    await log(`Cloudflare check passed (${how}) - window closed, checks resumed`);
    chrome.action.setBadgeText({ text: '' });
    chrome.tts.speak('Cloudflare passed. Resuming.', { rate: 1.0 });
    const resume = s.resume;
    await patchState({ resume: null, statusOkAt: 0 });
    // Signed out meanwhile? The status tab finds out (and signs back in) before anything resumes.
    const status = await statusCheck('after the Cloudflare check');
    if (status === 'challenge') { await patchState({ resume }); return; } // challenged again: resume after that pass
    if (status === 'signin-failed' || status === 'toolong') return;
    if (resume?.beforeRunAt && resume.beforeRunAt > Date.now()) {
      await log(`Cloudflare passed before the ${new Date(resume.beforeRunAt).toLocaleTimeString()} check - it runs on time`);
      return;
    }
    if (RW().retryAfterPass && resume?.cities?.length) {
      await runWindow({ manual: resume.manual, only: resume.cities, resume: true, rehearse: !!resume.rehearse });
    }
  } finally {
    passing = false;
  }
}

// "No checkbox" passes, to stop a loop where the status tab is challenged but the small window
// never shows a checkbox.
const noCheckboxPasses = [];

// The page on this URL showed no checkbox: try the next configured URL, or resume anyway.
async function nextRecoveryUrl(tabId) {
  const s = await getState();
  const rw = s.recovery;
  if (!rw || rw.tabId !== tabId || rw.sawChallenge) return;
  const next = rw.urlIdx + 1;
  // (rw is used below to close the window)
  if (next < RW().urls.length) {
    await patchState({ recovery: { ...rw, urlIdx: next } });
    await log(`Cloudflare: no checkbox on ${RW().urls[rw.urlIdx]} - trying ${RW().urls[next]}`);
    try { await chrome.tabs.update(tabId, { url: RW().urls[next] }); } catch {}
    return;
  }
  const now = Date.now();
  while (noCheckboxPasses.length && now - noCheckboxPasses[0] > 3 * 60000) noCheckboxPasses.shift();
  if (noCheckboxPasses.length >= 2) {
    await log('Cloudflare: no checkbox in the recovery window 3 times in 3 min - closing the window; the auto-resume probe checks the portal every ~2 min and resumes by itself once it answers normally');
    await patchState({ recovery: null, lastProbeAt: 0 });
    await chrome.alarms.clear('recoveryTimeout');
    try { await chrome.windows.remove(rw.windowId); } catch {}
    await pauseProbe().catch(() => {}); // try right away instead of waiting for the next alarm
    return;
  }
  noCheckboxPasses.push(now);
  await recoveryPassed('no checkbox appeared in the recovery window - trying again');
}

// ---- auto-resume: a Cloudflare pause must not wait for a human once the portal has stopped asking ----
// The recovery window can end up showing the normal portal page (nothing to tick), and after 3 such
// "no checkbox" passes the pause used to stay until midnight / Clear pause. Every minute, while paused
// for Cloudflare, ask the portal home page (the same request the status tab makes - not the schedule
// page, so it doesn't count toward the page-view limit). If it answers normally with no challenge,
// clear the pause and carry on. Probes are at least ~2 min apart; a real block (403, "Just a moment",
// "Attention Required", "Access Denied") keeps the pause.
async function pauseProbe() {
  const s = await getState();
  if (s.booked || !s.pauseForChallenge || Date.now() >= s.pausedUntil) return;
  if (passing || statusRun) return;
  if (Date.now() - (s.lastProbeAt || 0) < 110000) return;
  await patchState({ lastProbeAt: Date.now() });
  let status = 0, title = '';
  try {
    const r = await fetch(RW().urls[0] || 'https://www.usvisascheduling.com/en-US/', { credentials: 'include', cache: 'no-store' });
    status = r.status;
    title = ((await r.text()).slice(0, 30000).match(/<title>([^<]*)/i) || [])[1]?.replace(/\s+/g, ' ').trim() || '';
  } catch (e) {
    await log(`Auto-resume probe: no answer (${String(e?.message || e).slice(0, 80)}) - still paused`);
    return;
  }
  // Only the status and the page TITLE decide: a normal page can mention Cloudflare or "access" elsewhere.
  const challenged = status !== 200 || /Just a moment|Attention Required|Access Denied|Checking your browser/i.test(title);
  if (challenged) {
    await log(`Auto-resume probe: HTTP ${status}, page "${title.slice(0, 60)}" - still blocked, staying paused`);
    return;
  }
  await log(`Auto-resume: the portal answered HTTP ${status} ("${title.slice(0, 60)}") with no Cloudflare check - clearing the pause`);
  if (s.recovery) return recoveryPassed('auto-resume: the portal no longer shows a check');
  await patchState({ pausedUntil: 0, pauseForChallenge: false, statusOkAt: 0 });
  const st = await statusCheck('after the auto-resume');
  if (st === 'challenge' || st === 'signin-failed' || st === 'toolong') return;
  chrome.action.setBadgeText({ text: '' });
  await log('Auto-resume: checks resumed - running a check now');
  await runWindow({ label: 'auto-resume' }); // same as clicking Check now for the ticked cities, but by itself
}
async function ensurePauseProbeAlarm() {
  if (!(await chrome.alarms.get('pauseprobe'))) chrome.alarms.create('pauseprobe', { periodInMinutes: 1, delayInMinutes: 1 });
}
ensurePauseProbeAlarm();

async function recoveryTimedOut() {
  const s = await getState();
  if (!s.recovery) return;
  await log(`Cloudflare check not done after ${RW().timeoutMinutes || 10} min - checks stay paused; the window is still open`);
  alertUser('Cloudflare check still waiting', 'Tick the box in the recovery window to resume checks.');
}

// Main pass signal: Cloudflare sets cf_clearance when the check is passed.
chrome.cookies?.onChanged.addListener(async ({ removed, cookie, cause }) => {
  if (cookie?.name !== 'cf_clearance' || !/(^|\.)usvisascheduling\.com$/.test(cookie.domain || '')) return;
  // Replaced by a new one is normal ('overwrite'); deleted or expired means the next request is challenged.
  if (removed) {
    if (cause !== 'overwrite') await log(`Cloudflare clearance cookie removed (${cause}) - the next portal request will be challenged`);
    return;
  }
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
  if (isChallengeTitle(title)) return noteChallenge(tabId);
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
  await log('Cloudflare: recovery window closed before the check passed - still paused (click Clear pause to try again; don\'t reload the schedule page)');
});

// How long the recovery window stayed open after test.bat ran, however it was closed (by you, or
// by the extension once the check passed). Separate from the listener above, which only sees
// closes while `recovery` is still set.
chrome.windows?.onRemoved.addListener(async (windowId) => {
  const { batRun } = await getState();
  if (batRun?.windowId !== windowId) return;
  await patchState({ batRun: null });
  const ms = Date.now() - batRun.at;
  await log(`Cloudflare: window closed ${ms} ms after test.bat ran`);
});

// ---- status tab: a second portal tab that takes every sign-in / Cloudflare check ----
// The portal limits how often the schedule page is LOADED (about 20 a day, then "You have exceeded
// the limit for viewing this page" for 24 h), not how often you sign in or pick a city. So the
// schedule tab is never reloaded: shortly before each check the status tab (portal home page) is
// reloaded instead. A Cloudflare checkbox there opens the recovery window; a sign-in form is filled
// in right there. Both tabs share cookies, so the schedule tab is fixed too, without a page load.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ST = () => C.statusTab || {};
const DAY_MS = 24 * 3600 * 1000;
// The portal home page itself (https://www.usvisascheduling.com/en-US/), not a sign-in redirect on the way.
const onHome = (url) => /^https:\/\/www\.usvisascheduling\.com\/[a-z]{2}-[A-Za-z]{2}\/?(\?.*)?$/.test(url);
// After the portal's "approaching the maximum" warning, no schedule page loads for 24 h.
const pageLockUntil = (s) => (s.approachingAt && Date.now() - s.approachingAt < DAY_MS ? s.approachingAt + DAY_MS : 0);

// Resolves with the id of the next tab (or only `tabId`) that finishes loading a page whose URL
// passes `match` (default: a login.hosts site), or null after timeoutMs.
function waitForAuthLoad(tabId, timeoutMs, match = onLoginHost) {
  return new Promise((resolve) => {
    const done = (id) => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpd); resolve(id); };
    const onUpd = (id, info, tab) => {
      if (info.status !== 'complete' || (tabId != null && id !== tabId) || !match(tab?.url || '')) return;
      done(id);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

// True once `tabId` starts loading a new page (call before navigating it), false after timeoutMs.
function waitTabLoading(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpd); resolve(v); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'loading') done(true); };
    const timer = setTimeout(() => done(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

// Settings from signIn in config.js.
const signInTimeoutMs = () => (C.signIn?.pageLoadTimeoutSeconds || 30) * 1000;
// Random pause after each page loads, picked fresh every time (pageDelayMs: [min, max]).
const pageDelay = () => sleep(pickStartDelay(C.signIn?.pageDelayMs || [500, 1500]));

// The status tab, opened (in the background, next to the schedule tab) if it isn't open.
// fresh: just opened, so it's loading the home page already.
async function getStatusTab(s) {
  if (s.statusTabId != null) {
    try { return { tab: await chrome.tabs.get(s.statusTabId), fresh: false }; } catch { /* closed */ }
  }
  const [sched] = await scheduleTabs(s);
  const windowId = sched?.windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null))?.id;
  const tab = await chrome.tabs.create({ ...(windowId != null && { windowId }), url: ST().url, active: false });
  await patchState({ statusTabId: tab.id });
  await log(`Status tab: opened ${ST().url} in a background tab - leave it open (sign-in and Cloudflare checks happen there, so the schedule page is never reloaded)`);
  return { tab, fresh: true };
}

// What the status tab shows right now: 'challenge', 'toolong' (the portal's "request too long"
// error, or a runaway sign-in URL), 'signin' (password box), 'questions' (sign-in site, answer
// boxes, no password), 'home' (signed in), 'loading' or 'other'.
// 'signin-error': the sign-in site's own error redirect (.../api/SelfAsserted/error?code=UX016...).
// The questions page is recognised by its question text (one of the .env questions), before the
// password check: its answer boxes can be password-type (masked), which looks like a sign-in form.

// The .env security questions (text only), re-read at most once a minute - readStatusTab polls.
let envQ = { at: 0, list: [] };
async function envQuestions() {
  if (Date.now() - envQ.at < 60000) return envQ.list;
  const list = [];
  try {
    const env = await loadEnv();
    for (let n = 1; n <= 9; n++) if (env[`F1_SECURITY_Q${n}`]) list.push(env[`F1_SECURITY_Q${n}`]);
  } catch { /* no .env: questions are only recognised by their answer boxes */ }
  envQ = { at: Date.now(), list };
  return list;
}

async function readStatusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  // Chrome can leave url/title out (error pages, mid-navigation); the page itself is asked below.
  let url = tab.url || tab.pendingUrl || '';
  if (isChallengeTitle(tab.title)) return 'challenge';
  if (b2cError(url)) return 'signin-error';
  if (CC().enabled && isRunawayUrl(url)) return 'toolong';
  if (CC().enabled && TOO_LONG_TEXT.test(tab.title || '')) return 'toolong';
  if (tab.status !== 'complete') return 'loading';
  let page;
  const questions = await envQuestions();
  try {
    [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId },
      args: [C.signIn?.scheduleLink || '#continue_application', questions, C.login?.questionMatchMin ?? 0.6],
      func: (link, questions, minScore) => {
        const shown = (el) => el.getClientRects().length > 0;
        const body = document.body?.innerText || '';
        // Same word matching as Answer questions (login.js): share of a question's words on the page.
        const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2));
        const pageWords = words(body.slice(0, 5000));
        const question = questions.some((q) => {
          const wq = words(q);
          let hit = 0;
          for (const w of wq) if (pageWords.has(w)) hit++;
          return wq.size > 0 && hit / wq.size >= minScore;
        });
        return {
          url: location.href,
          password: [...document.querySelectorAll('input[type="password"]')].some(shown),
          answers: [...document.querySelectorAll('input[type="text"], input[type="password"], input:not([type])')].some(shown),
          question,
          link: !!document.querySelector(link),
          text: `${document.title} ${body.slice(0, 500)}`,
        };
      } });
  } catch { return url ? 'loading' : 'other'; } // mid-navigation, or a page scripts can't run on (Chrome error page)
  url = url || page.url || '';
  if (b2cError(url)) return 'signin-error';
  if (CC().enabled && TOO_LONG_TEXT.test(page.text)) return 'toolong';
  const onB2c = /^https:\/\/atlasauth\.b2clogin\.com\//.test(url);
  if (onB2c && page.question && page.answers) return 'questions';
  if (page.password) return 'signin';
  if (onHome(url) && page.link) return 'home';
  if (onB2c && page.answers) return 'questions';
  return 'other';
}

// Polls until the status tab shows one of `want`, or 'timeout' / 'gone'.
async function waitStatusTab(tabId, timeoutMs, want = ['challenge', 'toolong', 'signin', 'questions', 'home']) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let seen;
    try { seen = await readStatusTab(tabId); } catch { return 'gone'; }
    if (want.includes(seen)) return seen;
    await sleep(500);
  }
  return 'timeout';
}

// ---- "request too long": leftover sign-in cookies / runaway sign-in URLs ----
// Every sign-in the portal starts sets a one-time cookie (OpenIdConnect.nonce.*), removed only
// when that sign-in finishes. Abandoned sign-ins leave them behind; once the Cookie header is too
// big the portal's server answers 400 "Request Too Long". A sign-in redirect loop nests returnUrl
// inside returnUrl until the server answers 414 "The request URL is too long". Fixes, mildest first:
//  1. remove the leftover sign-in cookies (stay signed in, Cloudflare clearance kept)
//  2. remove all portal cookies except Cloudflare's (signs out; the status tab signs back in)
//  3. pause and alert you
// Before every status check the extras are pruned (newest kept, so a sign-in in progress survives).

const CC = () => C.cookieCleanup || {};
const TOO_LONG_TEXT = /request(ed)? url is too long|request too long|request header(s)?( or cookie)? (is |are )?too (long|large)|size of the request headers is too long|HTTP Error 414/i;
const isSignInCookie = (c) => /OpenIdConnect\.nonce\.|\.AspNetCore\.Correlation\./i.test(c.name);
const isCloudflareCookie = (c) => /^(cf_|__cf)/i.test(c.name);
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
// A portal / sign-in URL that has grown past maxUrlLength, or nests returnUrl in returnUrl.
function isRunawayUrl(url) {
  if (!/^https:\/\/(www\.usvisascheduling\.com|atlasauth\.b2clogin\.com)\//.test(url)) return false;
  return url.length > (CC().maxUrlLength || 2000) || (url.match(/returnurl/gi) || []).length >= 3;
}

async function portalCookies() {
  const lists = await Promise.all(['usvisascheduling.com', 'atlasauth.b2clogin.com'].map((domain) => chrome.cookies.getAll({ domain }).catch(() => [])));
  return lists.flat();
}

// How big the Cookie header to each site is, and how many leftover sign-in cookies there are.
async function cookieStats() {
  const all = await portalCookies();
  const bytesFor = (re) => all.filter((c) => re.test(c.domain)).reduce((n, c) => n + c.name.length + c.value.length + 3, 0);
  return { count: all.length, signIn: all.filter(isSignInCookie).length,
    bytes: Math.max(bytesFor(/usvisascheduling\.com$/), bytesFor(/b2clogin\.com$/)) };
}

async function removeCookies(list) {
  let removed = 0;
  for (const c of list) {
    const url = `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
    try {
      if (await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId, ...(c.partitionKey && { partitionKey: c.partitionKey }) })) removed++;
    } catch { /* already gone */ }
  }
  return removed;
}

// Before each status check: keep at most maxSignInCookies leftover sign-in cookies (the newest).
async function pruneSignInCookies(why) {
  if (!CC().enabled) return;
  const max = CC().maxSignInCookies ?? 3;
  // Newest first: each one expires a fixed time after its sign-in started.
  const list = (await portalCookies()).filter(isSignInCookie).sort((a, b) => (b.expirationDate || 0) - (a.expirationDate || 0));
  if (list.length <= max) return;
  const before = await cookieStats();
  const removed = await removeCookies(list.slice(max));
  const after = await cookieStats();
  await log(`Cookies (before ${why}): ${list.length} leftover sign-in cookies (OpenIdConnect.nonce.*) - removed the ${removed} oldest, kept the newest ${max}; cookie header ${kb(before.bytes)} -> ${kb(after.bytes)}`);
}

// Fix step 1 (leftover sign-in cookies) or 2 (all portal cookies except Cloudflare's).
async function clearPortalCookies(step, why, head = step === 1 ? 'Request too long - fix 1' : 'Request too long - fix 2') {
  const all = await portalCookies();
  const before = await cookieStats();
  const list = step === 1 ? all.filter(isSignInCookie) : all.filter((c) => !isCloudflareCookie(c));
  const removed = await removeCookies(list);
  const after = await cookieStats();
  await patchState({ cookieFix: { at: Date.now(), step, removed, why } });
  if (step === 1) {
    await log(`${head} (${why}): removed ${removed} leftover sign-in cookies; cookie header ${kb(before.bytes)} -> ${kb(after.bytes)} (${before.count} -> ${after.count} cookies). Still signed in, Cloudflare clearance kept`);
  } else {
    const names = [...new Set(list.map((c) => c.name.replace(/\.[^.]{12,}$/, '.*')))].slice(0, 12).join(', ');
    await log(`${head} (${why}): fix 1 didn't help - removed ${removed} portal cookies (${names}) except Cloudflare's; cookie header ${kb(before.bytes)} -> ${kb(after.bytes)}. Signed out: the status tab signs back in`);
  }
}

// Seen outside a status check (any portal tab, incl. the schedule tab's calendar requests):
// log it, stop a redirect loop, do fix 1, then a status check (which goes on to fix 2 if needed).
let lastTooLongAt = 0;
async function onTooLong({ how, tabId, url, status }) {
  const stats = await cookieStats();
  const err = b2cError(url);
  // A 400 with a small Cookie header and a normal URL is some other error, not this one.
  if (status === 400 && !err && !isRunawayUrl(url) && stats.bytes < (CC().minHeaderBytes || 4096) && stats.signIn <= (CC().maxSignInCookies ?? 3)) return;
  if (Date.now() - lastTooLongAt < 30000) return; // one report per incident
  lastTooLongAt = Date.now();
  const s = await getState();
  const sched = (await scheduleTabs(s)).some((t) => t.id === tabId);
  const where = tabId === s.statusTabId ? 'the status tab' : sched ? 'the schedule tab' : s.recovery?.tabId === tabId ? 'the recovery window' : tabId >= 0 ? `tab ${tabId}` : 'a background request';
  let path = '';
  try { const u = new URL(url); path = `${u.hostname}${u.pathname}`.slice(0, 80); } catch {}
  if (err) {
    // Not cookies: the sign-in site lost a sign-in and put a whole page into this URL.
    await log(`Request too long: ${fmtB2cError(err)} in ${where} - the sign-in site lost that sign-in (usually another sign-in started in this browser meanwhile) and copied a whole page into the error URL (${url.length} chars), so the server refused it. ${stats.signIn} leftover sign-in cookies, cookie header ${kb(stats.bytes)}`);
    if (tabId === s.statusTabId && statusRun) return; // the running status check signs in again
    await clearPortalCookies(1, `seen in ${where}`, 'Sign-in error cleanup');
    await patchState({ statusOkAt: 0 });
    // A fresh sign-in in the status tab only - the broken tab is left alone, so two sign-ins can't
    // replace each other again.
    if (ST().enabled) await statusCheck(`after ${err.code} in ${where}`);
    return;
  }
  await log(`Request too long: ${how} in ${where} (${path}) - URL ${url.length} chars, ${stats.signIn} leftover sign-in cookies, cookie header ${kb(stats.bytes)} (${stats.count} cookies)`);
  if (tabId === s.statusTabId && statusRun) return; // the running status check fixes it
  // A runaway sign-in URL in some other tab: send it back to the plain home page. Never the
  // schedule tab (it isn't reloaded) or the recovery window.
  if (isRunawayUrl(url) && tabId >= 0 && !sched && tabId !== s.statusTabId && s.recovery?.tabId !== tabId) {
    try { await chrome.tabs.update(tabId, { url: ST().url || 'https://www.usvisascheduling.com/en-US/' }); await log(`Request too long: sent ${where} back to the portal home page to stop the sign-in loop`); } catch {}
  }
  await clearPortalCookies(1, `seen in ${where}`);
  await patchState({ statusOkAt: 0 });
  if (ST().enabled) await statusCheck('after clearing cookies');
}

// Response codes: 414 (URL too long), 400 (usually the Cookie header too long - see onTooLong).
const PORTAL_HOSTS = ['https://www.usvisascheduling.com/*', 'https://atlasauth.b2clogin.com/*'];
chrome.webRequest?.onCompleted.addListener((d) => {
  if (!CC().enabled || (d.statusCode !== 414 && d.statusCode !== 400)) return;
  onTooLong({ how: `HTTP ${d.statusCode} (${d.type === 'main_frame' ? 'page' : d.type})`, tabId: d.tabId, url: d.url, status: d.statusCode }).catch(() => {});
}, { urls: PORTAL_HOSTS, types: ['main_frame', 'sub_frame', 'xmlhttprequest'] });
// A sign-in redirect loop, caught by its growing URL before the server refuses it.
chrome.webRequest?.onBeforeRequest.addListener((d) => {
  if (!CC().enabled || !isRunawayUrl(d.url)) return;
  onTooLong({ how: 'runaway sign-in URL (redirect loop)', tabId: d.tabId, url: d.url }).catch(() => {});
}, { urls: PORTAL_HOSTS, types: ['main_frame'] });

// ---- sign-in site errors (B2C) ----
// When a sign-in form is submitted but the sign-in site has lost that sign-in (another sign-in
// started in the same browser meanwhile and replaced it), it answers with a fresh sign-in page
// instead of the expected reply. Its script then redirects to .../api/SelfAsserted/error?code=UX016
// with that WHOLE page copied into the URL (~300 KB), which the server refuses: "HTTP Error 400 -
// URL too long". Cookies have nothing to do with it; the fix is a fresh sign-in, alone.

// { code, page, tx } for a sign-in site error URL, else null.
function b2cError(url) {
  if (!/^https:\/\/atlasauth\.b2clogin\.com\/.*\/api\/[^/?]+\/error\b/i.test(url)) return null;
  let q;
  try { q = new URL(url).searchParams; } catch { return { code: '?', page: '?', tx: '' }; }
  let tx = '', page = '';
  try { tx = JSON.parse(atob((q.get('tx') || '').split('=').slice(1).join('=').replace(/-/g, '+').replace(/_/g, '/'))).TID || ''; } catch {}
  try { page = JSON.parse(q.get('diags') || '{}').pageId || ''; } catch {}
  return { code: q.get('code') || '?', page, tx, length: url.length };
}
const fmtB2cError = (e) => `sign-in site error ${e.code}${e.page ? ` on its ${e.page} page` : ''}${e.tx ? ` (transaction ${e.tx})` : ''}`;

// Sign-ins started in other tabs while the status tab is signing in: the usual cause of UX016.
let signingInSince = 0;
chrome.webRequest?.onBeforeRequest.addListener((d) => {
  if (!/\/oauth2\/v2\.0\/authorize/i.test(d.url)) return;
  (async () => {
    const s = await getState();
    if (d.tabId === s.statusTabId) return;
    const sched = d.tabId >= 0 && (await scheduleTabs(s)).some((t) => t.id === d.tabId);
    const where = sched ? 'the schedule tab' : s.recovery?.tabId === d.tabId ? 'the recovery window' : d.tabId >= 0 ? `tab ${d.tabId}` : 'a background request';
    await log(signingInSince
      ? `Sign-in: a second sign-in started in ${where} while the status tab is signing in - this replaces the status tab's sign-in and breaks it (error UX016). Don't sign in in other tabs meanwhile`
      : `Sign-in: a sign-in started in ${where} (not the status tab)`);
  })().catch(() => {});
}, { urls: ['https://atlasauth.b2clogin.com/*'], types: ['main_frame', 'sub_frame', 'xmlhttprequest'] });

// Log in / Answer questions in the status tab, until it shows the portal home page.
// Never goes on to the schedule page. Returns true, false, or 'retry' (the sign-in site lost the
// sign-in - error UX016 - worth one fresh attempt).
async function signInStatusTab(tabId, seen) {
  signingInSince = Date.now();
  try { return await doSignInStatusTab(tabId, seen); } finally { signingInSince = 0; }
}

// The visible boxes and buttons on a sign-in page, for the log (never what's typed in them), plus
// its heading. Returns the boxes so the caller can tell a password-only step apart.
async function logAuthBoxes(tabId, tag) {
  let r;
  try {
    [{ result: r }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      const near = (el) => {
        const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        return (lab?.innerText || el.getAttribute('aria-label') || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      };
      const boxes = [...document.querySelectorAll('input, select, textarea')]
        .filter((el) => el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button' && shown(el))
        .map((el) => ({ type: el.type || el.tagName.toLowerCase(), id: el.id || '', label: near(el) }));
      const buttons = [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')].filter(shown)
        .map((b) => (b.innerText || b.value || b.id || '').trim().slice(0, 30)).filter(Boolean);
      const heading = [...document.querySelectorAll('h1, h2, .heading, .intro')].filter(shown)
        .map((h) => h.innerText.trim()).filter(Boolean).join(' / ').replace(/\s+/g, ' ').slice(0, 150);
      return { boxes, buttons, heading };
    } });
  } catch (e) {
    await log(`${tag}: could not read the page's boxes (${e?.message || e})`);
    return null;
  }
  await log(`${tag}: page heading "${r.heading}" - ${r.boxes.length} box(es): ${r.boxes.map((b) => `${b.type}#${b.id || '?'}${b.label ? ` "${b.label}"` : ''}`).join(', ') || 'none'} - buttons: ${r.buttons.join(', ') || 'none'}`);
  return r.boxes;
}

// After Log in the page moved on but wasn't recognised (seen once: the questions page looked like a
// sign-in form). Log its boxes and save a capture, then try Answer questions (it fills only when
// every box matches a .env question). If not, and the page is just one password box, Log in once
// more (a password-only step), then look again. Returns 'answered' or a waitStatusTab result.
async function unstickAfterLogIn(tabId, tag) {
  await log(`${tag}: page after Log in not recognised in ${signInTimeoutMs() / 1000} s - showing ${await describeTab(tabId)}`);
  const boxes = await logAuthBoxes(tabId, tag);
  await capturePage(tabId).catch(() => {});
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !onLoginHost(tab.url)) return 'timeout';
  if (await runAuth('questions', tabId) === 'Submitted') {
    await log(`${tag}: it was the questions page after all - answered them`);
    return 'answered';
  }
  // Typing the password into anything else could submit it as a security answer.
  if (!(boxes?.length === 1 && boxes[0].type === 'password')) {
    await log(`${tag}: not a password-only step either - stopped`);
    return 'timeout';
  }
  await log(`${tag}: one password box and no questions - Log in once more (password-only step)`);
  if (await runAuth('login', tabId) !== 'Submitted') return 'timeout';
  const next = await waitStatusTab(tabId, signInTimeoutMs(), ['questions', 'home', 'signin-error', 'toolong', 'challenge']);
  if (next !== 'timeout') return next;
  await logAuthBoxes(tabId, tag);
  return await runAuth('questions', tabId) === 'Submitted' ? 'answered' : 'timeout';
}

async function doSignInStatusTab(tabId, seen) {
  const tag = 'Status tab';
  const timeoutMs = signInTimeoutMs();
  const why = { gone: 'the status tab was closed', timeout: `nothing within ${timeoutMs / 1000} s`, toolong: '"request too long" page' };
  // The tab's current URL, for the log (a sign-in site error is decoded).
  const showing = async () => {
    try {
      const t = await chrome.tabs.get(tabId);
      const err = b2cError(t.url || '');
      return err ? `${fmtB2cError(err)}, URL ${err.length} chars` : `"${t.title || ''}" ${(t.url || 'no URL').slice(0, 120)}`;
    } catch { return 'tab closed'; }
  };
  await pageDelay(); // also lets the page's own scripts draw the form
  let next = seen;
  if (seen === 'signin') {
    const status = await runAuth('login', tabId);
    if (status !== 'Submitted') { await log(`${tag}: Log in ended with "${status}" - not answering questions`); return false; }
    // Next: the questions page, straight home, or a sign-in site error. Polled, not load events.
    // 'signin' is skipped: the submitted form still shows until the next page arrives.
    next = await waitStatusTab(tabId, timeoutMs, ['questions', 'home', 'signin-error', 'toolong', 'challenge']);
    if (next === 'timeout') next = await unstickAfterLogIn(tabId, tag);
    if (next === 'home') return true; // no questions this time
    if (next === 'signin-error') { await log(`${tag}: after Log in - ${await showing()}`); return 'retry'; }
    if (next !== 'questions' && next !== 'answered') { await log(`${tag}: no security questions after Log in (${why[next] || next}) - showing ${await showing()}`); return false; }
    if (next === 'questions') await pageDelay();
  }
  if (next !== 'answered') {
    const answered = await runAuth('questions', tabId);
    if (answered !== 'Submitted') {
      await logAuthBoxes(tabId, tag);
      await log(`${tag}: Answer questions ended with "${answered}" - stopped`);
      return false;
    }
  }
  // 'questions' / 'signin' are skipped: the submitted page still shows them for a moment.
  const done = await waitStatusTab(tabId, timeoutMs, ['home', 'signin-error', 'toolong', 'challenge']);
  if (done === 'home') return true;
  if (done === 'signin-error') { await log(`${tag}: after the questions - ${await showing()}`); return 'retry'; }
  await log(`${tag}: portal home page didn't load after the questions (${why[done] || done}) - showing ${await showing()}`);
  if (done === 'timeout') await logAuthBoxes(tabId, tag);
  return false;
}

// Only one status check at a time; a second caller waits for the running one.
let statusRun = null;
function statusCheck(why) {
  if (!statusRun) statusRun = doStatusCheck(why).catch(async (e) => { await log(`Status tab: check failed (${e?.message || e})`); return 'timeout'; })
    .finally(() => { statusRun = null; });
  return statusRun;
}

// Reload the status tab and act on what it shows. Returns 'ok', 'challenge' (recovery window
// opened, checks paused), 'signin-failed', 'toolong' (still "request too long" after both cookie
// fixes; checks paused) or 'timeout' (no answer; checks may go ahead).
async function doStatusCheck(why) {
  if (!ST().enabled) return 'ok';
  const s = await getState();
  if (s.recovery) return 'challenge'; // already waiting on the recovery window
  await pruneSignInCookies(why).catch(() => {});
  const { tab, fresh } = await getStatusTab(s);
  const timeoutMs = (ST().loadTimeoutSeconds || 30) * 1000;
  const reload = async () => {
    const started = waitTabLoading(tab.id, 5000);
    await chrome.tabs.update(tab.id, { url: ST().url });
    await started;
    return waitStatusTab(tab.id, timeoutMs);
  };
  let seen = fresh ? await waitStatusTab(tab.id, timeoutMs) : await reload();
  // "Request too long": fix 1, reload; still there: fix 2 (if allowed), reload; still there: give up.
  for (let step = 1; seen === 'toolong' && step <= (CC().allowSignOut === false ? 1 : 2); step++) {
    let url = '';
    try { url = (await chrome.tabs.get(tab.id)).url || ''; } catch {}
    const stats = await cookieStats();
    await log(`Status tab (${why}): "request too long" - URL ${url.length} chars, ${stats.signIn} leftover sign-in cookies, cookie header ${kb(stats.bytes)} (${stats.count} cookies)`);
    await clearPortalCookies(step, `status tab, ${why}`);
    seen = await reload();
    if (seen !== 'toolong') await log(`Request too long: fixed by fix ${step} - status tab now shows ${seen}`);
  }
  if (seen === 'toolong') {
    await patchState({ statusCheck: { at: Date.now(), result: 'toolong', why }, statusOkAt: 0 });
    const until = Date.now() + (CC().pauseMinutes || 60) * 60000;
    await startAutoPause({ kind: 'request too long', reason: 'portal still says "request too long" after clearing its cookies', until,
      ends: 'by itself at that time, or Clear pause (clear the usvisascheduling.com cookies yourself first)' });
    alertUser('Portal error: request too long', 'Clearing cookies didn\'t fix it. Clear the usvisascheduling.com cookies yourself, then click Clear pause.');
    return 'toolong';
  }
  let result, text;
  if (seen === 'home') {
    result = 'ok';
    text = 'signed in, no Cloudflare check';
  } else if (seen === 'challenge') {
    result = 'challenge';
    text = 'Cloudflare checkbox - opening the recovery window';
  } else if (seen === 'signin' || seen === 'questions') {
    await log(`Status tab (${why}): ${seen === 'signin' ? 'sign-in form' : 'security questions'} showing - signing back in there`);
    let signed = await signInStatusTab(tab.id, seen);
    if (signed === 'retry') {
      // The sign-in site lost this sign-in (UX016). Start one fresh sign-in from the home page,
      // after removing the leftover sign-in cookies the broken one left behind.
      await log(`Status tab (${why}): the sign-in site lost this sign-in (usually another sign-in started in this browser meanwhile) - starting one fresh sign-in`);
      await clearPortalCookies(1, `status tab, ${why}`, 'Sign-in error cleanup');
      const again = await reload();
      signed = again === 'home' ? true
        : again === 'signin' || again === 'questions' ? await signInStatusTab(tab.id, again)
        : false;
      if (signed === 'retry') signed = false;
      await log(`Status tab (${why}): fresh sign-in ${signed ? 'worked' : `failed (status tab showed ${again})`}`);
    }
    result = signed ? 'ok' : 'signin-failed';
    text = result === 'ok' ? 'signed back in' : 'could not sign back in - sign in yourself in the status tab';
    // Sign-in ran into "request too long": clear the leftovers so the next status check starts clean.
    if (result === 'signin-failed' && (await readStatusTab(tab.id).catch(() => null)) === 'toolong') {
      await clearPortalCookies(1, `status tab, during sign-in (${why})`);
      text += ' (it hit "request too long" - leftover sign-in cookies removed; the next check signs in again)';
    }
  } else {
    result = 'timeout';
    let at = '';
    try { const t = await chrome.tabs.get(tab.id); at = ` (showing "${t.title || ''}" ${(t.url || 'no URL').slice(0, 120)})`; } catch {}
    text = seen === 'gone' ? 'tab was closed' : `no answer within ${ST().loadTimeoutSeconds || 30} s${at} - going ahead anyway`;
  }
  await patchState({ statusCheck: { at: Date.now(), result, why }, ...(result === 'ok' ? { statusOkAt: Date.now() } : { statusOkAt: 0 }) });
  await log(`Status tab (${why}): ${text}`);
  if (result === 'challenge') await handleChallenge(`Cloudflare checkbox in the status tab (${why})`);
  if (result === 'ok' && (seen === 'signin' || seen === 'questions')) await afterStatusSignIn();
  if (result === 'signin-failed') alertUser('Sign-in needed', 'Could not sign back in. Sign in yourself in the status tab - don\'t reload the schedule page.');
  return result;
}

// A recent 'ok' (statusTab.leadSeconds + 90 s, which covers a scheduled check's own status check)
// is reused; otherwise check now.
async function ensureStatus(why) {
  if (!ST().enabled) return 'ok';
  const s = await getState();
  const freshMs = ((ST().leadSeconds ?? 60) + 90) * 1000;
  if (s.statusOkAt && Date.now() - s.statusOkAt < freshMs) return 'ok';
  return statusCheck(why);
}

// statusTab.leadSeconds before a scheduled check (the 'preflight' alarm).
async function preflightTick() {
  const s = await getState();
  if (!ST().enabled || !s.enabled || s.booked || Date.now() < s.pausedUntil) return;
  if (!(await scheduleTabs(s)).length) return;
  const at = s.nextRunAt ? new Date(s.nextRunAt).toLocaleTimeString() : 'next';
  const status = await statusCheck(`${ST().leadSeconds ?? 60} s before the ${at} check`);
  // Interrupted by a checkbox: if it's passed after the check time, run the check then.
  if (status === 'challenge') await patchState({ resume: { cities: selectedCities(s), manual: false, beforeRunAt: s.nextRunAt } });
}

// Signed back in: keep using the open schedule tab (the next check proves it still works; see
// onResult / DAYS_OK). With no schedule tab open, open one.
async function afterStatusSignIn() {
  const s = await getState();
  if ((await scheduleTabs(s)).length) {
    await patchState({ verifySchedule: true });
    await log('Status tab: signed back in - keeping the open schedule tab as it is (no page load); the next check confirms it still works');
  } else {
    await openScheduleTab('signed back in, but no schedule tab is open');
  }
}

// Costs 1 schedule page view. Portal home page -> its "Schedule Appointment" link (a plain link to
// /en-US/ofc-schedule/) in a new tab.
async function openScheduleTab(why) {
  const tag = 'Open schedule tab';
  const s = await getState();
  const lock = pageLockUntil(s);
  if (Date.now() < lock) {
    await log(`${tag}: ${why} - NOT opening it: no schedule page loads until ${new Date(lock).toLocaleString()} (portal's page-view warning)`);
    return;
  }
  const timeoutMs = signInTimeoutMs();
  let windowId = null;
  try { windowId = (await chrome.tabs.get(s.statusTabId)).windowId; } catch {}
  const tab = await chrome.tabs.create({ ...(windowId != null && { windowId }), url: ST().url || 'https://www.usvisascheduling.com/en-US/', active: true });
  await log(`${tag}: ${why} - opening it (1 schedule page view)`);
  if ((await waitStatusTab(tab.id, timeoutMs, ['home'])) !== 'home') { await log(`${tag}: portal home page didn't load within ${timeoutMs / 1000} s - stopped`); return; }
  await pageDelay();
  const link = C.signIn?.scheduleLink || '#continue_application';
  const onSchedulePage = waitForAuthLoad(tab.id, timeoutMs, (url) => /^https:\/\/www\.usvisascheduling\.com\/[^/]+\/(ofc-)?schedule/.test(url));
  let clicked = false;
  try {
    [{ result: clicked }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [link],
      func: (sel) => { const a = document.querySelector(sel); if (a) a.click(); return !!a; } });
  } catch (e) {
    await log(`${tag}: could not run on the home page (${e.message})`);
    return;
  }
  if (!clicked) { await log(`${tag}: no "Schedule Appointment" link (${link}) on this page - stopped`); return; }
  if ((await onSchedulePage) == null) { await log(`${tag}: schedule page didn't load within ${timeoutMs / 1000} s - stopped`); return; }
  await log(`${tag}: schedule page open`);
}

// Fallback, used only when the first check after signing in again fails in the old schedule tab:
// reload it once (1 schedule page view), then re-run `cities` once it's ready (PAGE_READY).
async function reloadScheduleTab(why, cities) {
  const s = await getState();
  await patchState({ verifySchedule: false });
  const lock = pageLockUntil(s);
  if (Date.now() < lock) {
    await log(`${why} - the schedule tab needs a reload, but no schedule page loads until ${new Date(lock).toLocaleString()} (portal's page-view warning)`);
    alertUser('Schedule page needs a reload', 'The portal is close to its page-view limit, so the extension won\'t reload it. Reload it yourself only if you must.');
    return;
  }
  const [tab] = await scheduleTabs(s);
  if (!tab) return;
  await patchState({ reloadResume: cities?.length ? cities : null });
  await log(`${why} - the old schedule page isn't accepted after signing in again: reloading it once (1 schedule page view)`);
  await chrome.tabs.reload(tab.id);
}

// The popup's Test sign-in button: one status check now; if it had to sign in, one keep-alive check
// in the open schedule tab proves that tab still works (1 calendar request, may book).
async function testSignIn() {
  if (statusRun) return 'Already running';
  (async () => {
    const before = (await getState()).statusCheck?.at || 0;
    const status = await statusCheck('Test sign-in button');
    const s = await getState();
    if (status === 'ok' && s.verifySchedule && s.statusCheck?.at > before) await runKeepAlive('test after signing back in');
  })().catch((e) => log(`Test sign-in: failed (${e?.message || e})`));
  return 'Started - see log';
}

// The status tab was closed: forget it (the next check opens a new one).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  if (s.statusTabId === tabId) await patchState({ statusTabId: null, statusOkAt: 0 });
});

// Every schedule page load (yours, the extension's, Cloudflare's redirects): the portal allows
// about 20 a day.
chrome.webRequest?.onCompleted.addListener((d) => {
  if (d.statusCode !== 200 || d.tabId < 0) return;
  (async () => {
    const s = await patchState((cur) => ({ pageViews: (cur.pageViews || 0) + 1, lastPageViewAt: Date.now() }));
    const warnAt = C.pageViews?.warnAt || 12;
    await log(`Schedule page loaded - ${s.pageViews} today${s.pageViews >= warnAt ? ' (the portal allows about 20 a day - avoid reloading it)' : ''}`);
    if (s.pageViews === warnAt) alertUser('Schedule page loads', `${s.pageViews} today. Avoid reloading the schedule page.`, false);
  })().catch(() => {});
}, { urls: SCHEDULE_URLS, types: ['main_frame'] });

// The portal's own page-view banners on the schedule page (content.js).
async function onPageLimit(level) {
  const s = await getState();
  const now = Date.now();
  if (level === 'approaching') {
    if (pageLockUntil(s)) return; // already noted in the last 24 h
    await patchState({ approachingAt: now });
    await log(`Portal warns: approaching the schedule page-view limit - the extension won't load the schedule page until ${new Date(now + DAY_MS).toLocaleString()} (24 h). City checks in the open tab continue.`);
    alertUser('Page-view limit close', 'Do not reload or close the schedule page for 24 hours.');
    return;
  }
  // Exceeded: 24 h from the "approaching" warning (or from now, if it was never seen).
  const until = (pageLockUntil(s) || now + DAY_MS);
  if (s.pauseKind === 'page-view limit' && s.pausedUntil >= until) return;
  await startAutoPause({ kind: 'page-view limit', reason: 'Portal page-view limit exceeded', until,
    ends: '24 h after the portal\'s "approaching" warning, or Clear pause' });
  alertUser('Visa checks paused', `Portal page-view limit exceeded. Checks resume at ${new Date(until).toLocaleString()}.`);
}

// ---- session keep-alive ----
// The portal logs you out after ~15 min without activity; a calendar load counts as activity.
// Checked once a minute: if no calendar has loaded for keepAlive.minutes, check the keep-alive
// city (book if it can). The dropdown stays on that city.

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
  // A scheduled check is about to run and keeps the session alive itself; a keep-alive now would
  // still be running when it comes due, and that check would be skipped.
  const soon = (K.skipWithinSeconds ?? 60) * 1000;
  if (s.nextRunAt && s.nextRunAt - Date.now() < soon && s.nextRunAt > Date.now() - 5000) return;
  // Only when the schedule page is open (no "no schedule page" log every minute otherwise).
  if (!(await scheduleTabs(s)).length) return;
  if (ST().enabled && ST().keepAliveByReload) {
    // Reloading the status tab instead of a calendar request (keepAliveByReload in config.js).
    await patchState({ lastActivityAt: Date.now() });
    await statusCheck(`keep-alive: no calendar load for ${K.minutes || 14} min`);
    return;
  }
  await runKeepAlive(`no calendar load for ${K.minutes || 14} min`);
}

// One keep-alive check now (also used after signing back in, to test the schedule page).
async function runKeepAlive(why) {
  const K = C.keepAlive || {};
  await patchState({ lastActivityAt: Date.now() }); // don't fire again next minute if this one fails
  await log(`Keep-alive: ${why} - checking ${K.city} to keep the session active`);
  return runWindow({ only: [K.city], keepAlive: true });
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

// ---- calendar screenshots: <slot-watcher-f1>/screenshots/YYYY-MM-DD/HH-MM-SS_CITY.jpg ----
// Taken when a calendar loads with dates in it (screenshots in config.js). Written by the native
// helper, like the log files. Chrome can only capture the tab showing in its window.
// Sends a captured screenshot to Telegram (data URL -> photo). Never throws; failures are logged.
async function tgPhoto(dataUrl, caption) {
  try {
    const env = await loadEnv();
    const tokens = tokensOf(env), chats = chatIdsOf(env);
    if (!tokens.length || !chats.length) return;
    const blob = await (await fetch(dataUrl)).blob();
    for (const token of tokens) for (const chat of chats) {
      try {
        const form = new FormData();
        form.append('chat_id', chat);
        form.append('caption', caption);
        form.append('photo', blob, 'calendar.jpg');
        const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      } catch (e) {
        await log(`Telegram: could not send screenshot to ${chat} - ${String(e?.message || e).replace(/bot\d+:[\w-]+/g, 'bot<token>')}`);
      }
    }
  } catch (e) {
    await log(`Telegram: could not send screenshot - ${String(e?.message || e).replace(/bot\d+:[\w-]+/g, 'bot<token>')}`);
  }
}

async function screenshotCalendar(tab, city) {
  const S = C.screenshots || {};
  if (!S.enabled || !tab?.id) return;
  await sleep(S.delayMs ?? 700); // let the portal draw the calendar
  const now = new Date();
  const label = city || 'unknown city';
  let dataUrl;
  try {
    const t = await chrome.tabs.get(tab.id);
    const win = await chrome.windows.get(t.windowId);
    if (!t.active || win.state === 'minimized') {
      await log(`Screenshot skipped (${label}): the schedule tab isn't showing - ${!t.active ? 'another tab is in front' : 'its window is minimized'}`);
      return;
    }
    const png = S.format === 'png';
    dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, png ? { format: 'png' } : { format: 'jpeg', quality: S.jpegQuality ?? 85 });
  } catch (e) {
    await log(`Screenshot failed (${label}): ${e?.message || e}`);
    return;
  }
  tgPhoto(dataUrl, `${label} calendar - ${now.toLocaleTimeString()}`); // not awaited: never slows booking
  keepShot(label, dataUrl);
  const p = (n) => String(n).padStart(2, '0');
  const ext = S.format === 'png' ? 'png' : 'jpg';
  const name = `${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}_${label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}.${ext}`;
  let res;
  try {
    res = await chrome.runtime.sendNativeMessage(LOG_HOST, { action: 'saveShot', day: dayKey(now), name, data: dataUrl.split(',')[1] });
  } catch (e) {
    res = { ok: false, error: e?.message || String(e) };
  }
  await log(res?.ok ? `Screenshot (${label}): ${res.file}` : `Screenshot not saved (${label}): ${res?.error || 'no answer'} - run slot-watcher-f1\\native\\install.bat once`);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg?.type) {
      case 'DAYS_REQUEST': {
        // Any calendar load (yours or the extension's) counts as session activity for keep-alive.
        await patchState((s) => ({ count: s.count + 1, lastActivityAt: Date.now() }));
        break;
      }
      case 'NOTE':
        await log(msg.text);
        noteTimes(msg.text);
        break;
      case 'PAGE_LIMIT':
        await onPageLimit(msg.level);
        break;
      case 'PAGE_READY': {
        const st = await getState();
        // Reloaded by reloadScheduleTab (or by you): it's a fresh page, nothing to verify.
        if (st.verifySchedule) await patchState({ verifySchedule: false });
        if (st.reloadResume?.length && sender?.tab?.id !== st.statusTabId) {
          await patchState({ reloadResume: null });
          await log('Schedule page reloaded - re-running the interrupted check');
          await runWindow({ only: st.reloadResume, resume: true });
          break;
        }
        // First consular page load after an OFC booking: check it right away (once).
        if (msg.page !== 'CONSULAR' || !st.consularNext) break;
        await patchState({ consularNext: false });
        await log('Consular page open after the OFC booking - checking now');
        await runWindow({ label: 'consular, right after OFC booking' });
        break;
      }
      case 'BLOCKED':
        if (msg.detail) {
          // A plain 403 without Cloudflare's "cf-mitigated: challenge" isn't a checkbox: the
          // recovery window will most likely show none.
          const plain403 = /HTTP 403/.test(msg.detail) && /cf-mitigated: none/.test(msg.detail);
          await log(`Blocked response in the ${await tabLabel(sender?.tab?.id, await getState())}: ${msg.detail}${plain403 ? ' - no Cloudflare challenge flag: probably not a checkbox (Cloudflare firewall or portal refusal)' : ''}`);
        }
        if (msg.challenge) {
          // Non-JSON right after signing in again in the status tab: probably the old schedule
          // page being sent to the sign-in page, not Cloudflare. onResult reloads it instead.
          if (/non-JSON/.test(msg.reason) && (await getState()).verifySchedule) break;
          await handleChallenge(msg.reason);
        } else {
          const until = Date.now() + C.rateLimitPauseMinutes * 60000;
          await startAutoPause({ kind: 'rate limit', reason: msg.reason, until, ends: 'by itself at that time, or Clear pause' });
          alertUser('Visa checks paused', `${msg.reason}. Resuming at ${new Date(until).toLocaleTimeString()}.`);
        }
        break;
      case 'DAYS_OK': {
        // Only when the calendar has dates in it. Not awaited: the screenshot waits for the
        // calendar to draw and must not hold up recovery.
        if (msg.dayCount > 0) screenshotCalendar(sender?.tab, msg.city).catch(() => {});
        const s = await getState();
        if (s.verifySchedule) {
          await patchState({ verifySchedule: false });
          await log('Old schedule tab still works after signing in again in the status tab - no page load needed');
        }
        if (s.recovery) {
          await recoveryPassed('calendar loaded again');
        } else if (s.pauseForChallenge && Date.now() < s.pausedUntil) {
          await patchState({ pausedUntil: 0, pauseForChallenge: false });
          await log('Calendar loaded again - Cloudflare check passed, checks resumed');
        }
        break;
      }
      case 'LOGIN':
      case 'ANSWER_QUESTIONS':
        reply({ status: await runAuth(msg.type === 'LOGIN' ? 'login' : 'questions', msg.tabId) });
        return;
      case 'CAPTURE':
        await capturePage(msg.tabId);
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
        reply({ state: st, cap: C.dailyCap, capOff: capIsOff(st), testMode: C.testMode, cities: C.cities, skipDates: C.skipDates || {}, keepAlive: C.keepAlive || null, startDelaySeconds: startDelayOf(st), repeat: { ...repeatOf(st), cities: repeatCitiesOf(st) },
          extraWindows: extraWindowsOn(st), extraWindowMinutes: C.extraWindowMinutes || [], windowMinutes: windowMinutesOf(st),
          mainWindowMinutes: C.windowMinutes, offGridWindows: offGridWindowsOn(st),
          consularWeeks: consularWeeksOf(st), ofcDate: st.ofcDate || '', consularLatest: consularLatestOf(st),
          dateWindows: C.dateWindows || [], ranges: dateRangesOf(st),
          pageViewWarnAt: C.pageViews?.warnAt || 12, pageLockUntil: pageLockUntil(st), statusTabOn: !!ST().enabled });
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
      case 'SET_REPEAT_CITIES':
        await patchState({ repeatCities: C.cities.filter((c) => (msg.cities || []).includes(c)) });
        break;
      case 'SET_REPEAT': {
        const num = (v) => { const raw = String(v ?? '').trim(); return raw === '' ? NaN : Number(raw); };
        const every = Math.round(num(msg.everySec)), forMin = num(msg.forMin);
        if (!Number.isFinite(every) || every < 5 || every > 3600) { reply({ ok: false, error: 'Every: 5-3600 seconds' }); return; }
        if (!Number.isFinite(forMin) || forMin < 1 || forMin > 120) { reply({ ok: false, error: 'For: 1-120 minutes' }); return; }
        await patchState({ repeatOn: !!msg.on, repeatEverySec: every, repeatForMin: forMin });
        await log(msg.on ? `Follow-up checks on: every ${every} s for ${forMin} min after each scheduled check` : 'Follow-up checks off');
        if (!msg.on) await stopRepeat();
        reply({ ok: true });
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
        const r = dateRangesOf(await getState());
        const list = (rs) => rs.map((x) => `${x.from}..${x.to}`).join(', ') || 'none';
        await log(`Consular limit ${weeks ? `${weeks} weeks after OFC` : 'off'}${ofcDate ? `, OFC ${ofcDate}` : ', no OFC date'}` +
          ` - OFC ranges: ${list(r.OFC)}; consular ranges: ${list(r.CONSULAR)}`);
        break;
      }
      case 'SET_CAP_OFF':
        await patchState({ capOff: !!msg.off });
        await log(msg.off ? 'Daily cap off' : `Daily cap on (${C.dailyCap}/day)`);
        break;
      case 'REHEARSE': {
        const city = String(msg.city || '').trim().toUpperCase();
        if (!city) { reply({ status: 'Type a city first' }); return; }
        reply({ status: await runWindow({ manual: true, only: [city], rehearse: true }) });
        return;
      }
      case 'CHECK_NOW':
        reply({ status: await runWindow({ manual: true }) });
        return;
      case 'RUN_TEST_BAT':
        reply({ status: await runTestBat('Test .bat button') });
        return;
      case 'TEST_SIGN_IN':
        // A status tab check now; runs on after this reply.
        reply({ status: await testSignIn() });
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
  if (alarm.name === 'tgpoll') return tgPoll();
  if (alarm.name === 'pauseprobe') return pauseProbe().catch(() => {});
  if (alarm.name === 'logsave') return saveLogFiles().catch(() => {});
  if (alarm.name === 'keepalive') return keepAliveTick().catch(() => {});
  if (alarm.name === 'preflight') return preflightTick().catch(() => {});
  if (alarm.name === 'repeat') return repeatTick().catch(() => {});
  if (alarm.name !== 'window') return;
  const s = await getState();
  await log(`Starting scheduled check (${selectedCities(s).join(' → ') || 'no cities ticked'})`);
  // Next check: a later window minute than this one (its minute start was saved when scheduled).
  const windowStart = s.nextWindowStart || Math.floor(alarm.scheduledTime / 60000) * 60000;
  try { await runWindow(); await startRepeat(); } finally { await scheduleNext(windowStart + 60000); }
});

// Reloading the extension (or starting Chrome) also writes any unsaved log lines to the log files
// right away, so a reload never loses lines waiting for the next 2-hour save.
chrome.runtime.onInstalled.addListener(() => { scheduleNext(); saveLogFiles().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { scheduleNext(); saveLogFiles().catch(() => {}); });
removeOldLogFileData().catch(() => {});
clearLegacyOfcStop().catch(() => {});
ensureLogSaveAlarm().catch(() => {});
ensureKeepAliveAlarm().catch(() => {});
chrome.alarms.clear('cfwatch').catch(() => {}); // the removed early-Cloudflare-window timer
