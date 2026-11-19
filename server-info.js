// Murdhi's Server: everything the dashboard's "Server" page shows (CPU, temp, network, Wi-Fi devices,
// ad blocker, apps, Tailscale) + a few safe buttons. Runs inside dashboard.js on the MacBook.
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const run = (cmd, args, timeout = 6000) =>
  new Promise((res) => execFile(cmd, args, { timeout }, (err, so) => res(err ? '' : String(so || ''))));
const read = (f) => {
  try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
};

// ---------------------------------------------------------------- CPU / memory / disk / temp

let lastCpu = null;
function cpuPct() {
  const line = read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  if (!line.length) return null;
  const idle = line[3] + (line[4] || 0), total = line.reduce((a, b) => a + b, 0);
  const prev = lastCpu;
  lastCpu = { idle, total };
  if (!prev) return null;
  const dt = total - prev.total;
  return dt > 0 ? Math.round((1 - (idle - prev.idle) / dt) * 100) : null;
}

function memory() {
  const m = read('/proc/meminfo');
  const t = +((m.match(/MemTotal:\s+(\d+)/) || [])[1] || 0), a = +((m.match(/MemAvailable:\s+(\d+)/) || [])[1] || 0);
  return t ? { pct: Math.round((1 - a / t) * 100), usedGb: +((t - a) / 1048576).toFixed(1), totalGb: +(t / 1048576).toFixed(1) } : null;
}

function temp() {
  // hottest CPU sensor we can find
  let best = null;
  try {
    for (const h of fs.readdirSync('/sys/class/hwmon')) {
      const dir = `/sys/class/hwmon/${h}`;
      const name = read(`${dir}/name`).trim();
      if (!/coretemp|k10temp|cpu|acpitz|applesmc/i.test(name)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => /^temp\d+_input$/.test(x))) {
        const c = +read(`${dir}/${f}`) / 1000;
        if (c > 0 && c < 120 && (best === null || c > best)) best = c;
      }
    }
  } catch {}
  if (best === null) {
    try {
      for (const z of fs.readdirSync('/sys/class/thermal').filter((x) => x.startsWith('thermal_zone'))) {
        const c = +read(`/sys/class/thermal/${z}/temp`) / 1000;
        if (c > 0 && c < 120 && (best === null || c > best)) best = c;
      }
    } catch {}
  }
  return best === null ? null : Math.round(best);
}

async function disk() {
  const out = await run('df', ['-B1', '--output=size,used', '/']);
  const n = out.trim().split('\n')[1];
  if (!n) return null;
  const [size, used] = n.trim().split(/\s+/).map(Number);
  return { pct: Math.round((used / size) * 100), usedGb: Math.round(used / 1e9), totalGb: Math.round(size / 1e9) };
}

// ---------------------------------------------------------------- network speed

let lastNet = null;
function netRate() {
  const now = Date.now();
  let rx = 0, tx = 0;
  for (const l of read('/proc/net/dev').split('\n').slice(2)) {
    const [name, rest] = l.split(':');
    if (!rest || /^(lo|docker|veth|br-|tailscale)/.test(name.trim())) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0]; tx += f[8];
  }
  const prev = lastNet;
  lastNet = { rx, tx, now };
  if (!prev || now === prev.now) return { down: 0, up: 0 };
  const s = (now - prev.now) / 1000;
  return { down: Math.max(0, (rx - prev.rx) / s), up: Math.max(0, (tx - prev.tx) / s) }; // bytes/second
}

async function ping() {
  const out = await run('ping', ['-c', '1', '-W', '2', '1.1.1.1'], 4000);
  const m = out.match(/time=([\d.]+)/);
  return m ? Math.round(+m[1]) : null;
}

// ---------------------------------------------------------------- Wi-Fi "Murdhi's server"

async function wifiDevices(iface) {
  let ifaces = iface ? [iface] : [];
  if (!ifaces.length) {
    const all = (await run('ls', ['/sys/class/net'])).split(/\s+/).filter((n) => /^wl/.test(n));
    ifaces = all.filter((n) => /^wlx/.test(n)); // the USB Wi-Fi adapter makes "Murdhi's server"
    if (!ifaces.length) ifaces = all;
  }
  const leases = {};
  for (const f of ['/var/lib/misc/dnsmasq.leases', '/var/lib/NetworkManager/dnsmasq-wlx.leases']) {
    for (const l of read(f).split('\n')) {
      const p = l.split(' ');
      if (p.length >= 4) leases[p[1].toLowerCase()] = { ip: p[2], name: p[3] === '*' ? '' : p[3] };
    }
  }
  try {
    for (const f of fs.readdirSync('/var/lib/NetworkManager').filter((x) => /\.leases$/.test(x) && /dnsmasq/.test(x))) {
      for (const l of read(`/var/lib/NetworkManager/${f}`).split('\n')) {
        const p = l.split(' ');
        if (p.length >= 4) leases[p[1].toLowerCase()] = { ip: p[2], name: p[3] === '*' ? '' : p[3] };
      }
    }
  } catch {}
  const list = [];
  for (const i of ifaces) {
    const out = await run('iw', ['dev', i, 'station', 'dump']);
    for (const block of out.split(/^Station /m).slice(1)) {
      const mac = block.slice(0, 17).toLowerCase();
      const sig = (block.match(/signal:\s+(-?\d+)/) || [])[1];
      const conn = (block.match(/connected time:\s+(\d+)/) || [])[1];
      const lease = leases[mac] || {};
      list.push({ mac, ip: lease.ip || '', name: lease.name || '', signal: sig ? +sig : null, minutes: conn ? Math.round(+conn / 60) : null, iface: i });
    }
  }
  return list;
}

// ---------------------------------------------------------------- AdGuard Home

function adguardConf(s) {
  return { url: (s.ADGUARD_URL || 'http://127.0.0.1:8080').replace(/\/+$/, ''), user: s.ADGUARD_USER || 'admin', pass: s.ADGUARD_PASS || 'root' };
}
async function adguard(s, path, body) {
  const c = adguardConf(s);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${c.url}/control/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Basic ' + Buffer.from(`${c.user}:${c.pass}`).toString('base64'), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const txt = await r.text();
    try { return JSON.parse(txt); } catch { return {}; }
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function adblock(s) {
  const [st, stats] = await Promise.all([adguard(s, 'status'), adguard(s, 'stats')]);
  if (!st) return null;
  const top = (stats && stats.top_blocked_domains) || [];
  return {
    on: Boolean(st.protection_enabled),
    queries: stats ? stats.num_dns_queries : null,
    blocked: stats ? stats.num_blocked_filtering : null,
    top: top.slice(0, 5).map((o) => Object.entries(o)[0]),
  };
}

// ---------------------------------------------------------------- apps, services, Tailscale

const APPS = [
  { key: 'jarvis', name: 'Jarvis', port: 80, path: '/' },
  { key: 'ha', name: 'Home Assistant', port: 8123, path: '/' },
  { key: 'adguard', name: 'AdGuard', port: 8080, path: '/' },
  { key: 'files', name: 'Files', port: 8081, path: '/' },
  { key: 'ai', name: 'AI chat', port: 3001, path: '/' },
  { key: 'classic', name: 'Classic dashboard', port: 3010, path: '/' },
];

async function portUp(port) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal, redirect: 'manual' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function apps() {
  return Promise.all(APPS.map(async (a) => ({ ...a, up: await portUp(a.port) })));
}

async function containers() {
  const out = await run('docker', ['ps', '-a', '--format', '{{.Names}}|{{.State}}|{{.Status}}']);
  return out.trim() ? out.trim().split('\n').map((l) => { const [name, state, status] = l.split('|'); return { name, up: state === 'running', status }; }) : [];
}

async function services() {
  const names = ['laudi-dashboard', 'laudi-voice', 'laudi', 'jarvis', 'tailscaled', 'hostapd', 'NetworkManager', 'docker'];
  const out = await run('systemctl', ['is-active', ...names.map((n) => `${n}.service`)]);
  const st = out.trim().split('\n');
  return names.map((n, i) => ({ name: n, state: st[i] || 'unknown' })).filter((x) => x.state !== 'inactive' || /^laudi/.test(x.name));
}

async function tailscale() {
  const out = await run('tailscale', ['status', '--json']);
  try {
    const j = JSON.parse(out);
    const peers = Object.values(j.Peer || {}).map((p) => ({ name: (p.HostName || p.DNSName || '').replace(/\..*$/, ''), ip: (p.TailscaleIPs || [])[0], online: Boolean(p.Online), os: p.OS }));
    return { me: j.Self ? (j.Self.TailscaleIPs || [])[0] : null, peers };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- everything at once (cached ~3 s)

let cache = null, cacheAt = 0, history = [];
async function info(settings) {
  if (cache && Date.now() - cacheAt < 2500) return cache;
  const s = settings();
  const [d, p, wifi, ad, ap, ct, sv, ts] = await Promise.all([
    disk(), ping(), wifiDevices(s.AP_IFACE), adblock(s), apps(), containers(), services(), tailscale(),
  ]);
  const cpu = cpuPct(), net = netRate(), t = temp();
  history.push({ at: Date.now(), cpu, down: net.down, up: net.up, temp: t });
  history = history.slice(-60);
  cache = {
    host: os.hostname(),
    ip: Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address),
    uptimeH: Math.round(os.uptime() / 3600),
    load: os.loadavg().map((x) => +x.toFixed(2)),
    cpu, temp: t, memory: memory(), disk: d, net, ping: p,
    wifi, adblock: ad, apps: ap, containers: ct, services: sv, tailscale: ts, history,
  };
  cacheAt = Date.now();
  return cache;
}

/** Buttons on the Server page. Only these exact things can be done. */
async function action(settings, b) {
  const s = settings();
  const a = String(b.a || '');
  if (a === 'adblock-on' || a === 'adblock-off') {
    const r = await adguard(s, 'protection', { enabled: a === 'adblock-on' });
    cache = null;
    return r ? (a === 'adblock-on' ? '🛡️ Ad blocker on' : 'Ad blocker paused') : "Couldn't reach AdGuard (check ADGUARD_USER / ADGUARD_PASS in Laudi's settings)";
  }
  if (a === 'restart-container' && /^[\w.-]+$/.test(String(b.name || ''))) {
    const out = await run('docker', ['restart', b.name], 60_000);
    cache = null;
    return out ? `Restarted ${b.name}` : `Couldn't restart ${b.name}`;
  }
  const sudo = (args) => new Promise((res) => execFile('sudo', ['-n', ...args], { timeout: 30_000 }, (err) => res(!err)));
  if (a === 'restart-wifi') return (await sudo(['systemctl', 'restart', 'hostapd.service'])) || (await sudo(['systemctl', 'restart', 'NetworkManager.service'])) ? '📶 Wi-Fi restarting' : 'Not allowed - run install.sh again';
  if (a === 'reboot') return (await sudo(['systemctl', 'reboot'])) ? '♻️ Server restarting… back in ~2 min' : 'Not allowed - run install.sh again';
  return 'unknown action';
}

module.exports = { info, action };
