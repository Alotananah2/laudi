// Laudi Remote for the Raspberry Pi: the phone app (same as Laudi Control's Phone tab on the PC).
// Runs on its own, so it can Start Laudi even when he's off. Open http://<pi-ip>:8787 on your phone.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const SETTINGS = path.join(ROOT, 'local-settings.txt');
const PORT = Number(process.env.PANEL_PORT || 8787);
fs.mkdirSync(DATA, { recursive: true });

function setting(key) {
  try {
    const m = fs.readFileSync(SETTINGS, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

// PIN: PHONE_PIN in local-settings.txt, otherwise a random one kept in data/phone-pin.txt
const PIN_FILE = path.join(DATA, 'phone-pin.txt');
let PIN = setting('PHONE_PIN');
if (PIN.length < 4) {
  try { PIN = fs.readFileSync(PIN_FILE, 'utf8').trim(); } catch {}
  if (PIN.length < 4) {
    PIN = String(100000 + Math.floor(Math.random() * 900000));
    fs.writeFileSync(PIN_FILE, PIN);
  }
}

function botPid() {
  try {
    const pid = Number(fs.readFileSync(path.join(DATA, 'bot.pid'), 'utf8').trim());
    process.kill(pid, 0);
    return pid;
  } catch {
    return 0;
  }
}

const remote = (line) => fs.appendFileSync(path.join(DATA, 'remote.txt'), line + '\n');

function start() {
  if (botPid()) return 'Laudi is already running';
  try { fs.unlinkSync(path.join(DATA, 'stop.flag')); } catch {}
  const term = ['lxterminal', 'x-terminal-emulator'].find((t) => fs.existsSync(`/usr/bin/${t}`));
  const cmd = term ? [term, ['-e', `bash "${path.join(ROOT, 'start.sh')}"`]] : ['bash', [path.join(ROOT, 'start.sh')]];
  spawn(cmd[0], cmd[1], { cwd: ROOT, detached: true, stdio: 'ignore', env: process.env }).unref();
  return 'Starting Laudi… (~20 s)';
}

function stop() {
  fs.writeFileSync(path.join(DATA, 'stop.flag'), 'stop');
  remote('shutdown');
  setTimeout(() => {
    const pid = botPid();
    if (pid) try { process.kill(pid); } catch {}
  }, 10_000);
  return 'Stopping Laudi';
}

function logTail(n) {
  try {
    const f = path.join(DATA, 'bot.log');
    const size = fs.statSync(f).size;
    const len = Math.min(size, 8000);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).slice(-n).join('\n');
  } catch {
    return '';
  }
}

const CMDS = new Set(['restart', 'vid', 'post-now', 'hi', 'health', 'elring', 'ring', 'hangup', 'update']);
const ICON = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='#5a63d6'/><text x='50' y='68' font-size='56' text-anchor='middle' fill='white' font-family='Arial' font-weight='bold'>L</text></svg>";
const MANIFEST = JSON.stringify({ name: 'Laudi Remote', short_name: 'Laudi', start_url: '/', display: 'standalone', background_color: '#181820', theme_color: '#181820', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] });

http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (u.pathname === '/' || u.pathname === '/index.html') {
      let html = '';
      try { html = fs.readFileSync(path.join(ROOT, 'gui', 'phone.html'), 'utf8'); } catch { html = 'phone.html missing'; }
      return send(200, 'text/html; charset=utf-8', html);
    }
    if (u.pathname === '/manifest.json') return send(200, 'application/manifest+json', MANIFEST);
    if (u.pathname === '/icon.svg') return send(200, 'image/svg+xml', ICON);
    if (!u.pathname.startsWith('/api/')) return send(404, 'application/json', '{}');
    if (u.searchParams.get('pin') !== PIN) return setTimeout(() => send(401, 'application/json', '{"error":"wrong pin"}'), 1500);
    const json = (o) => send(200, 'application/json; charset=utf-8', JSON.stringify(o));
    if (u.pathname === '/api/status') return json({ running: Boolean(botPid()), pc: `${os.hostname()} (Raspberry Pi)`, log: logTail(30) });
    if (u.pathname === '/api/cmd') {
      const c = String(u.searchParams.get('c') || '').toLowerCase();
      if (c === 'start') return json({ ok: true, msg: start() });
      if (c === 'stop') return json({ ok: true, msg: stop() });
      if (c === 'say') {
        const t = String(u.searchParams.get('t') || '').replace(/[\r\n]+/g, ' ').trim();
        if (!t) return json({ ok: false, error: 'empty' });
        remote(`say ${t}`);
        return json({ ok: true });
      }
      if (CMDS.has(c)) {
        remote(c);
        return json({ ok: true, msg: c === 'update' ? 'Updating… he restarts by himself' : `Sent: ${c}` });
      }
      return json({ ok: false, error: 'unknown command' });
    }
    return send(404, 'application/json', '{}');
  })
  .listen(PORT, '0.0.0.0', () => {
    const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    console.log(`📱 Laudi Remote: http://${ip ? ip.address : 'localhost'}:${PORT}  PIN ${PIN}`);
  });
