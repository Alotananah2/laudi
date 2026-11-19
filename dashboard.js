// Laudi dashboard: runs all the time (separate from Laudi himself), so it can start/stop him,
// show his invisible browser, run the setup, and keep alarms. Open http://<this-computer>:8787
// The phone app and Murdhi's Server dashboard (/embed) use the same page.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const SETTINGS = path.join(ROOT, 'local-settings.txt');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const BOT = `http://127.0.0.1:${process.env.CONTROL_PORT || 8788}`;
fs.mkdirSync(DATA, { recursive: true });

// ------------------------------------------------------------------ small helpers

const readJson = (f, def) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return def; }
};
const writeJson = (f, v, mode) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 2), mode ? { mode } : undefined);

function settings() {
  const out = {};
  try {
    for (const l of fs.readFileSync(SETTINGS, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}

function setSettings(patch) {
  let lines = [];
  try { lines = fs.readFileSync(SETTINGS, 'utf8').split(/\r?\n/); } catch {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const val = String(v).replace(/[\r\n]/g, '');
    const i = lines.findIndex((l) => new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${k}=${val}`;
    else lines.push(`${k}=${val}`);
  }
  fs.writeFileSync(SETTINGS, lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n', { mode: 0o600 });
}

const TZ = () => settings().TIMEZONE || 'Asia/Riyadh';
function localNow() {
  // "now" as a Date whose getHours()/getDay() are in Murdhi's time zone
  const s = new Date().toLocaleString('en-US', { timeZone: TZ() });
  return new Date(s);
}

/** The dashboard is only open 8pm-10am (DASHBOARD_HOURS=20-10, or "always"). */
function open() {
  const h = (settings().DASHBOARD_HOURS || '20-10').trim();
  if (/^always$/i.test(h)) return true;
  const m = h.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return true;
  const from = +m[1], to = +m[2], now = localNow().getHours();
  return from > to ? now >= from || now < to : now >= from && now < to;
}

const setupDone = () => Boolean(settings().DASHBOARD_PIN);

// ------------------------------------------------------------------ login (PIN -> token)

const tokens = () => readJson('dashboard-tokens.json', []);
function newToken() {
  const t = crypto.randomBytes(24).toString('hex');
  writeJson('dashboard-tokens.json', [...tokens().slice(-20), t], 0o600);
  return t;
}
function authed(req, u) {
  const c = (req.headers.cookie || '').match(/(?:^|;\s*)lt=([a-f0-9]+)/);
  const t = req.headers['x-token'] || (c && c[1]) || u.searchParams.get('token');
  return Boolean(t && tokens().includes(t));
}
const fails = new Map(); // ip -> [count, until]

// ------------------------------------------------------------------ Laudi the service

// Laudi is a system service (laudi.service); start/stop go through a sudo rule install.sh adds.
const sysctl = (args) =>
  new Promise((res) => {
    const [cmd, ...rest] = args[0] === 'is-active' ? ['systemctl', ...args] : ['sudo', '-n', 'systemctl', ...args];
    execFile(cmd, rest, { timeout: 15_000 }, (err, so, se) => res({ ok: !err, out: String(so || se || '').trim() }));
  });

// HUB MODE: Laudi runs on the Windows PC. LAUDI_PC_URL=http://<pc>:8787 (Laudi Control) + LAUDI_PC_PIN.
const PC = () => {
  const s = settings();
  return s.LAUDI_PC_URL ? { url: s.LAUDI_PC_URL.replace(/\/+$/, ''), pin: s.LAUDI_PC_PIN || '' } : null;
};

async function timedFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 4000);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Talk to Laudi's control port: here (127.0.0.1:8788) or on the PC through Laudi Control. */
async function botCall(p, opts = {}) {
  const pc = PC();
  if (!pc) return timedFetch(BOT + p, opts);
  const sep = p.includes('?') ? '&' : '?';
  return timedFetch(`${pc.url}/api/bot${p}${sep}pin=${encodeURIComponent(pc.pin)}`, { ...opts, timeout: Math.max(opts.timeout || 4000, 6000) });
}

/** Laudi Control on the PC (start/stop/status even when Laudi is off). */
async function pcApi(p, q = {}) {
  const pc = PC();
  const qs = new URLSearchParams({ ...q, pin: pc.pin }).toString();
  const r = await timedFetch(`${pc.url}/api/${p}?${qs}`, { timeout: 8000 });
  return r.json();
}

async function botStatus() {
  if (PC()) {
    let pcSt = null, live = null;
    try { pcSt = await pcApi('status'); } catch {}
    try {
      const r = await botCall('/status', { timeout: 5000 });
      if (r.ok) live = await r.json();
    } catch {}
    return { service: pcSt ? 'on the PC' : 'PC unreachable', where: 'pc', pcOnline: Boolean(pcSt), pcLog: pcSt ? pcSt.log : '', pcName: pcSt ? pcSt.pc : '', running: Boolean(live) || Boolean(pcSt && pcSt.running), ...(live || {}) };
  }
  const svc = await sysctl(['is-active', 'laudi.service']);
  let live = null;
  try {
    const r = await botCall('/status', { timeout: 2500 });
    if (r.ok) live = await r.json();
  } catch {}
  const service = /^(active|inactive|failed|activating|deactivating)$/.test(svc.out) ? svc.out : 'no systemd';
  return { service, running: Boolean(live) || service === 'active', ...(live || {}) };
}

async function startBot() {
  if (PC()) return (await pcApi('cmd', { c: 'start' }).catch((e) => ({ msg: `PC unreachable: ${e.message}` }))).msg || 'Starting Laudi on the PC…';
  try { fs.unlinkSync(path.join(DATA, 'stop.flag')); } catch {}
  const r = await sysctl(['start', 'laudi.service']);
  if (r.ok) return 'Starting Laudi… (~20 s)';
  // no systemd user service (dev setup): run start.sh ourselves
  spawn('bash', [path.join(ROOT, 'start.sh')], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
  return 'Starting Laudi…';
}

async function stopBot() {
  if (PC()) return (await pcApi('cmd', { c: 'stop' }).catch((e) => ({ msg: `PC unreachable: ${e.message}` }))).msg || 'Stopping Laudi on the PC';
  fs.writeFileSync(path.join(DATA, 'stop.flag'), 'stop');
  const r = await sysctl(['stop', 'laudi.service']);
  if (!r.ok) remote('shutdown');
  return 'Laudi stopped';
}

function remote(line) {
  if (PC()) {
    botCall('/remote', { method: 'POST', body: JSON.stringify({ line }), timeout: 8000 }).catch((e) => console.warn('[hub] PC unreachable:', e.message));
    return;
  }
  fs.appendFileSync(path.join(DATA, 'remote.txt'), String(line).replace(/[\r\n]+/g, ' ') + '\n');
}

function logTail(n) {
  try {
    const f = path.join(DATA, 'bot.log');
    const size = fs.statSync(f).size;
    const len = Math.min(size, 16000);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).slice(-n).join('\n');
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------ alarms

const alarms = () => readJson('alarms.json', []);
const saveAlarms = (a) => writeJson('alarms.json', a);
let firedKey = '';

setInterval(() => {
  const now = localNow();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const key = `${now.toDateString()} ${hm}`;
  if (key === firedKey) return;
  const list = alarms();
  let changed = false;
  for (const a of list) {
    if (!a.enabled || a.time !== hm) continue;
    if (a.days && a.days.length && !a.days.includes(now.getDay())) continue;
    firedKey = key;
    console.log(`[alarm] ⏰ ${a.label || 'alarm'} (${hm})`);
    if (a.laudiCalls !== false) remote(`alarm ${a.label || 'Alarm'}`);
    if (!a.days || !a.days.length) {
      a.enabled = false; // one-time alarm
      changed = true;
    }
  }
  if (changed) saveAlarms(list);
}, 15_000);

// ------------------------------------------------------------------ setup (accounts, keys, PIN)

function setupView() {
  const s = settings();
  let sec = {};
  try { sec = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8')); } catch {}
  const has = (v) => Boolean(v && String(v).length);
  return {
    done: setupDone(),
    ownerName: s.OWNER_NAME || '',
    ownerTiktok: s.OWNER_TIKTOK || '',
    ownerTiktokName: s.OWNER_TIKTOK_NAME || '',
    discordOwner: s.DISCORD_OWNER || '',
    elementOwner: s.ELEMENT_OWNER || '',
    assistantName: s.ASSISTANT_NAME || 'Laudi',
    tiktokUser: sec.tiktokUser || '',
    elementUser: sec.elementUser || '',
    hours: s.DASHBOARD_HOURS || '20-10',
    timezone: s.TIMEZONE || 'Asia/Riyadh',
    edunationUrl: s.EDUNATION_URL || 'https://app.edu-nation.net/',
    pcUrl: s.LAUDI_PC_URL || '',
    // secrets: only say whether they're set, never send them back
    set: {
      tiktokPass: has(sec.tiktokPass),
      elementPass: has(sec.elementPass),
      groq: has(s.GROQ_API_KEY),
      gemini: has(s.GEMINI_API_KEY),
      discord: has(s.DISCORD_TOKEN),
      pin: has(s.DASHBOARD_PIN),
      pcPin: has(s.LAUDI_PC_PIN),
    },
    features: {
      GROUPS: s.GROUPS !== '0',
      POSTS_PER_DAY: s.POSTS_PER_DAY !== '0',
      DISCORD_ENABLED: s.DISCORD_ENABLED !== '0',
      ELEMENT_ENABLED: s.ELEMENT_ENABLED !== '0',
      WATCH_ACCOUNTS: s.WATCH_ACCOUNTS !== '0',
      CALL_EVERY_MINUTES: (s.CALL_EVERY_MINUTES || '0') !== '0',
    },
  };
}

function saveSetup(b) {
  const p = {};
  const map = {
    ownerName: 'OWNER_NAME', ownerTiktok: 'OWNER_TIKTOK', ownerTiktokName: 'OWNER_TIKTOK_NAME', discordOwner: 'DISCORD_OWNER',
    elementOwner: 'ELEMENT_OWNER', assistantName: 'ASSISTANT_NAME', timezone: 'TIMEZONE', edunationUrl: 'EDUNATION_URL',
  };
  for (const [k, env] of Object.entries(map)) if (typeof b[k] === 'string' && b[k].trim()) p[env] = b[k].trim();
  if (typeof b.hours === 'string' && /^(always|\d{1,2}-\d{1,2})$/i.test(b.hours.trim())) p.DASHBOARD_HOURS = b.hours.trim();
  if (typeof b.pcUrl === 'string') p.LAUDI_PC_URL = b.pcUrl.trim().replace(/\/+$/, '');
  if (b.pcPin) p.LAUDI_PC_PIN = String(b.pcPin).trim();
  if (b.groq) p.GROQ_API_KEY = String(b.groq).trim();
  if (b.gemini) p.GEMINI_API_KEY = String(b.gemini).trim();
  if (b.discord) p.DISCORD_TOKEN = String(b.discord).trim();
  if (b.pin) {
    if (!/^\d{4,8}$/.test(String(b.pin))) throw new Error('PIN must be 4-8 numbers');
    p.DASHBOARD_PIN = String(b.pin);
  }
  if (b.features) {
    const f = b.features;
    if ('GROUPS' in f) p.GROUPS = f.GROUPS ? '1' : '0';
    if ('POSTS_PER_DAY' in f) p.POSTS_PER_DAY = f.POSTS_PER_DAY ? '8' : '0';
    if ('DISCORD_ENABLED' in f) p.DISCORD_ENABLED = f.DISCORD_ENABLED ? '1' : '0';
    if ('ELEMENT_ENABLED' in f) p.ELEMENT_ENABLED = f.ELEMENT_ENABLED ? '1' : '0';
    if ('WATCH_ACCOUNTS' in f) p.WATCH_ACCOUNTS = f.WATCH_ACCOUNTS ? '1' : '0';
    if ('CALL_EVERY_MINUTES' in f) p.CALL_EVERY_MINUTES = f.CALL_EVERY_MINUTES ? '60' : '0';
  }
  // Laudi on Linux never plays Roblox and never does live support
  p.ROBLOX_ENABLED = '0';
  p.LIVE_SUPPORT = '0';
  setSettings(p);
  // passwords: separate owner-only file
  let sec = {};
  try { sec = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8')); } catch {}
  if (typeof b.tiktokUser === 'string' && b.tiktokUser.trim()) sec.tiktokUser = b.tiktokUser.trim();
  if (b.tiktokPass) sec.tiktokPass = String(b.tiktokPass);
  if (typeof b.elementUser === 'string' && b.elementUser.trim()) sec.elementUser = b.elementUser.trim();
  if (b.elementPass) sec.elementPass = String(b.elementPass);
  writeJson('secrets.json', sec, 0o600);
  try { fs.chmodSync(path.join(DATA, 'secrets.json'), 0o600); } catch {}
}

// ------------------------------------------------------------------ HTTP

function readBody(req) {
  return new Promise((res) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { res(JSON.parse(d || '{}')); } catch { res({}); }
    });
  });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, type, body, extra = {}) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
      res.end(body);
    };
    const json = (o, code = 200, extra) => send(code, 'application/json; charset=utf-8', JSON.stringify(o), extra);
    try {
      // ---------- static page
      if (!u.pathname.startsWith('/api/')) {
        let f = u.pathname === '/' || u.pathname === '/embed' ? '/index.html' : u.pathname;
        f = path.normalize(f).replace(/^(\.\.[/\\])+/, '');
        const file = path.join(WEB, f);
        if (!file.startsWith(WEB) || !fs.existsSync(file)) return send(404, 'text/plain', 'not found');
        return send(200, TYPES[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
      }

      // ---------- always available
      if (u.pathname === '/api/hello') {
        return json({ name: settings().ASSISTANT_NAME || 'Laudi', setup: setupDone(), open: open(), hours: settings().DASHBOARD_HOURS || '20-10', authed: authed(req, u), timezone: TZ() });
      }
      if (u.pathname === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        const f = fails.get(ip) || [0, 0];
        if (f[1] > Date.now()) return json({ error: 'Too many tries, wait a minute' }, 429);
        const b = await readBody(req);
        if (!setupDone() || String(b.pin) !== settings().DASHBOARD_PIN) {
          fails.set(ip, [f[0] + 1, f[0] + 1 >= 5 ? Date.now() + 60_000 : 0]);
          await new Promise((r) => setTimeout(r, 800));
          return json({ error: 'Wrong PIN' }, 401);
        }
        fails.delete(ip);
        const t = newToken();
        return json({ token: t }, 200, { 'Set-Cookie': `lt=${t}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly` });
      }
      // first-time setup: no PIN yet, so anyone on your network can do it once
      if (u.pathname === '/api/setup' && req.method === 'POST' && !setupDone()) {
        const b = await readBody(req);
        if (!b.pin) return json({ error: 'Choose a PIN first' }, 400);
        saveSetup(b);
        const t = newToken();
        startBot().catch(() => {});
        return json({ ok: true, token: t }, 200, { 'Set-Cookie': `lt=${t}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly` });
      }
      if (u.pathname === '/api/setup' && req.method === 'GET' && !setupDone()) return json(setupView());

      if (!authed(req, u)) return json({ error: 'login' }, 401);

      // alarms work any time (the phone app syncs them)
      if (u.pathname === '/api/alarms') {
        if (req.method === 'GET') return json(alarms());
        if (req.method === 'POST') {
          const b = await readBody(req);
          const list = alarms();
          if (b.delete) return json((saveAlarms(list.filter((a) => a.id !== b.delete)), alarms()));
          if (!/^\d{2}:\d{2}$/.test(String(b.time || ''))) return json({ error: 'time must be HH:MM' }, 400);
          const a = {
            id: b.id || crypto.randomBytes(6).toString('hex'),
            time: b.time,
            label: String(b.label || 'Alarm').slice(0, 60),
            days: Array.isArray(b.days) ? b.days.filter((d) => d >= 0 && d <= 6) : [],
            enabled: b.enabled !== false,
            laudiCalls: b.laudiCalls !== false,
          };
          const i = list.findIndex((x) => x.id === a.id);
          if (i >= 0) list[i] = a;
          else list.push(a);
          saveAlarms(list);
          return json(alarms());
        }
      }

      // ---------- everything else: only 8pm-10am
      if (!open()) return json({ error: 'closed', hours: settings().DASHBOARD_HOURS || '20-10' }, 403);

      if (u.pathname === '/api/status') {
        const st = await botStatus();
        const n = Number(u.searchParams.get('lines')) || 40;
        const log = st.where === 'pc' ? String(st.pcLog || '').split('\n').slice(-n).join('\n') : logTail(n);
        return json({ ...st, host: st.where === 'pc' ? `${st.pcName || 'PC'} (hub: ${os.hostname()})` : os.hostname(), machineMemory: memPct(), log });
      }
      if (u.pathname === '/api/setup') {
        if (req.method === 'GET') return json(setupView());
        const b = await readBody(req);
        saveSetup(b);
        if (b.restart !== false && !PC() && (await botStatus()).running) remote('restart');
        return json({ ok: true });
      }
      if (u.pathname === '/api/cmd' && req.method === 'POST') {
        const b = await readBody(req);
        const c = String(b.c || '').toLowerCase();
        if (c === 'start') return json({ msg: await startBot() });
        if (c === 'stop') return json({ msg: await stopBot() });
        if (c === 'restart' && PC()) return json({ msg: (await pcApi('cmd', { c: 'restart' }).catch(() => ({}))).msg || 'Restarting Laudi on the PC…' });
        if (c === 'gaming-on' || c === 'gaming-off') return json((remote(c.replace('-', ' ')), { msg: c === 'gaming-on' ? 'Gaming mode on 🎮' : 'Gaming mode off' }));
        if (c === 'restart') {
          const r = await sysctl(['restart', 'laudi.service']);
          if (!r.ok) remote('restart');
          return json({ msg: 'Restarting Laudi…' });
        }
        if (c === 'say' && b.text) return json((remote(`say ${b.text}`), { msg: 'Sent' }));
        if (['vid', 'post-now', 'hi', 'health', 'elring', 'ring', 'hangup', 'update'].includes(c)) return json((remote(c), { msg: `Sent: ${c}` }));
        return json({ error: 'unknown command' }, 400);
      }
      // ---------- the screen of Laudi's invisible browser (for logins, QR codes, puzzles)
      if (u.pathname === '/api/tabs') {
        const r = await botCall('/tabs').catch(() => null);
        return r ? json(await r.json()) : json({ error: 'Laudi is not running' }, 503);
      }
      if (u.pathname === '/api/shot') {
        const r = await botCall(`/shot?tab=${encodeURIComponent(u.searchParams.get('tab') || '0')}&q=50`, { timeout: 10_000 }).catch(() => null);
        if (!r || !r.ok) return send(503, 'text/plain', 'Laudi is not running');
        return send(200, 'image/jpeg', Buffer.from(await r.arrayBuffer()));
      }
      // ---------- Murdhi's Server page
      if (u.pathname === '/api/server') return json(await require('./server-info').info(settings));
      if (u.pathname === '/api/server/action' && req.method === 'POST') return json({ msg: await require('./server-info').action(settings, await readBody(req)) });
      if (u.pathname === '/api/session' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await botCall('/cookies', { method: 'POST', body: JSON.stringify(b), timeout: 30_000 }).catch(() => null);
        return r ? json(await r.json()) : json({ error: 'Laudi is not running - press Start first' }, 503);
      }
      if ((u.pathname === '/api/input' || u.pathname === '/api/autologin') && req.method === 'POST') {
        const b = await readBody(req);
        const r = await botCall(u.pathname === '/api/input' ? '/input' : '/login', { method: 'POST', body: JSON.stringify(b), timeout: 60_000 }).catch(() => null);
        return r ? json(await r.json()) : json({ error: 'Laudi is not running' }, 503);
      }
      json({ error: 'not found' }, 404);
    } catch (e) {
      json({ error: e.message }, 500);
    }
  })
  .listen(PORT, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log(`🌙 Laudi dashboard: ${ips.map((ip) => `http://${ip}:${PORT}`).join('  ') || `http://localhost:${PORT}`}`);
  });

function memPct() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8');
    return Math.round((1 - +m.match(/MemAvailable:\s+(\d+)/)[1] / +m.match(/MemTotal:\s+(\d+)/)[1]) * 100);
  } catch {
    return Math.round((1 - os.freemem() / os.totalmem()) * 100);
  }
}
