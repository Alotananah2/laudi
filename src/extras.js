// Extra features: auto-start with Windows, health check + alerts, memory saver,
// Rararo new-video drops, Roblox playtime stats + friend pings, DM games, school-night nudges.
const config = require('./config');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const startedAt = Date.now();
const pick = (l) => l[Math.floor(Math.random() * l.length)];
const now = () => new Date();
const hm = (d = now()) => d.getHours() * 60 + d.getMinutes();
const quiet = (d = now()) => hm(d) >= 23 * 60 || hm(d) < 5 * 60; // never bother him 11pm-5am
const st = () => store.load('state.json', {});
const save = (patch) => store.save('state.json', { ...st(), ...patch });
const clean = (t) => String(t || '').replace(/😏/g, '').trim();

let api = null; // filled by start()

// ------------------------------------------------------------------ 1. start with Windows

function autostart() {
  if (process.platform !== 'win32' || !process.env.APPDATA) return;
  const dir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const file = path.join(dir, 'Laudi.bat');
  const body = [
    '@echo off',
    'rem Starts Laudi (the TikTok/Discord friend bot) when Windows starts. Delete this file to stop that.',
    'timeout /t 20 >NUL',
    `cd /d "${ROOT}"`,
    'start "Laudi" /min cmd /c start.bat',
    '',
  ].join('\r\n');
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
    console.log('[extras] ✅ Laudi will now start by himself when the PC turns on');
  } catch (err) {
    console.warn('[extras] auto-start:', err.message);
  }
}

/** Only one Laudi at a time (e.g. if start.bat gets double-clicked). Returns false if another one is running. */
function singleInstance() {
  const lock = path.join(config.dataDir, 'bot.pid');
  try {
    const old = parseInt(fs.readFileSync(lock, 'utf8'), 10);
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0); // still alive?
        return false;
      } catch {}
    }
  } catch {}
  fs.writeFileSync(lock, String(process.pid));
  return true;
}

// ------------------------------------------------------------------ 2. health check + alerts

function ramPct() {
  return Math.round((1 - os.freemem() / os.totalmem()) * 100);
}

async function healthReport() {
  const s = st();
  const up = Math.round((Date.now() - startedAt) / 3_600_000);
  const tiktokOk = await api.loggedIn().catch(() => false);
  const discord = s.discordBot ? `✅ ${s.discordBot}` : '❌ not connected';
  const rbx = s.roblox && s.roblox.name ? `✅ ${s.roblox.name}` : '❌ not logged in';
  const today = now().toDateString();
  return [
    `health check 🩺`,
    `tiktok: ${tiktokOk ? '✅' : '❌ logged out!'}`,
    `discord: ${discord}`,
    `roblox: ${rbx}`,
    `posts today: ${s.postDay === today ? s.postCount || 0 : 0}`,
    `running for ${up}h · pc memory ${ramPct()}%`,
  ].join('\n');
}

async function alert(text) {
  try {
    const d = require('./discord');
    if (d.dmOwner && (await d.dmOwner(`⚠️ ${text}`))) return;
  } catch {}
  console.warn(`[alert] ${text}`);
}

async function healthTick() {
  const d = now();
  const s = st();
  // daily report at 4pm
  if (d.getHours() === 16 && s.healthDay !== d.toDateString()) {
    save({ healthDay: d.toDateString() });
    api.enqueue(async () => api.send(await healthReport()));
  }
  // alert if TikTok logged him out (via Discord, since TikTok DMs won't work then)
  const ok = await api.loggedIn().catch(() => true);
  if (!ok && Date.now() - (s.logoutAlertAt || 0) > 6 * 3_600_000) {
    save({ logoutAlertAt: Date.now() });
    await alert("TikTok logged me out 😭 log me back in on the PC (my Chrome window) when u can");
  }
  if (ramPct() >= 93 && Date.now() - (s.ramAlertAt || 0) > 12 * 3_600_000) {
    save({ ramAlertAt: Date.now() });
    console.warn(`[extras] PC memory is at ${ramPct()}% - closing spare tabs`);
  }
}

// ------------------------------------------------------------------ 3. memory saver: close tabs nobody uses

async function janitor() {
  const keep = new Set(api.keepPages().filter(Boolean));
  const pages = api.ctx().pages();
  let closed = 0;
  for (const p of pages) {
    if (keep.has(p)) continue;
    // Only close empty/blank tabs: never something you opened yourself.
    if (!/^(about:blank|chrome:\/\/newtab|chrome-error:)/.test(p.url())) continue;
    if (pages.length - closed <= 1) break;
    await p.close().catch(() => {});
    closed++;
  }
  if (closed) console.log(`[extras] closed ${closed} unused tab(s) to save memory (pc memory ${ramPct()}%)`);
}

// ------------------------------------------------------------------ 4. Rararo posted a new video -> send it

async function rararoTick() {
  const s0 = require('./fun').streamers().find((x) => x.platform === 'tiktok');
  if (!s0 || quiet()) return;
  const s = st();
  if (Date.now() < (s.clipsPauseUntil || 0)) return;
  let links = [];
  try {
    links = await api.withTab((t) => require('./fun').profileVideos(t, s0.user, 6), 90_000);
  } catch (err) {
    save({ clipsPauseUntil: Date.now() + 2 * 3_600_000 });
    return console.warn(`[clips] couldn't check ${s0.name}'s videos (${err.message.split('\n')[0].slice(0, 60)}), trying again in 2h`);
  }
  if (!links.length) return;
  const seen = new Set(s.rararoSeen || []);
  const fresh = links.filter((l) => !seen.has(l));
  save({ rararoSeen: [...new Set([...(s.rararoSeen || []), ...links])].slice(-200) });
  if (!s.rararoSeen) return; // first look: just remember what's already there
  if (!fresh.length) return;
  const link = fresh[0];
  console.log(`[clips] ${s0.name} posted: ${link}`);
  let reaction = '';
  try {
    const v = await api.withTab((t) => require('./watch').judge(t, link, `a new video by ${s0.name}`), 120_000);
    reaction = v && v.about ? v.about : '';
  } catch {}
  const line = await api
    .think(
      [
        { role: 'system', content: `You are ${config.assistantName}, a hyped fan of ${s0.name}. Write a 3-10 word text to your best friend that ${s0.name} just posted a new video. Lowercase, an emoji. Plain text.` },
        { role: 'user', content: `The video: ${reaction || 'unknown'}` },
      ],
      { definitions: [], run: async () => '' },
    )
    .catch(() => '');
  await api.shareLink(link, clean(line) || `${s0.name.toLowerCase()} just posted 🔥 go watch`);
}

// ------------------------------------------------------------------ 5. Roblox: playtime stats + friends hopping on

const weekKey = (d = now()) => {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 1) % 7)); // weeks start on Saturday
  return x.toDateString();
};

function statsTick() {
  const s = st();
  const p = s.robloxPresence;
  if (!p || p.type !== 2 || !p.game) return;
  const stats = store.load('roblox-stats.json', {});
  const wk = weekKey();
  stats[wk] = stats[wk] || {};
  stats[wk][p.game] = (stats[wk][p.game] || 0) + 2; // called every 2 minutes
  // keep the last 8 weeks
  for (const k of Object.keys(stats).sort((a, b) => new Date(a) - new Date(b)).slice(0, -8)) delete stats[k];
  store.save('roblox-stats.json', stats);
}

function statsText(wk = weekKey()) {
  const games = Object.entries(store.load('roblox-stats.json', {})[wk] || {}).sort((a, b) => b[1] - a[1]);
  if (!games.length) return 'no roblox this week yet 👀';
  const total = games.reduce((n, [, m]) => n + m, 0);
  const fmt = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
  return [`roblox this week 🎮 ${fmt(total)} total`, ...games.slice(0, 5).map(([g, m]) => `• ${g}: ${fmt(m)}`)].join('\n');
}

async function weeklyStatsTick() {
  const d = now();
  // Friday 7pm
  if (d.getDay() !== 5 || d.getHours() !== 19) return;
  const s = st();
  if (s.statsSentWeek === weekKey()) return;
  save({ statsSentWeek: weekKey() });
  const text = statsText();
  if (/no roblox/.test(text)) return;
  const joke = await api
    .think(
      [
        { role: 'system', content: `You are ${config.assistantName}. Write ONE short funny lowercase comment (max 10 words) about these weekly Roblox stats for your best friend.` },
        { role: 'user', content: text },
      ],
      { definitions: [], run: async () => '' },
    )
    .catch(() => '');
  api.enqueue(() => api.send(`${text}${joke ? `\n${clean(joke)}` : ''}`));
}

async function friendsTick() {
  if (quiet()) return;
  const s = st();
  if (!s.ownerRobloxId) return;
  const today = now().toDateString();
  const pings = s.friendPingDay === today ? s.friendPings || 0 : 0;
  if (pings >= 4) return;
  const tab = await api.ensureRobloxTab().catch(() => null);
  if (!tab) return;
  const roblox = require('./roblox');
  const friends = (await roblox.friends(tab, s.ownerRobloxId).catch(() => [])).filter((f) => !s.roblox || f.id !== s.roblox.id);
  if (!friends.length) return;
  const pres = await roblox.presenceMany(tab, friends.map((f) => f.id)).catch(() => ({}));
  const before = s.friendPresence || {};
  const after = {};
  const hopped = [];
  for (const f of friends) {
    const p = pres[f.id];
    if (!p) continue;
    after[f.id] = p.type;
    if (p.type === 2 && before[f.id] !== undefined && before[f.id] !== 2 && p.game) hopped.push(`${f.name} (${p.game})`);
  }
  save({ friendPresence: after });
  if (!hopped.length || (s.robloxPresence && s.robloxPresence.type === 2)) return; // don't ping while he's already playing
  save({ friendPingDay: today, friendPings: pings + 1 });
  api.enqueue(() => api.send(`${hopped.slice(0, 2).join(' and ')} just hopped on roblox 🎮 wanna join?`));
}

// ------------------------------------------------------------------ 6. DM games: /trivia /quiz /wyr /score

async function newQuestion() {
  const thinkFn = api ? api.think : require('./brain').think;
  const topics = ['Roblox', 'video games', 'Minecraft', 'football', 'fun science', 'animals', 'world records', 'TikTok and memes', 'geography', 'movies'];
  const raw = await thinkFn(
    [
      {
        role: 'system',
        content:
          'Make ONE fun multiple-choice trivia question for a teen gamer. Correct facts only. Keep the question SHORT (max 15 words), no long setups. Options max 4 words each. ' +
          'Reply ONLY JSON: {"q":"question","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","fact":"one short fun fact about the answer"}',
      },
      { role: 'user', content: `Topic: ${pick(topics)}. Make it different from: ${(st().game && st().game.past || []).slice(-10).join(' | ')}` },
    ],
    { definitions: [], run: async () => '' },
  );
  const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  if (!j.q || !Array.isArray(j.options) || !/^[A-D]$/i.test(j.answer)) throw new Error('bad question');
  return j;
}

async function askQuestion(round) {
  const q = await newQuestion();
  const g = st().game || {};
  save({ game: { ...g, type: 'trivia', q, round, past: [...(g.past || []), q.q].slice(-30), at: Date.now() } });
  return api.send(`${round ? `Q${round.n}/${round.of} ` : ''}🧠 ${q.q}  ${q.options.join('   ')}`);
}

async function gameCommand(text) {
  if (/^\/(trivia)$/i.test(text)) return askQuestion(null).catch(() => api.send('my brain lagged 😭 try /trivia again'));
  if (/^\/quiz$/i.test(text)) return askQuestion({ n: 1, of: 5, right: 0 }).catch(() => api.send('my brain lagged 😭 try /quiz again'));
  if (/^\/score$/i.test(text)) {
    const sc = st().score || { right: 0, wrong: 0 };
    return api.send(`score 🏆 ${sc.right} right · ${sc.wrong} wrong${sc.best ? ` · best quiz ${sc.best}/5` : ''}`);
  }
  if (/^\/(wyr|wouldyourather)$/i.test(text)) {
    const q = await api
      .think(
        [
          { role: 'system', content: 'Write ONE funny "would you rather" for a teen gamer (Roblox/gaming/school/food). Short, clean. Plain text starting with "would u rather".' },
          { role: 'user', content: 'go' },
        ],
        { definitions: [], run: async () => '' },
      )
      .catch(() => 'would u rather only play obbies forever or never play obbies again');
    return api.send(`${clean(q)} 🤔`);
  }
  return null;
}

/** If a trivia question is waiting, treats `text` as the answer. Returns true if handled. */
async function gameAnswer(text) {
  const s = st();
  const g = s.game;
  if (!g || g.type !== 'trivia' || !g.q || Date.now() - g.at > 30 * 60_000) return false;
  const m = text.trim().match(/^\(?([a-d])\)?[.)!]*$/i) || text.trim().match(/^(?:it'?s |its |answer )?([a-d])\b/i);
  let letter = m ? m[1].toUpperCase() : null;
  if (!letter) {
    const opt = g.q.options.findIndex((o) => o.toLowerCase().replace(/^[a-d]\)\s*/, '').includes(text.toLowerCase().trim()) && text.trim().length > 2);
    if (opt >= 0) letter = 'ABCD'[opt];
  }
  if (!letter) return false; // not an answer: chat normally
  const right = letter === g.q.answer.toUpperCase();
  const sc = s.score || { right: 0, wrong: 0 };
  sc[right ? 'right' : 'wrong']++;
  const round = g.round ? { ...g.round, right: g.round.right + (right ? 1 : 0) } : null;
  save({ score: sc, game: { ...g, type: null, q: null } });
  const correct = g.q.options.find((o) => o.toUpperCase().startsWith(g.q.answer.toUpperCase())) || g.q.answer;
  await api.send(`${right ? pick(['W 🔥', 'yesss 🧠', 'correct 💯', 'big brain 😤']) : `nah 😭 it was ${correct}`}\n${g.q.fact || ''}`.trim());
  if (round && round.n < round.of) {
    await sleep(1200);
    await askQuestion({ ...round, n: round.n + 1 }).catch(() => {});
  } else if (round) {
    const best = Math.max(st().score.best || 0, round.right);
    save({ score: { ...st().score, best } });
    await api.send(`quiz done: ${round.right}/${round.of} ${round.right >= 4 ? '👑' : round.right >= 2 ? '👍' : '💀'}`);
  }
  return true;
}

// ------------------------------------------------------------------ 7. school nights: tests/homework nudge

async function schoolTick() {
  const d = now();
  // evenings before a school day (school = Sun-Thu) -> Sat..Wed at ~8:30pm
  if (![6, 0, 1, 2, 3].includes(d.getDay()) || hm(d) < 20 * 60 + 30 || hm(d) > 21 * 60 + 30) return;
  const s = st();
  if (s.schoolNudgeDay === d.toDateString()) return;
  save({ schoolNudgeDay: d.toDateString() });
  const line = await api
    .think(
      [
        {
          role: 'system',
          content:
            `You are ${config.assistantName}, best friend of ${config.ownerName}. He has school tomorrow. ` +
            'Text him ONE short casual message (max 12 words) checking if he has a test or homework tomorrow, or reminding him to sleep on time. Lowercase, maybe an emoji. Plain text.',
        },
        { role: 'user', content: 'write it' },
      ],
      { definitions: [], run: async () => '' },
    )
    .catch(() => '');
  api.enqueue(() => api.send(clean(line) || 'school tmrw 😮‍💨 got any tests or hw?'));
}

// ------------------------------------------------------------------ 8. more fun commands

const T = (system, user, max = 400) =>
  (api ? api.think : require('./brain').think)([{ role: 'system', content: system }, { role: 'user', content: user }], { definitions: [], run: async () => '' }).then(clean).catch(() => '');
const ME = () => `You are ${config.assistantName}, ${config.ownerName}'s funny, loyal best friend (an AI). Text like a teen: short, lowercase, emojis ok, no 😏, keep it clean.`;

/** Parses "19 nov big drop" / "rayan 3 march" into { what, date: 'YYYY-MM-DD' } with the AI. */
async function parseDated(text, kind) {
  const raw = await T(
    `Today is ${now().toDateString()}. Extract a ${kind} from the text. Reply ONLY JSON {"what":"short name","date":"YYYY-MM-DD"}. ` +
      'If no year is given, use the next upcoming date. If there is no date, use "date":"".',
    text,
  );
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    if (j.date && !isNaN(new Date(j.date))) return { what: String(j.what || text).slice(0, 60), date: j.date };
  } catch {}
  return null;
}
const daysUntil = (iso) => {
  const a = new Date(now().toDateString());
  const b = new Date(new Date(iso).toDateString());
  return Math.round((b - a) / 86_400_000);
};

async function avatarB64(userId) {
  const tab = await api.ensureRobloxTab().catch(() => null);
  if (!tab) return null;
  const req = tab.context().request;
  const r = await req.get(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`, { timeout: 20_000 });
  const url = r.ok() && (await r.json()).data[0].imageUrl;
  if (!url) return null;
  const img = await req.get(url, { timeout: 20_000 });
  return img.ok() ? (await img.body()).toString('base64') : null;
}

async function funCommand(text) {
  const arg = text.replace(/^\/\w+\s*/, '').trim();
  if (/^\/roast\b/i.test(text))
    return api.send((await T(`${ME()} Give a FRIENDLY roast (1-2 lines, funny, never mean about looks/family/religion). It's all love.`, arg || `roast ${config.ownerName} for playing too much roblox`)) || 'ur so bad at obbies the checkpoints feel bad for u 💀');
  if (/^\/8ball\b/i.test(text))
    return api.send(`🎱 ${pick(['yes fr', 'nah 💀', 'ask again after a snack', '100%', 'not looking good chief', 'the stars say yes ✨', 'bro idk 😭', 'definitely', 'no shot'])}`);
  if (/^\/pick\b/i.test(text)) {
    const opts = arg.split(/\s+or\s+|,|\|/i).map((x) => x.trim()).filter(Boolean);
    if (opts.length < 2) return api.send('give me options like: /pick pizza or burger');
    return api.send(`${pick(opts)} 👉 ${pick(['final answer', 'trust me', 'no debate', 'easy choice'])}`);
  }
  if (/^\/rate\b/i.test(text)) {
    const s = st();
    if (!s.ownerRobloxId) return api.send("i don't know ur roblox yet 😭");
    const b64 = await avatarB64(s.ownerRobloxId).catch(() => null);
    if (!b64) return api.send("couldn't load ur avatar rn 😭 (am i logged into roblox?)");
    const out = await require('./watch')
      .look([b64], `${ME()} This is your friend's Roblox avatar. Rate the fit out of 10 with a funny 1-2 line review (what's fire, what to change). Plain text.`, { timeout: 30_000 })
      .catch(() => '');
    return api.send(clean(out) || 'my eyes are lagging rn, try /rate again 😭');
  }
  if (/^\/game\b/i.test(text)) {
    const played = Object.entries(store.load('roblox-stats.json', {})[weekKey()] || {}).map(([g]) => g).join(', ');
    return api.send(
      (await T(`${ME()} Recommend 3 real, popular Roblox games for your friend to try, one line each with why. Only games you're sure exist.`, `He plays: ${played || 'Pilot Training Flight Simulator, Build a Phone Empire'}. Something different but similar vibe.`)) ||
        'try doors, blade ball and grow a garden 🎮',
    );
  }
  if (/^\/recap\b/i.test(text)) {
    const h = store.load('history.json', []).slice(-40).map((m) => `${m.role === 'user' ? 'him' : 'me'}: ${String(m.content).slice(0, 200)}`).join('\n');
    return api.send((await T(`${ME()} Recap your recent chats with your friend in 3-5 short funny bullet lines (use "•").`, h || '(nothing yet)')) || 'we just vibed honestly 😂');
  }
  if (/^\/countdown\b/i.test(text)) {
    if (!arg) {
      const list = st().countdowns || [];
      return api.send(list.length ? list.map((c) => `⏳ ${c.what}: ${daysUntil(c.date)} days`).join('\n') : 'no countdowns. try: /countdown nov 19 big drop');
    }
    const c = await parseDated(arg, 'countdown event');
    if (!c) return api.send('when tho? try like: /countdown nov 19 big drop');
    save({ countdowns: [...(st().countdowns || []).filter((x) => x.what !== c.what), c] });
    return api.send(`bet ⏳ ${c.what} in ${daysUntil(c.date)} days. i'll count down every morning`);
  }
  if (/^\/bday\b/i.test(text)) {
    if (!arg) {
      const list = st().bdays || [];
      return api.send(list.length ? list.map((b) => `🎂 ${b.what}: ${new Date(b.date).toDateString().slice(4, 10)}`).join('\n') : 'no birthdays saved. try: /bday rayan march 3');
    }
    const b = await parseDated(arg, "person's birthday (what = their name)");
    if (!b) return api.send('whose bday and when? try: /bday rayan march 3');
    save({ bdays: [...(st().bdays || []).filter((x) => x.what.toLowerCase() !== b.what.toLowerCase()), b] });
    return api.send(`saved 🎂 i'll remind u on ${b.what}'s bday`);
  }
  if (/^\/story\b/i.test(text)) {
    const opening = await T(
      `${ME()} Start a short choose-your-own-adventure story set in a Roblox-like world starring your friend. 3-4 short lines, end with 2-3 numbered choices.`,
      arg || 'surprise me',
    );
    save({ story: { turns: [{ role: 'assistant', content: opening }], at: Date.now() } });
    return api.send(`${opening}\n(/end to stop)`);
  }
  if (/^\/end$/i.test(text) && st().story) {
    save({ story: null });
    return api.send('story over 📕 that was fun');
  }
  return null;
}

/** Continues an active /story with the owner's choice. Returns true if handled. */
async function storyTurn(text) {
  const s = st();
  if (!s.story || Date.now() - s.story.at > 60 * 60_000) return false;
  const turns = [...s.story.turns, { role: 'user', content: text }];
  const next = await api
    .think(
      [
        { role: 'system', content: `${ME()} You are running a choose-your-own-adventure story. Continue from their choice in 3-4 short lines, keep it fun and clean, end with 2-3 numbered choices. After about 8 turns, give it a fun ending and write "THE END".` },
        ...turns.slice(-16),
      ],
      { definitions: [], run: async () => '' },
    )
    .then(clean)
    .catch(() => '');
  if (!next) return false;
  const done = /THE END/i.test(next);
  save({ story: done ? null : { turns: [...turns, { role: 'assistant', content: next }].slice(-20), at: Date.now() } });
  await api.send(next);
  return true;
}

async function datesTick() {
  const d = now();
  if (d.getHours() < 9 || d.getHours() > 11) return;
  const s = st();
  if (s.datesDay === d.toDateString()) return;
  save({ datesDay: d.toDateString() });
  const out = [];
  const keep = [];
  for (const c of s.countdowns || []) {
    const n = daysUntil(c.date);
    if (n > 0) out.push(n === 1 ? `⏳ ${c.what} is TOMORROW 🔥` : `⏳ ${n} days until ${c.what}`);
    if (n === 0) out.push(`🚨 ${c.what} is TODAY!!`);
    if (n > 0) keep.push(c);
  }
  for (const b of s.bdays || []) {
    const bd = new Date(b.date);
    if (bd.getMonth() === d.getMonth() && bd.getDate() === d.getDate()) out.push(`🎂 it's ${b.what}'s birthday today! wish them 🎉`);
  }
  save({ countdowns: keep });
  if (out.length) api.enqueue(() => api.send(out.join('\n')));
}

// ------------------------------------------------------------------ 9. trivia battles (group chats & Discord)
// First correct answer wins the point. key = a chat/channel id. say(text) sends into that chat.

const battles = new Map(); // key -> { q, at, timer }

async function battleAsk(key, say, { timer = true } = {}) {
  const old = battles.get(key);
  if (old && Date.now() - old.at > 180_000) battles.delete(key);
  if (battles.has(key)) return say('there\'s already a question up 👆 answer it first');
  const q = await newQuestion();
  const b = { q, at: Date.now() };
  if (timer) b.timer = setTimeout(() => {
    if (battles.get(key) !== b) return;
    battles.delete(key);
    const correct = q.options.find((o) => o.toUpperCase().startsWith(q.answer.toUpperCase())) || q.answer;
    say(`time's up ⏰ nobody got it. it was ${correct}`).catch(() => {});
  }, 90_000);
  battles.set(key, b);
  return say(`🧠 TRIVIA BATTLE (first right answer wins): ${q.q}  ${q.options.join('   ')}`);
}

/** Checks a message as an answer. Returns true if it was one. */
async function battleAnswer(key, who, text, say) {
  const b = battles.get(key);
  if (!b) return false;
  if (Date.now() - b.at > 180_000) {
    battles.delete(key);
    return false;
  }
  const m = String(text).trim().match(/^\(?([a-d])\)?[.)!]*$/i);
  if (!m) return false;
  if (m[1].toUpperCase() !== b.q.answer.toUpperCase()) return true; // wrong, keep going
  clearTimeout(b.timer);
  battles.delete(key);
  const all = store.load('battles.json', {});
  all[key] = all[key] || {};
  all[key][who] = (all[key][who] || 0) + 1;
  store.save('battles.json', all);
  await say(`${who} got it 🔥 (${m[1].toUpperCase()}) +1 point\n${b.q.fact || ''}`.trim());
  return true;
}

function battleBoard(key) {
  const rows = Object.entries(store.load('battles.json', {})[key] || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!rows.length) return 'no points yet, start one with /trivia 🧠';
  return ['🏆 trivia leaderboard', ...rows.map(([n, p], i) => `${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} ${n}: ${p}`)].join('\n');
}

/** Stateless quick commands that just return text (used by Discord + group chats). */
async function quick(text) {
  const arg = text.replace(/^[!/]\w+\s*/, '').trim();
  if (/^[!/]8ball\b/i.test(text)) return `🎱 ${pick(['yes fr', 'nah 💀', 'ask again after a snack', '100%', 'not looking good chief', 'the stars say yes ✨', 'bro idk 😭', 'definitely', 'no shot'])}`;
  if (/^[!/]pick\b/i.test(text)) {
    const opts = arg.split(/\s+or\s+|,|\|/i).map((x) => x.trim()).filter(Boolean);
    return opts.length < 2 ? 'give me options like: /pick pizza or burger' : `${pick(opts)} 👉 ${pick(['final answer', 'trust me', 'no debate'])}`;
  }
  if (/^[!/]roast\b/i.test(text))
    return (await T(`${ME()} Give a FRIENDLY roast (1-2 lines, funny, never mean about looks/family/religion). It's all love.`, arg || 'roast the whole chat')) || 'yall type like ur wifi is from 2009 💀';
  if (/^[!/](wyr|wouldyourather)\b/i.test(text))
    return `${(await T('Write ONE funny "would you rather" for teen gamers (Roblox/gaming/school/food). Short, clean. Plain text starting with "would u rather".', 'go')) || 'would u rather only play obbies forever or never again'} 🤔`;
  return null;
}

// ------------------------------------------------------------------ start

function every(ms, fn, first = ms) {
  const run = () => Promise.resolve().then(fn).catch((err) => console.warn('[extras]', err.message.split('\n')[0]));
  setTimeout(() => {
    run();
    setInterval(run, ms);
  }, first);
}

function start(a) {
  api = a;
  autostart();
  every(5 * 60_000, healthTick, 60_000);
  every(10 * 60_000, janitor, 5 * 60_000);
  if (!/^(1|true|yes|on)$/i.test(process.env.EXTRAS_ENABLED || '1')) return console.log('[extras] off (Laudi Control)');
  every(30 * 60_000, rararoTick, 3 * 60_000);
  every(2 * 60_000, statsTick, 2 * 60_000);
  every(10 * 60_000, weeklyStatsTick, 4 * 60_000);
  every(5 * 60_000, friendsTick, 6 * 60_000);
  every(5 * 60_000, schoolTick, 2 * 60_000);
  every(10 * 60_000, datesTick, 90_000);
  console.log('[extras] health check, memory saver, Rararo drops, Roblox stats, games and school nudges are on');
}

module.exports = { start, singleInstance, gameCommand, gameAnswer, statsText, healthReport, funCommand, storyTurn, battleAsk, battleAnswer, battleBoard, quick };
