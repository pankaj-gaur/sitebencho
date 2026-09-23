const { PlaywrightCrawler, RequestQueue, log } = require('crawlee');

log.setLevel(log.LEVELS.ERROR); // keep Crawlee's own logging quiet; the API layer reports progress

function normalizePath(rawUrl) {
  const url = new URL(rawUrl);
  let p = url.pathname;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (p === '') p = '/';
  return p + url.search;
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      console.warn(`[crawl] sitemap fetch ${url} returned HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn(`[crawl] sitemap fetch ${url} failed:`, e && e.message ? e.message : e);
    return null;
  }
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

/**
 * Sitemaps are the reliable source of "every page on the site" — link-following
 * alone plateaus early on real sites (pagination, "load more" JS, listings not
 * linked in nav/footer). This walks sitemap.xml / sitemap_index.xml (including
 * nested sitemaps, up to a couple levels deep) and returns every page URL listed.
 */
async function getSitemapUrls(origin, { maxUrls = 500, maxSubSitemaps = 25 } = {}) {
  const seenSitemaps = new Set();
  const urls = new Set();

  async function processSitemap(url, depth) {
    if (seenSitemaps.has(url) || seenSitemaps.size >= maxSubSitemaps || urls.size >= maxUrls) return;
    seenSitemaps.add(url);
    const xml = await fetchText(url);
    if (!xml) return;

    const locs = extractLocs(xml);
    const subSitemaps = locs.filter((l) => /sitemap[^/]*\.xml(\.gz)?(\?.*)?$/i.test(l));
    const pageUrls = locs.filter((l) => !/sitemap[^/]*\.xml(\.gz)?(\?.*)?$/i.test(l));

    pageUrls.forEach((u) => urls.size < maxUrls && urls.add(u));

    if (depth < 2) {
      for (const sm of subSitemaps) {
        if (urls.size >= maxUrls) break;
        await processSitemap(sm, depth + 1);
      }
    }
  }

  for (const candidate of [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]) {
    if (urls.size > 0) break;
    await processSitemap(candidate, 0);
  }

  return Array.from(urls);
}

/**
 * Shared crawling core used by both discovery-based site crawls and explicit
 * URL-list rendering — all the stability hardening (politeness pacing,
 * browser recycling, /dev/shm fix, stall watchdog, memory logging) lives
 * here once instead of being duplicated per mode.
 *
 * When `discover` is true, same-domain links found on each rendered page are
 * enqueued for further crawling (site-crawl mode). When false, ONLY the
 * URLs in `startRequests` are ever visited — nothing is followed beyond
 * that list (explicit URL-list mode).
 *
 * `startRequests` entries may be plain URL strings, or Crawlee request
 * objects ({ url, userData }) — the latter is used by renderUrlList() below
 * to stamp each request with its original list position (userData.origIndex),
 * since queue concurrency means pages don't necessarily finish rendering in
 * the order they were submitted.
 */
async function runPlaywrightCrawl(startRequests, {
  maxPages,
  requestsPerMinute = 20,
  userAgent,
  onProgress,
  registerStop,
  discover,
  sourceLabel,
} = {}) {
  const pages = new Map();
  let lastError = null;
  let lastActivity = Date.now();
  let watchdogFired = false;
  const report = (total) => {
    lastActivity = Date.now();
    if (onProgress) {
      onProgress({
        found: pages.size,
        total,
        // Snapshot of everything found so far (title/url/path only — no html,
        // see note below). Lets the caller checkpoint partial results and let
        // the UI fill in incrementally instead of waiting for the whole crawl.
        pages: Array.from(pages.values()),
      });
    }
  };

  // Isolated, uniquely-named queue per call — Crawlee's default queue name
  // ("default") persists to disk and is shared across calls in the same
  // process, so a second crawl of an already-seen URL would find it marked
  // "handled" from a previous run and silently process nothing.
  const queueName = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestQueue = await RequestQueue.open(queueName);

  const ua = userAgent || 'SiteDiffInspectorBot/1.0 (+internal QA tool; contact: set CONTACT_EMAIL env var)';

  const STALL_MS = 60_000; // no progress for 60s -> assume blocked/crashed and stop
  let watchdogTimer = null;

  try {
    let total = startRequests.length;
    report(total);

    const crawler = new PlaywrightCrawler({
      requestQueue,
      maxRequestsPerCrawl: Math.max(maxPages || 0, startRequests.length),
      // Polite by default: low concurrency + a rate cap. WAFs flag bursts of
      // parallel requests as bot/attack traffic — this keeps the crawl slower
      // but looking like ordinary traffic instead of a scraping spike.
      maxConcurrency: 2,
      maxRequestsPerMinute: requestsPerMinute,
      requestHandlerTimeoutSecs: 30,
      navigationTimeoutSecs: 25,
      maxRequestRetries: 1,
      browserPoolOptions: {
        useFingerprints: false, // no fingerprint spoofing — identify honestly instead
        // Recycle the Chromium instance periodically. Long-running headless
        // browsers accumulate memory over many navigations; on a several
        // hundred page crawl that growth is a plausible cause of a hang or
        // crash partway through. Forcing a fresh browser every 40 pages
        // caps how much any single instance can grow.
        retireBrowserAfterPageCount: 40,
        maxOpenPagesPerBrowser: 2,
      },
      launchContext: {
        userAgent: ua,
        launchOptions: {
          args: [
            '--disable-blink-features=AutomationControlled',
            // Chromium's default /dev/shm allocation is small on many systems;
            // a long crawl that fills it causes silent renderer crashes partway
            // through (a very common cause of "works for a while, then dies at
            // a consistent-ish page count"). This forces Chromium to spill to
            // disk instead of crashing when shared memory runs out.
            '--disable-dev-shm-usage',
          ],
        },
      },
      async requestHandler({ request, page, enqueueLinks }) {
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

        const loadedUrl = request.loadedUrl || request.url;
        const pathKey = normalizePath(loadedUrl);
        if (pages.has(pathKey)) return;

        const title = (await page.title()) || pathKey;

        // Deliberately NOT storing rendered HTML here. The /api/test phase
        // re-fetches each matched page fresh (so the diff reflects current
        // content, not a stale crawl snapshot) — caching full page HTML for
        // every crawled page here was pure memory bloat with no reader,
        // and on a several-hundred-page site that's enough to exhaust
        // Node's memory and crash or stall the process.
        const origIndex = request.userData && typeof request.userData.origIndex === 'number'
          ? request.userData.origIndex
          : undefined;
        pages.set(pathKey, { title, url: loadedUrl, path: pathKey, ...(origIndex !== undefined ? { origIndex } : {}) });

        if (pages.size % 25 === 0) {
          const mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
          console.log(`[crawl] ${sourceLabel || 'run'} — ${pages.size} page(s), rss=${mb}MB`);
        }

        if (discover) {
          await enqueueLinks({ strategy: 'same-domain' });
          // Links found beyond the sitemap push the real total up — keep the
          // progress estimate honest rather than stalling at the sitemap count.
          try {
            const info = await requestQueue.getInfo();
            if (info && info.totalRequestCount > total) total = Math.min(info.totalRequestCount, maxPages || info.totalRequestCount);
          } catch (e) {
            console.warn('[crawl] queue info check failed (non-fatal, progress total just won\'t self-correct):', e && e.message ? e.message : e);
          }
        }
        report(total);
      },
      async failedRequestHandler({ request, error }) {
        lastError = `${request.url} — ${error && error.message ? error.message : error}`;
        console.warn(`[crawl] request failed: ${lastError}`);
        report(total);
      },
    });

    // Hand the caller a way to cancel this specific run. Without this, a
    // request whose HTTP connection drops (or is superseded by a new crawl
    // for the same slot) keeps running on the server indefinitely — fully
    // detached from the UI, silently consuming resources and request budget
    // against the target site.
    if (registerStop) {
      registerStop(() => crawler.stop('Cancelled — superseded by a newer crawl request for this slot'));
    }

    // Stall watchdog: if nothing has happened for STALL_MS, something MIGHT be
    // wedged (a hung page, a WAF silently dropping requests, a crashed browser
    // tab). But a site with fewer real pages than maxPages also goes quiet for
    // a stretch once its queue drains — Crawlee needs a moment to confirm
    // "truly nothing left" before crawler.run() resolves on its own, and that
    // quiet period looks identical to a stall from the outside. Individual
    // page hangs are already bounded by requestHandlerTimeoutSecs (30s), so a
    // genuine silent gap this long almost always means the queue is empty and
    // the crawl is finishing, not stuck — check that before failing anything.
    watchdogTimer = setInterval(async () => {
      if (Date.now() - lastActivity <= STALL_MS || watchdogFired) return;

      let queueEmpty = false;
      try {
        queueEmpty = await requestQueue.isEmpty();
      } catch (e) {
        console.warn('[crawl] watchdog queue-emptiness check failed, treating as still active:', e && e.message ? e.message : e);
      }
      if (queueEmpty) {
        return; // Legitimate wind-down, not a stall — keep waiting for crawler.run() to resolve.
      }

      watchdogFired = true;
      console.error(`[crawl] stalled after ${pages.size} page(s) — no progress for ${STALL_MS / 1000}s, stopping.`);
      crawler.stop(`Stalled — no progress for ${STALL_MS / 1000}s`);
    }, 5000);

    await crawler.run(startRequests);
    await crawler.teardown();
  } finally {
    if (watchdogTimer) clearInterval(watchdogTimer);
    await requestQueue.drop().catch(() => {});
  }

  if (watchdogFired) {
    throw new Error(
      `Crawl stalled and was stopped after finding ${pages.size} page(s) — no progress for ${STALL_MS / 1000}s. ` +
        `This usually means the site started blocking/rate-limiting the crawler partway through, or a page hung. ` +
        `Check the terminal running the server for the exact request that stopped responding.` +
        (lastError ? ` Last error before stall: ${lastError}` : '')
    );
  }

  if (pages.size === 0) {
    throw new Error(
      `No pages could be rendered${sourceLabel ? ` for ${sourceLabel}` : ''}. The page(s) may have failed to load, timed out, or blocked the crawler.` +
        (lastError ? ` Last error: ${lastError}` : '')
    );
  }

  return { pages, lastError };
}

/**
 * Crawls a site: seeds from its sitemap (if any) so real page counts are
 * captured, then also follows same-domain links found while rendering each
 * page, to pick up anything new or unlisted. Every page is rendered with a
 * real headless browser (so client-rendered / SPA content is captured, not
 * just raw server HTML).
 *
 * Returns { origin, pages: Map<pathKey, {title, url, path}> }
 * Throws if zero pages could be rendered, with the reason attached.
 */
async function crawlSite(startUrl, { maxPages = 500, requestsPerMinute = 20, userAgent, onProgress, registerStop } = {}) {
  const origin = new URL(startUrl).origin;
  const sitemapUrls = await getSitemapUrls(origin, { maxUrls: maxPages });
  const startRequests = Array.from(new Set([startUrl, ...sitemapUrls])).slice(0, maxPages);

  const { pages } = await runPlaywrightCrawl(startRequests, {
    maxPages,
    requestsPerMinute,
    userAgent,
    onProgress,
    registerStop,
    discover: true,
    sourceLabel: startUrl,
  });

  return { origin, pages };
}

/**
 * Renders EXACTLY the given URLs with a real headless browser (so titles
 * and client-rendered content are accurate) — but unlike crawlSite(), never
 * seeds from a sitemap and never follows links found on the page
 * (discover:false is passed through to runPlaywrightCrawl). This is what
 * powers "Use a URL list" mode: the person told us precisely which pages
 * they want checked, so the render is restricted to just those pages — no
 * sitemap lookup, no link-following, nothing added or removed beyond what
 * was pasted/uploaded.
 *
 * Order is preserved and NOT deduplicated by path — needed for Diff
 * Inspector's position pairing, where the Nth benchmark URL always
 * corresponds to the Nth candidate URL (which may share a normalized path
 * across two different domains, e.g. both "/").
 *
 * Returns { origin, pages: Map<key, {title, url, path}>, invalidCount } —
 * same shape crawlSite() returns, so callers don't need to know which path
 * produced it. The Map key is `${index}::${path}` (not the bare path),
 * matching the old registerUrlList() behavior, so two different domains
 * that happen to share a path stay distinct entries.
 */
async function renderUrlList(urls, { maxPages = 500, requestsPerMinute = 20, userAgent, onProgress, registerStop } = {}) {
  const HARD_CEILING = Math.min(maxPages || 500, 500);
  const validUrls = [];
  let invalidCount = 0;

  (urls || []).forEach((raw) => {
    const candidate = String(raw || '').trim();
    if (!candidate) return;
    if (validUrls.length >= HARD_CEILING) return;
    try {
      const parsed = new URL(candidate);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('not http(s)');
      validUrls.push(parsed.href);
    } catch (e) {
      invalidCount += 1;
    }
  });

  if (validUrls.length === 0) {
    throw new Error(
      `No valid URLs found in the list provided.${invalidCount ? ` ${invalidCount} line(s) could not be parsed as a URL.` : ''}`
    );
  }

  const startRequests = validUrls.map((url, i) => ({ url, userData: { origIndex: i } }));

  // discover:false is the whole point of this function — only these exact
  // URLs are ever visited; nothing found ON them is followed, and no
  // sitemap is read for any of their origins.
  const { pages: renderedByPath } = await runPlaywrightCrawl(startRequests, {
    maxPages: startRequests.length,
    requestsPerMinute,
    userAgent,
    onProgress,
    registerStop,
    discover: false,
    sourceLabel: 'URL list',
  });

  // Rebuild in original list order (queue concurrency means pages don't
  // necessarily finish in input order) and re-key by ${index}::${path} so
  // two different URLs that happen to share a normalized path (e.g. both
  // "/" on two different domains) stay distinct, position-paired entries —
  // matching how registerUrlList() used to key its Map.
  const entries = Array.from(renderedByPath.values())
    .map((p, fallbackIdx) => ({
      idx: typeof p.origIndex === 'number' ? p.origIndex : fallbackIdx,
      page: { title: p.title, url: p.url, path: p.path },
    }))
    .sort((a, b) => a.idx - b.idx);

  const pages = new Map(entries.map((e) => [`${e.idx}::${e.page.path}`, e.page]));
  const origin = new URL(validUrls[0]).origin;
  return { origin, pages, invalidCount };
}

/**
 * Registers an EXPLICIT list of URLs exactly as given — no crawling, no
 * rendering, no sitemap lookup, no link discovery. Kept for reference/back-
 * compat only; the app now uses renderUrlList() above instead, so that
 * "Use a URL list" mode gets real rendered titles rather than a path
 * placeholder. Not called anywhere in server.js as of this version.
 *
 * Returns { origin, pages: Map<key, {title, url, path}>, invalidCount } —
 * same shape crawlSite() returns, so callers don't need to know which path
 * produced it. The Map key is NOT the bare path (two different domains can
 * legitimately share a path, e.g. both have "/") — it's `${index}::${path}`,
 * which stays unique regardless of cross-domain collisions.
 */
function registerUrlList(urls) {
  const HARD_CEILING = 500;
  const entries = [];
  let invalidCount = 0;

  for (const raw of urls || []) {
    const candidate = String(raw || '').trim();
    if (!candidate) continue;
    if (entries.length >= HARD_CEILING) break;
    try {
      const parsed = new URL(candidate);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('not http(s)');
      const path = normalizePath(parsed.href);
      entries.push({ title: path, url: parsed.href, path });
    } catch (e) {
      invalidCount += 1;
    }
  }

  if (entries.length === 0) {
    throw new Error(
      `No valid URLs found in the list provided.${invalidCount ? ` ${invalidCount} line(s) could not be parsed as a URL.` : ''}`
    );
  }

  const pages = new Map(entries.map((p, i) => [`${i}::${p.path}`, p]));
  const origin = new URL(entries[0].url).origin;
  return { origin, pages, invalidCount };
}

module.exports = { crawlSite, renderUrlList, registerUrlList, normalizePath, getSitemapUrls };
