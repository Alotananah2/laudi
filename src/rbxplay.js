// Lets the bot play Roblox in the Roblox app (Windows): join you, look at the screen, move, chat.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ keyboard / window helper (PowerShell)

class Input {
  constructor() {
    this.proc = null;
    this.waiting = [];
    this.buf = '';
  }

  async start() {
    if (this.proc) return;
    const script = path.join(__dirname, '..', 'scripts', 'rbx-input.ps1');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stdout.on('data', (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        const w = this.waiting.shift();
        if (w) w(line);
      }
    });
    this.proc.stderr.on('data', (d) => console.warn('[roblox input]', d.toString().trim().slice(0, 200)));
    this.proc.on('exit', () => {
      this.proc = null;
      this.waiting.splice(0).forEach((w) => w('error helper stopped'));
    });
    const first = await new Promise((r) => this.waiting.push(r));
    if (first !== 'ready') throw new Error(`Roblox helper failed to start: ${first}`);
  }

  async cmd(line) {
    await this.start();
    const p = new Promise((r) => this.waiting.push(r));
    this.proc.stdin.write(line.replace(/\r?\n/g, ' ') + '\n');
    return p;
  }

  stop() {
    if (this.proc) this.proc.kill();
    this.proc = null;
  }
}

const input = new Input();

// ------------------------------------------------------------------ joining

/** Gets a one-time login ticket from the bot's logged-in roblox.com tab. */
async function authTicket(tab) {
  // Ask from outside the page, using the browser's own Roblox login (avoids CORS problems).
  try {
    const req = tab.context().request;
    const url = 'https://auth.roblox.com/v1/authentication-ticket';
    const headers = {
      'Content-Type': 'application/json',
      RBXAuthenticationNegotiation: '1',
      Referer: 'https://www.roblox.com/',
      Origin: 'https://www.roblox.com',
    };
    let r = await req.post(url, { headers, data: '{}' });
    const token = r.headers()['x-csrf-token'];
    if (r.status() === 403 && token) r = await req.post(url, { headers: { ...headers, 'x-csrf-token': token }, data: '{}' });
    const ticket = r.headers()['rbx-authentication-ticket'];
    if (ticket) return ticket;
    console.warn(`[roblox] ticket request: HTTP ${r.status()}`);
  } catch (err) {
    console.warn('[roblox] ticket request:', err.message.split('\n')[0]);
  }
  return tab.evaluate(async () => {
    const url = 'https://auth.roblox.com/v1/authentication-ticket';
    const opts = {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', RBXAuthenticationNegotiation: '1' },
    };
    let r = await fetch(url, opts);
    const token = r.headers.get('x-csrf-token');
    if (r.status === 403 && token) {
      opts.headers['x-csrf-token'] = token;
      r = await fetch(url, opts);
    }
    return r.headers.get('rbx-authentication-ticket');
  });
}

/** Opens the Roblox app as the bot, following `followUserId` into their server (or joining `placeId`). */
async function launch(tab, { followUserId, placeId }) {
  const ticket = await authTicket(tab);
  if (!ticket) throw new Error('could not get a Roblox login ticket (is the bot logged in on roblox.com?)');
  const tracker = String(Math.floor(Math.random() * 1e12));
  const attempt = crypto.randomUUID();
  const launcher = followUserId
    ? `https://www.roblox.com/Game/PlaceLauncher.ashx?request=RequestFollowUser&browserTrackerId=${tracker}&userId=${followUserId}&joinAttemptId=${attempt}&joinAttemptOrigin=followUser`
    : `https://www.roblox.com/Game/PlaceLauncher.ashx?request=RequestGame&browserTrackerId=${tracker}&placeId=${placeId}&isPlayTogetherGame=false&joinAttemptId=${attempt}&joinAttemptOrigin=PlayButton`;
  const uri =
    `roblox-player:1+launchmode:play+gameinfo:${ticket}+launchtime:${Date.now()}` +
    `+placelauncherurl:${encodeURIComponent(launcher)}+browsertrackerid:${tracker}` +
    '+robloxLocale:en_us+gameLocale:en_us+channel:+LaunchExp:InApp';
  const r = await input.cmd(`open ${uri}`);
  if (r !== 'ok') throw new Error(`could not open Roblox: ${r}`);
}

async function robloxRunning() {
  const r = await input.cmd('running');
  return r.startsWith('yes') ? parseInt(r.split(' ')[1], 10) : null;
}

// ------------------------------------------------------------------ seeing + deciding

const KEYS = new Set(['w', 'a', 's', 'd', 'space', 'left', 'right', 'c', 'e', 'f', 'q', 'r', 'shift', '1', '2', '3']);

// What Laudi knows about playing Roblox (his "training").
const TRAINING = [
  'HOW ROBLOX WORKS (your training):',
  '- Every player has a name tag floating above their head. The player list (leaderboard) is at the top-right.',
  '- w = walk forward, s = back, a/d = sidestep, space = jump. left/right arrows turn the camera (and so the direction w walks).',
  '- To FOLLOW someone: turn the camera (left/right) until their name tag/character is in the MIDDLE of the screen, then hold w toward them; ' +
    'if they are far, hold w longer (2-3 s). If they are not visible, turn ~90 degrees (left 700ms) and look again. Jump over things in the way.',
  '- To walk somewhere, put it in the middle of the screen first, then hold w. Hold w together with space to jump while running (obbies, gaps, stairs).',
  '- Game action keys: e, f, c, q, r, shift, 1, 2, 3. On-screen prompts tell you which (e.g. "[E] Open", "C Passenger") - press that key.',
  '- Buttons, menus, popups, "Play", "Spawn", "Skip", "Close (X)", "OK", teleports, map/location buttons: CLICK them.',
  '- Loading screens: wait or click Skip/Play. If a big menu covers the screen, close it with X unless the friend asked for it.',
  '- If the last moves did nothing (same view as before), try something different: turn, jump, walk another way, click something else.',
  '- NEVER: Buy, purchase, Robux, gamepass prompts, Leave, Report, Block, Settings/Reset.',
  '- ALWAYS move every turn. Standing still is boring. Be active like a real player.',
  '- FOLLOWING STEP BY STEP: 1) Is the friend visible? If their character is left of center, tap "left" (150-400 ms); right of center, tap "right". ' +
    '2) When they are roughly centered, hold w (longer the farther/smaller they look: small = 2500 ms, medium = 1200 ms, close = 400 ms). ' +
    '3) If they were visible last turn but not now, turn back the way they went. 4) Not visible at all: turn left 900 ms, look again (do a full circle in 4 turns), then walk forward 2 s and repeat.',
  '- The friend is close when their character takes up a big part of the screen. Then STOP walking: no more w. Just keep them centered with small left/right taps (100-200 ms), maybe a jump. Only walk again when they move away (they get smaller).',
  '- If you walked forward last turn and the view did not change (stuck on a wall/pillar), do NOT press w again: step a or d for 600 ms, turn, then go around.',
  '- Your friend is a boy: say "he/him".',
  '- "Followed user has left the experience" or "Disconnected" means you must rejoin: just say so in "see".',
  '- Do not repeat the exact same click if nothing changed last turn; try a nearby spot or a different approach.',
].join('\n');

async function decide(imageB64, goal, friendName, memory = []) {
  const text =
    `You are ${config.assistantName}, playing Roblox with your best friend ${config.ownerName} ` +
    `(Roblox username: ${friendName || 'unknown'}, display name ${config.ownerName}). This is your screen right now.\n` +
    `${TRAINING}\n\nGOAL NOW: ${goal}\n` +
    (memory.length ? `What you did the last few turns:\n- ${memory.join('\n- ')}\n` : '') +
    'To CLICK, use {"click":[x,y]} where x and y go from 0 to 1000 across the screenshot (0,0 = top-left, 500,500 = center).\n' +
    'To hold keys together use {"keys":["w","space"],"ms":900}.\n' +
    'Reply with ONLY JSON like {"see":"what is on screen (short)","thought":"what you will do","done":false,"routine_screen":0,"in_world":false,"seated":false,' +
    '"moves":[{"key":"left","ms":400},{"keys":["w","space"],"ms":1500},{"click":[500,620]}],"chat":""}. ' +
    'Use 3-6 moves, each 100-3000 ms. "chat" = optional very short in-game chat message (usually empty).';
  try {
    const raw = await require('./watch').look([imageB64], text, { timeout: 20_000, cheap: true });
    if (raw) {
      let json;
      try {
        json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      } catch {
        // cut-off answer: keep what we can read
        const grab = (k) => (raw.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)`)) || [])[1] || '';
        const moves = [...raw.matchAll(/\{\s*"(?:key|keys|click)"[^{}]*\}/g)].map((m) => {
          try { return JSON.parse(m[0]); } catch { return null; }
        }).filter(Boolean);
        json = { see: grab('see'), thought: grab('thought'), moves };
      }
      const ms = (v) => Math.min(Math.max(parseInt(v, 10) || 400, 80), 3000);
      return {
        see: String(json.see || ''),
        thought: String(json.thought || ''),
        done: Boolean(json.done),
        routineScreen: parseInt(json.routine_screen, 10) || 0,
        inWorld: Boolean(json.in_world),
        seated: json.seated === undefined ? undefined : Boolean(json.seated),
        chat: String(json.chat || '').slice(0, 80),
        moves: (Array.isArray(json.moves) ? json.moves : [])
          .map((m) => {
            if (Array.isArray(m.click) && m.click.length === 2) return { click: m.click.map((v) => Math.min(1000, Math.max(0, parseInt(v, 10) || 0))) };
            if (Array.isArray(m.keys)) {
              const keys = m.keys.map((k) => String(k).toLowerCase()).filter((k) => KEYS.has(k)).slice(0, 3);
              return keys.length ? { keys, ms: ms(m.ms) } : null;
            }
            if (KEYS.has(String(m.key).toLowerCase())) return { keys: [String(m.key).toLowerCase()], ms: ms(m.ms) };
            return null;
          })
          .filter(Boolean)
          .slice(0, 6),
      };
    }
  } catch (err) {
    console.warn('[roblox vision]', err.message.split('\n')[0]);
  }
  // Can't see right now: keep moving like a player instead of standing still.
  const pick = (l) => l[Math.floor(Math.random() * l.length)];
  return {
    thought: "can't see (vision busy) - running around",
    chat: '',
    moves: [
      { keys: [pick(['left', 'right'])], ms: pick([250, 500, 800]) },
      { keys: ['w'], ms: pick([1200, 1800, 2400]) },
      { keys: ['w', 'space'], ms: 700 },
      { keys: [pick(['a', 'd', 'w'])], ms: 800 },
    ],
  };
}

// ------------------------------------------------------------------ the play session

let session = null;

async function press(key, ms) {
  await input.cmd(`down ${key}`);
  await sleep(ms);
  await input.cmd(`up ${key}`);
}

async function hold(keys, ms) {
  for (const k of keys) await input.cmd(`down ${k}`);
  await sleep(ms);
  for (const k of [...keys].reverse()) await input.cmd(`up ${k}`);
}

async function sayInGame(text) {
  await input.cmd('focus');
  await press('slash', 60);
  await sleep(400);
  await input.cmd(`text ${text}`);
  await sleep(150);
  await press('enter', 60);
}

/** Look → decide → move, until stopped, Roblox closes, or PLAY_MINUTES is up. */
async function playLoop(followUserId, friendName, hooks) {
  const shot = path.join(config.dataDir, 'debug', 'roblox-view.jpg'); // also lets you see what he sees
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  const goal = friendName
    ? `ALWAYS follow ${friendName} (${config.ownerName}). Find their name tag "${friendName}" above their character, turn toward them and run to them, stay right next to them, copy what they do.` +
      (session.look ? ` Their avatar: ${session.look}.` : '')
    : 'Explore and have fun, keep moving.';
  let said = false;
  const memory = [];
  const me = session; // this loop belongs to this session only
  require('./clips').start(); // rolling recording for clips
  while (session === me && !me.stop) {
    try {
      if (!(await robloxRunning())) {
        if (session === me && !me.stop) hooks.say('roblox closed on me 😭 send /play to get me back');
        break;
      }
      if (Date.now() - me.startedAt > config.playMinutes * 60_000) {
        hooks.say(`ok i played for ${config.playMinutes} min, im getting off 👋`);
        await input.cmd(`kill ${me.pid}`);
        break;
      }
      const front = await input.cmd('focus');
      if (front !== 'ok' && Date.now() - (me.focusWarn || 0) > 30_000) {
        me.focusWarn = Date.now();
        hooks.log(`[roblox] ⚠️ couldn't bring Roblox to the front (${front}) - keys won't reach it`);
      }
      await sleep(250);
      const shotRes = await input.cmd(`shot ${shot}`);
      if (shotRes !== 'ok') {
        hooks.log(`[roblox] couldn't see the screen (${shotRes})`);
        await sleep(3000);
        continue;
      }
      const b64 = fs.readFileSync(shot).toString('base64');
      const order = me.order && Date.now() - me.order.at < 10 * 60_000 ? me.order : null;
      const fullGoal = order
        ? `Your friend just told you to do this in the game: "${order.text}". Do it now: figure out from the screen what to click or where to walk. ` +
          'When it is clearly done, set "done":true. (If it is impossible or would spend Robux, set "done":true and explain in "thought".)'
        : goal;
      const tips = (me.tips || []).slice(-6);
      // Game knowledge: a routine from Murdhi, or the guide he wrote after studying the game.
      let gameGoal = '';
      const R = me.routine;
      if (R && !order) {
        if (me.step < R.steps.length) {
          gameGoal =
            `\nGAME START ROUTINE for ${me.game} (your friend taught you this). The steps are:\n` +
            R.steps.map((x, i) => `${i + 1}. ${x}${i < me.step ? ' (done)' : i === me.step ? '  <- you are here' : ''}`).join('\n') +
            '\nSet "routine_screen" to the NUMBER of the step whose button is visible on screen RIGHT NOW (0 if none of them). ' +
            'If it is visible, click that button. If a different screen is in the way (loading, "choose your device" -> pick Computer/Laptop, ' +
            'tutorial -> Skip, popups -> close/OK), handle it and set routine_screen 0. Set "in_world":true only if you are standing in the 3D game world with no menu.' +
            (R.extra ? `\n${R.extra}` : '');
        } else if (me.seated) gameGoal = `\n${R.seated}`;
        else gameGoal = `\n${R.then}`;
      }
      if (me.guide) gameGoal += `\nWHAT YOU KNOW ABOUT THIS GAME (${me.game}):\n${me.guide}`;
      const d = await decide(
        b64,
        (R && !order && me.step < R.steps.length ? 'Do the game start routine below first.' : fullGoal) +
          gameGoal +
          (tips.length ? `\nThings your friend taught you for this game (follow them): ${tips.join(' | ')}` : ''),
        friendName,
        memory,
      );
      if (R && !order && me.step < R.steps.length) {
        const rs = d.routineScreen;
        const clicked = d.moves.some((m) => m.click);
        if (rs > me.step + 1 && rs <= R.steps.length) {
          // a later step's button is already showing: the earlier ones are done
          hooks.log(`[roblox] routine: skipped to step ${rs}`);
          me.step = rs - 1;
          me.stepClicked = clicked;
        } else if (rs === me.step + 1) {
          if (clicked) me.stepClicked = true; // clicked it now; confirm next turn that it's gone
        } else if (me.stepClicked) {
          hooks.log(`[roblox] routine step ${me.step + 1} done: ${R.steps[me.step]}`);
          me.step++;
          me.stepClicked = false;
          memory.length = 0;
        }
        if (d.inWorld && me.step > 0) {
          if (me.step < R.steps.length) hooks.log('[roblox] in the game world - routine finished');
          me.step = R.steps.length;
        }
      }
      if (R && me.step >= R.steps.length && d.seated !== undefined && d.seated !== me.seated) {
        me.seated = d.seated;
        hooks.log(`[roblox] ${me.seated ? 'seated as passenger ✈️' : 'not seated anymore, following again'}`);
        if (me.seated) hooks.say('im in ur plane as passenger ✈️');
      }
      memory.push(`${d.see ? 'saw: ' + d.see + '; ' : ''}did: ${d.thought || '?'} (${d.moves.map((m) => (m.click ? 'click ' + m.click.join(',') : m.keys.join('+'))).join(', ')})`);
      if (memory.length > 4) memory.shift();
      if (order && d.done && me.order === order) {
        me.order = null;
        hooks.say(d.thought ? `done ✅ ${d.thought}`.slice(0, 120) : 'done ✅');
      }
      if (d.thought) hooks.log(`[roblox] ${d.see ? '👀 ' + d.see + ' → ' : ''}${d.thought}`);
      // Disconnected / kicked: don't keep clicking, rejoin the friend properly.
      if (/disconnect|error code|kicked|lost connection|reconnect|left the experience|has left/i.test(`${d.see} ${d.thought}`)) {
        me.discos = (me.discos || 0) + 1;
        if (me.discos >= 2 && hooks.rejoin && session === me) {
          hooks.log('[roblox] disconnected / friend left - closing and rejoining');
          await input.cmd(`kill ${me.pid}`).catch(() => {});
          session = null;
          await sleep(3000);
          hooks.rejoin();
          return;
        }
      } else me.discos = 0;
      if (session !== me || me.stop) break;
      await input.cmd('focus');
      for (const m of d.moves) {
        if (m.click) {
          hooks.log(`[roblox] click ${m.click[0]},${m.click[1]}`);
          await input.cmd(`click ${m.click[0]} ${m.click[1]}`);
          await sleep(400);
        } else await hold(m.keys, m.ms);
      }
      if (!said) {
        said = true;
        hooks.say('im in 😎');
        await sayInGame(`yo ${friendName || ''} im here`.trim());
      } else if (d.chat) {
        await sayInGame(d.chat);
      }
      // Automatic clips: a bit after takeoff as a passenger, and once after ~10 min of playing.
      if (me.seated && !me.seatClipAt) me.seatClipAt = Date.now() + 90_000;
      if (me.seatClipAt && Date.now() > me.seatClipAt && !me.seatClipped) {
        me.seatClipped = true;
        clipNow('flying in his plane', true);
      }
      if (!me.timeClipped && Date.now() - me.startedAt > 10 * 60_000) {
        me.timeClipped = true;
        clipNow('playing together', true);
      }
      await sleep(me.seated ? 12_000 : Math.min(config.playStepMs, 300));
    } catch (err) {
      hooks.log(`[roblox] ${err.message.split('\n')[0]}`);
      await sleep(3000);
    }
  }
  if (session === me) session = null;
  if (!session) require('./clips').stop();
}

/** Makes a clip of the last ~30 s and posts it (via hooks.clip). Max 4 per game, 2 automatic. */
function clipNow(why = 'asked', auto = false) {
  const me = session;
  if (!me || !me.hooks || !me.hooks.clip) return false;
  me.clips = me.clips || 0;
  me.autoClips = me.autoClips || 0;
  if (me.clips >= 4 || (auto && me.autoClips >= 2)) return false;
  me.clips++;
  if (auto) me.autoClips++;
  me.hooks.clip(why, me.game).catch((err) => me.hooks.log(`[clips] ${err.message}`));
  return true;
}

/**
 * Starts playing. `hooks.say(text)` sends a TikTok DM, `hooks.log(text)` writes to the console.
 * Returns a message for the DM.
 */
async function start(tab, { followUserId, placeId, friendName, game, gamePlaceId }, hooks) {
  const games = require('./rbxgames');
  const routine = games.routineFor(game);
  // Study the game before joining (title, description, thumbnail), unless Murdhi already taught me.
  const guide = routine ? '' : await games.study(tab, gamePlaceId || placeId, game).catch(() => '');
  const saved = (require('./store').load('roblox-tips.json', {})[game] || []).slice(-8);
  const extra = { game: game || 'this game', routine, step: 0, seated: false, guide, tips: saved, stepClicked: false };
  if (saved.length) hooks.log(`[roblox] remembered ${saved.length} tips for ${game}`);
  if (process.platform !== 'win32') return 'i live on a raspberry pi now so i cant play roblox 😭 but i can still see what ur playing';
  if (session) return "i'm already in a game lol";
  extra.hooks = hooks;
  const already = await robloxRunning();
  if (already) {
    // Probably my own game from before a restart: take control of it again.
    session = { pid: already, stop: false, startedAt: Date.now(), friendName, ...extra };
    hooks.log(`[roblox] roblox already open (pid ${already}), taking control`);
    playLoop(followUserId, friendName, hooks).catch((err) => hooks.log(`[roblox] ${err.message}`));
    return "roblox was already open, im controlling it now 🎮";
  }
  await launch(tab, { followUserId, placeId });
  session = { pid: null, stop: false, startedAt: Date.now(), friendName, ...extra };

  // Loading takes a while, so the rest happens in the background.
  (async () => {
    let pid = null;
    for (let i = 0; i < 40 && !pid && session && !session.stop; i++) {
      await sleep(3000);
      pid = await robloxRunning();
    }
    if (!session || session.stop) return;
    if (!pid) {
      session = null;
      hooks.say("roblox didn't open 😭 maybe it needs an update, open it once yourself");
      return;
    }
    session.pid = pid;
    hooks.log(`[roblox] app open (pid ${pid}), loading…`);
    await sleep(20_000);
    await playLoop(followUserId, friendName, hooks);
  })().catch((err) => {
    hooks.log(`[roblox] ${err.message}`);
    session = null;
  });
  return followUserId ? 'joining you rn 🏃' : 'hopping on 🏃';
}

async function stop() {
  require('./clips').stop();
  if (!session) return "i'm not in a game rn";
  session.stop = true;
  const pid = session.pid || (await robloxRunning().catch(() => null));
  if (pid) await input.cmd(`kill ${pid}`).catch(() => {});
  session = null;
  return 'ok im off roblox 👋';
}

const playing = () => Boolean(session);

/** Close my Roblox (if open) so a fresh join can happen. */
async function reset() {
  require('./clips').stop();
  const pid = (session && session.pid) || (await robloxRunning().catch(() => null));
  if (session) session.stop = true;
  session = null;
  if (pid) await input.cmd(`kill ${pid}`).catch(() => {});
  await sleep(2500);
}

/** An instruction from the owner while playing ("go to the shop", "follow me", "click play"). */
function instruct(text) {
  if (!session) return false;
  if (/\b(clip (that|it|this)|record (that|this)|post (that|this)|clip)\b/i.test(text)) {
    if (!clipNow(text)) session.hooks && session.hooks.say("can't clip more this game 😭 (max 4)");
    return true;
  }
  session.order = { text: String(text).slice(0, 200), at: Date.now() };
  session.tips = [...(session.tips || []), String(text).slice(0, 120)].slice(-10);
  // Remember tips for this game for next time (skip short chatter like "ok" / "lol").
  try {
    if (session.game && String(text).split(/\s+/).length >= 3) {
      const store = require('./store');
      const all = store.load('roblox-tips.json', {});
      const list = all[session.game] || [];
      if (!list.includes(String(text).slice(0, 120))) list.push(String(text).slice(0, 120));
      all[session.game] = list.slice(-15);
      store.save('roblox-tips.json', all);
    }
  } catch {}
  const look = String(text).match(/(?:the|with|has|in)?\s*([\w\s-]{2,30})\s+avatar/i);
  if (look) session.look = look[1].trim();
  return true;
}

module.exports = { start, stop, playing, instruct, reset, clipNow };
