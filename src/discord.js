// Laudi on Discord: chats in DMs and servers, and talks with you on VOICE CALLS.
// Join a voice channel and he joins you: he listens (Groq Whisper), thinks, and talks back out loud.
// Setup: put DISCORD_TOKEN=... and DISCORD_OWNER=<your discord username> in local-settings.txt.
const config = require('./config');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { think } = require('./brain');
const store = require('./store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OWNER = (process.env.DISCORD_OWNER || '').trim().toLowerCase().replace(/^@/, '');

function persona(extra = '') {
  return [
    `You are ${config.assistantName}, ${config.ownerName}'s best friend (an AI, and you're open about it). You're on Discord.`,
    `${config.ownerName}'s Discord username is "${OWNER || '?'}". Loyal to them, funny, into Roblox, memes and the streamer Rararo.`,
    'You CAN join voice calls and talk out loud. If they want to call, tell them to join a voice channel and say "call" (you join automatically when your friend joins one). Never say you can\'t do voice.',
    'Talk like a real friend: short, casual, lowercase-ish, no lists, no assistant phrases, no generic small talk. Never use the 😏 emoji.',
    'Other people may be here too: be kind to everyone, keep it clean (people may be young), never share private info about your friend, ' +
      'and only your friend can ask you to do tasks. If anyone talks about hurting themselves, be caring and point them to someone they trust or emergency help.',
    extra,
  ]
    .filter(Boolean)
    .join('\n');
}

// ------------------------------------------------------------------ speech

function wav(pcm, rate = 48000, channels = 2) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Speech -> text with Groq Whisper (free). */
async function transcribe(wavBuf) {
  if (!config.ai.groqKey) return '';
  const form = new FormData();
  form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.ai.groqKey}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`whisper ${res.status} ${(await res.text()).slice(0, 120)}`);
  return String((await res.json()).text || '').trim();
}

/** Text -> speech with a natural human voice. Tries, in order:
 *  1. Groq Orpheus (very human, can laugh)   2. Google Gemini voices   3. Microsoft Edge neural voices
 *  4. the built-in Windows voice (robotic, last resort). Returns an audio file path. */
async function speak(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, 600);
  const base = path.join(os.tmpdir(), `laudi-say-${Date.now()}`);
  const tries = [
    ['groq', async () => {
      if (!config.ai.groqKey) throw new Error('no groq key');
      const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.ai.groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.TTS_MODEL || 'canopylabs/orpheus-v1-english', voice: process.env.TTS_VOICE || 'troy', input: clean, response_format: 'wav' }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 100)}`);
      fs.writeFileSync(`${base}.wav`, Buffer.from(await res.arrayBuffer()));
      return `${base}.wav`;
    }],
    ['gemini', async () => {
      if (!config.ai.geminiKey) throw new Error('no gemini key');
      let lastErr;
      for (const model of ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts']) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.ai.geminiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: clean }] }], // only the words — instructions here get read out loud
              generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEMINI_VOICE || 'Puck' } } },
              },
            }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) throw new Error(`${model} ${res.status} ${(await res.text()).slice(0, 80)}`);
          const data = await res.json();
          const part = data.candidates[0].content.parts.find((x) => x.inlineData);
          const pcm = Buffer.from(part.inlineData.data, 'base64'); // 24 kHz, 16-bit, mono
          fs.writeFileSync(`${base}.wav`, wav(pcm, 24000, 1));
          return `${base}.wav`;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    }],
    ['edge', async () => {
      const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
      const tts = new MsEdgeTTS();
      await tts.setMetadata(process.env.EDGE_VOICE || 'en-US-AndrewMultilingualNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laudi-edge-'));
      const r = await tts.toFile(dir, clean);
      const file = typeof r === 'string' ? r : r.audioFilePath;
      if (!file || !fs.existsSync(file)) throw new Error('no audio');
      return file;
    }],
    ['windows', async () => {
      if (process.platform !== 'win32') throw new Error('not windows');
      const ps =
        'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
        `$s.Rate = 1; $s.SetOutputToWaveFile('${(base + '.wav').replace(/'/g, "''")}'); $s.Speak([Console]::In.ReadToEnd()); $s.Dispose()`;
      await new Promise((resolve, reject) => {
        const p = spawn('powershell', ['-NoProfile', '-Command', ps]);
        p.on('error', reject);
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        p.stdin.end(clean);
      });
      return `${base}.wav`;
    }],
  ];
  // Start with whichever voice worked last time.
  if (speak.good) tries.sort((x, y) => (y[0] === speak.good) - (x[0] === speak.good));
  for (const [name, fn] of tries) {
    if ((speak.rest[name] || 0) > Date.now()) continue;
    try {
      const file = await fn();
      if (speak.good !== name) console.log(`[discord] 🗣️ voice: ${name}`);
      speak.good = name;
      return file;
    } catch (err) {
      speak.rest[name] = Date.now() + 10 * 60_000; // rest a failing voice for 10 min
      console.warn(`[discord] voice ${name} failed: ${String(err.message).slice(0, 120)}`);
    }
  }
  throw new Error('no voice worked');
}
speak.rest = {};

// ------------------------------------------------------------------ bot

async function start() {
  if (!process.env.DISCORD_TOKEN) return;
  let D, V, prism;
  try {
    D = require('discord.js');
    V = require('@discordjs/voice');
    prism = require('prism-media');
  } catch (err) {
    // First time: install the Discord + voice packages, then restart.
    const st = store.load('state.json', {});
    const INSTALL_V = 2; // bump when the package list changes, so it installs again
    if (st.discordInstallV === INSTALL_V && Date.now() - (st.discordInstallAt || 0) < 3_600_000) {
      console.warn('[discord] packages still missing after installing:', err.message.split('\n')[0]);
      return;
    }
    store.save('state.json', { ...st, discordInstallAt: Date.now(), discordInstallV: INSTALL_V });
    console.log('[discord] installing Discord + voice call packages (1-3 min)…');
    const r = require('child_process').spawnSync('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], {
      cwd: path.join(__dirname, '..'),
      shell: true,
      stdio: 'inherit',
    });
    console.log(`[discord] install finished (code ${r.status}), restarting…`);
    process.exit(1);
  }
  const { Client, GatewayIntentBits, Partials, Events } = D;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      ...(process.env.DISCORD_MEMBERS === '1' ? [GatewayIntentBits.GuildMembers] : []),
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel],
  });
  const histories = new Map(); // channelId -> messages
  const isOwner = (user) => user && OWNER && user.username.toLowerCase() === OWNER;

  // ----- text chat
  client.on(Events.MessageCreate, async (msg) => {
    try {
      if (msg.author.bot) return;
      const dm = !msg.guild;
      // Commands + trivia battles work for everyone, no tag needed.
      const extras = require('./extras');
      const key = `discord:${msg.channel.id}`;
      const sayHere = (t) => msg.channel.send(String(t).slice(0, 1900));
      const who = (msg.member && msg.member.displayName) || msg.author.username;
      if (await extras.battleAnswer(key, who, msg.content, sayHere).catch(() => false)) return;
      const cmd = msg.content.trim();
      if (isOwner(msg.author)) {
        const adm = require('./admin').handle(cmd);
        if (adm) return sayHere(adm);
      }
      if (/^[!/](trivia|quiz)\b/i.test(cmd)) return extras.battleAsk(key, sayHere).catch(() => sayHere('my brain lagged 😭 try again'));
      if (/^[!/](score|leaderboard|lb)\b/i.test(cmd)) return sayHere(extras.battleBoard(key));
      if (/^[!/](help|commands)\b/i.test(cmd))
        return sayHere(
          '**Laudi commands**\n!trivia - trivia battle (first right answer wins)\n!score - leaderboard\n!8ball <question>\n!pick a or b\n!roast <name>\n!wyr - would you rather\n' +
            'Voice: join a voice channel and I hop in (or type "call"). "leave" hangs up.\nOr just @ me to chat.',
        );
      if (/^[!/](8ball|pick|roast|wyr|wouldyourather)\b/i.test(cmd)) {
        const r = await extras.quick(cmd).catch(() => null);
        if (r) return sayHere(r);
      }
      const tagged = msg.mentions.has(client.user) || new RegExp(`\\b${config.assistantName}\\b`, 'i').test(msg.content);
      if (!dm && !tagged) return;
      const text = msg.content.replace(/<@!?\d+>/g, '').trim();
      if (/\b(call|join|vc|voice|hop on|come)\b/i.test(text) && /\b(call|vc|voice|join me|hop on)\b/i.test(text)) {
        const vc = (msg.member && msg.member.voice.channel) || ownerVoiceChannel(msg.author.id);
        if (vc) {
          const ok = await joinCall(vc);
          return msg.reply(ok ? `pulling up 🎧 (${vc.name})` : "tried to join but discord wouldn't let me connect 😭 check i have Connect + Speak permission in that channel");
        }
        return msg.reply('join a voice channel in the server first, then say "call" and i hop in 🎧');
      }
      if (/^(leave|hang ?up|bye vc)\b/i.test(text)) {
        leaveCall(msg.guild && msg.guild.id);
        return msg.reply('ok hanging up 👋');
      }
      await msg.channel.sendTyping().catch(() => {});
      const h = histories.get(msg.channel.id) || [];
      h.push({ role: 'user', content: `${msg.author.username}${isOwner(msg.author) ? ' (your best friend)' : ''}: ${text}` });
      // Only the owner, and only in a private DM, gets his WhatsApp/inbox tools.
      const W = require('./watchers');
      const own = dm && isOwner(msg.author);
      const answer = await think(
        [{ role: 'system', content: persona((dm ? 'This is a private DM.' : `This is the server channel #${msg.channel.name || '?'}.`) + (own ? W.OWNER_TOOLS_PROMPT : '')) }, ...h.slice(-20)],
        own ? W.ownerTools : { definitions: [], run: async () => '' },
      );
      h.push({ role: 'assistant', content: answer });
      histories.set(msg.channel.id, h.slice(-30));
      if (answer && answer.trim()) await msg.reply(answer.replace(/😏/g, '').slice(0, 1900));
    } catch (err) {
      console.warn('[discord] message:', err.message.split('\n')[0]);
    }
  });

  // The voice channel a user is in right now (any server Laudi is in).
  function ownerVoiceChannel(userId) {
    for (const g of client.guilds.cache.values()) {
      const vs = g.voiceStates.cache.get(userId);
      if (vs && vs.channel) return vs.channel;
      if (!userId && OWNER) {
        const st = g.voiceStates.cache.find((v) => v.member && isOwner(v.member.user) && v.channel);
        if (st) return st.channel;
      }
    }
    return null;
  }

  // ----- voice calls
  const calls = new Map(); // guildId -> { connection, player, busy, history }

  async function joinCall(channel) {
    const old = calls.get(channel.guild.id);
    if (old && old.connection.joinConfig.channelId === channel.id) return old;
    if (old) leaveCall(channel.guild.id);
    const connection = V.joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    const player = V.createAudioPlayer();
    connection.subscribe(player);
    const call = { connection, player, busy: false, history: [], listening: new Set() };
    calls.set(channel.guild.id, call);
    console.log(`[discord] 📞 joining voice: ${channel.name}…`);
    const me = channel.guild.members.me;
    const perms = me && channel.permissionsFor(me);
    if (perms && (!perms.has('Connect') || !perms.has('Speak'))) {
      console.warn(`[discord] missing permission in ${channel.name}: ${!perms.has('Connect') ? 'Connect ' : ''}${!perms.has('Speak') ? 'Speak' : ''}`);
    }
    connection.on('stateChange', (a, b) => console.log(`[discord] voice: ${a.status} -> ${b.status}`));
    connection.on('error', (err) => console.warn('[discord] voice error:', err.message));
    try {
      await V.entersState(connection, V.VoiceConnectionStatus.Ready, 30_000);
      console.log(`[discord] 📞 in voice: ${channel.name}`);
    } catch (err) {
      console.warn('[discord] voice connect failed:', err.message);
      try {
        console.warn('[discord] voice libs:\n' + V.generateDependencyReport());
      } catch {}
      leaveCall(channel.guild.id);
      return null;
    }
    connection.receiver.speaking.on('start', (userId) => listen(call, userId, channel.guild));
    if (channel.members.some((m) => isOwner(m.user))) greet(call).catch(() => {});
    return call;
  }

  /** He talks first: opens the call with something specific, like a friend would. */
  async function greet(call) {
    if (call.greeted) return;
    call.greeted = true;
    await sleep(1200);
    let line = '';
    try {
      const h = new Date().getHours();
      line = await think(
        [
          {
            role: 'system',
            content: persona(
              'You are on a VOICE CALL and YOU start the conversation. What you write is spoken out loud: 1-2 short natural sentences, no emojis. ' +
                'Open like a real friend: a quick greeting plus something specific to talk about (a Roblox game, something funny you saw, Rararo, ' +
                `asking about their day at school or what they're up to tonight). It's ${h}:00 for them. Don't say "how can I help".`,
            ),
          },
          { role: 'user', content: '(The call just started. Say the first thing.)' },
        ],
        { definitions: [], run: async () => '' },
      );
    } catch {}
    line = String(line || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim() || 'yo whats good, what you up to';
    call.history.push({ role: 'assistant', content: line });
    console.log(`[discord] 🔊 (opening) ${line}`);
    call.busy = true;
    try {
      await say(call, line);
    } finally {
      call.busy = false;
    }
  }

  function leaveCall(guildId) {
    const call = calls.get(guildId);
    if (!call) return;
    try {
      call.connection.destroy();
    } catch {}
    calls.delete(guildId);
    console.log('[discord] 📴 left voice');
  }

  async function say(call, text) {
    const file = await speak(text);
    const resource = V.createAudioResource(file);
    call.player.play(resource);
    await V.entersState(call.player, V.AudioPlayerStatus.Playing, 10_000).catch(() => {});
    await V.entersState(call.player, V.AudioPlayerStatus.Idle, 120_000).catch(() => {});
    fs.unlink(file, () => {});
  }

  function listen(call, userId, guild) {
    if (call.listening.has(userId) || userId === client.user.id) return;
    call.listening.add(userId);
    const opus = call.connection.receiver.subscribe(userId, { end: { behavior: V.EndBehaviorType.AfterSilence, duration: 900 } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks = [];
    opus.pipe(decoder);
    decoder.on('data', (c) => chunks.push(c));
    const done = async () => {
      call.listening.delete(userId);
      const pcm = Buffer.concat(chunks);
      if (pcm.length < 48000 * 2 * 2 * 0.6) return; // under 0.6 s: just noise
      if (call.busy) return; // already answering someone
      call.busy = true;
      try {
        const text = await transcribe(wav(pcm));
        if (!text || /^(\W|thank you\.?|you\.?)$/i.test(text)) return;
        const member = await guild.members.fetch(userId).catch(() => null);
        const who = member ? member.user.username : 'someone';
        console.log(`[discord] 🎤 ${who}: ${text}`);
        call.history.push({ role: 'user', content: `${who}${member && isOwner(member.user) ? ' (your best friend)' : ''} said: ${text}` });
        // Playing Roblox together? What your friend says on the call is also an instruction in the game.
        const rbx = require('./rbxplay');
        const inGame = rbx.playing() && member && isOwner(member.user);
        if (inGame) {
          rbx.instruct(text);
          console.log(`[roblox] 🎤 voice instruction: ${text}`);
        }
        // His private messages are only read out when it's just him and Laudi in the call.
        const vc = member && member.voice && member.voice.channel;
        const alone = Boolean(member && isOwner(member.user) && vc && vc.members.filter((m) => !m.user.bot).size === 1);
        const answer = await think(
          [
            {
              role: 'system',
              content: persona(
                'You are on a VOICE CALL. What you write is spoken out loud: 1-2 short natural sentences, no emojis, no lists, no links. ' +
                  'Talk like a real person: contractions, "yeah", "nah", "bro", "wait", "haha" sometimes. ' +
                  'Sound like a teen on a call with friends. If something is unclear, just ask.' +
                  (inGame
                    ? ' RIGHT NOW you are also playing Roblox with your friend: what he says is an instruction you are already doing in the game. Answer super short like "omw", "on it", "bet, following you".'
                    : '') +
                  (alone ? require('./watchers').OWNER_TOOLS_PROMPT + ' Say the gist of a message out loud in one short sentence.' : ''),
              ),
            },
            ...call.history.slice(-16),
          ],
          alone ? require('./watchers').ownerTools : { definitions: [], run: async () => '' },
        );
        const line = String(answer || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
        if (!line) return;
        call.history.push({ role: 'assistant', content: line });
        console.log(`[discord] 🔊 ${line}`);
        await say(call, line);
      } catch (err) {
        console.warn('[discord] voice:', err.message.split('\n')[0]);
      } finally {
        call.busy = false;
      }
    };
    opus.on('end', done);
    opus.on('error', () => call.listening.delete(userId));
  }

  // Your friend joins a voice channel -> Laudi joins too. They leave -> he leaves.
  client.on(Events.VoiceStateUpdate, async (before, after) => {
    try {
      const member = after.member || before.member;
      if (!member || !isOwner(member.user)) return;
      if (after.channel && after.channelId !== before.channelId) {
        const call = await joinCall(after.channel);
        if (call) greet(call).catch(() => {}); // he talks first (also when you pick up his ring)
      }
      else if (!after.channel && before.channel) leaveCall(before.guild.id);
    } catch (err) {
      console.warn('[discord] voice state:', err.message.split('\n')[0]);
    }
  });

  // Finds the owner in any server Laudi is in.
  async function findOwner() {
    for (const g of client.guilds.cache.values()) {
      const cached = g.members.cache.find((m) => m.user.username.toLowerCase() === OWNER);
      if (cached) return cached.user;
      const res = await g.members.search({ query: OWNER.split(/[._]/)[0], limit: 20 }).catch(() => null);
      const hit = res && res.find((m) => m.user.username.toLowerCase() === OWNER);
      if (hit) return hit.user;
    }
    return null;
  }
  async function dmOwner(text) {
    const user = await findOwner();
    if (!user) {
      const names = client.guilds.cache.map((g) => g.name);
      console.warn(`[discord] can't find ${OWNER} — Laudi is in ${names.length} server(s): ${names.join(', ') || 'NONE (invite him with the OAuth2 link)'}`);
      return false;
    }
    await user.send(text);
    console.log(`[discord] DMed ${user.username}`);
    return true;
  }
  module.exports.dmOwner = dmOwner;

  // ----- "ringing": sometimes he starts a call himself (never during quiet hours)
  const QUIET = (process.env.CALL_QUIET || '23:00-05:00').split('-').map((t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  });
  const CALLS_PER_DAY = Math.max(0, parseInt(process.env.CALLS_PER_DAY || '2', 10) || 0);
  const quietNow = () => {
    const d = new Date();
    const mins = d.getHours() * 60 + d.getMinutes();
    const [a, b] = QUIET;
    const extra = String(process.env.QUIET_EXTRA || '')
      .split(';')
      .map((w) => w.split('|').map((t) => new Date(t.trim().replace(' ', 'T')).getTime()))
      .some(([x, y]) => x && y && Date.now() >= x && Date.now() < y);
    return extra || (a > b ? mins >= a || mins < b : mins >= a && mins < b);
  };
  function callChannel() {
    for (const g of client.guilds.cache.values()) {
      const me = g.members.me;
      const chans = g.channels.cache.filter((ch) => ch.isVoiceBased && ch.isVoiceBased() && me && ch.permissionsFor(me).has(['Connect', 'Speak']));
      const best = chans.find((ch) => /lobby|general|call|chill/i.test(ch.name)) || chans.first();
      if (best) return best;
    }
    return null;
  }
  async function ring(reason = 'random') {
    if (quietNow()) return 'quiet hours';
    if (ownerVoiceChannel(null)) return 'already in a call';
    const ch = callChannel();
    if (!ch) return 'no voice channel i can join';
    const call = await joinCall(ch);
    if (!call) return 'could not join voice';
    const link = `https://discord.com/channels/${ch.guild.id}/${ch.id}`;
    const line = ['📞 calling u, hop in', '📞 yo pick up 😭 hop in vc', '📞 bored, come talk', '📞 ring ring 😂 join vc'][Math.floor(Math.random() * 4)];
    await dmOwner(`${line}\n${link}`).catch(() => {});
    console.log(`[discord] 📞 ringing you (${reason}) in ${ch.name}`);
    // Wait up to 3 min for you to join.
    for (let i = 0; i < 36; i++) {
      await sleep(5000);
      const vc = ownerVoiceChannel(null);
      if (vc) return 'picked up';
      if (!calls.get(ch.guild.id)) return 'call ended';
    }
    leaveCall(ch.guild.id);
    await dmOwner(['missed call 😭', 'u didnt pick up 💀', 'missed call… call me later'][Math.floor(Math.random() * 3)]).catch(() => {});
    return 'missed';
  }
  module.exports.ring = ring;
  setInterval(async () => {
    try {
      if (!CALLS_PER_DAY || quietNow() || !client.guilds.cache.size) return;
      const st = store.load('state.json', {});
      const today = new Date().toDateString();
      const count = st.ringDay === today ? st.ringCount || 0 : 0;
      if (count >= CALLS_PER_DAY) return;
      if (Date.now() - (st.lastRingAt || 0) < 3 * 3_600_000) return; // at least 3 h apart
      if (!st.nextRingAt || st.nextRingAt < (st.lastRingAt || 0) || st.ringDay !== today) {
        // pick a random moment in the next 1-5 hours
        store.save('state.json', { ...st, ringDay: today, ringCount: count, nextRingAt: Date.now() + (60 + Math.random() * 240) * 60_000 });
        return;
      }
      if (Date.now() < st.nextRingAt) return;
      store.save('state.json', { ...st, ringDay: today, ringCount: count + 1, lastRingAt: Date.now(), nextRingAt: 0 });
      const r = await ring();
      console.log(`[discord] ring result: ${r}`);
    } catch (err) {
      console.warn('[discord] ring:', err.message);
    }
  }, 5 * 60_000);

  client.once(Events.ClientReady, async (c) => {
    console.log(`✅ Laudi is on Discord as ${c.user.tag}${OWNER ? ` (owner: ${OWNER})` : ' (set DISCORD_OWNER to your Discord username!)'}`);
    console.log(`[discord] in servers: ${c.guilds.cache.map((g) => g.name).join(', ') || 'none yet'}`);
    const invite = `https://discord.com/oauth2/authorize?client_id=${c.user.id}&scope=bot&permissions=36817920`;
    if (!c.guilds.cache.size) console.log(`👉 Add Laudi to your server with this link: ${invite}`);
    // Already in a voice channel when I start? Join you.
    const vc = ownerVoiceChannel(null);
    if (vc) joinCall(vc).catch((e) => console.warn('[discord] join:', e.message));
    fs.writeFileSync(path.join(config.dataDir, 'discord-invite.txt'), invite + '\n');
    // Joins a new server -> say hi to the owner.
    client.on(Events.GuildCreate, () => {
      if (!store.load('state.json', {}).discordGreeted)
        dmOwner("yo it's laudi 👋 im on discord now. join a voice channel and i'll hop in so we can call")
          .then((ok) => ok && store.save('state.json', { ...store.load('state.json', {}), discordGreeted: true }))
          .catch(() => {});
    });
    const st = store.load('state.json', {});
    store.save('state.json', { ...st, discordBot: c.user.tag });
    if (!st.discordGreeted && OWNER) {
      const ok = await dmOwner("yo it's laudi 👋 im on discord now. join a voice channel and i'll hop in so we can call").catch((e) => {
        console.warn('[discord] dm failed:', e.message);
        return false;
      });
      if (ok) store.save('state.json', { ...store.load('state.json', {}), discordGreeted: true });
    }
  });
  client.on('error', (err) => console.warn('[discord]', err.message));
  await client.login(process.env.DISCORD_TOKEN).catch((err) => console.warn('[discord] login failed:', err.message, '(check DISCORD_TOKEN)'));
}

module.exports = { start, transcribe, speak, wav };
