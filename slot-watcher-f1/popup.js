const $ = (id) => document.getElementById(id);

// One checkbox per city; Check now goes through the ticked ones in this order.
// `boxId`/`type`: the follow-up checks have their own list ('repeatCityList' / 'SET_REPEAT_CITIES').
function renderCities(cities, selected, boxId = 'cityList', type = 'SET_SELECTED') {
  const box = $(boxId);
  if (box.childElementCount) return; // built once; checkboxes keep their own state
  cities.forEach((city, i) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = city;
    cb.checked = !Array.isArray(selected) || selected.includes(city);
    if (boxId === 'repeatCityList') cb.disabled = true; // read-only: edit repeatChecks.cities in config.js
    cb.onchange = () => chrome.runtime.sendMessage({
      type,
      cities: [...box.querySelectorAll('input:checked')].map((c) => c.value),
    });
    label.append(cb, `${i + 1}. ${titleCase(city)}`);
    box.append(label);
  });
}

// Book now: one button per config city, in check order, labelled with its first letter.
const bookButtons = () => [...document.querySelectorAll('.book button')];
function resetBookButtons() {
  for (const b of bookButtons()) { b.textContent = b.dataset.letter; b.disabled = false; }
}
function renderBookCities(cities) {
  const row = document.querySelector('.book');
  if (bookButtons().length) return;
  cities.forEach((city, i) => {
    const b = document.createElement('button');
    b.dataset.letter = city[0];
    b.textContent = city[0];
    b.title = `${i + 1}. Book now: ${titleCase(city)} - earliest date in range, clicks Submit`;
    b.onclick = () => bookNow(city, b);
    row.append(b);
  });
}

// Read-only list of config skipDates per page, e.g. "OFC - Hyderabad: 01 Jan 2026".
const titleCase = (c) => c.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
function renderSkipDates(skip) {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = (iso) => { const [y, m, d] = iso.split('-'); return `${d} ${MON[Number(m) - 1]} ${y}`; };
  const label = { OFC: 'OFC', CONSULAR: 'Consular' };
  // Older config shape { CITY: [dates] } (background not reloaded yet) is shown without a page label.
  const byPage = Object.values(skip).some(Array.isArray) ? { '': skip } : skip;
  const lines = Object.entries(byPage).flatMap(([page, cities]) => Object.entries(cities || {})
    .filter(([, dates]) => Array.isArray(dates) && dates.length)
    .map(([city, dates]) => `${page ? `${label[page] || page} - ` : ''}${titleCase(city)}: ${dates.map(fmt).join(', ')}`));
  $('skipDates').textContent = lines.length ? lines.join('\n') : 'None (set skipDates in config.js)';
  $('skipDates').style.whiteSpace = 'pre-line';
}

// Consular limit: dropdown (Off, 1-12 weeks) + OFC date; the note shows the resulting cutoff.
function renderConsularLimit(weeks, ofcDate, latest) {
  const sel = $('consularWeeks');
  if (!sel.options.length) {
    sel.add(new Option('Off (whole window)', '0'));
    for (let w = 1; w <= 12; w++) sel.add(new Option(`${w} week${w > 1 ? 's' : ''} of OFC`, String(w)));
  }
  if (document.activeElement !== sel) sel.value = String(weeks);
  if (document.activeElement !== $('ofcDate')) $('ofcDate').value = ofcDate;
  $('consularNote').textContent = !ofcDate ? 'No OFC date: consular slots will NOT be booked'
    : !weeks ? ''
    : latest ? `Consular dates up to ${latest}`
    : 'Enter the OFC date to apply the limit';
}

// Date windows from config and the OFC / consular ranges checks actually book in.
function renderRanges(windows, ranges) {
  const fmt = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const list = (rs) => (rs?.length ? rs.map((r) => `${fmt(r.from)} - ${fmt(r.to)}`).join('\n') : 'none');
  $('ranges').textContent = `Windows:\n${list(windows)}\nOFC:\n${list(ranges.OFC)}\nConsular:\n${list(ranges.CONSULAR)}`;
  $('ranges').style.whiteSpace = 'pre-line';
}

// Countdown to the next scheduled check, updated every second from the last known state.
let latest = null;
function fmtLeft(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function tick() {
  if (!latest) return;
  const { s, cities, keepAlive } = latest;
  // Keep-alive: due keepAlive.minutes after the last calendar load (checked once a minute).
  if (keepAlive?.enabled && s.enabled && !s.booked) {
    const due = (s.lastActivityAt || 0) + keepAlive.minutes * 60000 - Date.now();
    $('keepAlive').textContent = due > 0 ? `${fmtLeft(due)} (${keepAlive.city.slice(0, 3)})` : `due (${keepAlive.city.slice(0, 3)})`;
  } else {
    $('keepAlive').textContent = '-';
  }
  const paused = Date.now() < s.pausedUntil;
  const nextAt = latest.nextAt;
  if (!nextAt || !s.enabled || s.booked) {
    $('countdown').textContent = '-';
    $('next').textContent = '';
    return;
  }
  const left = nextAt - Date.now();
  // Scheduled checks go through the ticked cities (all, until you change the ticks).
  const ticked = Array.isArray(s.selectedCities) ? cities.filter((c) => s.selectedCities.includes(c)) : cities;
  const order = ticked.length ? ticked.map((c) => c.slice(0, 3)).join(' → ') : 'no cities ticked';
  $('next').textContent = `${order} at ${new Date(nextAt).toLocaleTimeString()}${paused ? ' (will skip: paused)' : ''}`;
  $('countdown').textContent = left > 0 ? fmtLeft(left) : 'starting…';
}

async function render() {
  const { state: s, cap, capOff, testMode, cities, skipDates, keepAlive, startDelaySeconds, repeat, extraWindows,
    extraWindowMinutes = [], mainWindowMinutes = [], consularWeeks = 0, ofcDate = '', consularLatest = null, dateWindows = [], ranges = {},
    pageViewWarnAt = 12, pageLockUntil = 0, statusTabOn = false } = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  const views = s.pageViews || 0;
  $('pageViews').textContent = String(views);
  $('pageViews').className = views >= pageViewWarnAt ? 'warn' : '';
  $('pageLock').textContent = pageLockUntil > Date.now()
    ? `Portal warned "approaching the limit" - don't reload or close the schedule page until ${new Date(pageLockUntil).toLocaleString()}` : '';
  const sc = s.statusCheck;
  const scText = { ok: 'OK', challenge: 'Cloudflare', 'signin-failed': 'sign-in failed', timeout: 'no answer', toolong: 'request too long' };
  $('statusCheck').textContent = !statusTabOn ? 'off' : sc ? `${scText[sc.result] || sc.result} ${new Date(sc.at).toLocaleTimeString()}` : '-';
  $('extraWindows').checked = !!extraWindows;
  // The minutes the checkbox adds (beyond the always-on ones), e.g. [:00, :05, :10 ...].
  const mm = (list) => `[${list.map((m) => `:${String(m).padStart(2, '0')}`).join(', ')}]`;
  const main = [...mainWindowMinutes].sort((a, b) => a - b);
  $('mainTimes').textContent = mm(main.filter((m) => m % 5 === 0));
  const extra = extraWindowMinutes.filter((m) => !mainWindowMinutes.includes(m)).sort((a, b) => a - b);
  $('extraTimes').textContent = mm(extra);
  // Don't overwrite the box while you're typing in it.
  // [min, max]; a single number comes from a background that hasn't been reloaded yet.
  const [delayLo, delayHi] = Array.isArray(startDelaySeconds) ? startDelaySeconds : [startDelaySeconds || 0, startDelaySeconds || 0];
  if (![$('startDelayMin'), $('startDelayMax')].includes(document.activeElement)) {
    $('startDelayMin').value = delayLo;
    $('startDelayMax').value = delayHi;
  }
  if (repeat) {
    $('repeatOn').checked = repeat.on;
    if (![$('repeatEvery'), $('repeatFor')].includes(document.activeElement)) {
      $('repeatEvery').value = repeat.everySec;
      $('repeatFor').value = repeat.forMin;
    }
  }
  renderSkipDates(skipDates || {});
  renderConsularLimit(consularWeeks, ofcDate, consularLatest);
  renderRanges(dateWindows, ranges);
  // Countdown target: Chrome's own alarm for the next scheduled check (the real timer), falling
  // back to the saved time. Re-read every refresh, so after a run or a skip it moves straight on.
  let nextAt = s.nextRunAt || null;
  try {
    const alarm = await chrome.alarms?.get('window');
    if (alarm?.scheduledTime) nextAt = alarm.scheduledTime;
  } catch {}
  latest = { s, cities, keepAlive, nextAt };
  tick();
  renderCities(cities, s.selectedCities);
  renderCities(cities, repeat?.cities, 'repeatCityList', 'SET_REPEAT_CITIES');
  renderBookCities(cities);
  const paused = Date.now() < s.pausedUntil;
  $('test').textContent = testMode ? 'TEST MODE: will not click Submit (set testMode: false in config.js)' : '';
  const pauseText = s.pauseForChallenge
    ? 'Paused - tick the Cloudflare box in the small window'
    : `Paused until ${new Date(s.pausedUntil).toLocaleTimeString()}`;
  $('status').textContent = s.booked ? 'Booked - stopped' : !s.enabled ? 'Off' : paused ? pauseText : 'Running';
  $('count').textContent = capOff ? `${s.count} (no cap)` : `${s.count} / ${cap}`;
  $('capOff').checked = capOff;
  $('capOff').onchange = (e) => chrome.runtime.sendMessage({ type: 'SET_CAP_OFF', off: e.target.checked }).then(render);
  $('capWarn').textContent = capOff ? 'Portal usually stops serving the calendar after ~15-20/day. Checks still pause on a 429/Cloudflare block.' : '';
  $('toggle').textContent = s.enabled ? 'Turn off' : 'Turn on';
  $('toggle').title = s.enabled
    ? 'Turns off scheduled (:15/:25/:55) checks. Check now and Book now still work.'
    : 'Turns scheduled (:15/:25/:55) checks back on.';
  $('toggle').onclick = () => chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: !s.enabled }).then(render);
  // Only touch the text when it changed, so scrolling back through a long log isn't reset every refresh.
  const logText = s.log.join('\n') || 'No activity yet.';
  if ($('log').textContent !== logText) $('log').textContent = logText;
}

$('checkNow').onclick = async () => {
  $('checkNow').disabled = true;
  const { status } = await chrome.runtime.sendMessage({ type: 'CHECK_NOW' });
  const base = parseFloat(getComputedStyle($('checkNow')).fontSize) || 13;
  $('checkNow').textContent = status;
  $('checkNow').style.fontSize = `${base / 2}px`; // status text at half the button's normal size
  await render();
  // Results arrive in the log a few seconds later.
  setTimeout(async () => {
    $('checkNow').textContent = 'Check now';
    $('checkNow').style.fontSize = '';
    $('checkNow').disabled = false;
    await render();
  }, 20000);
};

async function bookNow(city, btn) {
  for (const b of bookButtons()) b.disabled = true;
  btn.textContent = '…';
  const { status } = await chrome.runtime.sendMessage({ type: 'REHEARSE', city });
  $('bookStatus').textContent = `${titleCase(city)}: ${status}`;
  await render();
  setTimeout(async () => {
    resetBookButtons();
    $('bookStatus').textContent = '';
    await render();
  }, 15000);
}

$('stop').onclick = async () => {
  const { status } = await chrome.runtime.sendMessage({ type: 'CANCEL' });
  $('stop').textContent = status;
  // Put Check now / Book now back to normal so they can be used again.
  $('checkNow').textContent = 'Check now';
  $('checkNow').style.fontSize = '';
  $('checkNow').disabled = false;
  resetBookButtons();
  $('bookStatus').textContent = '';
  await render();
  setTimeout(() => { $('stop').textContent = 'Stop'; }, 3000);
};

// Every 5 min vs only :15/:25/:55; the countdown follows on the next refresh.
$('extraWindows').onchange = (e) => chrome.runtime.sendMessage({ type: 'SET_EXTRA_WINDOWS', on: e.target.checked }).then(render);

// Both boxes save together as [min, max]; each check picks a random delay in that range.
$('startDelayMin').onchange = $('startDelayMax').onchange = async (e) => {
  const res = await chrome.runtime.sendMessage({ type: 'SET_START_DELAY', min: $('startDelayMin').value, max: $('startDelayMax').value });
  $('startDelayErr').textContent = res?.ok ? '' : res?.error || 'Could not save';
  e.target.blur();
  await render();
};

// Follow-up checks: the tick box and both number boxes save together.
const saveRepeat = async (e) => {
  const res = await chrome.runtime.sendMessage({ type: 'SET_REPEAT', on: $('repeatOn').checked, everySec: $('repeatEvery').value, forMin: $('repeatFor').value });
  $('repeatErr').textContent = res?.ok ? '' : res?.error || 'Could not save';
  if (e.target.type === 'number') e.target.blur();
  await render();
};
for (const id of ['repeatOn', 'repeatEvery', 'repeatFor']) $(id).disabled = true; // read-only: edit repeatChecks in config.js

const saveConsularLimit = () => chrome.runtime.sendMessage({ type: 'SET_CONSULAR_LIMIT', weeks: $('consularWeeks').value, ofcDate: $('ofcDate').value }).then(render);
$('consularWeeks').onchange = (e) => { e.target.blur(); saveConsularLimit(); };
// The date box reports a "change" mid-typing (year 2 -> 0002), so save only when you leave it or press Enter.
$('ofcDate').onblur = saveConsularLimit;
$('ofcDate').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };

// Log in / Answer questions act on the tab this popup was opened over.
for (const [id, type, label] of [['login', 'LOGIN', 'Log in'], ['answer', 'ANSWER_QUESTIONS', 'Answer questions']]) {
  $(id).onclick = async () => {
    $(id).disabled = true;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { status } = await chrome.runtime.sendMessage({ type, tabId: tab?.id });
    $(id).textContent = status;
    await render();
    setTimeout(() => { $(id).textContent = label; $(id).disabled = false; }, 4000);
  };
}

$('capture').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({ type: 'CAPTURE', tabId: tab?.id });
  await render();
};

$('testBat').onclick = async () => {
  $('testBat').disabled = true;
  const { status } = await chrome.runtime.sendMessage({ type: 'RUN_TEST_BAT' });
  $('testBat').textContent = status;
  await render();
  setTimeout(() => { $('testBat').textContent = 'Test .bat'; $('testBat').disabled = false; }, 4000);
};

$('testSignIn').onclick = async () => {
  $('testSignIn').disabled = true;
  const { status } = await chrome.runtime.sendMessage({ type: 'TEST_SIGN_IN' });
  $('testSignIn').textContent = status;
  await render();
  setTimeout(() => { $('testSignIn').textContent = 'Test sign-in'; $('testSignIn').disabled = false; }, 4000);
};

$('clear').onclick = () => chrome.runtime.sendMessage({ type: 'CLEAR_PAUSE' }).then(render);
chrome.action.setBadgeText({ text: '' });
render();
// Tick the countdown every second; refresh state (log, next run) every 2 s.
setInterval(tick, 1000);
setInterval(() => render().catch(() => {}), 2000);
