// Posting videos to the bot's own TikTok account.
// Queue: put .mp4/.webm files in data/posts/ (optional same-name .txt = caption). Posted ones move to data/posts/done/.
// When the queue is empty, the bot makes its own meme video (videogen.js).
const config = require('./config');
const fs = require('fs');
const path = require('path');
const fun = require('./fun');
const store = require('./store');
const { makeVideo } = require('./videogen');

const POSTS = path.join(config.dataDir, 'posts');
const DONE = path.join(POSTS, 'done');
const DEBUG = path.join(config.dataDir, 'debug');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AI_TAGS = '#ai #aigenerated #robot';

function queued() {
  fs.mkdirSync(POSTS, { recursive: true });
  return fs
    .readdirSync(POSTS)
    .filter((f) => /\.(mp4|webm|mov)$/i.test(f))
    .sort()
    .map((f) => {
      const file = path.join(POSTS, f);
      const txt = file.replace(/\.[^.]+$/, '.txt');
      return { file, caption: fs.existsSync(txt) ? fs.readFileSync(txt, 'utf8').trim() : '' };
    });
}

function markDone(file) {
  fs.mkdirSync(DONE, { recursive: true });
  for (const f of [file, file.replace(/\.[^.]+$/, '.txt')]) {
    if (fs.existsSync(f)) fs.renameSync(f, path.join(DONE, path.basename(f)));
  }
}

async function snap(tab, name) {
  fs.mkdirSync(DEBUG, { recursive: true });
  fs.writeFileSync(path.join(DEBUG, `${name}.html`), await tab.content().catch(() => ''));
  await tab.screenshot({ path: path.join(DEBUG, `${name}.png`) }).catch(() => {});
}

async function clickText(tab, re, scope = 'button, [role="button"], [role="switch"], label, span, div') {
  return tab
    .evaluate(
      ({ src, flags, scope }) => {
        const re = new RegExp(src, flags);
        const els = [...document.querySelectorAll(scope)].filter(
          (e) => e.offsetParent !== null && re.test((e.innerText || e.getAttribute('aria-label') || '').trim()),
        );
        // the smallest matching element is the real button
        els.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
        if (!els[0]) return false;
        els[0].click();
        return true;
      },
      { src: re.source, flags: re.flags, scope },
    )
    .catch(() => false);
}

/** Closes TikTok popups ("Turn on automatic content checks?", tips, etc.). */
const popupHits = new WeakMap();
async function closePopups(tab) {
  const hits = popupHits.get(tab) || {};
  popupHits.set(tab, hits);
  for (let i = 0; i < 4; i++) {
    const hit = await tab
      .evaluate((skip) => {
        const modals = [...document.querySelectorAll('.TUXModal, [role="dialog"], [data-floating-ui-portal]')].filter((m) => m.offsetParent !== null || m.getClientRects().length);
        for (const m of modals) {
          const btns = [...m.querySelectorAll('button')].filter((b) => !b.disabled && !skip.includes((b.innerText || 'x').trim()));
          const want = [/^turn on$/i, /^got it$/i, /^ok(ay)?$/i, /^not now$/i, /^cancel$/i, /^close$/i];
          for (const re of want) {
            const b = btns.find((x) => re.test((x.innerText || x.getAttribute('aria-label') || '').trim()));
            if (b) { b.click(); return (b.innerText || 'x').trim(); }
          }
        }
        return '';
      }, Object.keys(hits).filter((k) => hits[k] >= 2))
      .catch(() => '');
    if (!hit) return;
    hits[hit] = (hits[hit] || 0) + 1;
    if (hits[hit] > 2) return; // same popup keeps coming back: it's not blocking anything
    console.log(`[post] closed a popup (${hit})`);
    await sleep(1200);
  }
}

/** Uploads one video. Returns 'posted' or a reason it didn't. */
async function upload(tab, file, caption) {
  popupHits.delete(tab);
  await tab.goto('https://www.tiktok.com/tiktokstudio/upload?from=webapp', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(6000);
  if (await fun.captchaShown(tab)) return 'captcha';
  if (/login/.test(tab.url())) return 'not logged in';
  // Leftover draft from a failed try: throw it away.
  if (await clickText(tab, /^discard$/i, 'button')) {
    console.log('[post] discarded an old unsaved draft');
    await sleep(2000);
    await clickText(tab, /^discard$/i, 'button'); // confirm popup
    await sleep(2000);
  }

  const input = await tab.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30_000 }).catch(() => null);
  if (!input) {
    await snap(tab, 'post-no-upload-box');
    return 'upload page did not load (saved data/debug/post-no-upload-box.png)';
  }
  await input.setInputFiles(file);
  console.log(`[post] file picked: ${path.basename(file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  console.log('[post] uploading video…');

  // Caption box appears once the file is accepted.
  const box = await tab
    .waitForSelector('.public-DraftEditor-content, [contenteditable="true"]', { timeout: 90_000 })
    .catch(() => null);
  if (!box) {
    await snap(tab, 'post-no-caption');
    const why = await tab.evaluate(() => (document.body.innerText.match(/[^\n]*(not supported|unsupported|couldn.t upload|failed|try again)[^\n]*/i) || [''])[0]).catch(() => '');
    if (why) return `TikTok said: ${why.trim().slice(0, 120)}`;
    return 'video was not accepted (saved data/debug/post-no-caption.png)';
  }
  await sleep(3000);
  await closePopups(tab);
  await box.click({ force: true, timeout: 10_000 }).catch(() => box.evaluate((e) => e.focus()));
  await closePopups(tab);
  await box.evaluate((e) => e.focus()).catch(() => {});
  await tab.keyboard.press('Control+A');
  await tab.keyboard.press('Backspace');
  for (const part of caption.split(/(\s+)/)) {
    await tab.keyboard.type(part, { delay: 25 });
    if (part.startsWith('#') || part.startsWith('@')) {
      await sleep(1200); // let the hashtag popup show, then close it
      await tab.keyboard.press('Escape').catch(() => {});
    }
  }
  await sleep(800);

  // Label it as AI-generated (TikTok's own toggle, if the page shows it).
  if (await clickText(tab, /^(show more|more options|advanced settings)$/i)) await sleep(1500);
  const labeled = await tab
    .evaluate(() => {
      const label = [...document.querySelectorAll('*')].find(
        (e) => e.children.length < 3 && /AI-generated content/i.test(e.textContent || '') && (e.textContent || '').length < 60,
      );
      if (!label) return 'no toggle';
      let box = label;
      for (let i = 0; i < 6 && box; i++, box = box.parentElement) {
        const sw = box.querySelector('[role="switch"], input[type="checkbox"]');
        if (sw) {
          const on = sw.getAttribute('aria-checked') === 'true' || sw.checked;
          if (!on) sw.click();
          return 'on';
        }
      }
      return 'no switch';
    })
    .catch(() => 'error');
  if (labeled === 'on') {
    await sleep(1200);
    await clickText(tab, /^(turn on|confirm|ok)$/i, 'button'); // confirmation popup, if any
  }
  console.log(`[post] AI label: ${labeled}`);

  // Wait until the upload finished and Post is enabled.
  const postSel = 'button[data-e2e="post_video_button"]';
  const ready = Date.now() + 180_000;
  while (Date.now() < ready) {
    const ok = await tab
      .evaluate((sel) => {
        const b =
          document.querySelector(sel) ||
          [...document.querySelectorAll('button')].find((x) => /^post$/i.test((x.innerText || '').trim()));
        return Boolean(b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b.getAttribute('data-disabled') !== 'true');
      }, postSel)
      .catch(() => false);
    if (ok) break;
    await closePopups(tab);
    await sleep(2000);
  }
  await sleep(1500);
  await closePopups(tab);
  const clicked = (await tab.$(postSel).then((b) => b && b.click({ timeout: 10_000 }).then(() => true)).catch(() => false)) || (await clickText(tab, /^post$/i, 'button'));
  if (!clicked) {
    await snap(tab, 'post-no-button');
    return 'could not find the Post button (saved data/debug/post-no-button.png)';
  }
  await sleep(3000);
  await clickText(tab, /^(post now|continue|post anyway)$/i, 'button'); // "content check" popups
  await closePopups(tab);

  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    const url = tab.url();
    const text = await tab.evaluate(() => document.body.innerText).catch(() => '');
    if (/tiktokstudio\/content|\/manage/.test(url) || /video (has been|was) (uploaded|posted)|manage your posts|your video is being uploaded/i.test(text)) {
      return 'posted';
    }
    if (await fun.captchaShown(tab)) return 'captcha';
    await sleep(3000);
  }
  await snap(tab, 'post-unsure');
  return 'clicked Post but could not confirm it went up (saved data/debug/post-unsure.png)';
}

const FALLBACK = [
  ['when ur friend says *roblox* is easy 💀', '!then dies on the *first* obby 😭', 'tag that friend 👇'],
  ['me: *one more* game', '!also me at *3am* 🥲', 'who else 🙋'],
  ['*Rararo* live = 👑', 'everything else = 😐', '!go follow him rn 🔥'],
  ['pov: ur an *AI* 🤖', 'and u still lose in *roblox*', '!skill issue 💀'],
  ['rate my *dance* 🤖', '!beep boop 🕺', 'comment ur score 👇'],
];

/** Asks the AI for a short meme video idea. */
async function idea(think, topic = '') {
  try {
    const raw = await think(
      [
        {
          role: 'system',
          content:
            `You are ${config.assistantName}, an openly AI TikTok account (a funny robot). Make ONE short meme video idea for TikTok: ` +
            'Roblox jokes, gamer life, school life, being a robot, or hyping the streamer Rararo. Teen-friendly, no swearing, nothing mean. ' +
            'Reply ONLY with JSON: {"lines":["3 or 4 short lines, max 9 words each, emojis ok, wrap 1-2 key words in *stars*, start the punchline with !"],"caption":"short caption + 3 hashtags"}',
        },
        {
          role: 'user',
          content: topic
            ? `Make the video about this (keep the facts exactly as given): ${topic}`
            : `Idea number ${Math.floor(Math.random() * 10000)}. Something new.`,
        },
      ],
      { definitions: [], run: async () => '' },
    );
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    if (Array.isArray(json.lines) && json.lines.length >= 2) return { lines: json.lines.slice(0, 5).map(String), caption: String(json.caption || '') };
  } catch (err) {
    console.warn('[post] idea:', err.message.split('\n')[0]);
  }
  const lines = FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
  return { lines, caption: 'beep boop 🤖 #roblox #funny #fyp' };
}

const withAiTags = (caption) => (/#ai\b/i.test(caption) ? caption : `${caption} ${AI_TAGS}`).trim().slice(0, 2000);

/** Posts the next queued video, or makes a new one. withTab runs a job in the bot's background tab. */
async function postNext({ withTab, think, file: forced, topic = '', caption: forcedCaption = '' } = {}) {
  let item = forced ? { file: forced, caption: forcedCaption } : topic ? null : queued()[0];
  if (!item) {
    const { lines, caption } = await idea(think, topic);
    console.log(`[post] making a video: ${lines.join(' / ')}`);
    const file = await makeVideo(lines, path.join(POSTS, `auto-${Date.now()}.mp4`));
    console.log(`[post] made ${path.basename(file)}`);
    fs.writeFileSync(file.replace(/\.[^.]+$/, '.txt'), caption);
    item = { file, caption };
  }
  const caption = withAiTags(item.caption || 'beep boop 🤖');
  console.log(`[post] posting ${path.basename(item.file)}…`);
  const result = await withTab((t) => upload(t, item.file, caption), 6 * 60_000);
  console.log(`[post] ${result}`);
  const st = store.load('state.json', {});
  if (result === 'posted') {
    markDone(item.file);
    const today = new Date().toDateString();
    const count = st.postDay === today ? (st.postCount || 0) + 1 : 1;
    store.save('state.json', { ...st, postDay: today, postCount: count, lastPostAt: Date.now() });
  } else if (result === 'captcha') {
    store.save('state.json', { ...st, postPauseUntil: Date.now() + 60 * 60_000 });
  } else {
    store.save('state.json', { ...st, postPauseUntil: Date.now() + 30 * 60_000 });
  }
  return result;
}

/** Runs every few minutes: posts when it's time (spread out over the active hours). */
async function tick(deps) {
  if (!config.postsPerDay) return;
  const now = new Date();
  if (!fun.isActive(now)) return;
  const st = store.load('state.json', {});
  const today = now.toDateString();
  const count = st.postDay === today ? st.postCount || 0 : 0;
  if (count >= config.postsPerDay) return;
  if (st.postPauseUntil && Date.now() < st.postPauseUntil) return;
  const gap = Math.max(40, Math.floor((16 * 60) / config.postsPerDay)) * 60_000;
  if (st.lastPostAt && Date.now() - st.lastPostAt < gap) return;
  if (!st.nextPostAt || st.nextPostAt < (st.lastPostAt || 0)) {
    store.save('state.json', { ...st, nextPostAt: Date.now() + fun.rand(0, 25) * 60_000 });
    return;
  }
  if (Date.now() < st.nextPostAt) return;
  await postNext(deps);
  const s2 = store.load('state.json', {});
  store.save('state.json', { ...s2, nextPostAt: 0 });
}

module.exports = { postNext, tick, queued, upload, makeVideo };
