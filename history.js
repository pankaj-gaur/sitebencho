const fs = require('fs');
const path = require('path');

/**
 * Run history, stored per user:
 *   history/<userId>/<type>/<runId>.json      type = diff | analysis
 *
 * Every function works inside ONE user's folder, so a person can only ever
 * list, read, download or delete their own runs — someone else's run id
 * simply isn't found (404), which also means ids can't be probed.
 *
 * Use:  const h = forUser(userId, { maxEntries });  h.saveRun('diff', {...})
 */
const HISTORY_ROOT = path.join(__dirname, 'history');
const DEFAULT_MAX_ENTRIES = 30; // per type; the user's plan can set its own (runsKept)
const TYPES = ['diff', 'analysis'];
const USER_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const RUN_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function forUser(userId, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  if (!USER_ID_RE.test(String(userId || ''))) throw new Error('history: a valid user id is required');
  const userRoot = path.join(HISTORY_ROOT, userId);
  const keep = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : Infinity;

  function dirFor(type) {
    if (!TYPES.includes(type)) throw new Error(`history: unknown type "${type}"`);
    const dir = path.join(userRoot, type);
    ensureDir(dir);
    return dir;
  }

  // Only well-formed ids map to a file; anything else (e.g. "../x") is "not found".
  function fileFor(type, id) {
    if (!RUN_ID_RE.test(String(id || ''))) return null;
    return path.join(dirFor(type), `${id}.json`);
  }

  function pruneOldEntries(type) {
    if (keep === Infinity) return;
    const dir = dirFor(type);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    files.slice(keep).forEach(({ f }) => {
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
    fs.writeFileSync(path.join(dirFor(type), `${id}.json`), JSON.stringify(record), 'utf8');
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
    const file = fileFor(type, id);
    if (!file || !fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  function deleteRun(type, id) {
    const file = fileFor(type, id);
    if (file && fs.existsSync(file)) {
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
    const newId = id && RUN_ID_RE.test(String(id)) ? id : makeId();
    const record = { id: newId, timestamp: new Date().toISOString(), updatedAt: new Date().toISOString(), ...entry };
    fs.writeFileSync(path.join(dir, `${newId}.json`), JSON.stringify(record), 'utf8');
    pruneOldEntries(type);
    return record;
  }

  return { saveRun, saveOrUpdateRun, listRuns, getRun, deleteRun };
}

module.exports = { forUser, HISTORY_ROOT, TYPES };
