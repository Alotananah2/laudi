// While a streamer (Rararo) is live, Laudi sits in the live stream and supports him:
// a different supportive comment about every 3 minutes (reacting to the chat), plus a few taps of like.
const config = require('./config');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBUG = path.join(config.dataDir, 'debug');
const running = new Map(); // key -> { stop, page }

const INPUT = [
  '[data-e2e="room-chat-input-field"]',
  '[data-e2e="comment-input"] [contenteditable="true"]',
  '[data-e2e="live-comment-input"] [contenteditable="true"]',
  'div[contenteditable="true"][placeholder]',
  '[class*="CommentInput" i] [contenteditable="true"]',
  '[class*="ChatInput" i] [contenteditable="true"]',
  'div[contenteditable="plaintext-only"]',
  'div[contenteditable="true"]',
];

async function recentChat(page) {
  return page
    .evaluate(() => {
      const rows = [...document.querySelectorAll('[data-e2e="chat-message"], [class*="ChatMessage" i], [class*="chat-message" i], [class*="CommentItem" i]')];
      return rows
        .slice(-12)
        .map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t && t.length < 160);
    })
    .catch(() => []);
}

async function ended(page) {
  return page
    .evaluate(() => /LIVE has ended|live has ended|isn't live|not live right now|LIVE ended/i.test(document.body.innerText.slice(0, 5000)))
    .catch(() => false);
}

async function comment(page, text) {
  await page.bringToFront().catch(() => {}); // the chat only loads in the tab you're looking at
  await sleep(1500);
  for (const sel of INPUT) {
    const box = page.locator(sel).last();
    if (!(await box.count().catch(() => 0))) continue;
    if (!(await box.isVisible().catch(() => false))) continue;
    const off = await box.evaluate((e) => e.hasAttribute('disabled') || /comments off/i.test(e.getAttribute('placeholder') || '')).catch(() => false);
    if (off) return 'off';
    await box.click({ timeout: 5000 });
    await page.keyboard.insertText(text);
    await sleep(400);
    const sendBtn = page.locator('[data-e2e="room-chat-send-btn"]').first();
    if (await sendBtn.count().catch(() => 0)) await sendBtn.click({ timeout: 3000 }).catch(() => page.keyboard.press('Enter'));
    else await page.keyboard.press('Enter');
    return true;
  }
  return false;
}

async function like(page) {
  // A few taps of the like/heart button if the page has one.
  const btn = page.locator('[data-e2e="room-chat-like-btn"], [data-e2e="live-like-button"], [data-e2e="like-icon"]').first();
  if (!(await btn.count().catch(() => 0))) return;
  for (let i = 0; i < 3 + Math.floor(Math.random() * 5); i++) {
    await btn.click({ timeout: 3000 }).catch(() => {});
    await sleep(250 + Math.random() * 400);
  }
}

/**
 * Starts supporting `s` (from fun.streamers()) in its own tab. Stops by itself when the live ends.
 * deps: { ctx, think, liveUrl }
 */
async function start(s, { ctx, think, liveUrl, everyMs = 3 * 60_000 }) {
  const key = `${s.platform}:${s.user}`;
  if (running.has(key) || s.platform !== 'tiktok') return;
  const job = { stop: false, page: null };
  running.set(key, job);
  const said = [];
  console.log(`[live] 💜 supporting ${s.name} in their live`);
  try {
    job.page = await ctx.newPage();
    // Open the live the way a person does (opening the live link directly shows "Comments off" on the website).
    let viaSearch = false;
    const clickLive = async () => {
      const sel = `a[href*="/@${s.user}/live"]`;
      const a = job.page.locator(sel).first();
      if (await a.count().catch(() => 0)) {
        await a.click({ timeout: 8000 });
        await sleep(5000);
        return job.page.url().includes(`/@${s.user}/live`);
      }
      // user card / avatar with a LIVE ring
      const card = job.page.locator(`a[href*="/@${s.user}"]`).first();
      if (await card.count().catch(() => 0)) {
        await card.click({ timeout: 8000 }).catch(() => {});
        await sleep(5000);
        if (job.page.url().includes(`/@${s.user}/live`)) return true;
        const ring = job.page.locator('[data-e2e="user-avatar"], [data-e2e*="live" i]').first();
        if (await ring.count().catch(() => 0)) {
          await ring.click({ timeout: 8000 }).catch(() => {});
          await sleep(5000);
        }
      }
      return job.page.url().includes(`/@${s.user}/live`);
    };
    // Route 1: type the name into TikTok's search box, like a person.
    try {
      await job.page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await sleep(5000);
      const box = job.page.locator('[data-e2e="search-user-input"], input[type="search"], input[placeholder*="Search" i]').first();
      if (await box.count().catch(() => 0)) {
        await job.page.locator('[data-e2e="nav-search"]').first().click({ timeout: 3000 }).catch(() => {});
        await box.click({ timeout: 5000 }).catch(() => {});
        await job.page.keyboard.insertText(s.searchName || 'rararo the richest 1');
        await sleep(800);
        await job.page.keyboard.press('Enter');
        await sleep(7000);
        viaSearch = await clickLive();
      }
    } catch (err) {
      console.warn('[live] search route:', err.message.split('\n')[0]);
    }
    // Route 2: TikTok's LIVE page (shows lives of people you follow), click them there.
    if (!viaSearch) {
      try {
        await job.page.goto('https://www.tiktok.com/live', { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await sleep(7000);
        viaSearch = await clickLive();
      } catch (err) {
        console.warn('[live] live-page route:', err.message.split('\n')[0]);
      }
    }
    if (!job.page.url().includes(`/@${s.user}/live`)) {
      viaSearch = false;
      await job.page.goto(liveUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
    await job.page.bringToFront().catch(() => {});
    console.log(`[live] opened the live ${viaSearch ? 'by clicking it ✅' : 'by link'} (${job.page.url().split('?')[0]})`);
    // Keep the stream silent on the PC.
    const mute = () => job.page.evaluate(() => document.querySelectorAll('video, audio').forEach((m) => { m.muted = true; m.volume = 0; })).catch(() => {});
    await sleep(8000);
    await mute();
    // Follow him (once) - that's support too, and some streamers only allow followers to comment.
    const follow = job.page.locator('[data-e2e="room-header-follow-btn"]').first();
    if (await follow.count().catch(() => 0)) {
      const txt = ((await follow.innerText().catch(() => '')) || '').trim();
      if (/^\+?\s*follow$/i.test(txt)) {
        await follow.click({ timeout: 5000 }).catch(() => {});
        console.log(`[live] followed ${s.name}`);
        await sleep(3000);
        await job.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); // so the follow counts for the chat
        await sleep(8000);
        await mute();
      }
    }
    let first = true;
    let fails = 0;
    let rounds = 0;
    while (!job.stop) {
      // Refresh every ~15 min: comments may open up (e.g. followers-only for a while).
      if (++rounds % 5 === 0 && job.offNoted) {
        await job.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(8000);
        await mute();
      }
      if (await ended(job.page)) {
        console.log(`[live] ${s.name}'s live ended`);
        break;
      }
      const chat = await recentChat(job.page);
      let line = '';
      try {
        line = await think(
          [
            {
              role: 'system',
              content:
                `You are ${config.assistantName}, a big fan supporting the TikTok streamer ${s.name} in their LIVE chat. ` +
                'Write ONE short live comment (2-10 words): hype, kind and supportive, like a loyal fan. ' +
                'React to what is happening in the chat when it makes sense. Emojis ok. ' +
                'No links, no @mentions, no asking for anything, no begging for gifts or follows, nothing rude. ' +
                `Never repeat or closely copy these earlier comments: ${said.slice(-15).join(' | ') || '(none)'}. ` +
                'Reply with ONLY the comment.',
            },
            {
              role: 'user',
              content: first
                ? 'You just joined the live. Say hi / hype them up.'
                : `Recent chat:\n${chat.join('\n') || '(nothing visible)'}\n\nWrite your next comment.`,
            },
          ],
          { definitions: [], run: async () => '' },
        );
      } catch {}
      line = String(line || '')
        .replace(/https?:\/\/\S+|@\w+/g, '')
        .replace(/^["']|["']$/g, '')
        .split('\n')[0]
        .trim()
        .slice(0, 100);
      if (!line || said.some((x) => x.toLowerCase() === line.toLowerCase())) {
        line = ['lets gooo 🔥', 'goated stream fr 👑', 'best streamer 💜', 'W stream 🙌', 'always here supporting 💯'].find((x) => !said.includes(x)) || '';
      }
      if (line) {
        const ok = await comment(job.page, line).catch(() => false);
        if (ok === 'off' && !job.retriedFront) {
          job.retriedFront = true;
          await job.page.bringToFront().catch(() => {});
          await job.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await sleep(12000);
          await mute();
          const again = await comment(job.page, line).catch(() => false);
          if (again === true) {
            said.push(line);
            console.log(`[live] 💬 ${s.name}: ${line} (chat loaded once the live was the front tab)`);
            first = false;
            continue;
          }
        }
        if (ok === 'off') {
          if (!job.offNoted) console.log(`[live] ${s.name} has comments off for me - sending likes and checking again every 15 min 💜`);
          job.offNoted = true;
          fails = 0;
        } else if (ok) {
          if (job.offNoted) console.log(`[live] comments are open now 🎉`);
          job.offNoted = false;
          said.push(line);
          fails = 0;
          console.log(`[live] 💬 ${s.name}: ${line}`);
        } else {
          fails++;
          if (fails === 1) {
            fs.mkdirSync(DEBUG, { recursive: true });
            fs.writeFileSync(path.join(DEBUG, 'live-no-input.html'), await job.page.content().catch(() => ''));
            await job.page.screenshot({ path: path.join(DEBUG, 'live-no-input.png') }).catch(() => {});
            console.warn('[live] could not find the live chat box (saved data/debug/live-no-input.png)');
          }
          if (fails >= 3) break;
        }
      }
      first = false;
      await mute();
      await like(job.page).catch(() => {});
      // ~3 minutes, a bit random so it doesn't look like a timer
      const wait = everyMs + (Math.random() - 0.5) * 60_000;
      for (let t = 0; t < wait && !job.stop; t += 5000) await sleep(5000);
    }
  } catch (err) {
    console.warn('[live]', err.message.split('\n')[0]);
  } finally {
    if (job.page) await job.page.close().catch(() => {});
    running.delete(key);
    console.log(`[live] stopped supporting ${s.name}`);
  }
}

function stop(s) {
  const job = running.get(`${s.platform}:${s.user}`);
  if (job) job.stop = true;
}

module.exports = { start, stop, running };
