const fs = require('fs');
const path = require('path');

/**
 * Shared "politeness" helpers used by every part of the app that talks to a
 * target site (crawl, diff test, page-details capture, link scan):
 *
 *  - getUserAgent(): a normal Chrome UA with this tool's identifier appended.
 *    The old "SiteDiffInspectorBot/1.0" string tripped simple WAF rules that
 *    match the keyword "bot", and the diff-test phase was sending Playwright's
 *    default "HeadlessChrome" UA. This keeps the tool honestly identified
 *    (the SiteDiffInspector token + contact stay in the string) without the
 *    keyword that naive filters block on sight.
 *
 *  - detectBlock(): recognises WAF / bot-protection responses (Cloudflare,
 *    Akamai, Imperva, Sucuri, AWS WAF, Wordfence, DataDome, PerimeterX, rate
 *    limits) so a block is reported as "blocked", not as "changed"/"broken".
 *
 *  - HostThrottle: per-host back-off. After a block the host gets a cooldown
 *    (Retry-After if the site sent one, else exponential), and after several
 *    consecutive blocks the caller is told to stop hitting that host.
 *
 * Deliberately NOT here: fingerprint spoofing, headless-detection patches,
 * proxy rotation. If a site you control still blocks after this, allowlist
 * the tool in its WAF; if you don't control it, treat the block as a "no".
 */

const TOOL_TOKEN = 'SiteDiffInspector/1.0';

// Accept-Language is the one header a real browser always sends that
// headless Chromium can omit. Only this goes into Playwright's
// extraHTTPHeaders — extra headers there apply to EVERY sub-request
// (images, CSS, JS), so a page-level Accept header would look wrong.
const DEFAULT_HEADERS = {
  'Accept-Language': 'en-US,en;q=0.9',
};

// Full header set for plain Node fetch() calls (sitemaps, link checks),
// where there is no browser to fill in the rest.
const FETCH_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function platformToken() {
  if (process.platform === 'win32') return 'Windows NT 10.0; Win64; x64';
  if (process.platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7';
  return 'X11; Linux x86_64';
}

// Chromium major version of the browser Playwright actually ships, so the UA
// matches the engine that renders the page (read from playwright-core's own
// browsers.json — no browser launch needed).
function chromiumMajorVersion() {
  try {
    const pkg = require.resolve('playwright-core/package.json');
    const browsers = JSON.parse(fs.readFileSync(path.join(path.dirname(pkg), 'browsers.json'), 'utf8'));
    const chromium = (browsers.browsers || []).find((b) => b.name === 'chromium');
    if (chromium && chromium.browserVersion) return chromium.browserVersion.split('.')[0];
  } catch (e) {
    // fall through to the fixed fallback below
  }
  return '140';
}

let cachedUserAgent = null;

/**
 * The User-Agent every request from this app uses. Override entirely with
 * CRAWLER_USER_AGENT; set CONTACT_EMAIL so site owners can reach you.
 */
async function getUserAgent() {
  if (process.env.CRAWLER_USER_AGENT) return process.env.CRAWLER_USER_AGENT;
  if (cachedUserAgent) return cachedUserAgent;
  const contact = process.env.CONTACT_EMAIL ? `; contact: ${process.env.CONTACT_EMAIL}` : '';
  cachedUserAgent =
    `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${chromiumMajorVersion()}.0.0.0 Safari/537.36 ${TOOL_TOKEN} (+website QA tool${contact})`;
  return cachedUserAgent;
}

const MAX_COOLDOWN_MS = 120_000;

function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 1) * 1000, MAX_COOLDOWN_MS);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 1000), MAX_COOLDOWN_MS);
  return null;
}

// Body/title signatures of the common bot-protection products.
const SIGNATURES = [
  { re: /just a moment|attention required|checking your browser|cf-browser-verification|cf_chl_|challenge-platform/, reason: 'Cloudflare challenge' },
  { re: /sucuri website firewall|access denied - sucuri/, reason: 'Sucuri firewall' },
  { re: /incapsula|_incapsula_resource|imperva|pardon our interruption/, reason: 'Imperva/Incapsula' },
  { re: /errors\.edgesuite\.net|reference #\d+\.[0-9a-f]+/, reason: 'Akamai' },
  { re: /aws waf|request blocked\.|x-amzn-waf/, reason: 'AWS WAF' },
  { re: /wordfence/, reason: 'Wordfence' },
  { re: /datadome|captcha-delivery\.com/, reason: 'DataDome' },
  { re: /px-captcha|perimeterx|press (&|and) hold/, reason: 'PerimeterX' },
  { re: /ddos-guard/, reason: 'DDoS-Guard' },
  { re: /blocked due to suspicious|suspicious (activity|behaviou?r)|are you a robot|bot (detection|protection)|verify you are human/, reason: 'bot protection' },
];

// Titles that mean "challenge page" even when served with HTTP 200.
const CHALLENGE_TITLE_RE = /^(just a moment|attention required|ddos-guard|pardon our interruption|access denied)/;

/**
 * Returns null if the response looks like a real page, or
 * { reason, status, retryAfterMs } if it looks like a WAF / bot block.
 *
 * headers: plain object with lower-case keys.
 */
function detectBlock({ status = 0, headers = {}, title = '', bodyText = '' } = {}) {
  const h = (k) => String(headers[k] || '');
  const retryAfterMs = parseRetryAfter(h('retry-after'));
  const server = h('server').toLowerCase();
  const text = `${String(title).toLowerCase()} ${String(bodyText).slice(0, 5000).toLowerCase()}`;
  const block = (reason) => ({ reason: status ? `${reason}, HTTP ${status}` : reason, status, retryAfterMs });

  if (h('cf-mitigated')) return block('Cloudflare challenge');
  if (headers['x-datadome'] || headers['x-dd-b']) return block('DataDome');
  if (status === 429) return block('rate limited');
  if (status === 999) return block('bot protection');

  const suspiciousStatus = status === 401 || status === 403 || status === 406 || status === 503;
  if (suspiciousStatus) {
    const sig = SIGNATURES.find((s) => s.re.test(text));
    if (sig) return block(sig.reason);
    if (server.includes('cloudflare') && status !== 401) return block('Cloudflare');
    if (server.includes('akamaighost')) return block('Akamai');
    if (status === 406) return block('WAF');
  }

  if (status >= 200 && status < 300 && CHALLENGE_TITLE_RE.test(String(title).toLowerCase().trim())) {
    const sig = SIGNATURES.find((s) => s.re.test(text));
    return block(sig ? sig.reason : 'challenge page');
  }
  return null;
}

/**
 * detectBlock() for a Playwright page + its navigation response.
 */
async function pageBlockInfo(page, response) {
  if (!response) return null;
  let headers = {};
  try {
    headers = await response.allHeaders();
  } catch (e) {
    try { headers = response.headers(); } catch (e2) { headers = {}; }
  }
  const title = await page.title().catch(() => '');
  const bodyText = await page
    .evaluate(() => (document.body ? document.body.innerText.slice(0, 3000) : ''))
    .catch(() => '');
  return detectBlock({ status: response.status(), headers, title, bodyText });
}

function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return String(url); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Per-host back-off state for one run (create a new one per crawl / test /
 * scan so a block on yesterday's run doesn't slow today's).
 */
class HostThrottle {
  constructor({ baseCooldownMs = 15_000, maxCooldownMs = MAX_COOLDOWN_MS, abortAfter = 3, minGapMs = 0 } = {}) {
    this.baseCooldownMs = baseCooldownMs;
    this.maxCooldownMs = maxCooldownMs;
    this.abortAfter = abortAfter;
    this.minGapMs = minGapMs;
    this.hosts = new Map();
  }

  _state(url) {
    const host = hostOf(url);
    if (!this.hosts.has(host)) this.hosts.set(host, { strikes: 0, until: 0, last: 0 });
    return this.hosts.get(host);
  }

  /** Record the outcome of a request: a block object, or null for "fine". */
  record(url, block) {
    const s = this._state(url);
    if (!block) {
      s.strikes = 0;
      return 0;
    }
    s.strikes += 1;
    const backoff = this.baseCooldownMs * 2 ** (s.strikes - 1);
    const cooldown = Math.min(block.retryAfterMs || backoff, this.maxCooldownMs);
    s.until = Math.max(s.until, Date.now() + cooldown);
    return cooldown;
  }

  cooldownRemaining(url) {
    return Math.max(0, this._state(url).until - Date.now());
  }

  isCoolingDown(url) {
    if (url) return this.cooldownRemaining(url) > 0;
    const now = Date.now();
    for (const s of this.hosts.values()) if (s.until > now) return true;
    return false;
  }

  strikes(url) {
    return this._state(url).strikes;
  }

  /** True once a host has blocked `abortAfter` requests in a row. */
  shouldAbort(url) {
    return this._state(url).strikes >= this.abortAfter;
  }

  /**
   * Waits out any cooldown for this host plus the minimum gap between
   * requests to it. onTick fires every few seconds while waiting (used to
   * keep stall watchdogs from mistaking a deliberate pause for a hang).
   */
  async waitFor(url, onTick) {
    const s = this._state(url);
    for (;;) {
      const now = Date.now();
      const readyAt = Math.max(s.until, s.last + this.minGapMs);
      if (now >= readyAt) break;
      await sleep(Math.min(readyAt - now, 5000));
      if (onTick) onTick();
    }
    s.last = Date.now();
  }
}

module.exports = {
  TOOL_TOKEN,
  DEFAULT_HEADERS,
  FETCH_HEADERS,
  getUserAgent,
  detectBlock,
  pageBlockInfo,
  parseRetryAfter,
  HostThrottle,
  hostOf,
};
