// Reminders saved to data/reminders.json and checked every 20 seconds.
const store = require('./store');

let reminders = store.load('reminders.json', []);
const persist = () => store.save('reminders.json', reminders);

function add(atMs, text, voice) {
  const id = Math.max(0, ...reminders.map((r) => r.id)) + 1;
  reminders.push({ id, at: atMs, text, voice: Boolean(voice) });
  reminders.sort((a, b) => a.at - b.at);
  persist();
  return id;
}

function list() {
  return reminders.slice();
}

function cancel(id) {
  const before = reminders.length;
  reminders = reminders.filter((r) => r.id !== Number(id));
  persist();
  return reminders.length !== before;
}

/** Calls deliver(reminder) for each reminder that is due. */
function start(deliver) {
  setInterval(async () => {
    const now = Date.now();
    const due = reminders.filter((r) => r.at <= now);
    if (!due.length) return;
    reminders = reminders.filter((r) => r.at > now);
    persist();
    for (const r of due) {
      try {
        await deliver(r);
      } catch (err) {
        console.warn('[reminders]', err.message);
      }
    }
  }, 20_000);
}

module.exports = { add, list, cancel, start };
