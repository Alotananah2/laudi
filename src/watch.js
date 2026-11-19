// Lets the bot actually look at a TikTok before sending it:
// reads the caption, grabs a few frames, and asks a vision model what the video is about,
// whether it fits what was asked, and whether it's OK to send.
const config = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Picks a vision-capable model the key can actually use (models get retired, so ask the API).
const modelCache = {};
const badModels = new Set();
async function pickModel(base, key, wanted, prefer) {
  if (modelCache[base] !== undefined) return modelCache[base];
  let ids = [];
  try {
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) ids = ((await res.json()).data || []).map((m) => String(m.id).replace(/^models\//, ''));
  } catch {}
  let model = badModels.has(wanted) ? null : wanted;
  if (ids.length && (!model || !ids.includes(model))) {
    const ok = ids.filter((id) => prefer.test(id) && !badModels.has(id) && !/tts|audio|image-gen|embed|live|guard|whisper|preview-tts|native-audio/i.test(id));
    model = ok.sort().reverse()[0] || null;
  }
  modelCache[base] = model;
  if (model) console.log(`[watch] using vision model ${model}`);
  return model;
}

// All the vision models we can try, best first. Filled from the APIs' model lists.
let modelList = null;
const cooldown = {}; // model -> time it can be used again
let lastGood = null;
async function models() {
  if (modelList && modelList.length) return modelList;
  const list = [];
  if (config.ai.geminiKey) {
    const base = 'https://generativelanguage.googleapis.com/v1beta/openai';
    let ids = [];
    try {
      const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${config.ai.geminiKey}` }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) ids = ((await res.json()).data || []).map((m) => String(m.id).replace(/^models\//, ''));
    } catch {}
    const vision = (id) =>
      /^(gemini-[\d.]+-flash(-lite)?(-preview)?|gemini-flash(-lite)?-latest|gemma-[34]-[\w.-]+-it)$/.test(id) &&
      !/tts|image|live|audio|transcribe|robotics|embed|computer-use/i.test(id) &&
      !badModels.has(id);
    const rank = (id) => (/^gemma/.test(id) ? 2 : /lite/.test(id) ? 1 : 0) * 100 - (parseFloat((id.match(/[\d.]+/) || ['0'])[0]) || 0);
    const ok = ids.filter(vision).sort((x, y) => rank(x) - rank(y));
    const pick = ok.length ? ok : [config.visionGeminiModel, 'gemini-flash-latest', 'gemini-flash-lite-latest'];
    for (const m of pick) list.push({ base, key: config.ai.geminiKey, model: m, gemini: true });
  }
  if (config.ai.groqKey) {
    const base = 'https://api.groq.com/openai/v1';
    const m = await pickModel(base, config.ai.groqKey, config.visionGroqModel, /llama-4|scout|maverick|vision|vl\b|-vl-|gemma-3|qwen/i);
    if (m) list.push({ base, key: config.ai.groqKey, model: m });
  }
  console.log(`[watch] vision models: ${list.map((x) => x.model).join(', ') || 'none'}`);
  modelList = list;
  return list;
}

/** Ask a vision model about some images. Tries every model until one answers. Returns '' if none did. */
async function look(images, prompt, { timeout = 25_000, cheap = false } = {}) {
  const list = [...(await models())];
  // Use the light models first, keep the best ones for videos.
  if (cheap) list.sort((x, y) => (/lite|gemma/.test(y.model) ? 1 : 0) - (/lite|gemma/.test(x.model) ? 1 : 0));
  else if (lastGood) list.sort((x, y) => (y.model === lastGood) - (x.model === lastGood));
  for (const p of list) {
    if (badModels.has(p.model)) continue;
    if ((cooldown[p.model] || 0) > Date.now()) continue;
    try {
      const body = {
        model: p.model,
        temperature: 0.4,
        max_tokens: 400,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...images.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } })),
            ],
          },
        ],
      };
      if (p.gemini && /^gemini/.test(p.model)) body.reasoning_effort = 'low'; // thinking makes it slow
      const res = await fetch(`${p.base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
        if (res.status === 404 || (res.status === 400 && /model|image|vision|multimodal|content type/i.test(text))) {
          badModels.add(p.model);
          modelList = null;
        }
        throw new Error(`${res.status} ${text}`);
      }
      const data = await res.json();
      const out = (data.choices[0].message.content || '').trim();
      if (out) {
        if (lastGood !== p.model) console.log(`[watch] seeing with ${p.model}`);
        lastGood = p.model;
        return out;
      }
    } catch (err) {
      const m = err.message;
      // Out of free quota -> rest it 30 min; busy/slow -> rest it a few minutes.
      cooldown[p.model] = Date.now() + (/^429/.test(m) ? 30 : /^503|timeout|aborted/i.test(m) ? 4 : 1) * 60_000;
      console.warn(`[watch] ${p.model}: ${m.slice(0, 120)}`);
    }
  }
  return '';
}

/** Caption, author and a few frames of the video page open in `tab`. */
async function grab(tab) {
  const info = await tab
    .evaluate(() => {
      const q = (s) => {
        const e = document.querySelector(s);
        return e ? (e.innerText || '').trim() : '';
      };
      return {
        desc: q('[data-e2e="browse-video-desc"]') || q('[data-e2e="video-desc"]') || q('h1') || '',
        author: q('[data-e2e="browse-username"]') || q('[data-e2e="video-author-uniqueid"]') || '',
        music: q('[data-e2e="browse-music"]') || q('[data-e2e="video-music"]') || '',
      };
    })
    .catch(() => ({ desc: '', author: '', music: '' }));
  const frames = [];
  const video = tab.locator('video').first();
  for (let i = 0; i < 3; i++) {
    const shot = await (await video.count().catch(() => 0) ? video.screenshot({ type: 'jpeg', quality: 55, timeout: 8000 }) : tab.screenshot({ type: 'jpeg', quality: 50 }))
      .catch(() => null);
    if (shot) frames.push(shot.toString('base64'));
    if (i < 2) await sleep(1000);
  }
  return { ...info, frames };
}

/**
 * Opens `url` in `tab` and judges it. want: what the owner asked for ("" = funny stuff).
 * Returns { ok, about, reaction, reason }.
 */
async function judge(tab, url, want) {
  try {
    await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (err) {
    if (!/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_ABORTED/.test(err.message)) throw err;
    await sleep(4000); // TikTok sometimes refuses a quick visit; try once more, slower
    await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  await tab.waitForSelector('video', { timeout: 8000 }).catch(() => {});
  await sleep(1500);
  const { desc, author, music, frames } = await grab(tab);
  const goal = want || 'something funny, gaming or meme-y that a teen would laugh at';
  const prompt =
    `You are ${config.assistantName}, picking a TikTok to send your best friend. They want: "${goal}".\n` +
    `Video caption: "${desc.slice(0, 400)}"\nCreator: ${author || '?'}\nSound: ${music || '?'}\n` +
    'The images are frames from the video. Decide if it fits what they want and is OK to send. Be easygoing: ' +
    'if they did not ask for something specific, ANY funny, gaming, meme, skit or entertaining clip fits. Only say fits=false if it is clearly boring or off-topic (news, ads, tutorials about money, etc). ' +
    '(NOT ok: sexual, gory, hateful, drugs, scams, ads, sad/tragic news, or just a random unrelated video).\n' +
    'Reply ONLY with JSON: {"about":"what the video is, in under 15 words","fits":true/false,"safe":true/false,' +
    '"reaction":"what you would text with it: 2-8 words, casual lowercase, about THIS video, emoji ok"}';
  let raw = frames.length ? await look(frames, prompt) : '';
  if (!raw) {
    // No vision: judge from the caption only.
    const { complete } = require('./brain');
    raw = (await complete([{ role: 'user', content: prompt.replace('The images are frames from the video. ', '') }]).catch(() => ({}))).content || '';
  }
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const ok = Boolean(j.fits) && j.safe !== false;
    return { ok, about: String(j.about || desc || '').slice(0, 120), reaction: String(j.reaction || '').slice(0, 80), reason: ok ? '' : j.safe === false ? 'not ok to send' : 'not what you wanted' };
  } catch {
    return { ok: false, about: desc.slice(0, 120), reaction: '', reason: 'could not tell what it is' };
  }
}

module.exports = { judge, look, grab };
