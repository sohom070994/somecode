// Chrome native messaging host for Visa Slot Watcher.
// Appends log lines to <slot-watcher>/logs/YYYY-MM-DD.log. Chrome starts this per message
// (chrome.runtime.sendNativeMessage) and talks over stdin/stdout: 4-byte little-endian length + JSON.
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const SHOT_DIR = path.join(__dirname, '..', 'screenshots');

function reply(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

// Newest "dates found - in range" event in the log files, with its times, outcome and screenshot.
function lastSlot() {
  if (!fs.existsSync(LOG_DIR)) return { ok: true, found: false };
  const files = fs.readdirSync(LOG_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().reverse();
  const FOUND = /^(\d{4}-\d{2}-\d{2} \d\d:\d\d:\d\d)\s+(.+?): dates found - in range: (.+?) \| all returned/;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(FOUND);
      if (!m) continue;
      const [, at, city, dates] = m;
      const out = { ok: true, found: true, at, city, dates: dates.split(', '), times: [], attempts: [], outcome: '', shot: null };
      for (let j = i + 1; j < lines.length && j < i + 80; j++) {
        const l = lines[j];
        if (j > i + 1 && FOUND.test(l)) break; // the next find starts
        const text = l.replace(/^\d{4}-\d{2}-\d{2} [\d:]+\s+/, '');
        let x;
        if (text.startsWith(city + ' ') && (x = text.match(/^.+? (\d{4}-\d{2}-\d{2}): times - (.+)$/))) {
          if (!out.times.some((t) => t.startsWith(x[1]))) out.times.push(x[1] + ': ' + x[2]);
        } else if (text.startsWith(city + ': ') && (x = text.match(/found, autobook failed - (.+)$/))) {
          out.outcome = 'could not be booked - ' + x[1];
        } else if (text.includes('BOOKED') && text.includes(city)) {
          out.outcome = 'BOOKED - portal confirmed';
        } else if (text.startsWith(city + ': submitted ')) {
          out.outcome = text.slice(city.length + 2);
        } else if (l.startsWith(' ') || /^\d{4}-\d{2}-\d{2} [\d:]+ {4}/.test(l)) {
          if (text.startsWith(city + ' ') && /no answer|error|failed|too many|greyed|next slot/i.test(text) && !out.attempts.includes(text)) out.attempts.push(text);
        } else if (!out.shot && (x = text.match(/^Screenshot \([^)]*\): (.+\.(?:jpg|png))$/))) {
          const p = path.resolve(x[1]);
          if (p.toLowerCase().startsWith(path.resolve(SHOT_DIR).toLowerCase()) && fs.existsSync(p) && fs.statSync(p).size < 700000) out.shot = fs.readFileSync(p).toString('base64');
        }
      }
      if (!out.outcome) out.outcome = 'no booking result in the log';
      return out;
    }
  }
  return { ok: true, found: false };
}

function handle(msg) {
  try {
    if (msg.action === 'ping') return reply({ ok: true, dir: LOG_DIR });
    if (msg.action === 'runBat') {
      // Detached: Chrome ends this helper once it replies, and the batch file must outlive it.
      const bat = path.join(__dirname, '..', 'test.bat');
      require('child_process').spawn('cmd.exe', ['/c', 'start', '""', '/min', bat], { detached: true, stdio: 'ignore' }).unref();
      return reply({ ok: true, ran: bat });
    }
    if (msg.action === 'saveShot') {
      // screenshots/YYYY-MM-DD/<name>; the folder and file name come only from plain patterns.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(msg.day) || !/^[\w-]+\.(png|jpg)$/.test(msg.name)) return reply({ ok: false, error: 'bad screenshot name' });
      const dir = path.join(SHOT_DIR, msg.day);
      fs.mkdirSync(dir, { recursive: true });
      let file = path.join(dir, msg.name);
      for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, msg.name.replace(/(\.\w+)$/, `_${i}$1`));
      fs.writeFileSync(file, Buffer.from(String(msg.data || ''), 'base64'));
      return reply({ ok: true, file });
    }
    if (msg.action === 'lastSlot') return reply(lastSlot());
    if (msg.action !== 'append') return reply({ ok: false, error: `unknown action ${msg.action}` });
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const byDay = {};
    for (const e of msg.entries || []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e?.day)) continue; // file name comes only from a plain date
      (byDay[e.day] ||= []).push(String(e.line).replace(/[\r\n]+/g, ' '));
    }
    let written = 0;
    for (const [day, lines] of Object.entries(byDay)) {
      fs.appendFileSync(path.join(LOG_DIR, `${day}.log`), `${lines.join('\r\n')}\r\n`, 'utf8');
      written += lines.length;
    }
    return reply({ ok: true, written, dir: LOG_DIR });
  } catch (e) {
    return reply({ ok: false, error: String(e?.message || e) });
  }
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const raw = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    let msg;
    try { msg = JSON.parse(raw); } catch { reply({ ok: false, error: 'bad JSON' }); continue; }
    handle(msg);
  }
});
