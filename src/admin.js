// Owner-only control commands, for when you're away from home:
// DM Laudi on Discord or Element with !status, !restart, !log, !vid, !post, !hi, !health, !stop, !help.
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

const started = Date.now();
const remote = (line) => fs.appendFileSync(path.join(config.dataDir, 'remote.txt'), line + '\n');

function lastLog(n = 15) {
  try {
    const f = path.join(config.dataDir, 'bot.log');
    const size = fs.statSync(f).size;
    const fd = fs.openSync(f, 'r');
    const len = Math.min(size, 6000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf
      .toString('utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-n)
      .map((l) => l.slice(0, 160))
      .join('\n');
  } catch {
    return '(no log)';
  }
}

const HELP =
  '🛠 Laudi remote (only works for u):\n' +
  '!status - is everything ok\n!log - last lines of my log\n!restart - restart me\n!stop - turn me off (start again from the PC or the phone app at home)\n' +
  '!update - get the newest version\n!vid - send u a vid on TikTok\n!post - post a TikTok now\n!hi - text u on TikTok\n!health - health check on TikTok';

/** Returns a reply if `text` is an admin command, otherwise null. */
function handle(text) {
  const m = String(text || '').trim().match(/^!(status|log|logs|restart|stop|shutdown|vid|post|hi|health|remote|admin|update)\b/i);
  if (!m) return null;
  const c = m[1].toLowerCase();
  if (c === 'remote' || c === 'admin') return HELP;
  if (c === 'status') {
    const up = Math.round((Date.now() - started) / 60_000);
    const freeGb = (os.freemem() / 1e9).toFixed(1);
    const totGb = (os.totalmem() / 1e9).toFixed(1);
    const errs = lastLog(40)
      .split('\n')
      .filter((l) => /WARN|ERROR/.test(l)).length;
    return `✅ i'm running · up ${up >= 60 ? `${Math.floor(up / 60)}h ${up % 60}m` : `${up}m`} · PC memory free ${freeGb}/${totGb} GB · ${errs} warnings in the last log lines`;
  }
  if (c === 'log' || c === 'logs') return '```\n' + lastLog(15) + '\n```';
  if (c === 'update') {
    remote('update');
    return '⬇️ getting the newest version, i restart by myself if there is one (~1-2 min)';
  }
  if (c === 'restart') {
    remote('restart');
    return '↻ restarting, back in ~20 sec';
  }
  if (c === 'stop' || c === 'shutdown') {
    remote('shutdown');
    return "■ turning off. start me again from the PC or the phone app (home wifi)";
  }
  const map = { vid: 'vid', post: 'post-now', hi: 'hi', health: 'health' };
  remote(map[c]);
  return `👍 on it (${c})`;
}

module.exports = { handle, HELP };
