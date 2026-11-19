// The fun stuff: finding TikToks to send, checking if streamers are live,
// and planning random times in the day (videos, "texting you first").
const config = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// ------------------------------------------------------------------ videos

/** True when TikTok is showing a "drag the slider" / verify puzzle. */
async function captchaShown(tab) {
  return tab
    .evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      return (
        /drag the slider|fit the puzzle|verify to continue|select 2 objects/i.test(text) ||
        Boolean(document.querySelector('[id*="captcha" i], [class*="captcha" i]'))
      );
    })
    .catch(() => false);
}

/** Searches TikTok and returns video links (needs a logged-in browser tab). */
async function findVideos(tab, query) {
  await tab.goto(`https://www.tiktok.com/search/video?q=${encodeURIComponent(query)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await sleep(6000);
  if (await captchaShown(tab)) throw new Error('captcha');
  for (let i = 0; i < 3; i++) {
    await tab.mouse.wheel(0, 2500).catch(() => {});
    await sleep(1500);
  }
  return collectCards(tab);
}

/** Videos from the Explore page (works even when search shows a captcha). kind: 'gaming' | 'funny' */
async function exploreVideos(tab, kind = 'funny') {
  await tab.goto('https://www.tiktok.com/explore', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(6000);
  if (await captchaShown(tab)) throw new Error('captcha');
  const want = kind === 'gaming' ? /^(gaming|games?)$/i : /^(comedy|funny)$/i;
  const picked = await tab
    .evaluate((src) => {
      const re = new RegExp(src, 'i');
      const el = [...document.querySelectorAll('button, [role="tab"], span, div')]
        .filter((e) => e.offsetParent !== null && e.children.length <= 1)
        .find((e) => re.test((e.innerText || '').trim()));
      if (!el) return false;
      el.click();
      return true;
    }, want.source)
    .catch(() => false);
  if (picked) await sleep(5000);
  for (let i = 0; i < 2; i++) {
    await tab.mouse.wheel(0, 2500).catch(() => {});
    await sleep(1500);
  }
  return collectCards(tab);
}

/** Caption text seen next to each video link (url -> text), so the bot can pick relevant ones. */
const cardText = new Map();
async function collectCards(tab) {
  const cards = await tab.evaluate(() =>
    [...document.querySelectorAll('a[href*="/video/"]')].map((a) => {
      const box = a.closest('[data-e2e*="item"], [class*="Item" i], [class*="Card" i]') || a.parentElement || a;
      const alts = [...box.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ');
      return { url: a.href.split('?')[0], text: `${alts} ${(box.innerText || '').slice(0, 300)}`.trim() };
    }),
  );
  const out = [];
  for (const c of cards) {
    if (!/tiktok\.com\/@[^/]+\/video\/\d+/.test(c.url)) continue;
    if (c.text) cardText.set(c.url, ((cardText.get(c.url) || '') + ' ' + c.text).trim().slice(0, 500));
    if (!out.includes(c.url)) out.push(c.url);
  }
  if (cardText.size > 3000) cardText.clear();
  return out;
}

const CAPTIONS = {
  gaming: ['lmaooo gamers are something else 💀', 'bro this is so you 😭', 'gamer moment', 'nah why is this so real', 'LMAO look', 'this one got me 💀'],
  funny: ['lmaooo 😭', 'bro look at this', 'nah this killed me 💀', 'why did i laugh so hard at this', 'ok this is funny', '😭😭'],
};
const caption = (kind) => pick(CAPTIONS[kind] || CAPTIONS.funny);

// ------------------------------------------------------------------ live checks

/** STREAMERS="tiktok:rararo, twitch:someone" → [{ platform, user }] */
function streamers() {
  return []; // streamer/live support removed
  // eslint-disable-next-line no-unreachable
  return config.streamers
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const parts = s.split(':').map((x) => x.trim());
      const [platform, user, name] = parts.length === 1 ? ['tiktok', parts[0]] : parts;
      const handle = user.replace(/^@/, '');
      return { platform: platform.toLowerCase(), user: handle, name: name || handle };
    });
}

function liveUrl(s) {
  switch (s.platform) {
    case 'twitch':
      return `https://twitch.tv/${s.user}`;
    case 'youtube':
      return `https://www.youtube.com/@${s.user}/live`;
    case 'kick':
      return `https://kick.com/${s.user}`;
    default:
      return `https://www.tiktok.com/@${s.user}/live`;
  }
}

/** true = live, false = offline, null = couldn't tell. */
async function isLive(s, tab) {
  const get = async (url) => {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) });
    return res.ok ? res.text() : null;
  };
  try {
    if (s.platform === 'twitch') {
      const t = await get(`https://decapi.me/twitch/uptime/${s.user}`);
      return t == null ? null : !/offline|not found|error/i.test(t);
    }
    if (s.platform === 'youtube') {
      const t = await get(`https://www.youtube.com/@${s.user}/live`);
      return t == null ? null : t.includes('"isLiveNow":true');
    }
    if (s.platform === 'kick') {
      const t = await get(`https://kick.com/api/v2/channels/${s.user}`);
      if (t == null) return null;
      return Boolean(JSON.parse(t).livestream);
    }
    // TikTok: open their LIVE page in the background tab.
    await tab.goto(liveUrl(s), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await sleep(7000);
    return await tab.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      if (/live has ended|isn.t live|is not live|not live right now|currently offline|live ended|no live/i.test(text)) return false;
      const html = document.documentElement.innerHTML;
      if (/"liveRoom"[^]{0,400}"status":\s*2\b/.test(html)) return true;
      if (/"liveRoom"[^]{0,400}"status":\s*4\b/.test(html)) return false;
      const v = document.querySelector('video');
      return v ? true : null;
    });
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ watching, liking, reposting

/** Newest video links on a profile (pinned ones may come first). */
async function profileVideos(tab, user, n = 6) {
  await tab.goto(`https://www.tiktok.com/@${user}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(6000);
  if (await captchaShown(tab)) throw new Error('captcha');
  const links = await tab.evaluate(() =>
    [...document.querySelectorAll('a[href*="/video/"]')].map((a) => a.href.split('?')[0]),
  );
  return [...new Set(links)].filter((l) => /tiktok\.com\/@[^/]+\/video\/\d+/.test(l)).slice(0, n);
}

/** Clicks the first visible element matching any selector, or any button whose label/text matches `text`. */
async function clickAny(tab, selectors, text) {
  for (const sel of selectors) {
    const el = tab.locator(sel).first();
    if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) {
      await el.click({ timeout: 5000 });
      return true;
    }
  }
  if (text) {
    const el = tab.getByRole('button', { name: text }).first();
    if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) {
      await el.click({ timeout: 5000 });
      return true;
    }
    const any = tab.getByText(text, { exact: true }).first();
    if ((await any.count().catch(() => 0)) && (await any.isVisible().catch(() => false))) {
      await any.click({ timeout: 5000 });
      return true;
    }
  }
  return false;
}

/**
 * Opens a video, watches it for a bit like a person, and optionally likes / reposts it.
 * Returns { watched, liked, reposted, desc }.
 */
async function engage(tab, url, { like = true, repost = false } = {}) {
  const out = { watched: false, liked: false, reposted: false, desc: '' };
  await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(rand(9000, 22000)); // watch it
  out.watched = true;
  out.desc = await tab
    .evaluate(() => {
      const el = document.querySelector('[data-e2e="browse-video-desc"], [data-e2e="video-desc"], h1');
      return el ? el.innerText.trim().slice(0, 300) : '';
    })
    .catch(() => '');

  if (like) {
    // Don't un-like something that's already liked.
    const already = await tab
      .evaluate(() => {
        const b = document.querySelector('[data-e2e="browse-like-icon"], [data-e2e="like-icon"]');
        const btn = b && (b.closest('button') || b);
        return Boolean(btn && (btn.getAttribute('aria-pressed') === 'true' || /unlike/i.test(btn.getAttribute('aria-label') || '')));
      })
      .catch(() => false);
    out.liked = already || (await clickAny(tab, ['[data-e2e="browse-like-icon"]', '[data-e2e="like-icon"]', 'button[aria-label*="Like" i]'], null).catch(() => false));
    await sleep(rand(1500, 4000));
  }

  if (repost) {
    let ok = await clickAny(tab, ['[data-e2e="video-share-repost"]', 'button[aria-label*="Repost" i]'], 'Repost').catch(() => false);
    if (!ok) {
      // Repost often sits inside the Share menu.
      const opened = await clickAny(tab, ['[data-e2e="browse-share-icon"]', '[data-e2e="share-icon"]', 'button[aria-label*="Share" i]'], null).catch(() => false);
      if (opened) {
        await sleep(2000);
        ok = await clickAny(tab, ['[data-e2e="video-share-repost"]', '[data-e2e="share-repost"]'], 'Repost').catch(() => false);
        await tab.keyboard.press('Escape').catch(() => {});
      }
    }
    out.reposted = ok;
  }
  return out;
}


/**
 * Shares a video to a friend's DMs with TikTok's own Share → Send button, so it shows up
 * as a real video (not a link). `names` = how the friend appears (nickname / username).
 * Returns true if it was sent.
 */
async function shareToFriend(tab, url, names) {
  const fs = require('fs');
  const path = require('path');
  const DEBUG = path.join(config.dataDir, 'debug');
  const shot = async (name) => {
    fs.mkdirSync(DEBUG, { recursive: true });
    fs.writeFileSync(path.join(DEBUG, `share-${name}.html`), await tab.content().catch(() => ''));
    await tab.screenshot({ path: path.join(DEBUG, `share-${name}.png`) }).catch(() => {});
  };
  const fail = async (step) => {
    console.warn(`[share] stuck at: ${step}`);
    await shot('fail-' + step);
    await tab.keyboard.press('Escape').catch(() => {});
    return false;
  };
  const wanted = names.filter(Boolean).map((n) => n.toLowerCase().replace(/^@/, ''));
  // Finds the friend in whatever share/send panel is open and marks it.
  const markFriend = () =>
    tab.evaluate((wanted) => {
      document.querySelectorAll('[data-bot-friend]').forEach((e) => e.removeAttribute('data-bot-friend'));
      const visible = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const all = [...document.querySelectorAll('body *')].filter((e) => e.children.length <= 3 && visible(e));
      for (const e of all) {
        const norm = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        const t = norm((e.innerText || '').replace(/…|\.\.\.$/g, ''));
        if (!t || t.length > 40) continue;
        if (t && wanted.map(norm).filter(Boolean).some((n) => t === n || (t.length >= 6 && n.startsWith(t)) || t.startsWith(n))) {
          // skip the chat list / sidebar on the left of the page
          if (e.getBoundingClientRect().left < 260) continue;
          const target = e.closest('button, [role="button"], [role="option"], [role="checkbox"], li, label, [tabindex]') || e;
          target.setAttribute('data-bot-friend', '1');
          return true;
        }
      }
      return false;
    }, wanted);
  const clickText = (re) =>
    tab.evaluate((src) => {
      const r = new RegExp(src, 'i');
      const els = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], a, div, span, p')]
        .filter((e) => e.getBoundingClientRect().width > 0 && r.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
      els.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      const el = els[0];
      if (!el) return false;
      (el.closest('button, [role="button"], [role="menuitem"], a') || el).click();
      return true;
    }, re.source);

  if (tab.url().split('?')[0] !== url) {
    await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  await tab.waitForSelector('[data-e2e="share-icon"], [data-e2e="browse-share-icon"], [data-e2e="video-share-icon"]', { timeout: 10_000 }).catch(() => {});
  await sleep(800);
  if (await captchaShown(tab)) throw new Error('captcha');

  const opened = await clickAny(
    tab,
    ['[data-e2e="share-icon"]', '[data-e2e="browse-share-icon"]', '[data-e2e="video-share-icon"]', 'button[aria-label*="Share" i]'],
    null,
  ).catch(() => false);
  if (!opened) return fail('no-share-button');

  // The panel loads slowly; wait for the friend (TikTok tags each one as share-<username>).
  const tagSel = wanted
    .filter((n) => /^[a-z0-9._]+$/.test(n))
    .map((n) => `[data-e2e="share-${n}"] [tabindex="0"], [data-e2e="share-${n}"]`)
    .join(', ');
  let found = false;
  for (let i = 0; i < 20 && !found; i++) {
    await sleep(400);
    if (tagSel && (await tab.locator(tagSel).count().catch(() => 0))) {
      await tab.evaluate((sel) => {
        document.querySelectorAll('[data-bot-friend]').forEach((e) => e.removeAttribute('data-bot-friend'));
        document.querySelector(sel).setAttribute('data-bot-friend', '1');
      }, tagSel);
      found = true;
    } else {
      found = await markFriend();
    }
  }
  if (!found) {
    // Not in the top row (groups usually aren't): use the 🔍 in the "Share to" panel.
    const searched = await tab
      .evaluate(() => {
        const title = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /^share to$/i.test((e.innerText || '').trim()));
        if (!title) return false;
        let box = title.parentElement;
        for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
          const btn = [...box.querySelectorAll('button, [role="button"], svg')].find((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.left < title.getBoundingClientRect().left;
          });
          if (btn) {
            (btn.closest('button, [role="button"]') || btn).dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return true;
          }
        }
        return false;
      })
      .catch(() => false);
    if (searched) {
      await sleep(1200);
      const q = names.filter(Boolean)[0] || '';
      const input = tab.locator('input[type="text"], input[type="search"], input:not([type])').last();
      if (await input.count().catch(() => 0)) {
        await input.fill(q.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 3).join(' ')).catch(() => {});
        await sleep(2500);
        found = await markFriend();
        if (!found) {
          // Search doesn't find group chats: clear it and scroll the whole list instead.
          await input.fill('').catch(() => {});
          await sleep(2000);
          for (let k = 0; k < 8 && !found; k++) {
            found = await markFriend();
            if (found) break;
            await tab
              .evaluate(() => {
                const lists = [...document.querySelectorAll('[role="dialog"] *, [class*="Modal" i] *')].filter(
                  (e) => e.scrollHeight > e.clientHeight + 20 && getComputedStyle(e).overflowY !== 'visible',
                );
                lists.forEach((e) => (e.scrollTop += 400));
              })
              .catch(() => {});
            await sleep(900);
          }
        }
      }
    }
  }
  if (!found) {
    await shot('panel');
    if (await clickText(/^send to friends?$/)) {
      await sleep(3000);
      for (let i = 0; i < 8 && !found; i++) {
        found = await markFriend();
        if (!found) await sleep(1000);
      }
      if (!found) {
        // search box in the "send to" dialog
        const box = tab.locator('[role="dialog"] input, [class*="Modal" i] input, [class*="Share" i] input').first();
        if (await box.count().catch(() => 0)) {
          await box.fill(wanted.find((n) => /[a-z]/.test(n)) || wanted[0]).catch(() => {});
          await sleep(3000);
          found = await markFriend();
        }
      }
    }
  }
  if (!found) return fail('no-friend');
  await tab.locator('[data-bot-friend="1"]').first().click({ timeout: 5000 }).catch(() => {});
  await sleep(900);
  let sent = false;
  for (let i = 0; i < 5 && !sent; i++) {
    sent =
      (await clickAny(tab, ['[data-e2e="share-send-button"]', '[data-e2e="send-button"]', 'button[aria-label="Send" i]'], 'Send').catch(() => false)) ||
      (await clickText(/^(send|send separately)$/));
    if (!sent) {
      // Some versions send straight away when you tap the friend.
      const toast = await tab.evaluate(() => /\b(sent|shared)\b/i.test(document.body.innerText.slice(0, 20000))).catch(() => false);
      if (toast && i >= 1) break;
      await sleep(1000);
    }
  }
  if (!sent) {
    const toast = await tab.evaluate(() => /\bsent\b/i.test(document.body.innerText)).catch(() => false);
    if (!toast) return fail('no-send-button');
  }
  await sleep(1200);
  await tab.keyboard.press('Escape').catch(() => {});
  return true;
}

// ------------------------------------------------------------------ daily plan

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function at(day, hhmm) {
  const [h, m] = String(hhmm).split(':').map((x) => parseInt(x, 10) || 0);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Time windows for one calendar day, e.g. school day 05:00-06:30 and 14:20-02:00. */
function windowsFor(day) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  const school = config.schoolDays.includes(DAYS[d.getDay()]);
  const spec = school ? config.schoolDayTimes : config.weekendTimes;
  return spec
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.includes('-'))
    .map((r) => {
      const [a, b] = r.split('-');
      const start = at(d, a);
      const end = at(d, b);
      if (end <= start) end.setDate(end.getDate() + 1); // goes past midnight
      return { start: start.getTime(), end: end.getTime(), label: a.trim() };
    });
}

/** Which day's plan applies now (a window that started yesterday may still be running). */
function planDayFor(now = new Date()) {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const t = now.getTime();
  if (windowsFor(yesterday).some((w) => t >= w.start && t < w.end)) return yesterday;
  return now;
}

function isActive(now = new Date()) {
  const t = now.getTime();
  const day = planDayFor(now);
  return windowsFor(day).some((w) => t >= w.start && t < w.end);
}

/** Random times (ms) for the day: videos, a burst of texts at the start of each window, extra check-ins. */
function planDay(now = new Date()) {
  const day = planDayFor(now);
  const t = now.getTime();
  const windows = windowsFor(day)
    .map((w) => ({ ...w, from: Math.max(w.start, t + 2 * 60_000) }))
    .filter((w) => w.end - w.from > 10 * 60_000);
  const total = windows.reduce((sum, w) => sum + (w.end - w.from), 0);

  // A random moment inside the windows, weighted by how long each window is.
  const randomMoment = () => {
    let x = Math.random() * total;
    for (const w of windows) {
      const len = w.end - w.from;
      if (x < len) return Math.round(w.from + x);
      x -= len;
    }
    return null;
  };
  const many = (n) => (total > 0 ? Array.from({ length: n }, randomMoment).filter(Boolean).sort((a, b) => a - b) : []);

  // If the day is already partly over (bot started late), only plan the share for the time that's left.
  const fullTotal = windowsFor(day).reduce((sum, w) => sum + (w.end - w.start), 0) || 1;
  const left = Math.min(1, total / fullTotal);
  const videoCount = Math.round((Math.round(rand(config.videosMin, config.videosMax + 0.999) - 0.5)) * left);
  const extraTexts = Math.round(config.checkinsPerDay * left);
  const bursts = windows
    .filter((w) => w.start >= t - 60_000) // only windows that haven't started yet
    .map((w) => ({ at: w.start + Math.round(rand(0, 4) * 60_000), label: w.label }));

  const d = new Date(day);
  return {
    key: d.toDateString(),
    videos: many(videoCount),
    checkins: many(extraTexts),
    bursts,
    followups: [],
  };
}

module.exports = { cardText, shareToFriend, captchaShown, findVideos, exploreVideos, profileVideos, engage, caption, streamers, liveUrl, isLive, isActive, planDay, windowsFor, pick, rand, sleep };
