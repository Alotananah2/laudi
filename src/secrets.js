// Account passwords from the dashboard's setup. Stored only on this computer, in data/secrets.json (owner-only file).
const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.dataDir, 'secrets.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(patch) {
  const next = { ...load(), ...patch };
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch {}
  return next;
}

module.exports = { load, save, FILE };
