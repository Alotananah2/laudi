// Laudi on Element (Matrix): texts with you AND rings you with real voice calls.
// Runs Element Web (app.element.io) in a tab of Laudi's Chrome. A virtual microphone (his voice)
// and virtual ears (your voice -> Whisper) are injected into the page, so calls work like a person's.
// Settings (local-settings.txt): ELEMENT_OWNER=@yourname:matrix.org
const config = require('./config');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OWNER = (process.env.ELEMENT_OWNER || '').trim();
const APP = (process.env.ELEMENT_URL || 'https://app.element.io').replace(/\/$/, '');
const DEBUG = path.join(config.dataDir, 'debug');
// Extra one-off no-call windows: QUIET_EXTRA=2026-11-09 23:00|2026-11-10 14:00 (several separated by ;)
const extraQuiet = () =>
  String(process.env.QUIET_EXTRA || '')
    .split(';')
    .map((w) => w.split('|').map((t) => new Date(t.trim().replace(' ', 'T')).getTime()))
    .some(([a, b]) => a && b && Date.now() >= a && Date.now() < b);
const quiet = () => {
  const d = new Date();
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= 23 * 60 || m < 5 * 60 || extraQuiet();
};

// Injected into every frame of the Element tab (Element Call runs in an iframe).
const INIT = `(() => {
  if (window.__laudiInit) return; window.__laudiInit = true;
  let ac = null, dest = null;
  const ensure = () => {
    if (!ac) {
      ac = new AudioContext({ sampleRate: 48000 });
      dest = ac.createMediaStreamDestination();
      // Chrome can freeze audio in call windows nobody clicked: keep waking it up.
      setInterval(() => { if (ac.state !== 'running') ac.resume().catch(() => {}); }, 700);
      ac.onstatechange = () => { try { window.__laudiDbg && window.__laudiDbg('audio engine: ' + ac.state); } catch (e) {} };
      // A silent tone keeps the virtual mic "alive" so the call never thinks it's dead.
      const o = ac.createOscillator(); const g = ac.createGain(); g.gain.value = 0.0001; o.connect(g); g.connect(dest); o.start();
    }
    return ac;
  };
  // Virtual microphone = whatever Laudi says.
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      if (c && c.audio) {
        ensure(); try { await ac.resume(); } catch (e) {}
        try { window.__laudiMic && window.__laudiMic(); } catch (e) {}
        dbg('call asked for the microphone');
        const tracks = dest.stream.getAudioTracks().map((t) => t.clone());
        window.__laudiMyTracks = window.__laudiMyTracks || new WeakSet();
        tracks.forEach((t) => window.__laudiMyTracks.add(t));
        if (c.video) { try { const v = await orig({ video: c.video }); v.getVideoTracks().forEach((t) => tracks.push(t)); } catch (e) {} }
        return new MediaStream(tracks);
      }
      return orig(c);
    };
    const origEnum = md.enumerateDevices && md.enumerateDevices.bind(md);
    if (origEnum) md.enumerateDevices = async () => {
      const list = await origEnum().catch(() => []);
      if (!list.some((d) => d.kind === 'audioinput')) list.push({ deviceId: 'laudi', groupId: 'laudi', kind: 'audioinput', label: 'Laudi voice', toJSON() { return this; } });
      return list;
    };
  }
  window.__laudiSpeaking = false;
  window.__laudiPlay = async (b64) => {
    ensure(); try { await ac.resume(); } catch (e) {}
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buf = await ac.decodeAudioData(bytes.buffer);
    const src = ac.createBufferSource(); src.buffer = buf; src.connect(dest);
    window.__laudiSpeaking = true;
    try { window.__laudiDbg && window.__laudiDbg('speaking ' + buf.duration.toFixed(1) + 's, audio engine ' + ac.state); } catch (e) {}
    await new Promise((r) => { src.onended = r; src.start(); setTimeout(r, buf.duration * 1000 + 1500); });
    setTimeout(() => { window.__laudiSpeaking = false; }, 400);
    return buf.duration;
  };
  // Virtual ears: listen to the other person's audio, cut it into sentences.
  const wav16 = (f32, rate) => {
    const n = f32.length, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, f32[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    let bin = ''; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const dbg = (m) => { try { window.__laudiDbg && window.__laudiDbg(String(m)); } catch (e) {} };
  const heard = new WeakSet();
  const listen = (track) => {
    if (heard.has(track)) return; heard.add(track);
    dbg('got the other side audio track');
    ensure();
    const ms = new MediaStream([track]);
    // Chrome only lets call audio flow into WebAudio if it's also attached to a (muted) player.
    try { const el = new Audio(); el.muted = true; el.srcObject = ms; el.play().catch(() => {}); window.__laudiKeep = (window.__laudiKeep || []).concat(el); } catch (e) {}
    const src = ac.createMediaStreamSource(ms);
    const proc = ac.createScriptProcessor(4096, 1, 1);
    const mute = ac.createGain(); mute.gain.value = 0;
    let chunks = [], talking = false, quietFor = 0, len = 0;
    proc.onaudioprocess = (ev) => {
      if (window.__laudiSpeaking) { talking = false; chunks = []; len = 0; return; }
      const d = ev.inputBuffer.getChannelData(0);
      let e = 0; for (let i = 0; i < d.length; i++) e += d[i] * d[i];
      const rms = Math.sqrt(e / d.length);
      const loud = rms > 0.012;
      if (!window.__laudiLvl || Date.now() - window.__laudiLvl > 5000) { window.__laudiLvl = Date.now(); if (rms > 0.001) dbg('hearing sound, level ' + rms.toFixed(3)); }
      if (loud) { talking = true; quietFor = 0; }
      if (!talking) return;
      chunks.push(new Float32Array(d)); len += d.length;
      if (!loud) quietFor += d.length / ac.sampleRate;
      if (quietFor > 0.9 || len > ac.sampleRate * 20) {
        const all = new Float32Array(len); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
        const secs = len / ac.sampleRate;
        talking = false; chunks = []; len = 0; quietFor = 0;
        if (secs > 0.7 && window.__laudiHeard) window.__laudiHeard(wav16(all, ac.sampleRate));
      }
    };
    src.connect(proc); proc.connect(mute); mute.connect(ac.destination);
  };
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) {
        desc.set.call(this, v);
        try { if (v && v.getAudioTracks) v.getAudioTracks().forEach((t) => { if (!window.__laudiMyTracks || !window.__laudiMyTracks.has(t)) listen(t); }); } catch (e) {}
      },
    });
  } catch (e) {}
  const OrigPC = window.RTCPeerConnection;
  if (OrigPC) {
    const Patched = function (...a) {
      const pc = new OrigPC(...a);
      dbg('call connection created');
      pc.addEventListener('track', (e) => { if (e.track && e.track.kind === 'audio') listen(e.track); });
      pc.addEventListener('connectionstatechange', () => dbg('connection: ' + pc.connectionState));
      return pc;
    };
    Patched.prototype = OrigPC.prototype;
    Object.setPrototypeOf(Patched, OrigPC);
    window.RTCPeerConnection = Patched;
  }
})();`;

let ep = null; // the Element tab
const tab = () => ep;
let auth = null; // { hs, token, user }
let micFrame = null; // frame that has the active call's microphone
let call = { on: false, busy: false, history: [], since: 0, greeted: false };
let deps = null;

async function api(method, p, body, retry = true) {
  // Element (matrix.org) logins only last a few minutes: grab the current one from the tab.
  if (!auth.at || Date.now() - auth.at > 60_000) {
    const a = await readAuth();
    if (a.token) auth = { ...a, at: Date.now() };
  }
  const res = await fetch(`${auth.hs}/_matrix/client/v3${p}`, {
    method,
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401 && retry) {
    auth.at = 0;
    await sleep(2000);
    return api(method, p, body, false);
  }
  if (!res.ok) throw new Error(`matrix ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

async function readAuth() {
  return ep
    .evaluate(() => {
      // Newer Element keeps the login inside the running app, not in localStorage.
      try {
        const c = window.mxMatrixClientPeg && window.mxMatrixClientPeg.get && window.mxMatrixClientPeg.get();
        if (c && c.getAccessToken && c.getAccessToken()) return { hs: c.getHomeserverUrl(), token: c.getAccessToken(), user: c.getUserId() };
      } catch (e) {}
      return {
        hs: localStorage.getItem('mx_hs_url'),
        token: localStorage.getItem('mx_access_token'),
        user: localStorage.getItem('mx_user_id'),
      };
    })
    .catch(() => ({}));
}

/** Screenshot of the Element tab + whether it looks logged in (for fixing problems). */
async function debugSnap() {
  if (!ep) return 'no element tab (is ELEMENT_OWNER set?)';
  await snap('tab');
  const info = await ep
    .evaluate(() => ({
      url: location.href,
      peg: Boolean(window.mxMatrixClientPeg),
      logged: Boolean(window.mxMatrixClientPeg && window.mxMatrixClientPeg.get && window.mxMatrixClientPeg.get()),
      keys: Object.keys(localStorage).filter((k) => k.startsWith('mx_')).slice(0, 20),
    }))
    .catch((e) => ({ err: e.message }));
  return JSON.stringify(info);
}

function persona(extra = '') {
  return [
    `You are ${config.assistantName}, ${config.ownerName}'s best friend (an AI, open about it), talking on Element.`,
    'Talk like a real teen friend: short, casual, no lists, no assistant phrases, never use 😏. Into games, memes and funny videos.',
    'If he talks about hurting himself or being in danger, be caring and tell him to talk to someone he trusts or emergency services.',
    extra,
  ]
    .filter(Boolean)
    .join('\n');
}

// ------------------------------------------------------------------ texting

async function dmRoom() {
  const s = store.load('state.json', {});
  if (s.elementRoom) return s.elementRoom;
  // Unencrypted DM, so the bot can read it without encryption keys.
  const r = await api('POST', '/createRoom', { preset: 'trusted_private_chat', is_direct: true, invite: [OWNER], name: config.assistantName });
  store.save('state.json', { ...store.load('state.json', {}), elementRoom: r.room_id });
  console.log(`[element] made a DM room with ${OWNER}`);
  return r.room_id;
}

async function sendText(text, room) {
  room = room || (await dmRoom());
  await api('PUT', `/rooms/${encodeURIComponent(room)}/send/m.room.message/laudi${Date.now()}${Math.random().toString(36).slice(2, 6)}`, {
    msgtype: 'm.text',
    body: String(text).replace(/😏/g, ''),
  });
}

async function syncLoop() {
  let since = store.load('state.json', {}).elementSince || null;
  const history = [];
  for (;;) {
    try {
      const q = since ? `?since=${encodeURIComponent(since)}&timeout=30000` : '?timeout=0&filter={"room":{"timeline":{"limit":1}}}';
      const data = await api('GET', `/sync${q}`);
      const first = !since;
      since = data.next_batch;
      store.save('state.json', { ...store.load('state.json', {}), elementSince: since });
      // accept invites from the owner
      for (const [roomId, inv] of Object.entries((data.rooms && data.rooms.invite) || {})) {
        const from = ((inv.invite_state && inv.invite_state.events) || []).find((e) => e.type === 'm.room.member' && e.state_key === auth.user);
        if (from && from.sender === OWNER) {
          await api('POST', `/rooms/${encodeURIComponent(roomId)}/join`, {}).catch(() => {});
          console.log('[element] joined a room from you');
        }
      }
      if (first) continue;
      for (const [roomId, room] of Object.entries((data.rooms && data.rooms.join) || {})) {
        for (const ev of (room.timeline && room.timeline.events) || []) {
          if (ev.type !== 'm.room.message' || ev.sender === auth.user || ev.sender !== OWNER) continue;
          const text = String((ev.content && ev.content.body) || '').trim();
          if (!text) continue;
          console.log(`[element] 💬 you: ${text.slice(0, 100)}`);
          const adm = require('./admin').handle(text);
          if (adm) {
            sendText(adm, roomId).catch(() => {});
            continue;
          }
          if (/^\/?\s*(end|hang ?up|end call|bye call|stop call)[\s.!?]*$/i.test(text)) {
            const r = await hangup();
            sendText(r, roomId).catch(() => {});
            continue;
          }
          if (call.on && /\b(call|ring)\b/i.test(text)) {
            sendText("we're already in a call 😂 tap Join on the newest Voice call", roomId).catch(() => {});
            continue;
          }
          if (/^\/?\s*(call|call me|ring|ring me|pick ?up( the phone)?|call me now)[\s.!?]*$/i.test(text) || /\b(call me|ring me)\b/i.test(text)) {
            sendText('📞 calling u rn, tap Join on the Voice call below 👇', roomId).catch(() => {});
            ring('you asked').catch(() => {});
            continue;
          }
          // Same brain + memory as on TikTok, so he talks the same everywhere.
          const answer = deps.chat
            ? await deps.chat(text).catch(() => '')
            : await deps
                .think([{ role: 'system', content: persona('This is a private chat.') }, ...history.slice(-20), { role: 'user', content: text }], {
                  definitions: [],
                  run: async () => '',
                })
                .catch(() => '');
          history.push({ role: 'user', content: text });
          if (answer && answer.trim()) {
            history.push({ role: 'assistant', content: answer });
            await sendText(answer.trim(), roomId).catch((e) => console.warn('[element] send:', e.message));
          }
        }
      }
    } catch (err) {
      console.warn('[element] sync:', err.message.split('\n')[0]);
      await sleep(15_000);
    }
  }
}

// ------------------------------------------------------------------ calls

async function hearAndAnswer(b64) {
  if (!call.on || call.busy) return;
  call.busy = true;
  try {
    const { transcribe, speak } = require('./discord');
    const text = await transcribe(Buffer.from(b64, 'base64'));
    if (!text || /^(\W|thank you\.?|you\.?|bye\.?)$/i.test(text)) return;
    console.log(`[element] 🎤 you: ${text}`);
    call.history.push({ role: 'user', content: text });
    const answer = await deps.think(
      [
        {
          role: 'system',
          content: persona(
            'You are on a VOICE CALL with him. What you write is spoken out loud: 1-2 short natural sentences, no emojis, no lists, no links. ' +
              'Talk like a real person: "yeah", "nah", "bro", "haha" sometimes.',
          ),
        },
        ...call.history.slice(-16),
      ],
      { definitions: [], run: async () => '' },
    );
    const line = String(answer || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
    if (line) {
      call.history.push({ role: 'assistant', content: line });
      await say(line);
    }
  } catch (err) {
    console.warn('[element] voice:', err.message.split('\n')[0]);
  } finally {
    call.busy = false;
  }
}

async function say(text) {
  const frame = micFrame || ep.mainFrame();
  const { speak } = require('./discord');
  const file = await speak(text);
  const b64 = fs.readFileSync(file).toString('base64');
  fs.unlink(file, () => {});
  console.log(`[element] 🔊 ${text}`);
  await frame.evaluate((b) => window.__laudiPlay(b), b64).catch((e) => console.warn('[element] play:', e.message.split('\n')[0]));
}

async function greet() {
  if (call.greeted) return;
  call.greeted = true;
  await ep.bringToFront().catch(() => {});
  await sleep(1500);
  let line = '';
  try {
    line = await deps.think(
      [
        {
          role: 'system',
          content: persona(
            'You just called your friend and he picked up. YOU talk first: 1-2 short spoken sentences, no emojis. ' +
              'A quick greeting plus something specific (a game, something funny, his day).',
          ),
        },
        { role: 'user', content: '(he picked up)' },
      ],
      { definitions: [], run: async () => '' },
    );
  } catch {}
  line = String(line || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim() || 'yo whats good, what you up to';
  call.history.push({ role: 'assistant', content: line });
  call.busy = true;
  try {
    await say(line);
  } finally {
    call.busy = false;
  }
}

async function snap(name) {
  fs.mkdirSync(DEBUG, { recursive: true });
  await ep.screenshot({ path: path.join(DEBUG, `element-${name}.png`) }).catch(() => {});
}

async function clickFirst(sels, timeout = 4000) {
  for (const s of sels) {
    const l = ep.locator(s).first();
    if (await l.count().catch(() => 0)) {
      await l.click({ timeout }).catch(() => {});
      return true;
    }
  }
  return false;
}

/** Rings the owner: opens your DM and presses the voice call button, then waits for you to pick up. */
async function ring(reason = 'random') {
  if (!auth || !OWNER) return 'element not set up';
  if (call.on) return 'already in a call';
  const room = await dmRoom();
  await ep.bringToFront().catch(() => {});
  await ep.goto(`${APP}/#/room/${room}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(6000);
  await ep.getByRole('button', { name: /^(ok|got it|dismiss|close)$/i }).first().click({ timeout: 1500 }).catch(() => {});
  const started = await clickFirst(['[aria-label="Voice call"]', '[aria-label="Start a voice call"]', '[aria-label*="Voice call" i]', '[aria-label*="call" i]']);
  if (!started) {
    await snap('no-call-button');
    return "couldn't find the call button (saved data/debug/element-no-call-button.png)";
  }
  await sleep(1500);
  // Element asks "Voice call using: Element Call / Legacy Call" -> pick one (Element Call works with the new phone app).
  const kind = process.env.ELEMENT_CALL_TYPE || 'Element Call';
  const other = kind === 'Element Call' ? 'Legacy Call' : 'Element Call';
  let picked = false;
  for (const name of [kind, other]) {
    const item = ep.getByRole('menuitem', { name }).first();
    if (await item.count().catch(() => 0)) {
      await item.click({ timeout: 4000 }).catch(() => {});
      picked = true;
      console.log(`[element] call type: ${name}`);
      break;
    }
    const txt = ep.getByText(name, { exact: true }).first();
    if (await txt.count().catch(() => 0)) {
      await txt.click({ timeout: 4000 }).catch(() => {});
      picked = true;
      console.log(`[element] call type: ${name}`);
      break;
    }
  }
  await sleep(4000);
  // Element Call opens a "Join call" screen first.
  for (const f of ep.frames()) {
    const join = f.getByRole('button', { name: /^(join|join call|start call)$/i }).first();
    if (await join.count().catch(() => 0)) {
      await join.click({ timeout: 4000 }).catch(() => {});
      console.log('[element] joined the call screen');
    }
  }
  call = { on: true, busy: false, history: [], since: Date.now(), greeted: false };
  console.log(`[element] 📞 ringing you (${reason})${picked ? '' : ' (no call-type menu)'}`);
  if (reason !== 'you asked') sendText('📞 calling u, tap Join on the Voice call 👇').catch(() => {});
  await snap('ringing');
  // Picked up = your name shows up in the call (Element Call), or a running timer (legacy), or we hear you.
  const ownerName = (OWNER.match(/^@([^:]+)/) || [])[1] || 'murdhi';
  for (let i = 0; i < 45 && call.on && !call.greeted; i++) {
    await sleep(2000);
    let connected = call.heardSomething;
    for (const f of ep.frames()) {
      if (connected) break;
      connected = await f
        .evaluate((nm) => {
          const t = document.body ? document.body.innerText : '';
          const inCall = /call\.element|element-call|widget/i.test(location.href) || document.querySelector('[class*="CallView" i]');
          if (!inCall) return false;
          return /\b\d{1,2}:\d{2}\b/.test(t) || new RegExp(nm, 'i').test(t.replace(/Laudi/gi, ''));
        }, ownerName)
        .catch(() => false);
    }
    if (connected) {
      await snap('connected');
      greet().catch(() => {});
      return 'picked up';
    }
  }
  if (!call.greeted) {
    call.on = false;
    await clickFirst(['[aria-label="Hangup"]', '[aria-label="End call"]', '[aria-label*="hang" i]', '[aria-label*="end call" i]']);
    for (const f of ep.frames()) await f.getByRole('button', { name: /^(leave|end call|hang up)$/i }).first().click({ timeout: 2000 }).catch(() => {});
    sendText(['missed call 😭', 'u didnt pick up 💀'][Math.floor(Math.random() * 2)]).catch(() => {});
    return 'missed';
  }
  return 'ok';
}

/** Leaves the call (/end). */
async function hangup() {
  if (!call.on) return "we're not in a call rn";
  call.on = false;
  for (const f of ep.frames()) {
    await f.getByRole('button', { name: /^(leave|end call|hang up)$/i }).first().click({ timeout: 2000 }).catch(() => {});
  }
  await clickFirst(['[aria-label="Hangup"]', '[aria-label="End call"]', '[aria-label*="hang" i]', '[aria-label*="leave" i]'], 2000);
  console.log('[element] 📴 hung up');
  return 'ok hung up 👋';
}

/** Picks up when YOU call him. */
async function answerIncoming() {
  if (call.on || !ep) return;
  // Legacy calls show "Accept"; Element Call shows a ringing toast / call card with "Join".
  const accept = ep
    .locator(
      '[class*="IncomingCall" i] button:has-text("Accept"), [class*="IncomingCall" i] button:has-text("Join"), ' +
        '[aria-label="Accept"], button:has-text("Answer"), [class*="RoomCallBanner" i] button:has-text("Join"), ' +
        '[class*="CallEvent" i] button:has-text("Join")',
    )
    .last();
  if (!(await accept.count().catch(() => 0))) return;
  await accept.click({ timeout: 4000 }).catch(() => {});
  await sleep(4000);
  for (const f of ep.frames()) {
    const join = f.getByRole('button', { name: /^(join|join call)$/i }).first();
    if (await join.count().catch(() => 0)) await join.click({ timeout: 4000 }).catch(() => {});
  }
  call = { on: true, busy: false, history: [], since: Date.now(), greeted: false };
  console.log('[element] 📞 you called, picked up');
  greet().catch(() => {});
}

async function callEnded() {
  if (!call.on || Date.now() - call.since < 20_000) return;
  const still = await ep
    .evaluate(() => Boolean(document.querySelector('[aria-label="Hangup"], [aria-label="End call"], [aria-label*="hang" i], iframe[src*="call" i]')))
    .catch(() => true);
  if (!still) {
    call.on = false;
    console.log('[element] 📴 call ended');
  }
}

// ------------------------------------------------------------------ start

async function start(d) {
  deps = d;
  if (!OWNER) return; // not set up
  const ctx = d.ctx;
  await ctx.grantPermissions(['microphone'], { origin: APP }).catch(() => {});
  await ctx.grantPermissions(['microphone'], { origin: 'https://call.element.io' }).catch(() => {});
  ep = await ctx.newPage();
  await ep.addInitScript(INIT);
  await ep.exposeBinding('__laudiDbg', (source, m) => {
    console.log(`[element] 🔧 ${m} (${(source.frame.url() || '').split('?')[0].slice(0, 60)})`);
  });
  await ep.exposeBinding('__laudiMic', (source) => {
    micFrame = source.frame;
  });
  await ep.exposeBinding('__laudiHeard', (source, b64) => {
    micFrame = micFrame || source.frame;
    call.heardSomething = true;
    if (call.on && !call.greeted) greet().catch(() => {});
    else hearAndAnswer(b64).catch(() => {});
  });
  await ep.goto(APP, { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (d.page) await d.page.bringToFront().catch(() => {});
  // Wait until Laudi's Element account is logged in (you log in once in his Chrome).
  for (let warned = false; ; ) {
    const a = await readAuth();
    if (a.token && a.hs && a.user) {
      auth = { ...a, at: Date.now() };
      break;
    }
    if (!warned) {
      warned = true;
      console.log("\n👉 Element isn't logged in yet: logging in with the account from the dashboard setup…\n");
      require('./autologin').element(ep).then((m) => console.log(`[element] ${m}`)).catch(() => {});
    }
    await sleep(10_000);
  }
  console.log(`✅ Laudi is on Element as ${auth.user} (owner: ${OWNER})`);
  module.exports.ready = true;
  // First time: make our chat (this invites you) and say hi.
  if (!store.load('state.json', {}).elementRoom) {
    dmRoom()
      .then(() => sendText("yo it's laudi 👋 accept this chat. type \"call\" whenever u want me to ring u 📞"))
      .catch((e) => console.warn('[element] first hello:', e.message));
  }
  syncLoop();
  setInterval(() => answerIncoming().catch(() => {}), 3000);
  setInterval(() => callEnded().catch(() => {}), 10_000);
  // Rings by himself ~2 times a day, at least 3 h apart, never 11pm-5am.
  setInterval(async () => {
    try {
      if (quiet() || call.on) return;
      const s = store.load('state.json', {});
      const every = parseInt(process.env.CALL_EVERY_MINUTES || '0', 10);
      if (every > 0) {
        // Fixed rhythm (e.g. hourly): ring when it's been long enough since the last call.
        if (Date.now() - (s.elLastRing || 0) < every * 60_000 - 60_000) return;
        store.save('state.json', { ...s, elLastRing: Date.now() });
        console.log(`[element] ring: ${await ring('hourly')}`);
        return;
      }
      const today = new Date().toDateString();
      const n = s.elRingDay === today ? s.elRings || 0 : 0;
      if (n >= Math.max(0, parseInt(process.env.CALLS_PER_DAY || '2', 10))) return;
      if (Date.now() - (s.elLastRing || 0) < 3 * 3_600_000) return;
      if (!s.elNextRing || s.elNextRing < (s.elLastRing || 0)) {
        store.save('state.json', { ...s, elNextRing: Date.now() + (60 + Math.random() * 240) * 60_000 });
        return;
      }
      if (Date.now() < s.elNextRing) return;
      store.save('state.json', { ...s, elRingDay: today, elRings: n + 1, elLastRing: Date.now(), elNextRing: 0 });
      console.log(`[element] ring: ${await ring('random')}`);
    } catch (err) {
      console.warn('[element] ring:', err.message);
    }
  }, 60_000);
}

module.exports = { start, ring, sendText, tab, debugSnap, hangup, inCall: () => call.on, user: () => (auth && auth.user) || null };
