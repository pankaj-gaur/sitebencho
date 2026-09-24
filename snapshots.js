/**
 * Daily Snapshots — captures a full-page screenshot of every configured URL
 * once a day and keeps them on disk so the timeline page can browse them.
 *
 * Storage layout (all under ./snapshots, next to ./history):
 *   config.json                      tracked URLs + capture time + retention
 *   state.json                       last automatic run date (survives restarts)
 *   <urlId>/YYYY-MM-DD.jpg           full-page capture for that day
 *   <urlId>/YYYY-MM-DD-thumb.jpg     360x225 thumbnail of the first screen
 *   <urlId>/YYYY-MM-DD.json          metadata (HTTP status, error, height…)
 *   <urlId>/benchmark(.jpg|-thumb.jpg|.json)   the reference capture
 *
 * The first successful capture of a URL becomes its benchmark automatically;
 * any later day can be promoted to benchmark from the UI.
 *
 * No new dependencies — uses the Playwright Chromium the app already installs.
 * The scheduler only runs while `npm start` is running. If the machine was off
 * at capture time, the capture happens as soon as the server comes back up
 * that same day.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, 'snapshots');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_FILE = path.join(ROOT, 'state.json');

const VIEWPORT = { width: 1440, height: 900 };
const THUMB = { width: 360, height: 225 }; // same 16:10 ratio as the viewport
const MAX_HEIGHT = 15000;                  // very long pages are clipped here
const GAP_MS = 3000;                       // politeness pause between URLs
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^u-[a-z0-9]+-[a-z0-9]+$/;
const FILE_RE = /^(\d{4}-\d{2}-\d{2}|benchmark)(-thumb)?\.jpg$/;

const UA = `SiteDiffInspectorBot/1.0 (+internal QA tool; daily snapshots; contact: ${process.env.CONTACT_EMAIL || 'set CONTACT_EMAIL env var'})`;

const DEFAULT_CONFIG = { urls: [], captureTime: '06:00', retentionDays: 400 };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
// The capture schedule runs on a fixed GMT/UTC clock, not the host machine's
// local time — this keeps behavior identical no matter where the server is
// hosted or what timezone it's set to, and avoids DST edge cases entirely.
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
function makeId() {
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.toString();
  } catch (e) {
    return null;
  }
}
function defaultLabel(url) {
  try {
    const u = new URL(url);
    const p = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return `${u.hostname.replace(/^www\./, '')}${p}`;
  } catch (e) {
    return url;
  }
}
function loadConfig() { return { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) }; }
function urlDir(id) { return path.join(ROOT, id); }
function copyIfExists(from, to) { if (fs.existsSync(from)) fs.copyFileSync(from, to); }
function removeIfExists(f) { try { fs.unlinkSync(f); } catch (e) { /* not there */ } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------
async function autoScroll(page) {
  // Scroll through the page once so lazy-loaded images and sections render
  // before the full-page screenshot. Bounded by MAX_HEIGHT so it always ends.
  await page.evaluate(async (maxH) => {
    await new Promise((resolve) => {
      let y = 0;
      const t = setInterval(() => {
        const h = document.documentElement.scrollHeight;
        window.scrollBy(0, 600);
        y += 600;
        if (y >= h || y >= maxH) { clearInterval(t); resolve(); }
      }, 120);
    });
    window.scrollTo(0, 0);
  }, MAX_HEIGHT).catch(() => {});
}

async function makeThumb(browser, viewportJpeg) {
  // Downscale with Chromium itself instead of adding an image library.
  const ctx = await browser.newContext({ viewport: THUMB });
  try {
    const p = await ctx.newPage();
    await p.setContent(
      `<html><body style="margin:0;background:#fff"><img id="i" style="display:block;width:${THUMB.width}px;height:auto" src="data:image/jpeg;base64,${viewportJpeg.toString('base64')}"></body></html>`
    );
    await p.waitForFunction(() => {
      const i = document.getElementById('i');
      return i && i.complete && i.naturalWidth > 0;
    }, null, { timeout: 5000 });
    return await p.screenshot({ type: 'jpeg', quality: 75 });
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function captureOne(browser, url, outBase) {
  const meta = {
    url,
    capturedAt: new Date().toISOString(),
    httpStatus: null,
    ok: false,
    error: null,
    height: null,
    truncated: false,
  };
  const context = await browser.newContext({ viewport: VIEWPORT, userAgent: UA, ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    meta.httpStatus = resp ? resp.status() : null;
    meta.ok = !!resp && resp.ok();
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await autoScroll(page);
    await page.waitForTimeout(800);

    const height = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
    );
    meta.height = height;
    const opts = { type: 'jpeg', quality: 70, fullPage: true };
    if (height > MAX_HEIGHT) {
      opts.clip = { x: 0, y: 0, width: VIEWPORT.width, height: MAX_HEIGHT };
      meta.truncated = true;
    }
    const full = await page.screenshot(opts);
    const top = await page.screenshot({ type: 'jpeg', quality: 85 }); // first screen only
    const thumb = await makeThumb(browser, top);

    fs.writeFileSync(`${outBase}.jpg`, full);
    fs.writeFileSync(`${outBase}-thumb.jpg`, thumb);
    // Non-2xx pages are still captured (the error page itself is useful
    // evidence) but flagged so the timeline shows them in red.
    if (!meta.ok) meta.error = `HTTP ${meta.httpStatus ?? 'no response'}`;
  } catch (e) {
    meta.error = e && e.message ? e.message.split('\n')[0] : String(e);
    // Don't leave an older capture for the same day next to a failure record.
    removeIfExists(`${outBase}.jpg`);
    removeIfExists(`${outBase}-thumb.jpg`);
  } finally {
    await context.close().catch(() => {});
  }
  writeJson(`${outBase}.json`, meta);
  return meta;
}

function promoteToBenchmark(id, date) {
  const dir = urlDir(id);
  const src = path.join(dir, date);
  if (!fs.existsSync(`${src}.jpg`)) return false;
  copyIfExists(`${src}.jpg`, path.join(dir, 'benchmark.jpg'));
  copyIfExists(`${src}-thumb.jpg`, path.join(dir, 'benchmark-thumb.jpg'));
  const meta = readJson(`${src}.json`, {});
  writeJson(path.join(dir, 'benchmark.json'), { ...meta, sourceDate: date, setAt: new Date().toISOString() });
  return true;
}

function pruneOld(cfg) {
  const days = Number(cfg.retentionDays) || 0;
  if (days <= 0) return; // 0 = keep forever
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = localDate(cutoff);
  for (const u of cfg.urls) {
    const dir = urlDir(u.id);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m && m[1] < cutoffStr) removeIfExists(path.join(dir, f));
    }
  }
}

// ---------------------------------------------------------------------------
// run orchestration
// ---------------------------------------------------------------------------
const run = {
  status: 'idle', // idle | running
  trigger: null,  // schedule | manual | setup
  done: 0,
  total: 0,
  current: null,
  startedAt: null,
  finishedAt: null,
  lastErrors: [],
};
const pendingIds = new Set(); // URLs added while a run was already going

async function runCapture({ trigger, onlyIds = null, skipExisting = false, logErr }) {
  if (run.status === 'running') {
    if (onlyIds) onlyIds.forEach((id) => pendingIds.add(id));
    return false;
  }
  const cfg = loadConfig();
  const today = localDate();
  let targets = cfg.urls.filter((u) => !onlyIds || onlyIds.includes(u.id));
  if (skipExisting) targets = targets.filter((u) => !fs.existsSync(path.join(urlDir(u.id), `${today}.jpg`)));

  Object.assign(run, {
    status: 'running', trigger, done: 0, total: targets.length, current: null,
    startedAt: new Date().toISOString(), finishedAt: null, lastErrors: [],
  });

  let browser;
  try {
    if (targets.length) browser = await chromium.launch();
    for (const u of targets) {
      run.current = u.url;
      const dir = urlDir(u.id);
      ensureDir(dir);
      const meta = await captureOne(browser, u.url, path.join(dir, today));
      if (meta.error) run.lastErrors.push({ url: u.url, error: meta.error });
      // First successful (2xx) capture becomes the benchmark automatically —
      // an error page is never used as the reference.
      if (meta.ok && !meta.error && !fs.existsSync(path.join(dir, 'benchmark.jpg'))) {
        promoteToBenchmark(u.id, today);
      }
      run.done += 1;
      if (run.done < targets.length) await sleep(GAP_MS);
    }
    pruneOld(cfg);
  } catch (e) {
    if (logErr) logErr('daily snapshot run failed', e);
    run.lastErrors.push({ url: run.current, error: e && e.message ? e.message : String(e) });
  } finally {
    if (browser) await browser.close().catch(() => {});
    run.status = 'idle';
    run.current = null;
    run.finishedAt = new Date().toISOString();
  }

  if (pendingIds.size) {
    const ids = Array.from(pendingIds);
    pendingIds.clear();
    setTimeout(() => runCapture({ trigger: 'setup', onlyIds: ids, logErr }), 500);
  }
  return true;
}

function minutesOf(hhmm) {
  const [h, m] = String(hhmm || '06:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function nextRunAt(cfg) {
  if (!cfg.urls.length) return null;
  const state = readJson(STATE_FILE, {});
  const now = new Date();
  const mins = minutesOf(cfg.captureTime);
  // Built with Date.UTC so the resulting instant is always "mins past
  // midnight UTC today", regardless of the host machine's own timezone.
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(mins / 60), mins % 60, 0));
  const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (state.lastAutoRun === localDate(now)) {
    next.setUTCDate(next.getUTCDate() + 1);      // today's run is done → tomorrow
  } else if (nowMins >= mins) {
    return new Date(now.getTime() + 60000).toISOString(); // due → next tick
  }
  return next.toISOString();
}

function startScheduler(logErr) {
  const tick = async () => {
    try {
      const cfg = loadConfig();
      if (!cfg.urls.length || run.status === 'running') return;
      const state = readJson(STATE_FILE, {});
      const today = localDate();
      if (state.lastAutoRun === today) return;
      const now = new Date();
      if (now.getUTCHours() * 60 + now.getUTCMinutes() < minutesOf(cfg.captureTime)) return;
      // skipExisting: URLs already captured today (e.g. just added, or a
      // manual "Capture now") aren't captured twice.
      const started = await runCapture({ trigger: 'schedule', skipExisting: true, logErr });
      if (started) writeJson(STATE_FILE, { ...readJson(STATE_FILE, {}), lastAutoRun: today });
    } catch (e) {
      logErr('snapshot scheduler tick failed', e);
    }
  };
  setTimeout(tick, 5000);   // catch up shortly after the server starts
  setInterval(tick, 60000); // then check once a minute
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------
function mountSnapshots(app, { logErr = (c, e) => console.error(c, e) } = {}) {
  ensureDir(ROOT);

  app.get('/api/snapshots/config', (req, res) => {
    const cfg = loadConfig();
    const urls = cfg.urls.map((u) => {
      const bm = readJson(path.join(urlDir(u.id), 'benchmark.json'), null);
      return { ...u, benchmark: bm && fs.existsSync(path.join(urlDir(u.id), 'benchmark.jpg')) ? bm : null };
    });
    res.json({ ok: true, configured: urls.length > 0, ...cfg, urls });
  });

  app.put('/api/snapshots/config', (req, res) => {
    const body = req.body || {};
    const current = loadConfig();
    const byId = new Map(current.urls.map((u) => [u.id, u]));

    if (!Array.isArray(body.urls)) return res.status(400).json({ ok: false, error: 'urls must be an array.' });
    if (body.captureTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.captureTime)) {
      return res.status(400).json({ ok: false, error: 'Capture time must be HH:MM (24-hour, GMT/UTC).' });
    }
    const retention = body.retentionDays === undefined ? current.retentionDays : Number(body.retentionDays);
    if (!Number.isInteger(retention) || retention < 0 || retention > 3650) {
      return res.status(400).json({ ok: false, error: 'Keep-for days must be a whole number from 0 to 3650.' });
    }

    const next = [];
    const seen = new Set();
    const invalid = [];
    for (const item of body.urls) {
      const existing = item && item.id ? byId.get(item.id) : null;
      if (existing) {
        // URL of an existing entry is fixed; only its label can change.
        next.push({ ...existing, label: String(item.label || '').trim() || defaultLabel(existing.url) });
        seen.add(existing.url);
        continue;
      }
      const url = normalizeUrl(item && item.url);
      if (!url) { invalid.push(item && item.url); continue; }
      if (seen.has(url)) continue; // silently drop duplicates
      seen.add(url);
      next.push({ id: makeId(), url, label: String(item.label || '').trim() || defaultLabel(url), addedAt: new Date().toISOString() });
    }
    if (invalid.length) {
      return res.status(400).json({ ok: false, error: `Not a valid web address: ${invalid.filter(Boolean).join(', ') || '(empty)'}` });
    }

    // Removed entries lose their stored screenshots too (the UI confirms first).
    const keptIds = new Set(next.map((u) => u.id));
    for (const u of current.urls) {
      if (!keptIds.has(u.id)) {
        try { fs.rmSync(urlDir(u.id), { recursive: true, force: true }); } catch (e) { logErr(`failed to delete snapshots for ${u.url}`, e); }
      }
    }

    const cfg = { urls: next, captureTime: body.captureTime || current.captureTime, retentionDays: retention };
    writeJson(CONFIG_FILE, cfg);

    // New URLs are captured straight away so they get a benchmark today.
    const newIds = next.filter((u) => !byId.has(u.id)).map((u) => u.id);
    if (newIds.length) runCapture({ trigger: 'setup', onlyIds: newIds, logErr });

    res.json({ ok: true, ...cfg, capturingNew: newIds.length });
  });

  app.get('/api/snapshots/status', (req, res) => {
    const cfg = loadConfig();
    const state = readJson(STATE_FILE, {});
    res.json({ ok: true, ...run, pending: pendingIds.size, lastAutoRun: state.lastAutoRun || null, nextRunAt: nextRunAt(cfg), captureTime: cfg.captureTime });
  });

  app.post('/api/snapshots/run', (req, res) => {
    if (run.status === 'running') return res.status(409).json({ ok: false, error: 'A capture is already running.' });
    if (!loadConfig().urls.length) return res.status(400).json({ ok: false, error: 'Add at least one URL first.' });
    const onlyIds = req.body && Array.isArray(req.body.urlIds) ? req.body.urlIds : null;
    runCapture({ trigger: 'manual', onlyIds, logErr });
    res.json({ ok: true });
  });

  // Everything the timeline needs for one URL and one year, in one call.
  app.get('/api/snapshots/index', (req, res) => {
    const { urlId } = req.query;
    const year = String(req.query.year || new Date().getFullYear());
    if (!ID_RE.test(String(urlId || ''))) return res.status(400).json({ ok: false, error: 'A valid urlId is required.' });
    const dir = urlDir(urlId);
    const days = {};
    const years = new Set([String(new Date().getFullYear())]);
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^(\d{4})-\d{2}-\d{2}\.json$/);
        if (!m) continue;
        years.add(m[1]);
        if (m[1] !== year) continue;
        const date = f.slice(0, 10);
        const meta = readJson(path.join(dir, f), {});
        days[date] = {
          ok: !!meta.ok && !meta.error,
          httpStatus: meta.httpStatus ?? null,
          error: meta.error || null,
          capturedAt: meta.capturedAt || null,
          truncated: !!meta.truncated,
          hasImage: fs.existsSync(path.join(dir, `${date}.jpg`)),
        };
      }
    }
    const bm = readJson(path.join(dir, 'benchmark.json'), null);
    const benchmark = bm && fs.existsSync(path.join(dir, 'benchmark.jpg')) ? bm : null;
    res.json({ ok: true, year, days, benchmark, years: Array.from(years).sort().reverse() });
  });

  app.post('/api/snapshots/benchmark', (req, res) => {
    const { urlId, date } = req.body || {};
    if (!ID_RE.test(String(urlId || '')) || !DATE_RE.test(String(date || ''))) {
      return res.status(400).json({ ok: false, error: 'urlId and date (YYYY-MM-DD) are required.' });
    }
    if (!promoteToBenchmark(urlId, date)) return res.status(404).json({ ok: false, error: 'No capture for that day.' });
    res.json({ ok: true });
  });

  // Image files — validated names only, so config/state JSON is never served.
  app.get('/snapshot-files/:id/:file', (req, res) => {
    const { id, file } = req.params;
    if (!ID_RE.test(id) || !FILE_RE.test(file)) return res.status(404).end();
    const f = path.join(urlDir(id), file);
    if (!fs.existsSync(f)) return res.status(404).end();
    res.set('Cache-Control', 'no-cache');
    res.sendFile(f);
  });

  startScheduler(logErr);
}

module.exports = { mountSnapshots };
