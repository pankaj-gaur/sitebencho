const { chromium } = require('playwright');

// Standard, documented way to get a desktop audit out of Lighthouse — its
// out-of-the-box default is mobile (throttled, mobile viewport), so getting
// a real desktop score means extending the default config explicitly rather
// than relying on an internal preset file path that can move between
// Lighthouse major versions.
const DESKTOP_CONFIG = {
  extends: 'lighthouse:default',
  settings: {
    formFactor: 'desktop',
    screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
    throttling: {
      rttMs: 40,
      throughputKbps: 10240,
      cpuSlowdownMultiplier: 1,
      requestLatencyMs: 0,
      downloadThroughputKbps: 0,
      uploadThroughputKbps: 0,
    },
  },
};

const MOBILE_CONFIG = {
  extends: 'lighthouse:default',
  settings: {
    formFactor: 'mobile',
  },
};

// The five metrics Lighthouse's performance score is actually weighted
// from — i.e. exactly what's already computed by the SAME audit run that
// produces the score, just not previously read out of the result.
const METRIC_AUDIT_IDS = {
  lcp: 'largest-contentful-paint',
  fcp: 'first-contentful-paint',
  cls: 'cumulative-layout-shift',
  tbt: 'total-blocking-time',
  speedIndex: 'speed-index',
};

// Recommendation-bearing audit groups in Lighthouse's own categorization —
// "load-opportunities" (things that would save time if fixed) and
// "diagnostics" (other issues worth knowing about). Passing audits
// (score >= 0.9, or non-numeric/binary audits that already passed) are
// left out — only what's actually worth recommending.
const RECOMMENDATION_GROUPS = new Set(['load-opportunities', 'diagnostics']);
const MAX_RECOMMENDATIONS = 10;

/**
 * Pulls Core Web Vitals and improvement recommendations out of a Lighthouse
 * result — data that was already computed as part of the same run that
 * produced the performance score, just previously discarded. Markdown links
 * in Lighthouse's audit descriptions (e.g. "[Learn more](https://...)") are
 * stripped since they're not meaningful outside Lighthouse's own report UI.
 */
function extractPerformanceDetails(lhr) {
  const audits = (lhr && lhr.audits) || {};

  const vitals = {};
  for (const [key, auditId] of Object.entries(METRIC_AUDIT_IDS)) {
    const a = audits[auditId];
    if (!a) continue;
    vitals[key] = {
      title: a.title || auditId,
      displayValue: a.displayValue || null,
      numericValue: typeof a.numericValue === 'number' ? a.numericValue : null,
      score: typeof a.score === 'number' ? a.score : null,
    };
  }

  const recommendations = [];
  const perfCategory = lhr && lhr.categories && lhr.categories.performance;
  if (perfCategory && Array.isArray(perfCategory.auditRefs)) {
    for (const ref of perfCategory.auditRefs) {
      if (!RECOMMENDATION_GROUPS.has(ref.group)) continue;
      const a = audits[ref.id];
      if (!a || typeof a.score !== 'number' || a.score >= 0.9) continue; // not applicable, or already passing
      recommendations.push({
        id: ref.id,
        title: a.title || ref.id,
        description: (a.description || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim(),
        displayValue: a.displayValue || null,
        score: a.score,
      });
    }
    recommendations.sort((a, b) => a.score - b.score); // worst-scoring (most impactful) first
  }

  return { vitals, recommendations: recommendations.slice(0, MAX_RECOMMENDATIONS) };
}

/**
 * Runs a Lighthouse performance audit against a URL, reusing the same
 * Chromium binary Playwright already downloaded (via chrome-launcher's
 * chromePath option) so this doesn't require a separate Chrome install.
 *
 * Both `lighthouse` and `chrome-launcher` are ESM-only in their current
 * major versions — dynamic import() works for both ESM and CJS packages,
 * require() does not (it throws ERR_REQUIRE_ESM), so this file avoids
 * top-level require() for either.
 *
 * formFactor: 'mobile' | 'desktop'.
 * Returns { score, vitals, recommendations } — score is an integer 0-100;
 * vitals and recommendations are extracted from the SAME audit run (no
 * extra Lighthouse call). Throws a clearly-prefixed error identifying which
 * stage failed (Chrome launch vs. the audit itself) — the caller logs and
 * displays that per-page rather than silently collapsing everything into a
 * bare "n/a".
 */
async function runLighthouse(url, { formFactor = 'mobile', timeoutMs = 90000 } = {}) {
  let launch;
  let lighthouse;
  try {
    const chromeLauncherModule = await import('chrome-launcher');
    launch = chromeLauncherModule.launch || (chromeLauncherModule.default && chromeLauncherModule.default.launch);
    const lighthouseModule = await import('lighthouse');
    lighthouse = lighthouseModule.default || lighthouseModule;
    if (typeof launch !== 'function' || typeof lighthouse !== 'function') {
      throw new Error('chrome-launcher or lighthouse did not export the expected function — check installed versions');
    }
  } catch (e) {
    throw new Error(`Failed to load lighthouse/chrome-launcher: ${e && e.message ? e.message : e}`);
  }

  let chrome;
  try {
    chrome = await launch({
      chromePath: chromium.executablePath(),
      chromeFlags: [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // same /dev/shm exhaustion fix as the crawler
        // Lighter footprint per launch — matters a lot over a long run (a
        // 350-page scan launches Chrome ~700 times, twice per page); each of
        // these trims background work that otherwise accumulates resource
        // pressure and has been observed causing "Chrome prevented page load
        // with an interstitial" failures partway through long runs.
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
      ],
    });
  } catch (e) {
    throw new Error(`Chrome launch failed (using Playwright's Chromium at ${chromium.executablePath()}): ${e && e.message ? e.message : e}`);
  }

  try {
    const config = formFactor === 'desktop' ? DESKTOP_CONFIG : MOBILE_CONFIG;
    const runnerResultPromise = lighthouse(
      url,
      { port: chrome.port, onlyCategories: ['performance'], output: 'json', logLevel: 'error' },
      config
    );
    // Promise.race doesn't cancel the loser — if the timeout wins, the
    // original Lighthouse call keeps running in the background against a
    // Chrome instance we're about to kill in `finally`. Without this catch,
    // its eventual rejection ("Target closed", once we kill Chrome) has no
    // listener left and surfaces as an unhandled promise rejection — noisy,
    // and it means two audits were briefly contending for resources instead
    // of one, which compounds the interstitial/crash risk on a long run.
    runnerResultPromise.catch(() => {});
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Lighthouse (${formFactor}) run timed out after ${timeoutMs / 1000}s`)), timeoutMs)
    );
    const runnerResult = await Promise.race([runnerResultPromise, timeoutPromise]);

    if (!runnerResult || !runnerResult.lhr) {
      throw new Error('Lighthouse returned no result (page may have failed to load)');
    }
    const perf = runnerResult.lhr.categories && runnerResult.lhr.categories.performance;
    if (!perf || perf.score === null || perf.score === undefined) {
      const topError = runnerResult.lhr.runtimeError;
      throw new Error(
        `Lighthouse could not compute a performance score${topError ? `: ${topError.message}` : ' (no error detail provided by Lighthouse)'}`
      );
    }
    return { score: Math.round(perf.score * 100), ...extractPerformanceDetails(runnerResult.lhr) };
  } catch (e) {
    throw new Error(`Lighthouse (${formFactor}) audit failed: ${e && e.message ? e.message : e}`);
  } finally {
    // chrome.kill() doesn't reliably return a Promise across chrome-launcher
    // versions — some return one, some don't. Chaining .catch() directly on
    // its result throws "Cannot read properties of undefined (reading
    // 'catch')" when it doesn't, and because this runs in `finally`, that
    // exception REPLACES whatever the try block actually returned — silently
    // discarding a perfectly good score and reporting this instead. try/await
    // handles both cases safely: awaiting a non-Promise just resolves it.
    try {
      await chrome.kill();
    } catch (killErr) {
      // best-effort cleanup only — never let this mask the real result
    }
  }
}

module.exports = { runLighthouse };
