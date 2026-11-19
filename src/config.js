// Loads settings from .env. Must be required before anything uses Date.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
// Extra settings (optional). Values in .env win.
require('dotenv').config({ path: path.join(__dirname, '..', 'local-settings.txt') });

// Use the owner's time zone for all the bot's clocks. Windows ignores TZ, so if the machine's
// clock is in a different zone, shift "now" so hours/days match the owner's local time.
{
  const want = process.env.TIMEZONE || 'Asia/Riyadh';
  process.env.TZ = want;
  const RealDate = Date;
  const wallAsUTC = (d, tz) => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(d);
      const get = (t) => +parts.find((p) => p.type === t).value;
      return RealDate.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    } catch {
      return null;
    }
  };
  const now = new RealDate();
  const wanted = wallAsUTC(now, want);
  const machine = now.getTime() - now.getTimezoneOffset() * 60_000;
  const fallback = (parseInt(process.env.TIMEZONE_OFFSET_MINUTES || '180', 10) + now.getTimezoneOffset()) * 60_000;
  const shift = Math.round(((wanted == null ? machine + fallback : wanted) - machine) / 60_000) * 60_000;
  if (Math.abs(shift) >= 60_000) {
    class ShiftedDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(RealDate.now() + shift);
        else super(...args);
      }
      static now() {
        return RealDate.now() + shift;
      }
    }
    global.Date = ShiftedDate;
  }
}

const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

const config = {
  ownerName: process.env.OWNER_NAME || 'Boss',
  ownerTiktok: (process.env.OWNER_TIKTOK || '').trim().replace(/^@/, ''),
  ownerTiktokName: (process.env.OWNER_TIKTOK_NAME || '').trim(),
  playPlaceId: (process.env.PLAY_PLACE_ID || '').trim(),
  playMinutes: Math.max(5, parseInt(process.env.PLAY_MINUTES || '60', 10) || 60),
  playStepMs: Math.max(300, parseInt(process.env.PLAY_STEP_MS || '1500', 10) || 1500),
  visionGeminiModel: process.env.VISION_GEMINI_MODEL || 'gemini-3.8-flash',
  visionGroqModel: process.env.VISION_GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
  browser: (process.env.BROWSER || 'msedge').toLowerCase(),
  checkSeconds: 1, // check for new messages every second
  streamers: '',
  liveCheckMinutes: Math.max(10, parseInt(process.env.LIVE_CHECK_MINUTES || '10', 10) || 10),
  videosMin: Math.max(0, parseInt(process.env.VIDEOS_MIN || '5', 10)),
  videosMax: Math.max(0, parseInt(process.env.VIDEOS_MAX || '8', 10)),
  videoSearches: (process.env.VIDEO_SEARCHES || 'funny videos, try not to laugh, funny gaming moments, memes, funny animals')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // Extra random "texting first" moments per day, on top of the burst at the start of each time window
  // Videos he makes and posts on his own TikTok per day (0 = off)
  postsPerDay: Math.min(10, Math.max(0, parseInt(process.env.POSTS_PER_DAY || '8', 10) || 0)),
  // Say hi when added to group chats and answer when tagged
  groups: bool(process.env.GROUPS, true),
  // Comment supportive messages in the streamer's live while they're live
  liveSupport: bool(process.env.LIVE_SUPPORT, true),
  repostsPerDay: Math.max(0, parseInt(process.env.REPOSTS_PER_DAY || '3', 10)),
  supportHours: Math.max(4, parseFloat(process.env.SUPPORT_CHECK_HOURS || '4')),
  streakTime: process.env.STREAK_TIME || '00:10',
  streakReminder: process.env.STREAK_REMINDER || '21:00',
  checkinsPerDay: Math.max(0, parseInt(process.env.CHECKINS_PER_DAY || '2', 10)),
  // When he's allowed to text you. The start of each window is when he texts you first.
  schoolDays: (process.env.SCHOOL_DAYS || 'sun,mon,tue,wed,thu').toLowerCase().split(',').map((d) => d.trim().slice(0, 3)),
  schoolDayTimes: process.env.SCHOOL_DAY_TIMES || '05:00-06:30,14:20-02:00',
  weekendTimes: process.env.WEEKEND_TIMES || '10:00-02:00',
  mode: 'bot',
  assistantName: process.env.ASSISTANT_NAME || 'Sam',
  personality: (process.env.PERSONALITY || 'friend').toLowerCase(),
  timezone: process.env.TZ,
  dataDir: path.join(__dirname, '..', 'data'),

  ai: {
    provider: (process.env.AI_PROVIDER || 'groq').toLowerCase(),
    groqKey: process.env.GROQ_API_KEY || '',
    groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    geminiKey: process.env.GEMINI_API_KEY || '',
    // gemini-2.5-flash was retired for new users -> use the always-current alias
    geminiModel: process.env.GEMINI_MODEL && !/^gemini-2\.5-flash$/.test(process.env.GEMINI_MODEL) ? process.env.GEMINI_MODEL : 'gemini-flash-latest',
    ollamaModel: process.env.OLLAMA_MODEL || 'qwen3:8b',
  },

  email: {
    address: process.env.EMAIL_ADDRESS || '',
    password: (process.env.EMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),
    imapHost: process.env.EMAIL_IMAP_HOST || 'imap.gmail.com',
    smtpHost: process.env.EMAIL_SMTP_HOST || 'smtp.gmail.com',
    notify: bool(process.env.EMAIL_NOTIFY, true),
    checkMinutes: Math.max(1, parseInt(process.env.EMAIL_CHECK_MINUTES || '5', 10) || 5),
  },

  briefTime: (process.env.BRIEF_TIME || '').trim(),
};

config.email.enabled = Boolean(config.email.address && config.email.password);

require('fs').mkdirSync(config.dataDir, { recursive: true });

// Copy everything printed in the black window into data/bot.log (so problems can be checked remotely).
{
  const fs = require('fs');
  const logFile = path.join(config.dataDir, 'bot.log');
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1_000_000) fs.renameSync(logFile, logFile + '.old');
  } catch {}
  const stamp = () => new Date().toLocaleTimeString('en-GB');
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      try {
        const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        fs.appendFileSync(logFile, `[${stamp()}] ${level === 'log' ? '' : level.toUpperCase() + ' '}${text}\n`);
      } catch {}
    };
  }
  console.log('---- bot starting ----');
}

module.exports = config;
