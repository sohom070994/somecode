const $ = (id) => document.getElementById(id);

// One checkbox per city; Check now goes through the ticked ones in this order.
function renderCities(cities, selected) {
  const box = $('cityList');
  if (box.childElementCount) return; // built once; checkboxes keep their own state
  for (const city of cities) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = city;
    cb.checked = !Array.isArray(selected) || selected.includes(city);
    cb.onchange = () => chrome.runtime.sendMessage({
      type: 'SET_SELECTED',
      cities: [...box.querySelectorAll('input:checked')].map((c) => c.value),
    });
    label.append(cb, titleCase(city));
    box.append(label);
  }
}

// Book now city dropdown, filled once from config cities (Hyderabad preselected).
function renderBookCities(cities) {
  const sel = $('rehearseCity');
  if (sel.options.length) return;
  for (const city of cities) sel.add(new Option(titleCase(city), city, false, city === 'HYDERABAD'));
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
    sel.add(new Option('Off (any date)', '0'));
    for (let w = 1; w <= 12; w++) sel.add(new Option(`${w} week${w > 1 ? 's' : ''} of OFC`, String(w)));
  }
  if (document.activeElement !== sel) sel.value = String(weeks);
  if (document.activeElement !== $('ofcDate')) $('ofcDate').value = ofcDate;
  $('consularNote').textContent = !weeks ? ''
    : latest ? `Consular dates up to ${latest}`
    : 'Enter the OFC date to apply the limit';
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
  const { state: s, cap, capOff, testMode, cities, skipDates, keepAlive, startDelaySeconds, extraWindows,
    extraWindowMinutes = [], mainWindowMinutes = [], offGridWindows, consularWeeks = 0, ofcDate = '', consularLatest = null } = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  $('extraWindows').checked = !!extraWindows;
  $('offGridWindows').checked = !!offGridWindows;
  // The minutes the checkbox adds (beyond the always-on ones), e.g. [:00, :05, :10 ...].
  const mm = (list) => `[${list.map((m) => `:${String(m).padStart(2, '0')}`).join(', ')}]`;
  const main = [...mainWindowMinutes].sort((a, b) => a - b);
  $('mainTimes').textContent = mm(main.filter((m) => m % 5 === 0));
  $('offGridTimes').textContent = mm(main.filter((m) => m % 5 !== 0));
  const extra = extraWindowMinutes.filter((m) => !mainWindowMinutes.includes(m)).sort((a, b) => a - b);
  $('extraTimes').textContent = mm(extra);
  // Don't overwrite the box while you're typing in it.
  // [min, max]; a single number comes from a background that hasn't been reloaded yet.
  const [delayLo, delayHi] = Array.isArray(startDelaySeconds) ? startDelaySeconds : [startDelaySeconds || 0, startDelaySeconds || 0];
  if (![$('startDelayMin'), $('startDelayMax')].includes(document.activeElement)) {
    $('startDelayMin').value = delayLo;
    $('startDelayMax').value = delayHi;
  }
  renderSkipDates(skipDates || {});
  renderConsularLimit(consularWeeks, ofcDate, consularLatest);
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
  renderBookCities(cities);
  const paused = Date.now() < s.pausedUntil;
  $('test').textContent = testMode ? 'TEST MODE: will not click Submit (set testMode: false in config.js)' : '';
  const pauseText = s.pauseForChallenge
    ? 'Paused - pass Cloudflare check on schedule page'
    : `Paused until ${new Date(s.pausedUntil).toLocaleTimeString()}`;
  $('status').textContent = s.booked ? 'Booked - stopped' : !s.enabled ? 'Off' : paused ? pauseText : 'Running';
  $('count').textContent = capOff ? `${s.count} (no cap)` : `${s.count} / ${cap}`;
  $('capOff').checked = capOff;
  $('capOff').onchange = (e) => chrome.runtime.sendMessage({ type: 'SET_CAP_OFF', off: e.target.checked }).then(render);
  $('capWarn').textContent = capOff ? 'Portal usually stops serving the calendar after ~15-20/day. Checks still pause on a 429/Cloudflare block.' : '';
  $('toggle').textContent = s.enabled ? 'Turn off' : 'Turn on';
  $('toggle').title = s.enabled
    ? 'Turns off scheduled (:25/:55) and WhatsApp-triggered checks. Check now and Book now still work.'
    : 'Turns scheduled (:25/:55) and WhatsApp-triggered checks back on.';
  $('toggle').onclick = () => chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: !s.enabled }).then(render);
  $('log').textContent = s.log.join('\n') || 'No activity yet.';
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

$('rehearse').onclick = async () => {
  $('rehearse').disabled = true;
  const { status } = await chrome.runtime.sendMessage({ type: 'REHEARSE', city: $('rehearseCity').value });
  $('rehearse').textContent = status.length > 30 ? 'See log' : status;
  await render();
  setTimeout(async () => {
    $('rehearse').textContent = 'Book now (any date)';
    $('rehearse').disabled = false;
    await render();
  }, 15000);
};

$('stop').onclick = async () => {
  const { status } = await chrome.runtime.sendMessage({ type: 'CANCEL' });
  $('stop').textContent = status;
  // Put Check now / Book now back to normal so they can be used again.
  $('checkNow').textContent = 'Check now';
  $('checkNow').style.fontSize = '';
  $('checkNow').disabled = false;
  $('rehearse').textContent = 'Book now (any date)';
  $('rehearse').disabled = false;
  await render();
  setTimeout(() => { $('stop').textContent = 'Stop'; }, 3000);
};

// Every 5 min vs only :25/:55; the countdown follows on the next refresh.
$('extraWindows').onchange = (e) => chrome.runtime.sendMessage({ type: 'SET_EXTRA_WINDOWS', on: e.target.checked }).then(render);

// Main times off the 5-minute grid (:02 :14 :27 ...) on/off; :25/:55 always stay.
$('offGridWindows').onchange = (e) => chrome.runtime.sendMessage({ type: 'SET_OFFGRID_WINDOWS', on: e.target.checked }).then(render);

// Both boxes save together as [min, max]; each check picks a random delay in that range.
$('startDelayMin').onchange = $('startDelayMax').onchange = async (e) => {
  const res = await chrome.runtime.sendMessage({ type: 'SET_START_DELAY', min: $('startDelayMin').value, max: $('startDelayMax').value });
  $('startDelayErr').textContent = res?.ok ? '' : res?.error || 'Could not save';
  e.target.blur();
  await render();
};

const saveConsularLimit = () => chrome.runtime.sendMessage({ type: 'SET_CONSULAR_LIMIT', weeks: $('consularWeeks').value, ofcDate: $('ofcDate').value }).then(render);
$('consularWeeks').onchange = (e) => { e.target.blur(); saveConsularLimit(); };
// The date box reports a "change" mid-typing (year 2 -> 0002), so save only when you leave it or press Enter.
$('ofcDate').onblur = saveConsularLimit;
$('ofcDate').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };

$('capture').onclick = () => chrome.runtime.sendMessage({ type: 'CAPTURE' }).then(render);

$('waTest').onclick = () => chrome.runtime.sendMessage({ type: 'WA_TEST' }).then(render);

$('clear').onclick = () => chrome.runtime.sendMessage({ type: 'CLEAR_PAUSE' }).then(render);
chrome.action.setBadgeText({ text: '' });
render();
// Tick the countdown every second; refresh state (log, next run) every 2 s.
setInterval(tick, 1000);
setInterval(() => render().catch(() => {}), 2000);
