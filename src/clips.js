// Records the Roblox window while Laudi plays (a rolling ~80 s buffer, low quality to save CPU),
// and cuts the last ~30 s into a clip that can be posted to TikTok.
const config = require('./config');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(config.dataDir, 'rec');
const POSTS = path.join(config.dataDir, 'posts');
let rec = null; // { proc, startedAt }

function ffmpegPath() {
  try {
    return require('ffmpeg-static');
  } catch {
    return null;
  }
}

function start() {
  if (rec || process.platform !== 'win32') return false;
  const ff = ffmpegPath();
  if (!ff) {
    console.warn('[clips] ffmpeg not found - no clips');
    return false;
  }
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of fs.readdirSync(DIR)) fs.unlink(path.join(DIR, f), () => {});
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'gdigrab', '-framerate', '20', '-draw_mouse', '0', '-i', 'title=Roblox',
    '-vf', 'scale=1280:-2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '27', '-pix_fmt', 'yuv420p', '-g', '40',
    '-f', 'segment', '-segment_time', '10', '-segment_wrap', '8', '-reset_timestamps', '1',
    path.join(DIR, 'seg%02d.ts'),
  ];
  const proc = spawn(ff, args, { windowsHide: true });
  proc.stderr.on('data', (d) => {
    const t = String(d).trim();
    if (t && !rec.warned) console.warn('[clips] recorder:', t.slice(0, 160));
    if (rec) rec.warned = true;
  });
  proc.on('exit', () => {
    if (rec && rec.proc === proc) rec = null;
  });
  rec = { proc, startedAt: Date.now(), warned: false };
  console.log('[clips] 🎥 recording the Roblox window (for clips)');
  return true;
}

function stop() {
  if (!rec) return;
  try {
    rec.proc.stdin.write('q');
  } catch {}
  const p = rec.proc;
  setTimeout(() => {
    try {
      p.kill();
    } catch {}
  }, 3000);
  rec = null;
  console.log('[clips] recording stopped');
}

const recording = () => Boolean(rec);

/** Cuts the last `seconds` into data/posts/clip-<time>.mp4. Returns the file path, or null. */
async function cut(seconds = 30) {
  const ff = ffmpegPath();
  if (!ff || !fs.existsSync(DIR)) return null;
  const segs = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ f: path.join(DIR, f), t: fs.statSync(path.join(DIR, f)).mtimeMs, size: fs.statSync(path.join(DIR, f)).size }))
    .filter((x) => x.size > 20_000)
    .sort((a, b) => a.t - b.t);
  const take = segs.slice(-Math.max(1, Math.ceil(seconds / 10)));
  if (!take.length) return null;
  fs.mkdirSync(POSTS, { recursive: true });
  const list = path.join(DIR, `list-${Date.now()}.txt`);
  fs.writeFileSync(list, take.map((x) => `file '${x.f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const out = path.join(POSTS, `clip-${Date.now()}.mp4`);
  await new Promise((resolve, reject) => {
    const p = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], { windowsHide: true });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });
  fs.unlink(list, () => {});
  if (!fs.existsSync(out) || fs.statSync(out).size < 50_000) return null;
  console.log(`[clips] ✂️ made ${path.basename(out)} (${take.length * 10}s)`);
  return out;
}

module.exports = { start, stop, recording, cut };
