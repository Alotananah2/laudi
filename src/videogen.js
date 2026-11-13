// Makes short vertical TikTok videos (1080x1920, with a beat) by drawing on a canvas
// in a headless browser and recording it. No ffmpeg needed. Output: .webm
const config = require('./config');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const THEMES = [
  { a: '#3b1d8f', b: '#0e7c86', main: '#9af7ee', pop: '#ff3d7f' },
  { a: '#8f1d4f', b: '#1d3b8f', main: '#ffd23d', pop: '#3dffb0' },
  { a: '#1d8f4a', b: '#5a1d8f', main: '#b6ff3d', pop: '#ff7a3d' },
  { a: '#8f5a1d', b: '#1d6f8f', main: '#ffe9a8', pop: '#ff3d3d' },
];

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c" width="1080" height="1920"></canvas>
<script>
async function render(lines, theme, tag) {
  const c = document.getElementById('c');
  const g = c.getContext('2d');
  const W = 1080, H = 1920;
  // timing
  let t0 = 400;
  const segs = lines.map((l) => {
    const words = l.text.replace(/\\*/g, '').split(/\\s+/).length;
    const dur = Math.min(3200, 1300 + words * 260);
    const s = { ...l, start: t0, end: t0 + dur };
    t0 += dur;
    return s;
  });
  const TOTAL = t0 + 700;

  // audio: simple beat
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  const master = ac.createGain(); master.gain.value = 0.6; master.connect(dest);
  const start = ac.currentTime + 0.05;
  for (let b = 0; b * 0.5 < TOTAL / 1000; b++) {
    const at = start + b * 0.5;
    const o = ac.createOscillator(), og = ac.createGain();
    o.frequency.setValueAtTime(120, at); o.frequency.exponentialRampToValueAtTime(40, at + 0.15);
    og.gain.setValueAtTime(1, at); og.gain.exponentialRampToValueAtTime(0.001, at + 0.2);
    o.connect(og).connect(master); o.start(at); o.stop(at + 0.22);
    const buf = ac.createBuffer(1, 2205, 44100), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const n = ac.createBufferSource(), hp = ac.createBiquadFilter(), ng = ac.createGain();
    n.buffer = buf; hp.type = 'highpass'; hp.frequency.value = 6000; ng.gain.value = 0.35;
    n.connect(hp).connect(ng).connect(master); n.start(at + 0.25);
    if (b % 2 === 0) {
      const m = ac.createOscillator(), mg = ac.createGain();
      m.type = 'triangle'; m.frequency.value = [220, 262, 196, 247][(b / 2) % 4 | 0];
      mg.gain.setValueAtTime(0.12, at); mg.gain.exponentialRampToValueAtTime(0.001, at + 0.45);
      m.connect(mg).connect(master); m.start(at); m.stop(at + 0.5);
    }
  }

  const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));

  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  const FONT = (s) => '900 ' + s + 'px "Segoe UI", "Segoe UI Emoji", "DejaVu Sans", sans-serif';

  function wrap(text, size) {
    g.font = FONT(size);
    const out = [];
    for (const para of text.split('\\n')) {
      let cur = [];
      for (const w of para.split(/\\s+/)) {
        const test = [...cur, w].join(' ').replace(/\\*/g, '');
        if (cur.length && g.measureText(test).width > 920) { out.push(cur); cur = [w]; } else cur.push(w);
      }
      if (cur.length) out.push(cur);
    }
    return out;
  }

  function drawLine(seg, now) {
    const local = now - seg.start, left = seg.end - now;
    if (local < 0 || left < -300) return;
    let a = Math.min(1, local / 250), dy = 0, sc = 1;
    if (local < 450) { const p = local / 450; sc = 0.9 + 0.1 * (1 + Math.sin(p * Math.PI) * 0.6); dy = (1 - p) * 40; }
    if (left < 0) { a = Math.max(0, 1 + left / 300); dy = left / 8; }
    let size = 96, rows = wrap(seg.text, size);
    while (rows.length > 4 && size > 60) { size -= 8; rows = wrap(seg.text, size); }
    g.save();
    g.globalAlpha = a;
    g.translate(W / 2, 1040 + dy); g.scale(sc, sc);
    g.font = FONT(size); g.textBaseline = 'middle';
    const lh = size * 1.15, top = -((rows.length - 1) * lh) / 2;
    rows.forEach((words, i) => {
      const parts = words.map((w) => ({ w: w.replace(/\\*/g, ''), hl: /^\\*.*\\*$/.test(w) || /\\*/.test(w) }));
      const full = parts.map((p) => p.w).join(' ');
      let x = -g.measureText(full).width / 2;
      parts.forEach((p, j) => {
        const txt = p.w + (j < parts.length - 1 ? ' ' : '');
        g.fillStyle = '#000'; g.fillText(txt, x, top + i * lh + 7);
        g.fillStyle = p.hl ? (i % 2 ? theme.pop : theme.main) : '#fff';
        g.fillText(txt, x, top + i * lh);
        x += g.measureText(txt).width;
      });
    });
    g.restore();
  }

  function frame(now) {
    const s = now / 1000;
    g.fillStyle = '#07070d'; g.fillRect(0, 0, W, H);
    const blob = (x, y, col) => { const r = g.createRadialGradient(x, y, 0, x, y, 900); r.addColorStop(0, col); r.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = r; g.fillRect(0, 0, W, H); };
    blob(300 + Math.sin(s * 0.5) * 80, 380 + Math.cos(s * 0.4) * 60, theme.a);
    blob(800 + Math.cos(s * 0.45) * 80, 1450 + Math.sin(s * 0.5) * 80, theme.b);
    g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 2;
    for (let x = 0; x < W; x += 90) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let y = (s * 30) % 90; y < H; y += 90) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    // robot
    const by = 330 + Math.sin(s * 2.6) * 22, bx = W / 2 - 220;
    g.fillStyle = theme.main; g.fillRect(W / 2 - 5, by - 70, 10, 70);
    g.shadowColor = theme.pop; g.shadowBlur = 40 + Math.sin(s * 5) * 25;
    g.fillStyle = theme.pop; g.beginPath(); g.arc(W / 2, by - 76, 22, 0, 7); g.fill();
    g.shadowColor = theme.main; g.shadowBlur = 60;
    rr(bx, by, 440, 400, 80); g.fillStyle = '#121833'; g.fill(); g.lineWidth = 8; g.strokeStyle = theme.main; g.stroke();
    const blink = (s % 3.2) > 1.45 && (s % 3.2) < 1.6 ? 0.1 : 1;
    g.fillStyle = theme.main;
    [[bx + 135, by + 175], [bx + 305, by + 175]].forEach(([x, y]) => { g.beginPath(); g.ellipse(x, y, 55, 55 * blink, 0, 0, 7); g.fill(); });
    g.shadowBlur = 20; g.shadowColor = theme.pop; g.fillStyle = theme.pop;
    const talking = segs.some((x) => now >= x.start && now < x.end - 300);
    for (let i = 0; i < 5; i++) {
      const h = talking ? 14 + Math.abs(Math.sin(s * 9 + i * 1.3)) * 52 : 14;
      rr(W / 2 - 88 + i * 36, by + 330 - h, 22, h, 6); g.fill();
    }
    g.shadowBlur = 0;
    // text
    segs.forEach((seg) => drawLine(seg, now));
    // flash on big moments
    segs.forEach((seg) => { const d = now - seg.start; if (seg.boom && d >= 0 && d < 450) { g.fillStyle = 'rgba(255,255,255,' + (0.8 * (1 - d / 450)) + ')'; g.fillRect(0, 0, W, H); } });
    // tag
    g.font = '700 46px "Segoe UI", "Segoe UI Emoji", "DejaVu Sans", sans-serif'; g.textBaseline = 'middle';
    const tw = g.measureText(tag).width + 92, jitter = (s % 2.5) > 2.35 ? 8 : 0;
    rr(W / 2 - tw / 2 + jitter, H - 330, tw, 96, 48); g.fillStyle = 'rgba(0,0,0,0.35)'; g.fill(); g.lineWidth = 4; g.strokeStyle = theme.pop; g.stroke();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText(tag, W / 2 + jitter, H - 282); g.textAlign = 'left';
  }

  frame(0);
  rec.start(500);
  const begin = performance.now();
  await new Promise((resolve) => {
    const loop = () => {
      const now = performance.now() - begin;
      frame(now);
      if (now >= TOTAL) return resolve();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  rec.stop();
  await done;
  ac.close();
  const blob = new Blob(chunks, { type: mime });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { b64: btoa(bin), mp4: mime.startsWith('video/mp4') };
}
</script></body></html>`;

/**
 * lines: ["hey tiktok 👋", "i'm *Laudi*", ...]  (*word* = highlighted). A line starting with "!" gets a flash.
 * Returns the path of the saved .webm.
 */
async function makeVideo(lines, outFile, { tag = '🤖 made by an AI', launchOpts } = {}) {
  const segs = lines.map((l) => ({ text: String(l).replace(/^!/, ''), boom: String(l).startsWith('!') }));
  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  let browser;
  const channels = launchOpts ? [null] : [config.browser, 'msedge', 'chrome'].filter((c, i, a) => a.indexOf(c) === i);
  for (const channel of channels) {
    try {
      browser = await chromium.launch({
        ...(launchOpts || { channel }),
        headless: true,
        args: ['--autoplay-policy=no-user-gesture-required'],
      });
      break;
    } catch {}
  }
  if (!browser) throw new Error('could not open a browser to make the video');
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.setContent(PAGE);
    const { b64, mp4 } = await page.evaluate(({ segs, theme, tag }) => render(segs, theme, tag), { segs, theme, tag });
    outFile = outFile.replace(/\.(webm|mp4)$/i, mp4 ? '.mp4' : '.webm');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, Buffer.from(b64, 'base64'));
    return outFile;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { makeVideo };
