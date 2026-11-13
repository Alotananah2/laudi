// Talks to a free AI model through an OpenAI-compatible API (Groq, Gemini or local Ollama),
// with automatic fallback to the backup provider when the main one is busy.
const config = require('./config');

// Every free model we can fall back to. Each has its own daily limit, so when one runs out
// (429) we rest it for a while and use the next one instead of failing.
function providers() {
  const { ai } = config;
  const groq = (model) => ai.groqKey && { name: `groq/${model}`, base: 'https://api.groq.com/openai/v1', key: ai.groqKey, model };
  const gem = (model) => ai.geminiKey && { name: `gemini/${model}`, base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: ai.geminiKey, model };
  const extraGroq = (process.env.GROQ_BACKUP_MODELS || 'openai/gpt-oss-20b,qwen/qwen3.8-27b,allam-2-7b').split(',');
  const extraGem = (process.env.GEMINI_BACKUP_MODELS || 'gemini-flash-lite-latest,gemini-3.5-flash-lite,gemma-4-31b-it').split(',');
  const groqList = [ai.groqModel, ...extraGroq].map((m) => m.trim()).filter(Boolean).map(groq);
  const gemList = [ai.geminiModel, ...extraGem].map((m) => m.trim()).filter(Boolean).map(gem);
  const ollama = ai.provider === 'ollama' ? [{ name: 'ollama', base: 'http://localhost:11434/v1', key: 'ollama', model: ai.ollamaModel }] : [];
  const list = ai.provider === 'gemini' ? [...gemList, ...groqList] : [...ollama, ...groqList, ...gemList];
  const seen = new Set();
  return list.filter((p) => p && !seen.has(p.name) && seen.add(p.name));
}

const restUntil = {}; // provider name -> time it can be used again
function rest(p, err) {
  const msg = String(err.message || '');
  let ms = 60_000;
  const m = msg.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (m && (m[1] || m[2] || m[3])) ms = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 + 5000;
  else if (/per day|tokens per day|TPD|RPD|quota/i.test(msg)) ms = 60 * 60_000;
  if (err.status === 404 || err.status === 400) ms = 6 * 3600_000; // model not available / not supported
  restUntil[p.name] = Date.now() + Math.min(ms, 12 * 3600_000);
}

async function call(p, body) {
  const res = await fetch(`${p.base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, model: p.model }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`${p.name} ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** One chat completion, trying each configured provider in turn. */
async function complete(messages, tools) {
  const list = providers();
  if (!list.length) throw new Error('No AI provider configured: add GROQ_API_KEY or GEMINI_API_KEY to .env');
  let lastErr;
  const ready = list.filter((p) => !(restUntil[p.name] > Date.now()));
  for (const p of ready.length ? ready : list) {
    try {
      const body = { messages, temperature: 0.4, max_tokens: 700 };
      if (/gpt-oss/i.test(p.model)) body.reasoning_effort = 'low'; // much faster answers
      if (tools && tools.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }
      const data = await call(p, body);
      return data.choices[0].message;
    } catch (err) {
      lastErr = err;
      if (err.status === 429 || err.status === 404 || err.status === 400 || err.status === 413) rest(p, err);
      console.warn(`[brain] ${p.name} failed (${err.status || 'error'}), trying the next one`);
    }
  }
  throw lastErr;
}

/**
 * Runs the conversation, letting the model call tools until it gives a final answer.
 * `tools` is { definitions: [...], run: async (name, args) => string }.
 */
async function think(messages, tools, maxRounds = 6) {
  const convo = [...messages];
  for (let round = 0; round < maxRounds; round++) {
    const msg = await complete(convo, tools.definitions);
    const calls = msg.tool_calls || [];
    if (!calls.length) return (msg.content || '').trim();
    convo.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const c of calls) {
      let args = {};
      try {
        args = JSON.parse(c.function.arguments || '{}');
      } catch {
        args = {};
      }
      let result;
      try {
        result = await tools.run(c.function.name, args);
      } catch (err) {
        result = `Error: ${err.message}`;
      }
      convo.push({ role: 'tool', tool_call_id: c.id, content: String(result).slice(0, 6000) });
    }
  }
  return 'Sorry, that took too many steps. Can you ask in a simpler way?';
}

module.exports = { think, complete };
