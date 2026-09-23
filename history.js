const fs = require('fs');
const path = require('path');

const HISTORY_ROOT = path.join(__dirname, 'history');
const MAX_ENTRIES_PER_TYPE = 30; // keep disk usage bounded — oldest entries get pruned beyond this

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function dirFor(type) {
  const dir = path.join(HISTORY_ROOT, type);
  ensureDir(dir);
  return dir;
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pruneOldEntries(type) {
  const dir = dirFor(type);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  files.slice(MAX_ENTRIES_PER_TYPE).forEach(({ f }) => {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch (e) {
      // best-effort cleanup only
    }
  });
}

/**
 * Persists a completed run to disk as JSON. `entry` should contain both the
 * heavy data (results/pages arrays, needed to regenerate a report later) and
 * summary fields (counts, origins) used for the lightweight list view.
 */
function saveRun(type, entry) {
  const id = makeId();
  const record = { id, timestamp: new Date().toISOString(), ...entry };
  const dir = dirFor(type);
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record), 'utf8');
  pruneOldEntries(type);
  return record;
}

/**
 * Lists runs of a type, newest first, WITHOUT the heavy fields (results/
 * pages/linkResults/lhResults) — the list view only needs summary data, the
 * heavy fields are loaded on demand when a specific report is downloaded.
 */
function listRuns(type) {
  const dir = dirFor(type);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const full = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const { results, pages, linkResults, lhResults, aiSummaries, ...summary } = full;
        return summary;
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function getRun(type, id) {
  const file = path.join(dirFor(type), `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function deleteRun(type, id) {
  const file = path.join(dirFor(type), `${id}.json`);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return true;
  }
  return false;
}

/**
 * Creates a new run, or updates an existing one if `id` is given and found.
 * This is what lets "crawl, then later scan links, then later run Lighthouse"
 * end up as ONE history row that grows richer over time, instead of three
 * separate disconnected entries. Fields in `entry` are merged over whatever
 * already exists — anything not included in this call is left untouched.
 */
function saveOrUpdateRun(type, id, entry) {
  const dir = dirFor(type);
  if (id) {
    const existing = getRun(type, id);
    if (existing) {
      const record = { ...existing, ...entry, id, timestamp: existing.timestamp, updatedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record), 'utf8');
      return record;
    }
  }
  const newId = id || makeId();
  const record = { id: newId, timestamp: new Date().toISOString(), updatedAt: new Date().toISOString(), ...entry };
  fs.writeFileSync(path.join(dir, `${newId}.json`), JSON.stringify(record), 'utf8');
  pruneOldEntries(type);
  return record;
}

module.exports = { saveRun, saveOrUpdateRun, listRuns, getRun, deleteRun };
