// Chrome native messaging host for Visa Slot Watcher.
// Appends log lines to <slot-watcher>/logs/YYYY-MM-DD.log. Chrome starts this per message
// (chrome.runtime.sendNativeMessage) and talks over stdin/stdout: 4-byte little-endian length + JSON.
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');

function reply(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

function handle(msg) {
  try {
    if (msg.action === 'ping') return reply({ ok: true, dir: LOG_DIR });
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
