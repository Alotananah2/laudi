// Tiny JSON file storage in ./data
const fs = require('fs');
const path = require('path');
const config = require('./config');

function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.dataDir, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function save(name, value) {
  const file = path.join(config.dataDir, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}

module.exports = { load, save };
