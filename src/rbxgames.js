// What Laudi knows about specific Roblox games:
// - hand-written routines (from Murdhi) for games he plays a lot
// - for any other game, he studies it before joining: title, description and thumbnail -> a short guide.
const config = require('./config');
const store = require('./store');

// Routines told by the owner. Matched by game name (case-insensitive, partial).
const ROUTINES = [
  {
    match: /pilot\s*training\s*flight\s*sim/i,
    steps: [
      'Click the "Normal" button.',
      'Click the "Play" button.',
      'Click "Greater Rockford".',
      'Click "Greater Rockford" again (the spawn/airport choice).',
    ],
    extra: 'Between steps the game may ask which device you play on: choose Computer/Laptop. If it offers a tutorial, skip it.',
    then:
      'Now find your friend and follow them closely. Keep following until a prompt with "Copilot" and "Passenger" appears on screen ' +
      '(it shows when you are next to their plane). As soon as you see it, press the c key (Passenger) and set "seated":true.',
    seated:
      'You are now a PASSENGER in your friend\'s plane. Stay in the seat: do NOT press w/a/s/d/space/c. ' +
      'Every turn only tap "left" or "right" briefly (100-300 ms) to look around. If you are clearly no longer in the plane (standing outside), set "seated":false.',
  },
];

function routineFor(gameName) {
  return ROUTINES.find((r) => r.match.test(gameName || '')) || null;
}

/** Downloads a game's info + thumbnail and asks the vision model for a short "how to play" guide. Cached. */
async function study(tab, placeId, gameName) {
  const cache = store.load('roblox-games.json', {});
  const key = String(placeId || gameName || '');
  if (!key) return '';
  if (cache[key] && cache[key].guide) return cache[key].guide;
  const req = tab.context().request;
  const getJson = async (url) => {
    const r = await req.get(url, { headers: { Referer: 'https://www.roblox.com/' }, timeout: 20_000 });
    return r.ok() ? r.json() : null;
  };
  let name = gameName || '';
  let desc = '';
  let thumbB64 = null;
  try {
    if (placeId) {
      const u = await getJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
      const universeId = u && u.universeId;
      if (universeId) {
        const g = await getJson(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
        const info = g && g.data && g.data[0];
        if (info) {
          name = info.name || name;
          desc = String(info.description || '').slice(0, 1500);
        }
        const t = await getJson(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${universeId}&countPerUniverse=1&size=768x432&format=Jpeg`);
        const url = t && t.data && t.data[0] && t.data[0].thumbnails && t.data[0].thumbnails[0] && t.data[0].thumbnails[0].imageUrl;
        if (url) {
          const img = await req.get(url, { timeout: 20_000 });
          if (img.ok()) thumbB64 = (await img.body()).toString('base64');
        }
      }
    }
  } catch (err) {
    console.warn('[roblox] studying game:', err.message.split('\n')[0]);
  }
  const prompt =
    `You are about to play the Roblox game "${name}" with your friend. Title: ${name}\nDescription:\n${desc || '(none)'}\n` +
    (thumbB64 ? 'The image is the game thumbnail.\n' : '') +
    'Write a SHORT practical guide for yourself (max 8 lines): what kind of game this is, what the goal is, what menus/buttons you probably need to click at the start ' +
    '(e.g. Play, team/mode select, spawn location), the main controls/keys used in it, and what players normally do there. ' +
    'Also: how to play TOGETHER with a friend in this game. Plain text.';
  let guide = '';
  try {
    if (thumbB64) guide = await require('./watch').look([thumbB64], prompt, { timeout: 30_000 });
    if (!guide) {
      const { complete } = require('./brain');
      guide = ((await complete([{ role: 'user', content: prompt }])) || {}).content || '';
    }
  } catch (err) {
    console.warn('[roblox] guide:', err.message.split('\n')[0]);
  }
  guide = String(guide).trim().slice(0, 1200);
  if (guide) {
    cache[key] = { name, guide, at: Date.now() };
    store.save('roblox-games.json', cache);
    console.log(`[roblox] studied "${name}": ${guide.replace(/\s+/g, ' ').slice(0, 160)}…`);
  }
  return guide;
}

module.exports = { routineFor, study };
