const express = require('express');
const path = require('path');
const { chromium } = require('playwright');
const { diffHtml } = require('./diff-utils');
const { crawlSite, renderUrlList } = require('./crawler');
const { checkPageLinks } = require('./linkcheck');
const { runLighthouse } = require('./lighthouse-check');
const {
  renderPdfFromHtml,
  buildDiffCsv,
  buildDiffPdfHtml,
  buildAnalysisCsv,
  buildAnalysisPdfHtml,
} = require('./report');
const { saveRun, saveOrUpdateRun, listRuns, getRun, deleteRun } = require('./history');
const { generateAiSummary, generatePageForecast, markdownToHtml } = require('./ai-summary');

// Node's default behavior for an unhandled promise rejection is to crash the
// entire process immediately — no error response, every open connection
// (including the browser's in-flight fetch to /api/crawl or /api/progress)
// just dies, which is exactly what "TypeError: Failed to fetch" in the UI
// means. Crawlee/Playwright's internal browser-pool machinery runs a fair
// amount of background async work; catching this here turns "the whole
// server vanishes with no explanation" into "one thing failed, logged, and
// the server keeps running" for anything that isn't a true OOM kill.
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection (server stayed up):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception (server stayed up):', err);
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Every catch block in this file should call this rather than swallow the
// error silently — a message that only reaches the API response and never
// the terminal is invisible when the client's own connection also drops
// (e.g. "Failed to fetch"), which is exactly the scenario that matters most.
function logErr(context, err) {
  console.error(`[server] ${context}:`, err && err.stack ? err.stack : err);
}

const VALID_SLOTS = ['bench', 'cand', 'site'];

// In-memory only — this is a local single-user tool, nothing persists to disk.
const store = { bench: null, cand: null, site: null }; // slot -> { origin, pages: Map }
const progress = {
  bench: { status: 'idle', found: 0, total: 0, error: null, pages: [] },
  cand: { status: 'idle', found: 0, total: 0, error: null, pages: [] },
  site: { status: 'idle', found: 0, total: 0, error: null, pages: [] },
};
// Tracks which crawl "generation" is current per slot, and how to cancel the
// one currently running. A dropped client connection does NOT stop the
// server-side crawl on its own — without this, an abandoned or superseded
// crawl keeps running in the background indefinitely, invisible to the UI,
// and its progress updates can clobber a newer crawl's results for the same
// slot (which is exactly what "candidate shows 500 when I set max to 20"
// turned out to be: a stale run from before the setting changed, still alive).
const crawlGeneration = { bench: 0, cand: 0, site: 0 };
const activeStop = { bench: null, cand: null, site: null };

function normalizeSource(html) {
  return (html || '')
    // HTML comments — some caching/perf plugins inject a generation
    // timestamp or "rendered in Xms" comment that changes on every load.
    .replace(/<!--[\s\S]*?-->/g, '')
    // CSP nonces are *designed* to be different on every single request —
    // comparing them will always show "different" regardless of content.
    .replace(/\snonce=["'][^"']*["']/gi, '')
    // Inline <script> bodies commonly carry analytics/tracking payloads with
    // unique per-request IDs — keep the tags (structure matters) but ignore
    // their contents, since that's rarely the "content" a QA diff cares about.
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

// Finds the first point where two (already-normalized) strings diverge, with
// a bit of surrounding context — so "source differs" comes with evidence
// instead of just an assertion.
function firstDivergence(a, b, context = 70) {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  if (i === len && a.length === b.length) return null; // truly identical
  const start = Math.max(0, i - context);
  return {
    index: i,
    benchLength: a.length,
    candLength: b.length,
    benchSnippet: a.slice(start, i + context),
    candSnippet: b.slice(start, i + context),
  };
}

// Extracts the set of absolute link URLs found on a rendered page. Used to
// compare benchmark vs candidate link sets — NOT to check whether each link
// is reachable (that's a live-health check, which Site Analysis already
// covers separately; comparing a benchmark and candidate that both point at
// the same broken external link isn't a "diff" issue).
async function extractPageLinks(page, baseUrl) {
  try {
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
    const out = new Set();
    for (const href of hrefs) {
      if (!href) continue;
      const trimmed = href.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (/^(mailto:|tel:|javascript:|data:)/i.test(trimmed)) continue;
      try {
        const abs = new URL(trimmed, baseUrl).href.split('#')[0];
        if (/^https?:\/\//i.test(abs)) out.add(abs);
      } catch (e) {
        // malformed href — skip it
      }
    }
    return out;
  } catch (e) {
    return new Set();
  }
}

// Extracts the set of absolute static-asset URLs (stylesheets, scripts,
// favicons, web manifest) found on a rendered page. Site Diff only — this
// lists and compares which CSS/JS/asset files a page references, separate
// from the visible-content and link-set checks above.
async function extractPageAssets(page, baseUrl) {
  try {
    const raw = await page.$$eval(
      'link[rel~="stylesheet"][href], script[src], link[rel="icon"][href], link[rel="shortcut icon"][href], link[rel="manifest"][href]',
      (els) => els.map((el) => el.getAttribute('href') || el.getAttribute('src') || '')
    );
    const out = new Set();
    for (const href of raw) {
      if (!href) continue;
      const trimmed = href.trim();
      if (!trimmed) continue;
      try {
        const abs = new URL(trimmed, baseUrl).href.split('#')[0];
        if (/^https?:\/\//i.test(abs)) out.add(abs);
      } catch (e) {
        // malformed src/href — skip it
      }
    }
    return out;
  } catch (e) {
    return new Set();
  }
}

function ensureUrl(u) {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

// Forces any promise to give up after `ms` — used as a hard safety net
// around per-page work that has no cancellation of its own (Linkinator,
// Lighthouse). Doesn't actually cancel the underlying request, just stops
// the caller from waiting on it forever, so a single hung/blocked page can't
// freeze an entire sequential scan.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  // If the timeout wins, `promise` keeps running in the background with
  // nothing left listening for its eventual settlement — an unhandled
  // rejection once it finally rejects (e.g. Lighthouse's Chrome instance
  // getting killed mid-flight). This silences that specific case without
  // masking the real error, which is already surfaced via the timeout
  // rejection below.
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Consistent, filename-safe timestamp for report downloads — YYYYMMDD-HHmmss.
// Historical downloads pass the run's own saved timestamp (so the filename
// identifies which session it is); live downloads use "now".
function filenameTimestamp(date) {
  const d = date ? new Date(date) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Session bookkeeping: one "Crawl sites" click (Diff Inspector) or one
// "Crawl Site" click (Site Analysis) should end up as ONE history row that
// grows richer as later phases (testing; link scan; Lighthouse) complete —
// not a fresh disconnected entry per phase. Reset to null whenever a new
// crawl starts; the first snapshot saved after that assigns a fresh id,
// every snapshot after reuses it via saveOrUpdateRun.
let diffSessionId = null;
let analysisSessionId = null;

// How to pair benchmark and candidate pages for testing — 'path' (default):
// match pages that share the same normalized path, as when comparing two
// real crawls of what's meant to be the same site. 'position': pair the
// Nth benchmark URL with the Nth candidate URL regardless of path, domain,
// or structure — set whenever the benchmark side is crawled in "Use a URL
// list" mode, since two independently-typed lists have no shared-path
// relationship to match on (e.g. contentbloom.com/abc vs
// new.contentbloom.com/xyz/def are meant to be compared as a pair even
// though nothing about their paths corresponds). Reset alongside the rest
// of the session whenever a fresh benchmark crawl starts.
let diffPairMode = 'path';

// One AI summary PER PHASE per tool — each phase (crawl, then testing/link
// scan/Lighthouse) APPENDS a new entry rather than overwriting the previous
// one, so a person can still see "what did the crawl summary say" after a
// later scan has also run. `entries` is also persisted onto the current
// history row (see persistAiSummaryEntry) so it survives across restarts and
// shows up in downloaded reports, exactly like pages/results/link data does.
const aiSummaryState = {
  diff: { status: 'idle', error: null, updatedAt: null, entries: [], lastAttempt: null },
  analysis: { status: 'idle', error: null, updatedAt: null, entries: [], lastAttempt: null },
};

// Bumped every time a tool's session is reset (fresh crawl, or an explicit
// mode-switch reset from the UI). An AI call that was already in flight when
// the reset happened captures the OLD value, and when it eventually resolves
// it sees the mismatch and discards its result — otherwise a summary from
// the previous session would get appended into the brand-new session's
// panel (and saved into its history row) a few seconds after the reset.
const aiSummaryGen = { diff: 0, analysis: 0 };

function resetAiSummaryState(type) {
  aiSummaryGen[type] += 1;
  aiSummaryState[type] = { status: 'idle', error: null, updatedAt: null, entries: [], lastAttempt: null };
}

// Fires the AI summary call in the background — the scan endpoint that
// triggers this has already responded by the time it resolves. The frontend
// polls GET /api/ai-summary/:type to pick up the "generating" -> "done"/
// "error" transition, and reads the growing `entries` array (each with its
// own reportType label, plain text, and pre-rendered HTML) rather than a
// single overwritten string. Never throws; a failure (including "not
// configured", or every configured provider failing after its own retries)
// just lands in aiSummaryState[type].error — already a friendly, human
// -readable message (see ai-summary.js) — rather than breaking anything, and
// previously-generated entries are left untouched.
//
// `onUpdate`, when given, is called once the new entry lands in
// aiSummaryState[type].entries — callers pass in whichever
// saveDiffCrawlSnapshot/saveDiffSnapshot/saveAnalysisSnapshot already
// applies to this phase, so the freshly-generated summary is written into
// history using the SAME record-building logic as everything else (pages,
// results, link data), rather than a separate side-write that could race
// against session changes or silently disagree with what's on disk.
//
// `lastAttempt` is remembered on aiSummaryState[type] so a failed attempt
// can be manually retried later (see the /retry endpoint below) without the
// caller having to reconstruct reportType/dataObject/onUpdate from scratch.
function triggerAiSummary(type, reportType, dataObject, onUpdate) {
  const myGen = aiSummaryGen[type];
  aiSummaryState[type] = {
    status: 'generating',
    error: null,
    updatedAt: aiSummaryState[type].updatedAt,
    entries: aiSummaryState[type].entries,
    lastAttempt: { reportType, dataObject, onUpdate },
  };
  generateAiSummary(reportType, dataObject)
    .then(({ text, provider, usedFallback }) => {
      if (aiSummaryGen[type] !== myGen) return; // session was reset while this was generating — discard
      const entry = { reportType, text, html: markdownToHtml(text), provider, usedFallback, createdAt: new Date().toISOString() };
      const entries = [...aiSummaryState[type].entries, entry];
      aiSummaryState[type] = {
        status: 'done',
        error: null,
        updatedAt: entry.createdAt,
        entries,
        lastAttempt: { reportType, dataObject, onUpdate },
      };
      if (onUpdate) {
        try {
          onUpdate();
        } catch (e) {
          logErr(`failed to persist AI summary entry for ${type}`, e);
        }
      }
    })
    .catch((e) => {
      if (aiSummaryGen[type] !== myGen) return; // session was reset while this was generating — discard
      // e.message is already the friendly, human-readable version (built in
      // ai-summary.js); e.raw carries the full provider response for anyone
      // debugging from the terminal.
      logErr(`AI summary generation failed for ${type} (${reportType})`, e && e.raw ? e.raw : e);
      aiSummaryState[type] = {
        status: 'error',
        error: e && e.message ? e.message : String(e),
        updatedAt: new Date().toISOString(),
        entries: aiSummaryState[type].entries,
        lastAttempt: { reportType, dataObject, onUpdate },
      };
    });
}

// Saves/updates the Diff Inspector history row right after crawling BOTH
// sides finishes — this alone should already produce a downloadable
// "crawl only" report, even if testing is never run.
function saveDiffCrawlSnapshot() {
  try {
    if (!store.bench || !store.cand) return;
    const benchPages = Array.from(store.bench.pages.values());
    const candPages = Array.from(store.cand.pages.values());
    if (benchPages.length === 0 && candPages.length === 0) return;
    let matchedCount;
    if (diffPairMode === 'position') {
      matchedCount = Math.min(benchPages.length, candPages.length);
    } else {
      const candPaths = new Set(candPages.map((p) => p.path));
      matchedCount = benchPages.filter((p) => candPaths.has(p.path)).length;
    }
    const record = saveOrUpdateRun('diff', diffSessionId, {
      benchOrigin: store.bench.origin,
      candOrigin: store.cand.origin,
      benchCount: benchPages.length,
      candCount: candPages.length,
      benchPages,
      candPages,
      matchedCount,
      counts: { green: 0, red: 0, amber: 0 },
      results: [],
      testRun: false,
      aiSummaries: aiSummaryState.diff.entries,
    });
    diffSessionId = record.id;
  } catch (e) {
    logErr('failed to save diff crawl snapshot to history', e);
  }
}

// Updates the SAME Diff Inspector history row once testing completes,
// upgrading it from "crawl only" to a full report with the comparison
// ledger included.
function saveDiffSnapshot(results) {
  try {
    if (!results) return;
    const counts = { green: 0, red: 0, amber: 0 };
    results.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const record = saveOrUpdateRun('diff', diffSessionId, {
      benchOrigin: store.bench ? store.bench.origin : '',
      candOrigin: store.cand ? store.cand.origin : '',
      benchCount: store.bench ? store.bench.pages.size : 0,
      candCount: store.cand ? store.cand.pages.size : 0,
      benchPages: store.bench ? Array.from(store.bench.pages.values()) : [],
      candPages: store.cand ? Array.from(store.cand.pages.values()) : [],
      matchedCount: results.length,
      counts,
      results,
      testRun: true,
      aiSummaries: aiSummaryState.diff.entries,
    });
    diffSessionId = record.id;
  } catch (e) {
    logErr('failed to save diff run to history', e);
  }
}

// Saves/updates the Site Analysis history row — called after the crawl
// finishes (crawl-only report), and again after either the link scan or the
// Lighthouse scan completes, so the SAME row accumulates whichever checks
// have actually been run rather than spawning a new entry each time.
function saveAnalysisSnapshot() {
  try {
    const site = store.site;
    if (!site) return;
    const pages = Array.from(site.pages.values());
    if (pages.length === 0) return;

    let broken = 0, clean = 0, linkScannedCount = 0;
    pages.forEach((p) => {
      const r = linkScanState.results[p.path];
      if (r) { linkScannedCount++; if (r.status === 'red') broken++; else clean++; }
    });
    const lhEntries = Object.values(lighthouseState.results);
    const mobileScores = lhEntries.map((r) => r.mobile && r.mobile.score).filter((s) => typeof s === 'number');
    const desktopScores = lhEntries.map((r) => r.desktop && r.desktop.score).filter((s) => typeof s === 'number');
    const lighthouseScannedCount = Object.keys(lighthouseState.results).length;
    const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

    const record = saveOrUpdateRun('analysis', analysisSessionId, {
      siteOrigin: site.origin,
      pageCount: pages.length,
      linkScannedCount,
      brokenCount: broken,
      cleanCount: clean,
      lighthouseScannedCount,
      avgMobileScore: avg(mobileScores),
      avgDesktopScore: avg(desktopScores),
      pages,
      linkResults: linkScanState.results,
      lhResults: lighthouseState.results,
      aiSummaries: aiSummaryState.analysis.entries,
    });
    analysisSessionId = record.id;
  } catch (e) {
    logErr('failed to save analysis run to history', e);
  }
}

app.get('/api/progress/:slot', (req, res) => {
  const { slot } = req.params;
  if (!VALID_SLOTS.includes(slot)) {
    return res.status(400).json({ ok: false, error: `slot must be one of: ${VALID_SLOTS.join(', ')}` });
  }
  res.json({ ok: true, ...progress[slot] });
});

// ---------------------------------------------------------------------------
// Session reset — called by the UI when the person switches between "Crawl a
// site" / "Use a URL list" / "Load from history" and confirms the warning.
// Clears EVERYTHING the server holds for that tool (crawled pages, progress,
// test/scan results, AI summaries, per-row detail caches, history session
// id) so the next poll or report download reflects a clean slate, exactly
// as if the app had just been opened. Any crawl still running for the
// tool's slots is cancelled. A test or scan loop that's mid-run can't be
// safely interrupted (it would keep writing into the state being cleared),
// so the reset is refused with 409 in that case and the UI keeps its state.
// ---------------------------------------------------------------------------

function cancelCrawl(slot) {
  if (activeStop[slot]) {
    try { activeStop[slot](); } catch (e) { /* best-effort */ }
    activeStop[slot] = null;
  }
  crawlGeneration[slot] += 1; // any in-flight crawl response for this slot is now stale
  store[slot] = null;
  progress[slot] = { status: 'idle', found: 0, total: 0, error: null, pages: [] };
}

app.post('/api/reset/:type', (req, res) => {
  const { type } = req.params;
  if (type !== 'diff' && type !== 'analysis') {
    return res.status(400).json({ ok: false, error: 'type must be "diff" or "analysis"' });
  }

  if (type === 'diff') {
    if (testRunning) {
      return res.status(409).json({ ok: false, error: 'A comparison test is still running. Wait for it to finish before switching modes.' });
    }
    cancelCrawl('bench');
    cancelCrawl('cand');
    diffSessionId = null;
    diffPairMode = 'path';
    testState.status = 'idle';
    testState.done = 0;
    testState.total = 0;
    testState.error = null;
    testState.results = [];
    resetTestPageDetailsState();
    resetAiSummaryState('diff');
  } else {
    if (linkScanRunning || lighthouseRunning) {
      return res.status(409).json({ ok: false, error: 'A scan is still running. Wait for it to finish before switching modes.' });
    }
    cancelCrawl('site');
    analysisSessionId = null;
    linkScanState.status = 'idle';
    linkScanState.done = 0;
    linkScanState.total = 0;
    linkScanState.error = null;
    linkScanState.results = {};
    lighthouseState.status = 'idle';
    lighthouseState.done = 0;
    lighthouseState.total = 0;
    lighthouseState.error = null;
    lighthouseState.results = {};
    resetPageForecastState();
    resetAiSummaryState('analysis');
  }

  res.json({ ok: true });
});

app.post('/api/crawl/:slot', async (req, res) => {
  const { slot } = req.params;
  if (!VALID_SLOTS.includes(slot)) {
    return res.status(400).json({ ok: false, error: `slot must be one of: ${VALID_SLOTS.join(', ')}` });
  }
  const { url, maxPages, mode, urls, historyType, historyId, historySide } = req.body || {};
  const isListMode = mode === 'list';
  const isHistoryMode = mode === 'history';

  if (!isListMode && !isHistoryMode && (!url || !url.trim())) {
    return res.status(400).json({ ok: false, error: 'url is required' });
  }
  if (isListMode && (!Array.isArray(urls) || urls.filter((u) => String(u || '').trim()).length === 0)) {
    return res.status(400).json({ ok: false, error: 'At least one URL is required in the list.' });
  }
  if (isHistoryMode && (!historyType || !historyId)) {
    return res.status(400).json({ ok: false, error: 'historyType and historyId are required in history mode.' });
  }

  // Cancel whatever's already running for this slot before starting fresh —
  // otherwise the old one keeps going in the background and stomps on this
  // new one's progress/results.
  if (activeStop[slot]) {
    try { activeStop[slot](); } catch (e) { /* best-effort */ }
    activeStop[slot] = null;
  }

  // A fresh "Crawl sites" / "Crawl Site" click starts a brand new session —
  // reset the session id (so the next history save creates a new row, not an
  // update to a stale one) and clear any leftover phase state from a
  // previous crawl so it can't leak into this session's history snapshot.
  // 'bench' is always crawled first in the Diff Inspector flow, so that's
  // the right moment to reset for that tool.
  if (slot === 'bench') {
    diffSessionId = null;
    diffPairMode = isListMode ? 'position' : 'path';
    testState.status = 'idle';
    testState.done = 0;
    testState.total = 0;
    testState.error = null;
    testState.results = [];
    resetTestPageDetailsState();
    resetAiSummaryState('diff');
  }
  if (slot === 'site') {
    analysisSessionId = null;
    linkScanState.status = 'idle';
    linkScanState.done = 0;
    linkScanState.total = 0;
    linkScanState.error = null;
    linkScanState.results = {};
    lighthouseState.status = 'idle';
    lighthouseState.done = 0;
    lighthouseState.total = 0;
    lighthouseState.error = null;
    lighthouseState.results = {};
    resetPageForecastState();
    resetAiSummaryState('analysis');
  }

  const myGen = ++crawlGeneration[slot];
  const startUrl = isListMode ? null : (isHistoryMode ? null : ensureUrl(url.trim()));

  function safeOrigin(u) {
    try { return new URL(u).origin; } catch (e) { return ''; }
  }

  progress[slot] = { status: 'running', found: 0, total: 0, error: null, pages: [] };

  // History mode is a simple disk read, not a crawl — no Playwright, no
  // progress polling needed, resolves near-instantly. Handled as its own
  // early-return path rather than threading a third branch through all the
  // crawl/list machinery below.
  if (isHistoryMode) {
    try {
      const run = getRun(historyType, historyId);
      if (!run) {
        throw new Error('That saved crawl could not be found — it may have been deleted or pruned.');
      }
      let sourcePages, origin;
      if (historyType === 'diff') {
        if (historySide === 'bench') { sourcePages = run.benchPages; origin = run.benchOrigin; }
        else if (historySide === 'cand') { sourcePages = run.candPages; origin = run.candOrigin; }
        else throw new Error('historySide must be "bench" or "cand" for a diff-type saved crawl.');
      } else if (historyType === 'analysis') {
        sourcePages = run.pages;
        origin = run.siteOrigin;
      } else {
        throw new Error('historyType must be "diff" or "analysis".');
      }
      if (!sourcePages || sourcePages.length === 0) {
        throw new Error('That saved crawl has no pages to load.');
      }
      if (crawlGeneration[slot] !== myGen) {
        return res.status(409).json({ ok: false, error: 'Superseded by a newer crawl request for this slot.' });
      }
      const pages = sourcePages.map((p) => ({ title: p.title, url: p.url, path: p.path }));
      store[slot] = { origin: origin || '', pages: new Map(pages.map((p) => [p.path, p])) };
      progress[slot] = { status: 'done', found: pages.length, total: pages.length, error: null, pages };
      if (slot === 'cand') {
        saveDiffCrawlSnapshot();
        triggerAiSummary('diff', 'Site Diff — Crawl', {
          benchmarkOrigin: store.bench ? store.bench.origin : '',
          benchmarkPageCount: store.bench ? store.bench.pages.size : 0,
          candidateOrigin: store.cand.origin,
          candidatePageCount: store.cand.pages.size,
        }, saveDiffCrawlSnapshot);
      }
      if (slot === 'site') {
        saveAnalysisSnapshot();
        triggerAiSummary('analysis', 'Site Analysis — Crawl', {
          siteOrigin: store.site.origin,
          pageCount: store.site.pages.size,
        }, saveAnalysisSnapshot);
      }
      return res.json({ ok: true, count: pages.length, pages, invalidCount: 0, loadedFromHistory: true });
    } catch (e) {
      logErr(`history load failed for slot "${slot}"`, e);
      progress[slot] = { status: 'error', found: 0, total: 0, error: e.message || String(e), pages: [] };
      return res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  }

  const commonOpts = {
    userAgent: process.env.CRAWLER_USER_AGENT ||
      `SiteDiffInspectorBot/1.0 (+internal QA tool; contact: ${process.env.CONTACT_EMAIL || 'set CONTACT_EMAIL env var'})`,
    registerStop: (stopFn) => { activeStop[slot] = stopFn; },
    onProgress: ({ found, total, pages }) => {
      if (crawlGeneration[slot] !== myGen) return; // superseded — ignore stale updates
      progress[slot].found = found;
      progress[slot].total = total;
      progress[slot].pages = pages;
      // In list mode the "origin" isn't known upfront (the list can span
      // multiple domains) — best-effort it from whatever's rendered so far,
      // falling back to the first requested URL before anything's finished.
      const origin = isListMode
        ? (pages[0] ? safeOrigin(pages[0].url) : safeOrigin((urls || [])[0]))
        : safeOrigin(startUrl);
      store[slot] = { origin, pages: new Map(pages.map((p) => [p.path, p])) };
    },
  };

  try {
    const result = isListMode
      ? await renderUrlList(urls, { maxPages: maxPages || 500, ...commonOpts })
      : await crawlSite(startUrl, { maxPages: maxPages || 500, ...commonOpts });

    if (crawlGeneration[slot] !== myGen) {
      // A newer crawl started while this one was finishing up — don't let
      // this stale result overwrite it.
      return res.status(409).json({ ok: false, error: 'Superseded by a newer crawl request for this slot.' });
    }
    activeStop[slot] = null;
    store[slot] = result;
    const pages = Array.from(result.pages.values()).map((p) => ({
      title: p.title,
      url: p.url,
      path: p.path,
    }));
    progress[slot] = { status: 'done', found: pages.length, total: pages.length, error: null, pages };

    // 'cand' is crawled second in the Diff Inspector flow (after 'bench'),
    // and 'site' is the only slot Site Analysis uses — both are the right
    // moment to save a "crawl only" history snapshot, since it's already a
    // complete, downloadable report even if no further testing/scanning
    // happens afterward.
    if (slot === 'cand') {
      saveDiffCrawlSnapshot();
      triggerAiSummary('diff', 'Site Diff — Crawl', {
        benchmarkOrigin: store.bench ? store.bench.origin : '',
        benchmarkPageCount: store.bench ? store.bench.pages.size : 0,
        candidateOrigin: store.cand.origin,
        candidatePageCount: store.cand.pages.size,
      }, saveDiffCrawlSnapshot);
    }
    if (slot === 'site') {
      saveAnalysisSnapshot();
      triggerAiSummary('analysis', 'Site Analysis — Crawl', {
        siteOrigin: store.site.origin,
        pageCount: store.site.pages.size,
      }, saveAnalysisSnapshot);
    }

    res.json({ ok: true, count: pages.length, pages, invalidCount: result.invalidCount || 0 });
  } catch (e) {
    if (crawlGeneration[slot] !== myGen) {
      return res.status(409).json({ ok: false, error: 'Superseded by a newer crawl request for this slot.' });
    }
    logErr(`crawl failed for slot "${slot}"`, e);
    activeStop[slot] = null;
    const partialPages = progress[slot].pages || [];
    progress[slot] = {
      status: 'error',
      found: partialPages.length,
      total: progress[slot].total,
      error: e && e.message ? e.message : String(e),
      pages: partialPages,
    };
    res.status(500).json({
      ok: false,
      error: e && e.message ? e.message : String(e),
      partialPages,
      partialCount: partialPages.length,
    });
  }
});

app.get('/api/pages/:slot', (req, res) => {
  const { slot } = req.params;
  const s = store[slot];
  if (!s) return res.json({ ok: true, pages: [] });
  const pages = Array.from(s.pages.values()).map((p) => ({
    title: p.title,
    url: p.url,
    path: p.path,
  }));
  res.json({ ok: true, pages });
});

const testState = { status: 'idle', done: 0, total: 0, error: null, results: [] };
let testRunning = false;

app.get('/api/test/progress', (req, res) => {
  res.json({ ok: true, ...testState });
});

app.post('/api/test', async (req, res) => {
  if (!store.bench || !store.cand) {
    return res.status(400).json({ ok: false, error: 'Crawl both the benchmark and candidate sites first.' });
  }
  if (testRunning) {
    return res.status(409).json({ ok: false, error: 'A test run is already in progress.' });
  }

  let pairs = []; // [{ benchPage, candPage }]
  if (diffPairMode === 'position') {
    // URL-list mode: the Nth benchmark URL is compared against the Nth
    // candidate URL, full stop — paths, domains, and structures don't need
    // to correspond at all. Extra entries on the longer side are left
    // unpaired (nothing sensible to compare them against).
    const benchList = Array.from(store.bench.pages.values());
    const candList = Array.from(store.cand.pages.values());
    const count = Math.min(benchList.length, candList.length);
    for (let i = 0; i < count; i++) {
      pairs.push({ benchPage: benchList[i], candPage: candList[i] });
    }
  } else {
    const matchedPaths = [];
    store.bench.pages.forEach((_, pathKey) => {
      if (store.cand.pages.has(pathKey)) matchedPaths.push(pathKey);
    });
    pairs = matchedPaths.map((pathKey) => ({ benchPage: store.bench.pages.get(pathKey), candPage: store.cand.pages.get(pathKey) }));
  }

  if (pairs.length === 0) {
    testState.status = 'done';
    testState.done = 0;
    testState.total = 0;
    testState.results = [];
    testState.error = null;
    return res.json({ ok: true, results: [] });
  }

  testRunning = true;
  testState.status = 'running';
  testState.done = 0;
  testState.total = pairs.length;
  testState.results = [];
  testState.error = null;
  resetTestPageDetailsState();

  let browser;
  const results = [];

  try {
    browser = await chromium.launch();
    const context = await browser.newContext();

    for (const { benchPage, candPage } of pairs) {

      // Small pacing gap between matched-page checks — same politeness reasoning
      // as the crawl phase, so testing doesn't itself look like a request burst.
      await new Promise((r) => setTimeout(r, 400));

      let benchOk = true, candOk = true, benchStatus = 0, candStatus = 0;
      let benchText = '', candText = '';
      let benchLinks = new Set(), candLinks = new Set();
      let benchAssets = new Set(), candAssets = new Set();
      let benchTitle = '', candTitle = '';

      try {
        const p1 = await context.newPage();
        const r1 = await p1.goto(benchPage.url, { waitUntil: 'networkidle', timeout: 15000 });
        benchStatus = r1 ? r1.status() : 0;
        benchOk = !!r1 && r1.ok();
        // Visible text only — this is what a reader actually sees. Tracking
        // scripts, GTM containers, ad iframes, and other injected noise are
        // invisible (display:none, empty script/iframe tags), so this sidesteps
        // almost all of the false-positive "changed" noise a full HTML diff hits.
        benchText = await p1.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        benchLinks = await extractPageLinks(p1, benchPage.url);
        benchAssets = await extractPageAssets(p1, benchPage.url);
        benchTitle = await p1.title().catch(() => '');
        await p1.close();
      } catch (e) {
        logErr(`test: benchmark page fetch failed for ${benchPage.url}`, e);
        benchOk = false;
      }

      try {
        const p2 = await context.newPage();
        const r2 = await p2.goto(candPage.url, { waitUntil: 'networkidle', timeout: 15000 });
        candStatus = r2 ? r2.status() : 0;
        candOk = !!r2 && r2.ok();
        candText = await p2.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        candLinks = await extractPageLinks(p2, candPage.url);
        candAssets = await extractPageAssets(p2, candPage.url);
        candTitle = await p2.title().catch(() => '');
        await p2.close();
      } catch (e) {
        logErr(`test: candidate page fetch failed for ${candPage.url}`, e);
        candOk = false;
      }

      // Static-asset (CSS/JS/icon/manifest) comparison — informational only,
      // doesn't affect the equal/changed/links-differ status above. Computed
      // whenever both pages actually rendered, regardless of what that
      // status came out to, since an asset change can matter even when the
      // visible content and links are identical.
      let assetDiff = null;
      if (benchOk && candOk) {
        const assetsOnlyInBench = [...benchAssets].filter((a) => !candAssets.has(a));
        const assetsOnlyInCand = [...candAssets].filter((a) => !benchAssets.has(a));
        if (assetsOnlyInBench.length > 0 || assetsOnlyInCand.length > 0) {
          assetDiff = { onlyInBench: assetsOnlyInBench, onlyInCand: assetsOnlyInCand };
        }
      }

      let status, detail, broken = [], diffSnippet = null;

      if (!benchOk || !candOk) {
        status = 'red';
        const whom = !benchOk && !candOk ? 'Both pages' : !benchOk ? 'Benchmark page' : 'Candidate page';
        detail = `${whom} unreachable (HTTP ${!benchOk ? benchStatus || 'error' : candStatus || 'error'}).`;
      } else {
        const normBenchText = normalizeSource(benchText);
        const normCandText = normalizeSource(candText);
        if (normBenchText !== normCandText) {
          status = 'red';
          const div = firstDivergence(normBenchText, normCandText);
          detail = 'Visible text content differs between benchmark and candidate (this compares what a reader actually sees — markup, scripts, and tracking-tag noise are ignored).';
          if (div) {
            detail += ` Benchmark is ${div.benchLength} chars, candidate is ${div.candLength} chars — first difference around character ${div.index}.`;
            diffSnippet = div;
          }
        } else {
          // Content matches — now compare the LINK SETS between benchmark and
          // candidate. This is deliberately a diff (did the page gain or lose
          // links), not a live health check of whether each link resolves —
          // Site Analysis already covers broken-link health checking on its
          // own, and a benchmark/candidate pair sharing the same broken
          // external link isn't a meaningful "changed" signal here.
          const onlyInBench = [...benchLinks].filter((l) => !candLinks.has(l));
          const onlyInCand = [...candLinks].filter((l) => !benchLinks.has(l));
          if (onlyInBench.length > 0 || onlyInCand.length > 0) {
            status = 'amber';
            const parts = [];
            if (onlyInBench.length) parts.push(`${onlyInBench.length} link(s) present on benchmark but missing on candidate`);
            if (onlyInCand.length) parts.push(`${onlyInCand.length} link(s) present on candidate but not on benchmark`);
            detail = `Visible content matches. ${parts.join('; ')}.`;
            broken = [...onlyInBench.map((l) => `\u2212 ${l}`), ...onlyInCand.map((l) => `+ ${l}`)];
          } else {
            status = 'green';
            detail = `Visible content matches. All ${benchLinks.size} link(s) match between benchmark and candidate.`;
          }
        }
      }

      results.push({
        benchPath: benchPage.path,
        candPath: candPage.path,
        benchUrl: benchPage.url,
        candUrl: candPage.url,
        benchTitle,
        candTitle,
        status,
        detail,
        broken,
        diffSnippet,
        assetDiff,
      });
      testState.done = results.length;
      testState.results = results.slice();
    }
  } catch (e) {
    logErr('test run failed', e);
    testRunning = false;
    testState.status = 'error';
    testState.error = e && e.message ? e.message : String(e);
    saveDiffSnapshot(results); // partial results are still worth keeping
    return res.status(500).json({
      ok: false,
      error: e && e.message ? e.message : String(e),
      partialResults: results,
    });
  } finally {
    if (browser) await browser.close();
  }

  testRunning = false;
  testState.status = 'done';
  saveDiffSnapshot(results);
  {
    const counts = { green: 0, red: 0, amber: 0 };
    results.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    triggerAiSummary('diff', 'Site Diff — Comparison Test', {
      benchmarkOrigin: store.bench ? store.bench.origin : '',
      candidateOrigin: store.cand ? store.cand.origin : '',
      matchedPages: results.length,
      equalCount: counts.green,
      changedCount: counts.red,
      linksDifferCount: counts.amber,
      sampleChangedPages: results.filter((r) => r.status === 'red').slice(0, 15).map((r) => ({ benchPath: r.benchPath, candPath: r.candPath, detail: r.detail })),
      sampleLinksDifferPages: results.filter((r) => r.status === 'amber').slice(0, 15).map((r) => ({ benchPath: r.benchPath, candPath: r.candPath, detail: r.detail })),
    }, () => saveDiffSnapshot(results));
  }
  res.json({ ok: true, results });
});

// ---------------------------------------------------------------------------
// Diff Inspector: per-pair "view details" — a side-by-side source diff and
// full-page screenshots for ONE matched/paired result, fetched on demand
// when the person clicks that row's details icon. Deliberately NOT computed
// for every pair during the bulk /api/test run above: a full-page screenshot
// plus a full HTML capture for every page would multiply the cost of a scan
// that might already cover dozens or hundreds of pairs, for detail most
// people will only ever look at for a handful of rows they're actually
// investigating. Results are cached per result index so reopening the same
// row's popup doesn't re-fetch; the cache is cleared whenever a new test
// run (or a fresh benchmark crawl) makes the old indexes stale.
// ---------------------------------------------------------------------------

const testPageDetailsState = {};

function resetTestPageDetailsState() {
  Object.keys(testPageDetailsState).forEach((k) => delete testPageDetailsState[k]);
}

// Loads one URL in its own fresh browser, capturing both the full HTML
// source (for the diff) and a full-page screenshot (for the layout tab) in
// the same page visit — one navigation serves both tabs of the popup rather
// than loading the page twice. JPEG at a moderate quality keeps the
// screenshot payload reasonable for long pages without needing PNG's exact
// pixel fidelity for a visual layout comparison. Never throws — a failed
// capture just comes back with empty html/null screenshot and an `error`
// note, so the diff can still render (as "everything added/removed" against
// an empty document) rather than the whole popup failing.
async function captureFullPage(url) {
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    const ok = !!resp && resp.ok();
    const html = await page.content().catch(() => '');
    const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 70 }).catch(() => null);
    const screenshot = screenshotBuffer ? `data:image/jpeg;base64,${screenshotBuffer.toString('base64')}` : null;
    return { html, screenshot, error: ok ? null : `Page responded with HTTP ${resp ? resp.status() : 'error'}` };
  } catch (e) {
    return { html: '', screenshot: null, error: e && e.message ? e.message : String(e) };
  } finally {
    if (browser) await browser.close();
  }
}

function triggerTestPageDetails(index) {
  const pair = testState.results[index];
  testPageDetailsState[index] = {
    status: 'generating',
    error: null,
    updatedAt: testPageDetailsState[index] ? testPageDetailsState[index].updatedAt : null,
  };

  (async () => {
    try {
      const [benchCapture, candCapture] = await Promise.all([
        captureFullPage(pair.benchUrl),
        captureFullPage(pair.candUrl),
      ]);
      const { rows, truncated, identical } = diffHtml(benchCapture.html, candCapture.html);
      testPageDetailsState[index] = {
        status: 'done',
        error: null,
        updatedAt: new Date().toISOString(),
        diffRows: rows,
        truncated,
        identical,
        benchScreenshot: benchCapture.screenshot,
        candScreenshot: candCapture.screenshot,
        benchError: benchCapture.error,
        candError: candCapture.error,
      };
    } catch (e) {
      logErr(`test page-details failed for result index ${index}`, e);
      testPageDetailsState[index] = {
        status: 'error',
        error: e && e.message ? e.message : String(e),
        updatedAt: new Date().toISOString(),
      };
    }
  })();
}

app.post('/api/test/page-details', (req, res) => {
  const { index } = req.body || {};
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= testState.results.length) {
    return res.status(400).json({ ok: false, error: 'A valid result index is required.' });
  }
  const existing = testPageDetailsState[index];
  if (existing && existing.status === 'generating') {
    return res.json({ ok: true, alreadyRunning: true });
  }
  triggerTestPageDetails(index);
  res.json({ ok: true });
});

app.get('/api/test/page-details', (req, res) => {
  const index = req.query && req.query.index !== undefined ? Number(req.query.index) : NaN;
  if (!Number.isInteger(index)) {
    return res.status(400).json({ ok: false, error: 'A valid result index is required.' });
  }
  const state = testPageDetailsState[index] || { status: 'idle', error: null, updatedAt: null };
  res.json({ ok: true, ...state });
});

// ---------------------------------------------------------------------------
// Site Analysis: single-site link scan + Lighthouse performance scoring.
// Both report results per-page (keyed by path) as they complete, rather than
// only at the end — the UI polls and fills in each row's status individually
// (a spinner cell until that page's entry appears) instead of a single global
// progress bar.
// ---------------------------------------------------------------------------

const linkScanState = { status: 'idle', done: 0, total: 0, error: null, results: {} };
let linkScanRunning = false;

app.get('/api/analysis/linkscan/progress', (req, res) => {
  res.json({ ok: true, ...linkScanState });
});

app.post('/api/analysis/linkscan', async (req, res) => {
  const site = store.site;
  if (!site) {
    return res.status(400).json({ ok: false, error: 'Crawl the site first.' });
  }
  if (linkScanRunning) {
    return res.status(409).json({ ok: false, error: 'A link scan is already running.' });
  }

  const pages = Array.from(site.pages.values());
  linkScanRunning = true;
  linkScanState.status = 'running';
  linkScanState.done = 0;
  linkScanState.total = pages.length;
  linkScanState.results = {};
  linkScanState.error = null;

  try {
    for (const page of pages) {
      // Same politeness pacing as everywhere else in this app.
      await new Promise((r) => setTimeout(r, 300));
      try {
        const linkResult = await withTimeout(checkPageLinks(page.url, 50), 45000, `Link scan for ${page.url}`);
        linkScanState.results[page.path] = {
          checked: linkResult.checked,
          broken: linkResult.broken,
          status: linkResult.broken.length > 0 ? 'red' : 'green',
        };
      } catch (e) {
        logErr(`link scan failed for ${page.url}`, e);
        linkScanState.results[page.path] = {
          checked: 0,
          broken: [`Link scan failed: ${e && e.message ? e.message : e}`],
          status: 'red',
        };
      }
      linkScanState.done += 1;
    }
    linkScanRunning = false;
    linkScanState.status = 'done';
    saveAnalysisSnapshot();
    {
      let broken = 0, clean = 0;
      const brokenSamples = [];
      pages.forEach((p) => {
        const r = linkScanState.results[p.path];
        if (!r) return;
        if (r.status === 'red') {
          broken++;
          if (brokenSamples.length < 15) brokenSamples.push({ path: p.path, brokenLinks: r.broken });
        } else {
          clean++;
        }
      });
      triggerAiSummary('analysis', 'Site Analysis — Broken Link Scan', {
        siteOrigin: site.origin,
        pageCount: pages.length,
        brokenPageCount: broken,
        cleanPageCount: clean,
        sampleBrokenPages: brokenSamples,
      }, saveAnalysisSnapshot);
    }
    res.json({ ok: true, results: linkScanState.results });
  } catch (e) {
    logErr('link scan run failed', e);
    linkScanRunning = false;
    linkScanState.status = 'error';
    linkScanState.error = e && e.message ? e.message : String(e);
    res.status(500).json({ ok: false, error: linkScanState.error, partialResults: linkScanState.results });
  }
});

const lighthouseState = { status: 'idle', done: 0, total: 0, error: null, results: {} };
let lighthouseRunning = false;

// Per-page "assess these recommendations" AI forecast, triggered on demand
// from the page-score details popup (NOT part of the phase-summary
// `entries` history — it's an ephemeral, per-page interactive tool). Keyed
// by page path; reset whenever new Lighthouse results supersede the old
// ones, since a stale forecast talking about recommendations that no longer
// apply would be actively misleading.
const pageForecastState = {};

function resetPageForecastState() {
  Object.keys(pageForecastState).forEach((k) => delete pageForecastState[k]);
}

// Builds the payload sent to the AI for a single page's forecast — current
// scores, Core Web Vitals, and full recommendation list (not capped to 3
// like the site-wide phase-summary payload, since this is about ONE page).
function buildPageForecastPayload(pagePath, page) {
  const entry = lighthouseState.results[pagePath] || {};
  const formFactor = (r) => ({
    score: r && typeof r.score === 'number' ? r.score : null,
    vitals: (r && r.vitals) || null,
    recommendations: (r && r.recommendations) || [],
  });
  return {
    pageTitle: page ? page.title : pagePath,
    path: pagePath,
    mobile: formFactor(entry.mobile),
    desktop: formFactor(entry.desktop),
  };
}

function triggerPageForecast(pagePath) {
  const site = store.site;
  const page = site ? Array.from(site.pages.values()).find((p) => p.path === pagePath) : null;
  const payload = buildPageForecastPayload(pagePath, page);

  pageForecastState[pagePath] = {
    status: 'generating',
    text: '',
    html: '',
    error: null,
    updatedAt: pageForecastState[pagePath] ? pageForecastState[pagePath].updatedAt : null,
  };
  generatePageForecast('Site Analysis — Page Score Forecast', payload)
    .then(({ text }) => {
      pageForecastState[pagePath] = { status: 'done', text, html: markdownToHtml(text), error: null, updatedAt: new Date().toISOString() };
    })
    .catch((e) => {
      logErr(`page score forecast failed for ${pagePath}`, e && e.raw ? e.raw : e);
      pageForecastState[pagePath] = {
        status: 'error',
        text: '',
        html: '',
        error: e && e.message ? e.message : String(e),
        updatedAt: new Date().toISOString(),
      };
    });
}

app.get('/api/analysis/lighthouse/progress', (req, res) => {
  res.json({ ok: true, ...lighthouseState });
});

// Triggers (or re-triggers) the AI forecast for one page's already-scanned
// Lighthouse results. The vitals/recommendations data itself comes from
// lighthouseState.results (populated by the scan above) — this endpoint
// only kicks off the AI call and returns immediately; the frontend polls
// the GET endpoint below for the result, same pattern as the phase summary.
app.post('/api/analysis/page-forecast', (req, res) => {
  const { path: pagePath } = req.body || {};
  if (!pagePath) return res.status(400).json({ ok: false, error: 'path is required' });
  const entry = lighthouseState.results[pagePath];
  if (!entry || (!entry.mobile && !entry.desktop)) {
    return res.status(400).json({ ok: false, error: 'No page-score results for this page yet — run "Scan for Page Score" first.' });
  }
  const existing = pageForecastState[pagePath];
  if (existing && existing.status === 'generating') {
    return res.json({ ok: true, alreadyRunning: true });
  }
  triggerPageForecast(pagePath);
  res.json({ ok: true });
});

app.get('/api/analysis/page-forecast', (req, res) => {
  const pagePath = req.query && req.query.path;
  if (!pagePath) return res.status(400).json({ ok: false, error: 'path is required' });
  const state = pageForecastState[pagePath] || { status: 'idle', text: '', html: '', error: null, updatedAt: null };
  res.json({ ok: true, ...state });
});

app.post('/api/analysis/lighthouse', async (req, res) => {
  const site = store.site;
  if (!site) {
    return res.status(400).json({ ok: false, error: 'Crawl the site first.' });
  }
  if (lighthouseRunning) {
    return res.status(409).json({ ok: false, error: 'A performance scan is already running.' });
  }

  // Lighthouse is slow (10-20s per audit, full simulated-throttle passes) —
  // scoring every page of a large site by default would take hours. Cap it
  // explicitly rather than silently running forever. Each page gets both a
  // mobile and a desktop audit, so total work is 2x the page count.
  const requested = req.body && req.body.maxPages;
  const cap = Number.isFinite(+requested) && +requested > 0 ? Math.min(Math.floor(+requested), 200) : 15;
  const allPages = Array.from(site.pages.values());
  const pages = allPages.slice(0, cap);

  lighthouseRunning = true;
  lighthouseState.status = 'running';
  lighthouseState.done = 0;
  lighthouseState.total = pages.length * 2;
  lighthouseState.results = {};
  lighthouseState.error = null;

  // Runs a Lighthouse audit, retrying once on failure — most failures on a
  // long run (timeout, "Chrome prevented page load with an interstitial")
  // are transient resource pressure from launching Chrome hundreds of times
  // in a row, not a real problem with that page, and usually succeed on a
  // second attempt once resources settle. Only retries once, so a genuinely
  // broken page still fails fast rather than doubling total time for nothing.
  async function runLighthouseWithRetry(url, opts, label) {
    try {
      return await withTimeout(runLighthouse(url, opts), 75000, label);
    } catch (firstErr) {
      console.error(`[lighthouse] ${label} failed, retrying once:`, firstErr.message || firstErr);
      await new Promise((r) => setTimeout(r, 1500)); // brief pause before retrying
      return withTimeout(runLighthouse(url, opts), 75000, label);
    }
  }

  try {
    for (const page of pages) {
      lighthouseState.results[page.path] = lighthouseState.results[page.path] || {};

      try {
        const { score, vitals, recommendations } = await runLighthouseWithRetry(page.url, { formFactor: 'mobile' }, `Lighthouse mobile audit for ${page.url}`);
        lighthouseState.results[page.path].mobile = { score, vitals, recommendations, error: null };
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error(`[lighthouse] mobile audit failed for ${page.url}:`, e);
        lighthouseState.results[page.path].mobile = { score: null, vitals: null, recommendations: null, error: msg };
      }
      lighthouseState.done += 1;

      // Brief pacing gap between audits — gives the OS a moment to fully
      // reclaim the previous Chrome instance's resources before the next
      // launch, instead of launching back-to-back at maximum rate for
      // potentially 700 launches in a row.
      await new Promise((r) => setTimeout(r, 500));

      try {
        const { score, vitals, recommendations } = await runLighthouseWithRetry(page.url, { formFactor: 'desktop' }, `Lighthouse desktop audit for ${page.url}`);
        lighthouseState.results[page.path].desktop = { score, vitals, recommendations, error: null };
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error(`[lighthouse] desktop audit failed for ${page.url}:`, e);
        lighthouseState.results[page.path].desktop = { score: null, vitals: null, recommendations: null, error: msg };
      }
      lighthouseState.done += 1;

      await new Promise((r) => setTimeout(r, 500));
    }
    lighthouseRunning = false;
    lighthouseState.status = 'done';
    resetPageForecastState(); // new scan results supersede any cached per-page forecasts
    saveAnalysisSnapshot();
    {
      // Recommendations aren't shown as a raw table anywhere in the UI, but
      // they ARE fed into the AI summary here (and saved to history as part
      // of lighthouseState.results via saveAnalysisSnapshot above) so the
      // generated summary can speak to actual bottlenecks, not just scores.
      const summarizeRecs = (entry) =>
        entry && Array.isArray(entry.recommendations)
          ? entry.recommendations.slice(0, 3).map((r) => ({ title: r.title, estimatedSavings: r.displayValue || null }))
          : [];

      const scored = pages.map((p) => {
        const r = lighthouseState.results[p.path] || {};
        return {
          path: p.path,
          mobile: r.mobile && typeof r.mobile.score === 'number' ? r.mobile.score : null,
          desktop: r.desktop && typeof r.desktop.score === 'number' ? r.desktop.score : null,
          mobileVitals: r.mobile ? r.mobile.vitals : null,
          desktopVitals: r.desktop ? r.desktop.vitals : null,
          mobileRecommendations: summarizeRecs(r.mobile),
          desktopRecommendations: summarizeRecs(r.desktop),
        };
      });
      const withScores = scored.filter((s) => s.mobile !== null || s.desktop !== null);
      const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
      const avgMobile = avg(withScores.map((s) => s.mobile).filter((n) => typeof n === 'number'));
      const avgDesktop = avg(withScores.map((s) => s.desktop).filter((n) => typeof n === 'number'));
      const worstPages = [...withScores]
        .sort((a, b) => (a.mobile ?? 100) + (a.desktop ?? 100) - ((b.mobile ?? 100) + (b.desktop ?? 100)))
        .slice(0, 10);

      // Which recommendation titles recur most often across pages — lets
      // the summary call out a shared/template-level fix rather than
      // repeating the same note page by page.
      const recommendationCounts = {};
      withScores.forEach((s) => {
        [...s.mobileRecommendations, ...s.desktopRecommendations].forEach((r) => {
          recommendationCounts[r.title] = (recommendationCounts[r.title] || 0) + 1;
        });
      });
      const commonRecommendations = Object.entries(recommendationCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([title, pagesAffected]) => ({ title, pagesAffected }));

      triggerAiSummary('analysis', 'Site Analysis — Page Performance Scan', {
        siteOrigin: site.origin,
        pagesScored: pages.length,
        avgMobileScore: avgMobile,
        avgDesktopScore: avgDesktop,
        commonRecommendations,
        worstScoringPages: worstPages,
      }, saveAnalysisSnapshot);
    }
    res.json({ ok: true, results: lighthouseState.results, scannedCount: pages.length, totalPages: allPages.length });
  } catch (e) {
    logErr('lighthouse run failed', e);
    lighthouseRunning = false;
    lighthouseState.status = 'error';
    lighthouseState.error = e && e.message ? e.message : String(e);
    res.status(500).json({ ok: false, error: lighthouseState.error, partialResults: lighthouseState.results });
  }
});

// ---------------------------------------------------------------------------
// Report downloads — CSV and PDF for both tools. PDFs are rendered server-
// side via Playwright's own print-to-PDF (no extra dependency); CSVs are
// plain text with a Content-Disposition header, so both are just a normal
// GET a browser downloads natively — no client-side JS needed to fetch them.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// History — every completed test/scan run is persisted to disk (see
// history.js) so past reports stay downloadable even after the in-memory
// state has moved on to a newer run.
// ---------------------------------------------------------------------------

app.get('/api/ai-summary/:type', (req, res) => {
  const { type } = req.params;
  if (type !== 'diff' && type !== 'analysis') {
    return res.status(400).json({ ok: false, error: 'type must be "diff" or "analysis"' });
  }
  // lastAttempt is internal bookkeeping for the /retry endpoint below (it
  // holds the raw data payload sent to the AI and a function reference) —
  // never worth sending to the client.
  const { lastAttempt, ...publicState } = aiSummaryState[type];
  res.json({ ok: true, ...publicState, canRetry: !!lastAttempt && publicState.status !== 'generating' });
});

// Manually re-runs the most recent AI summary attempt for this tool (same
// reportType/dataObject/onUpdate as whichever phase last triggered one) —
// the backstop for when automatic retries + fallback still didn't succeed,
// without making the person re-run the whole crawl/scan just to try again.
app.post('/api/ai-summary/:type/retry', (req, res) => {
  const { type } = req.params;
  if (type !== 'diff' && type !== 'analysis') {
    return res.status(400).json({ ok: false, error: 'type must be "diff" or "analysis"' });
  }
  const state = aiSummaryState[type];
  if (state.status === 'generating') {
    return res.status(409).json({ ok: false, error: 'A summary is already being generated.' });
  }
  if (!state.lastAttempt) {
    return res.status(400).json({ ok: false, error: 'Nothing to retry yet — run a crawl or scan first.' });
  }
  const { reportType, dataObject, onUpdate } = state.lastAttempt;
  triggerAiSummary(type, reportType, dataObject, onUpdate);
  res.json({ ok: true });
});

app.get('/api/history/diff', (req, res) => {
  try {
    res.json({ ok: true, runs: listRuns('diff') });
  } catch (e) {
    logErr('list diff history failed', e);
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

app.get('/api/history/analysis', (req, res) => {
  try {
    res.json({ ok: true, runs: listRuns('analysis') });
  } catch (e) {
    logErr('list analysis history failed', e);
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

// Combined, flattened list of every loadable page list across both history
// types — powers the "Load from history" mode on both tools. A diff-type
// session contributes up to two entries (its benchmark side, its candidate
// side); an analysis-type session contributes one.
app.get('/api/history/pagesets', (req, res) => {
  try {
    const options = [];
    listRuns('diff').forEach((r) => {
      if (r.benchCount > 0) {
        options.push({
          key: `diff:${r.id}:bench`,
          type: 'diff',
          id: r.id,
          side: 'bench',
          label: `Diff \u00b7 Benchmark \u00b7 ${r.benchOrigin || '?'} (${r.benchCount} pages) \u00b7 ${new Date(r.timestamp).toLocaleString()}`,
          pageCount: r.benchCount,
          timestamp: r.timestamp,
        });
      }
      if (r.candCount > 0) {
        options.push({
          key: `diff:${r.id}:cand`,
          type: 'diff',
          id: r.id,
          side: 'cand',
          label: `Diff \u00b7 Candidate \u00b7 ${r.candOrigin || '?'} (${r.candCount} pages) \u00b7 ${new Date(r.timestamp).toLocaleString()}`,
          pageCount: r.candCount,
          timestamp: r.timestamp,
        });
      }
    });
    listRuns('analysis').forEach((r) => {
      if (r.pageCount > 0) {
        options.push({
          key: `analysis:${r.id}`,
          type: 'analysis',
          id: r.id,
          side: null,
          label: `Analysis \u00b7 ${r.siteOrigin || '?'} (${r.pageCount} pages) \u00b7 ${new Date(r.timestamp).toLocaleString()}`,
          pageCount: r.pageCount,
          timestamp: r.timestamp,
        });
      }
    });
    options.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ ok: true, options });
  } catch (e) {
    logErr('list history pagesets failed', e);
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

app.get('/api/history/diff/:id/csv', (req, res) => {
  const run = getRun('diff', req.params.id);
  if (!run) return res.status(404).send('Run not found — it may have been pruned or deleted.');
  try {
    const csv = buildDiffCsv({ results: run.results, benchOrigin: run.benchOrigin, candOrigin: run.candOrigin, benchPages: run.benchPages, candPages: run.candPages, aiSummaries: run.aiSummaries || [] });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="site-diff-report-${filenameTimestamp(run.timestamp)}.csv"`);
    res.send(csv);
  } catch (e) {
    logErr('historical diff CSV failed', e);
    res.status(500).send('Failed to generate CSV report.');
  }
});

app.get('/api/history/diff/:id/pdf', async (req, res) => {
  const run = getRun('diff', req.params.id);
  if (!run) return res.status(404).send('Run not found — it may have been pruned or deleted.');
  try {
    const html = buildDiffPdfHtml({ results: run.results, benchOrigin: run.benchOrigin, candOrigin: run.candOrigin, benchPages: run.benchPages, candPages: run.candPages, aiSummaries: run.aiSummaries || [] });
    const buffer = await renderPdfFromHtml(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="site-diff-report-${filenameTimestamp(run.timestamp)}.pdf"`);
    res.send(buffer);
  } catch (e) {
    logErr('historical diff PDF failed', e);
    res.status(500).send('Failed to generate PDF report: ' + (e && e.message ? e.message : e));
  }
});

app.get('/api/history/analysis/:id/csv', (req, res) => {
  const run = getRun('analysis', req.params.id);
  if (!run) return res.status(404).send('Run not found — it may have been pruned or deleted.');
  try {
    const csv = buildAnalysisCsv({ pages: run.pages, linkResults: run.linkResults, lhResults: run.lhResults, siteOrigin: run.siteOrigin, aiSummaries: run.aiSummaries || [] });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="site-analysis-report-${filenameTimestamp(run.timestamp)}.csv"`);
    res.send(csv);
  } catch (e) {
    logErr('historical analysis CSV failed', e);
    res.status(500).send('Failed to generate CSV report.');
  }
});

app.get('/api/history/analysis/:id/pdf', async (req, res) => {
  const run = getRun('analysis', req.params.id);
  if (!run) return res.status(404).send('Run not found — it may have been pruned or deleted.');
  try {
    const html = buildAnalysisPdfHtml({ pages: run.pages, linkResults: run.linkResults, lhResults: run.lhResults, siteOrigin: run.siteOrigin, aiSummaries: run.aiSummaries || [] });
    const buffer = await renderPdfFromHtml(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="site-analysis-report-${filenameTimestamp(run.timestamp)}.pdf"`);
    res.send(buffer);
  } catch (e) {
    logErr('historical analysis PDF failed', e);
    res.status(500).send('Failed to generate PDF report: ' + (e && e.message ? e.message : e));
  }
});

app.delete('/api/history/:type/:id', (req, res) => {
  const { type, id } = req.params;
  if (type !== 'diff' && type !== 'analysis') {
    return res.status(400).json({ ok: false, error: 'type must be "diff" or "analysis"' });
  }
  try {
    const deleted = deleteRun(type, id);
    res.json({ ok: true, deleted });
  } catch (e) {
    logErr('delete history run failed', e);
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

app.get('/api/report/diff.csv', (req, res) => {
  try {
    const csv = buildDiffCsv({
      results: testState.results,
      benchOrigin: store.bench ? store.bench.origin : '',
      candOrigin: store.cand ? store.cand.origin : '',
      benchPages: store.bench ? Array.from(store.bench.pages.values()) : [],
      candPages: store.cand ? Array.from(store.cand.pages.values()) : [],
      aiSummaries: aiSummaryState.diff.entries,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="site-diff-report-${filenameTimestamp()}.csv"`);
    res.send(csv);
  } catch (e) {
    logErr('diff CSV report failed', e);
    res.status(500).send('Failed to generate CSV report.');
  }
});

app.get('/api/report/diff.pdf', async (req, res) => {
  try {
    const html = buildDiffPdfHtml({
      results: testState.results,
      benchOrigin: store.bench ? store.bench.origin : '',
      candOrigin: store.cand ? store.cand.origin : '',
      benchPages: store.bench ? Array.from(store.bench.pages.values()) : [],
      candPages: store.cand ? Array.from(store.cand.pages.values()) : [],
      aiSummaries: aiSummaryState.diff.entries,
    });
    const buffer = await renderPdfFromHtml(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="site-diff-report-${filenameTimestamp()}.pdf"`);
    res.send(buffer);
  } catch (e) {
    logErr('diff PDF report failed', e);
    res.status(500).send('Failed to generate PDF report: ' + (e && e.message ? e.message : e));
  }
});

app.get('/api/report/analysis.csv', (req, res) => {
  try {
    const site = store.site;
    const pages = site ? Array.from(site.pages.values()) : [];
    const csv = buildAnalysisCsv({
      pages,
      linkResults: linkScanState.results,
      lhResults: lighthouseState.results,
      siteOrigin: site ? site.origin : '',
      aiSummaries: aiSummaryState.analysis.entries,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="site-analysis-report-${filenameTimestamp()}.csv"`);
    res.send(csv);
  } catch (e) {
    logErr('analysis CSV report failed', e);
    res.status(500).send('Failed to generate CSV report.');
  }
});

app.get('/api/report/analysis.pdf', async (req, res) => {
  try {
    const site = store.site;
    const pages = site ? Array.from(site.pages.values()) : [];
    const html = buildAnalysisPdfHtml({
      pages,
      linkResults: linkScanState.results,
      lhResults: lighthouseState.results,
      siteOrigin: site ? site.origin : '',
      aiSummaries: aiSummaryState.analysis.entries,
    });
    const buffer = await renderPdfFromHtml(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="site-analysis-report-${filenameTimestamp()}.pdf"`);
    res.send(buffer);
  } catch (e) {
    logErr('analysis PDF report failed', e);
    res.status(500).send('Failed to generate PDF report: ' + (e && e.message ? e.message : e));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Site Diff Inspector running at http://localhost:${PORT}`);
});
