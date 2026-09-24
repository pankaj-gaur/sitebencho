const { PlaywrightCrawler, RequestQueue, log } = require('crawlee');
const { getUserAgent, DEFAULT_HEADERS, FETCH_HEADERS, HostThrottle, pageBlockInfo, hostOf } = require('./politeness');

log.setLevel(log.LEVELS.ERROR); // keep Crawlee's own logging quiet; the API layer reports progress

function normalizePath(rawUrl) {
  const url = new URL(rawUrl);
  let p = url.pathname;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (p === '') p = '/';
  return p + url.search;
}

async function fetchText(url, userAgent) {
  try {
    const ua = userAgent || (await getUserAgent());
    const res = await fetch(url, {
      redirect: 'follow',
      // Same identity as the browser crawl — previously this went out with
      // Node's default "node" UA and no Accept headers, which some WAFs block
      // outright before the crawl even starts.
      headers: { ...FETCH_HEADERS, Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8', 'User-Agent': ua },
    });
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
async function getSitemapUrls(origin, { maxUrls = 500, maxSubSitemaps = 25, userAgent } = {}) {
  const seenSitemaps = new Set();
  const urls = new Set();

  async function processSitemap(url, depth) {
    if (seenSitemaps.has(url) || seenSitemaps.size >= maxSubSitemaps || urls.size >= maxUrls) return;
    seenSitemaps.add(url);
    const xml = await fetchText(url, userAgent);
    if (!xml) return;

    const locs = extractLocs(xml);
    const subSitemaps = locs.filter((l) => /sitemap[^/]*\.xml(\.gz)?(\?.*)?$/i.test(l));
    const pageUrls = locs.filter((l) => !/sitemap[^/]*\.xml(\.gz)?(\?.*)?$/i.test(l));

    pageUrls.forEach((u) => urls.size < maxUrls && urls.add(u));

    if (depth < 2) {
      for (const sm of subSitemaps) {
        if (urls.size >= maxUrls) break;
        // Small gap between sitemap files — no reason to burst these either.
        await new Promise((r) => setTimeout(r, 300));
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
 * browser recycling, /dev/shm fix, stall watchdog, memory logging, WAF
 * back-off) lives here once instead of being duplicated per mode.
 *
 * When `discover` is true, same-domain links found on each rendered page are
 * enqueued for further crawling (site-crawl mode). When false, ONLY the
 * URLs in `startRequests` are ever visited — nothing is followed beyond
 * that list (explicit URL-list mode).
 *
 * `maxPages` caps UNIQUE PAGES stored, not requests made. Requests that
 * resolve to an already-stored page (e.g. the start URL redirecting to
 * /en/us and then a nav link to /en/us being crawled again) don't count
 * against it — previously they did, which made every crawl return one page
 * fewer than "Max Pages to Scan".
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

  // Normal Chrome UA + "SiteDiffInspector/1.0 (+contact)" — see politeness.js.
  const ua = userAgent || (await getUserAgent());

  const STALL_MS = 60_000; // no progress for 60s -> assume blocked/crashed and stop
  let watchdogTimer = null;

  // WAF back-off state for this run. On a detected block the whole crawler
  // PAUSES (no new pages start) for a cooldown — Retry-After if the site sent
  // one, else 15s, 30s, 60s... — and after 3 blocks in a row from the same
  // host the crawl stops instead of continuing to hit a site that has
  // clearly said no.
  const throttle = new HostThrottle({ baseCooldownMs: 15_000, abortAfter: 3 });
  let pausedUntil = 0;
  let resumeTimer = null;
  let blockAbort = null;
  let crawler = null;

  // Unique-page cap. Enforced in requestHandler, not via maxRequestsPerCrawl
  // (which counts every request, including ones that turn out to be
  // duplicates of a page already stored).
  const pageLimit = maxPages > 0 ? maxPages : Infinity;
  let limitReached = false;

  function pauseCrawlerFor(ms) {
    const pool = crawler && crawler.autoscaledPool;
    if (!pool) return;
    const until = Date.now() + ms;
    if (until <= pausedUntil) return;
    pausedUntil = until;
    // Not awaited on purpose: pause() resolves only once running tasks finish,
    // and it's being called FROM a running task.
    pool.pause().catch(() => {});
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      pausedUntil = 0;
      lastActivity = Date.now();
      pool.resume();
    }, ms);
  }

  // crawler.stop() can't take effect while the pool is paused (a paused pool
  // never re-checks whether it's finished), so un-pause as part of stopping.
  function stopCrawler(reason) {
    crawler.stop(reason);
    if (pausedUntil > 0) {
      clearTimeout(resumeTimer);
      pausedUntil = 0;
      if (crawler.autoscaledPool) crawler.autoscaledPool.resume();
    }
  }

  try {
    let total = startRequests.length;
    report(total);

    crawler = new PlaywrightCrawler({
      requestQueue,
      // Safety net only — the real cap is pageLimit (unique pages), enforced
      // in requestHandler. Redirects, duplicate paths and WAF retries use up
      // requests without adding pages, so this has to sit well above
      // pageLimit or it cuts the page count short (the old N-1 bug). It still
      // stops a site full of duplicate URLs from being crawled forever.
      maxRequestsPerCrawl: Number.isFinite(pageLimit)
        ? Math.max(pageLimit, startRequests.length) * 3
        : undefined,
      // Polite by default: low concurrency + a rate cap. WAFs flag bursts of
      // parallel requests as bot/attack traffic — this keeps the crawl slower
      // but looking like ordinary traffic instead of a scraping spike.
      maxConcurrency: 2,
      maxRequestsPerMinute: requestsPerMinute,
      requestHandlerTimeoutSecs: 30,
      navigationTimeoutSecs: 25,
      maxRequestRetries: 1,

      // One session for the whole crawl, with its cookies carried over even
      // when the browser is recycled every 40 pages. Before, each recycle
      // wiped cookies, so the site saw a brand-new visitor over and over —
      // any WAF clearance or consent cookie it had set was thrown away.
      useSessionPool: true,
      persistCookiesPerSession: true,
      sessionPoolOptions: {
        maxPoolSize: 1,
        // Blocks are detected and handled below (cooldown / stop); don't let
        // Crawlee silently rotate sessions on 401/403/429 instead.
        blockedStatusCodes: [],
        sessionOptions: { maxUsageCount: 100_000, maxErrorScore: 20 },
      },

      preNavigationHooks: [
        async ({ page }) => {
          await page.setExtraHTTPHeaders(DEFAULT_HEADERS);
        },
      ],

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
      async requestHandler({ request, page, response, enqueueLinks }) {
        // A page that was already in flight when the limit was hit — drop it.
        if (limitReached) return;

        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

        // WAF / bot-protection check BEFORE treating this as a real page — a
        // challenge page must not end up in the page list (it would then
        // "differ" from everything in the test phase).
        const block = await pageBlockInfo(page, response);
        const cooldown = throttle.record(request.url, block);
        if (block) {
          const host = hostOf(request.url);
          lastError = `${request.url} — blocked by bot protection (${block.reason})`;
          if (throttle.shouldAbort(request.url)) {
            blockAbort = `${host} blocked ${throttle.strikes(request.url)} requests in a row (${block.reason})`;
            console.error(`[crawl] ${blockAbort} — stopping crawl.`);
            request.noRetry = true;
            stopCrawler(`Stopped — ${blockAbort}`);
          } else {
            console.warn(`[crawl] ${lastError}; pausing ${Math.round(cooldown / 1000)}s before continuing.`);
            pauseCrawlerFor(cooldown);
          }
          report(total);
          // Throwing sends the request back for its one retry, which runs
          // after the cooldown above.
          throw new Error(`Blocked by bot protection (${block.reason})`);
        }

        if (limitReached) return;

        const loadedUrl = request.loadedUrl || request.url;
        const pathKey = normalizePath(loadedUrl);
        if (pages.has(pathKey)) return;

        const title = (await page.title()) || pathKey;

        // Re-check and store with NO await in between. With maxConcurrency: 2,
        // two handlers can both pass the checks above during the awaits and
        // would otherwise overshoot the limit (or store the same path twice).
        if (pages.has(pathKey)) return;
        if (pages.size >= pageLimit) {
          limitReached = true;
          return;
        }

        // Deliberately NOT storing rendered HTML here. The /api/test phase
        // re-fetches each matched page fresh (so the diff reflects current
        // content, not a stale crawl snapshot) — caching full page HTML for
        // every crawled page here was pure memory bloat with no reader,
        // and on a several-hundred-page site that's enough to exhaust
        // Node's memory and crash or stall the process.
        pages.set(pathKey, { title, url: loadedUrl, path: pathKey });

        if (pages.size % 25 === 0) {
          const mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
          console.log(`[crawl] ${sourceLabel || 'run'} — ${pages.size} page(s), rss=${mb}MB`);
        }

        // Hit the cap: stop cleanly right away instead of letting the queue
        // keep rendering pages that would just be thrown away.
        if (pages.size >= pageLimit) {
          limitReached = true;
          total = pages.size;
          report(total);
          stopCrawler(`Reached max pages to scan (${pageLimit})`);
          return;
        }

        if (discover) {
          await enqueueLinks({
            strategy: 'same-domain',
            // Skip links to pages already stored (e.g. a nav link back to the
            // page the start URL redirected to) — they'd only cost a request
            // against the site and add nothing.
            transformRequestFunction: (req) => {
              try {
                if (pages.has(normalizePath(req.url))) return false;
              } catch (e) {
                return false;
              }
              return req;
            },
          });
          // Links found beyond the sitemap push the real total up — keep the
          // progress estimate honest rather than stalling at the sitemap count.
          try {
            const info = await requestQueue.getInfo();
            if (info && info.totalRequestCount > total) {
              total = Number.isFinite(pageLimit)
                ? Math.min(info.totalRequestCount, pageLimit)
                : info.totalRequestCount;
            }
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
      registerStop(() => stopCrawler('Cancelled — superseded by a newer crawl request for this slot'));
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
    // A deliberate WAF cooldown pause is not a stall either, and neither is
    // winding down after reaching the page limit.
    watchdogTimer = setInterval(async () => {
      if (limitReached) return;
      if (Date.now() < pausedUntil) return;
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
      stopCrawler(`Stalled — no progress for ${STALL_MS / 1000}s`);
    }, 5000);

    await crawler.run(startRequests);
    await crawler.teardown();
  } finally {
    if (watchdogTimer) clearInterval(watchdogTimer);
    clearTimeout(resumeTimer);
    await requestQueue.drop().catch(() => {});
  }

  if (blockAbort) {
    throw new Error(
      `Crawl stopped after finding ${pages.size} page(s): ${blockAbort}. ` +
        `The site's bot protection is refusing this tool. If you control the site, ask whoever manages its ` +
        `firewall/WAF to allowlist this tool's User-Agent (contains "SiteDiffInspector") or your outbound IP. ` +
        `If you don't control it, get permission first rather than retrying.`
    );
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
  const ua = userAgent || (await getUserAgent());
  const sitemapUrls = await getSitemapUrls(origin, { maxUrls: maxPages, userAgent: ua });
  const startRequests = Array.from(new Set([startUrl, ...sitemapUrls])).slice(0, maxPages);

  const { pages } = await runPlaywrightCrawl(startRequests, {
    maxPages,
    requestsPerMinute,
    userAgent: ua,
    onProgress,
    registerStop,
    discover: true,
    sourceLabel: startUrl,
  });

  return { origin, pages };
}

/**
 * Registers an EXPLICIT list of URLs exactly as given — no crawling, no
 * rendering, no sitemap lookup, no link discovery. The person already told
 * us precisely which URLs they want; there's nothing left to discover, and
 * validating a URL string is instant, so this never touches Playwright.
 * This is what makes "Use a URL list" behave like "Load from history" —
 * the page list appears immediately, with no crawl step to wait through.
 *
 * Deliberately does NOT deduplicate: unlike the old sitemap/discovery path,
 * this list may be paired position-by-position against another list (Site
 * Diff's benchmark vs candidate) where entry N always means entry N on both
 * sides — silently dropping a "duplicate" would shift every later position
 * out of alignment. Order is preserved exactly as submitted.
 *
 * Returns { origin, pages: Map<key, {title, url, path}>, invalidCount } —
 * same shape crawlSite() returns, so callers don't need to know which path
 * produced it. The Map key is NOT the bare path (two different domains can
 * legitimately share a path, e.g. both have "/") — it's `${index}::${path}`,
 * which stays unique regardless of cross-domain collisions. Nothing outside
 * this module ever looks a page up by that key; everything else only ever
 * iterates .values(), so this is invisible to every other caller.
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

module.exports = { crawlSite, registerUrlList, normalizePath, getSitemapUrls };
