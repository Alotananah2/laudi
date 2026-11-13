// Roblox: see whether you're online / in a game / in Studio, using the bot's Roblox account.
// Calls Roblox's own web APIs from inside a logged-in roblox.com tab.

async function api(tab, url, body) {
  return Promise.race([
    apiInner(tab, url, body),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Roblox API timed out: ${url.split('?')[0]}`)), 30_000)),
  ]);
}

async function apiInner(tab, url, body) {
  return tab.evaluate(
    async ({ url, body }) => {
      const opts = {
        method: body ? 'POST' : 'GET',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      };
      let r = await fetch(url, opts);
      const token = r.headers.get('x-csrf-token');
      if (r.status === 403 && token) {
        opts.headers['x-csrf-token'] = token;
        r = await fetch(url, opts);
      }
      if (!r.ok) return { error: r.status };
      return r.json();
    },
    { url, body },
  );
}

async function userId(tab, username) {
  const res = await api(tab, 'https://users.roblox.com/v1/usernames/users', {
    usernames: [username],
    excludeBannedUsers: false,
  });
  return res && res.data && res.data[0] ? res.data[0].id : null;
}

/** { type: 0 offline | 1 online | 2 in game | 3 in Studio, game, placeId } */
async function presence(tab, id) {
  const res = await api(tab, 'https://presence.roblox.com/v1/presence/users', { userIds: [id] });
  const p = res && res.userPresences && res.userPresences[0];
  if (!p) return null;
  return { type: p.userPresenceType, game: p.lastLocation || '', placeId: p.placeId || p.rootPlaceId || null };
}

module.exports = { userId, presence };

/** The bot's own Roblox account. */
async function me(tab) {
  const res = await api(tab, 'https://users.roblox.com/v1/users/authenticated');
  return res && res.id ? { id: res.id, name: res.name } : null;
}

/** The bot's Roblox friends: [{ id, name }] */
async function friends(tab, id) {
  const res = await api(tab, `https://friends.roblox.com/v1/users/${id}/friends`);
  const list = (res && res.data) || [];
  const out = [];
  for (const f of list.slice(0, 50)) {
    let name = f.name || f.displayName;
    if (!name) {
      const u = await api(tab, `https://users.roblox.com/v1/users/${f.id}`);
      name = (u && (u.name || u.displayName)) || String(f.id);
    }
    out.push({ id: f.id, name });
  }
  return out;
}

module.exports.me = me;
module.exports.friends = friends;

/** Sends a friend request from the bot's account. Returns a short result string. */
async function requestFriend(tab, id) {
  const res = await api(tab, `https://friends.roblox.com/v1/users/${id}/request-friendship`, {
    friendshipOriginSourceType: 'UserProfile',
  });
  if (res && res.error) return `failed (HTTP ${res.error})`;
  if (res && res.isCaptchaRequired) return 'Roblox wants a captcha first';
  return 'sent';
}

module.exports.requestFriend = requestFriend;

/** Is `id` already friends with the bot? */
async function isFriend(tab, botId, id) {
  const list = await api(tab, `https://friends.roblox.com/v1/users/${botId}/friends`);
  return Boolean(list && list.data && list.data.some((f) => f.id === id));
}

/** Accepts a pending friend request from `id`. Returns true if there was one. */
async function acceptFrom(tab, id) {
  const reqs = await api(tab, 'https://friends.roblox.com/v1/my/friends/requests?limit=100');
  const has = reqs && reqs.data && reqs.data.some((r) => r.id === id || (r.friendRequest && r.friendRequest.senderId === id));
  if (!has) return false;
  const res = await api(tab, `https://friends.roblox.com/v1/users/${id}/accept-friend-request`, {});
  return !(res && res.error);
}

module.exports.isFriend = isFriend;

/** Presence for many users at once: { id: { type, game } } */
async function presenceMany(tab, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const res = await api(tab, 'https://presence.roblox.com/v1/presence/users', { userIds: ids.slice(i, i + 50) });
    for (const p of (res && res.userPresences) || []) out[p.userId] = { type: p.userPresenceType, game: p.lastLocation || '' };
  }
  return out;
}
module.exports.presenceMany = presenceMany;
module.exports.acceptFrom = acceptFrom;
