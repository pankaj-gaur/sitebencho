const { getUserAgent, FETCH_HEADERS, detectBlock, HostThrottle } = require('./politeness');

/**
 * Link checker for Site Analysis' "Scan for Broken Links".
 *
 * Replaces the old linkinator call, which (a) ran 5 requests in parallel with
 * no pacing, outside the crawler's rate cap, (b) re-checked the same header
 * and footer links on every single page, (c) sent linkinator's own UA, and
 * (d) reported WAF challenges (403/429/503) as "broken".
 *
 * Now:
 *  - one checker per scan run, with a result CACHE shared across pages, so a
 *    nav link that appears on 40 pages is requested once, not 40 times;
 *  - low concurrency (2) plus a minimum gap per host;
 *  - the same User-Agent / headers as the rest of the app;
 *  - GET instead of linkinator's HEAD-first probing (HEAD bursts are a
 *    classic scanner pattern and some servers answer HEAD wrongly);
 *  - bot-protection responses are reported as "unverified", not broken;
 *  - per-host back-off, and after 3 blocks in a row that host is left alone
 *    for the rest of the run instead of being hammered.
 */

const SKIP_SCHEME_RE = /^(mailto:|tel:|javascript:|data:|blob:|about:|#)/i;
const TAG_RE = /<(a|link|img|script|iframe|source|meta)\b([^>]*)>/gi;
const ATTRS_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

// <meta> tags whose content is a URL (Open Graph, Twitter cards, Windows
// tiles, schema.org itemprop). Absolute http(s) URLs in ANY meta tag are
// also checked; relative ones only for these known URL-bearing keys.
const URL_META_KEYS = new Set([
  'og:url', 'og:image', 'og:image:url', 'og:image:secure_url', 'og:video', 'og:video:url',
  'og:video:secure_url', 'og:audio', 'og:audio:url', 'og:audio:secure_url',
  'twitter:image', 'twitter:image:src', 'twitter:player', 'twitter:player:stream', 'twitter:url',
  'msapplication-tileimage', 'msapplication-config', 'msapplication-square70x70logo',
  'msapplication-square150x150logo', 'msapplication-wide310x150logo', 'msapplication-square310x310logo',
  'image', 'thumbnail', 'thumbnailurl', 'url', 'contenturl', 'logo',
]);

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseAttrs(str) {
  const out = {};
  let m;
  ATTRS_RE.lastIndex = 0;
  while ((m = ATTRS_RE.exec(str))) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities((m[2] ?? m[3] ?? m[4] ?? '').trim());
  }
  return out;
}

// The URL a single tag points at, or null.
function urlFromTag(tag, attrs) {
  if (tag === 'meta') {
    // <meta http-equiv="refresh" content="5; url=/new-page">
    if ((attrs['http-equiv'] || '').toLowerCase() === 'refresh') {
      const m = (attrs.content || '').match(/url\s*=\s*['"]?([^'";]+)/i);
      return m ? m[1].trim() : null;
    }
    const content = attrs.content || '';
    if (!content) return null;
    if (/^https?:\/\//i.test(content)) return content;
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (URL_META_KEYS.has(key) && /^(\/|\.\.?\/)/.test(content)) return content;
    return null;
  }
  if (tag === 'link') {
    // preconnect/dns-prefetch hrefs are bare origins, not resources
    if (/preconnect|dns-prefetch/i.test(attrs.rel || '')) return null;
    return attrs.href || null;
  }
  if (tag === 'a') return attrs.href || null;
  return attrs.src || null; // img, script, iframe, source
}

/**
 * Every checkable URL in the page's raw HTML — links, assets, and URLs in
 * <meta> tags (og:image, twitter:image, og:url, meta refresh, …) — absolute,
 * deduped, in document order (so <head> meta/links come first and are never
 * cut off by the per-page link cap).
 */
function describeSource(tag, attrs) {
  if (tag === 'meta') {
    if ((attrs['http-equiv'] || '').toLowerCase() === 'refresh') return 'meta refresh';
    return `meta ${attrs.property || attrs.name || attrs.itemprop || 'content'}`;
  }
  if (tag === 'link') return `link rel=${attrs.rel || '?'}`;
  return tag;
}

/** Map of absolute URL -> where it was found (first occurrence), in document order. */
function extractLinkSources(html, baseUrl) {
  const out = new Map();
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html || ''))) {
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    const raw = urlFromTag(tag, attrs);
    if (!raw || SKIP_SCHEME_RE.test(raw)) continue;
    try {
      const abs = new URL(raw, baseUrl);
      if (!/^https?:$/.test(abs.protocol)) continue;
      abs.hash = '';
      if (!out.has(abs.href)) out.set(abs.href, describeSource(tag, attrs));
    } catch (e) {
      // unparseable URL — ignore, same as a browser would
    }
  }
  return out;
}

function extractLinks(html, baseUrl) {
  return Array.from(extractLinkSources(html, baseUrl).keys());
}

// "Soft 404s": the server answers HTTP 200 but the page says it doesn't
// exist. Social platforms do this for deleted/renamed profiles, which is why
// a dead Facebook/Instagram/X link can look fine by status code alone.
const SOFT_404_RULES = [
  { host: /(^|\.)facebook\.com$|(^|\.)fb\.com$/, re: /this (content|page) isn[’']?t available|the link you followed may be broken|page not found/i },
  { host: /(^|\.)instagram\.com$/, re: /sorry, this page isn[’']?t available|the link you followed may be broken/i },
  { host: /(^|\.)(x|twitter)\.com$/, re: /this account doesn[’']?t exist|this page doesn[’']?t exist|hmm\.\.\.this page doesn/i },
  { host: /(^|\.)linkedin\.com$/, re: /page not found|this page doesn[’']?t exist/i },
  { host: /(^|\.)youtube\.com$/, re: /this channel does not exist|this page isn[’']?t available|404 not found/i },
  { host: /(^|\.)tiktok\.com$/, re: /couldn[’']?t find this account|page not available/i },
  { host: /(^|\.)pinterest\.[a-z.]+$/, re: /sorry! we couldn[’']?t find that page/i },
];
// Any site: a <title> that plainly says "not found".
const GENERIC_SOFT_404_TITLE = /^\s*(?:(?:error\s*)?404\b.*|(?:(?:page|file)\s+)?not\s+found|page\s+(?:does\s+not|doesn['’]t)\s+exist|page\s+cannot\s+be\s+found)\s*(?:[-|–—:·•].*)?$/i;
// Social platforms that bounce logged-out visitors to a login page — we
// can't tell whether the real page exists, so report it as unverified.
const SOCIAL_HOST_RE = /(^|\.)(facebook|fb|instagram|x|twitter|linkedin|tiktok|pinterest|threads)\.(com|net|[a-z.]+)$/i;
const LOGIN_WALL_RE = /\/(login|signin|sign-in|checkpoint|authwall|accounts\/login|i\/flow\/login)\b/i;

const BODY_SNIFF_BYTES = 256 * 1024; // enough for <title> and the "not available" text

async function readLimited(res, limit) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= limit) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

function titleOf(html) {
  const m = (html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/** 'broken' note if a 200 response is really a "not found" page, else null. */
function softNotFound(url, finalUrl, html) {
  let host = '';
  try { host = new URL(finalUrl || url).hostname.toLowerCase(); } catch (e) { /* ignore */ }
  const title = titleOf(html);
  const rule = SOFT_404_RULES.find((r) => r.host.test(host));
  if (rule) {
    // Match against visible text only — platform JS bundles can contain
    // these phrases as translation strings even on pages that exist.
    const visible = (html || '')
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    if (rule.re.test(visible) || rule.re.test(title)) return 'page says it is not available (soft 404)';
  }
  if (GENERIC_SOFT_404_TITLE.test(title)) return `page title says "${title.slice(0, 60)}" (soft 404)`;
  return null;
}

function headersToObject(headers) {
  const obj = {};
  headers.forEach((v, k) => { obj[k.toLowerCase()] = v; });
  return obj;
}

function errorNote(e) {
  if (!e) return 'unreachable';
  if (e.name === 'AbortError') return 'timeout';
  if (e.cause && e.cause.code) return e.cause.code;
  return e.message || 'unreachable';
}

/**
 * Creates a checker for ONE scan run. Call checker.checkPageLinks(url, max)
 * for each page; results are cached across calls.
 */
function createLinkChecker({ concurrency = 2, timeoutMs = 12_000, minGapMs = 400 } = {}) {
  const cache = new Map(); // url -> Promise<{ state: 'ok'|'broken'|'unverified', status, note }>
  const throttle = new HostThrottle({ minGapMs, abortAfter: 3 });

  async function request(url, { readBody }) {
    const ua = await getUserAgent();
    await throttle.waitFor(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { ...FETCH_HEADERS, 'User-Agent': ua },
        signal: ctrl.signal,
      });
      const headers = headersToObject(res.headers);
      const isHtml = /html/i.test(headers['content-type'] || '');
      let bodyText = '';
      if (readBody === 'always') {
        bodyText = await res.text();
      } else if (readBody === 'errors' && isHtml) {
        // HTML only (never images/PDFs): enough of the page to spot a WAF
        // challenge on errors, or a "not found" page served with HTTP 200.
        bodyText = await readLimited(res, BODY_SNIFF_BYTES);
      } else if (res.body) {
        // We only need the status — don't download images/PDFs/videos.
        await res.body.cancel().catch(() => {});
      }
      return { status: res.status, headers, bodyText, finalUrl: res.url || url, isHtml };
    } finally {
      clearTimeout(timer);
    }
  }

  function checkUrl(url) {
    if (cache.has(url)) return cache.get(url);
    const p = (async () => {
      if (throttle.shouldAbort(url)) {
        return { state: 'unverified', status: 0, note: 'site kept blocking the checker, skipped' };
      }
      try {
        const r = await request(url, { readBody: 'errors' });
        const title = (r.bodyText.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
        const block = detectBlock({ status: r.status, headers: r.headers, title, bodyText: r.bodyText });
        throttle.record(url, block);
        if (block) return { state: 'unverified', status: r.status, note: `bot protection: ${block.reason}` };
        if (r.status === 401 || r.status === 403) {
          return { state: 'unverified', status: r.status, note: `HTTP ${r.status}, access denied to the checker` };
        }
        if (r.status >= 400) return { state: 'broken', status: r.status };
        if (r.isHtml) {
          const soft = softNotFound(url, r.finalUrl, r.bodyText);
          if (soft) return { state: 'broken', status: r.status, note: soft };
          let finalHost = '';
          let finalPath = '';
          try { const fu = new URL(r.finalUrl); finalHost = fu.hostname; finalPath = fu.pathname; } catch (e) { /* ignore */ }
          if (SOCIAL_HOST_RE.test(finalHost) && LOGIN_WALL_RE.test(finalPath) && !LOGIN_WALL_RE.test(new URL(url).pathname)) {
            return { state: 'unverified', status: r.status, note: 'redirected to a login page, cannot verify while logged out' };
          }
        }
        return { state: 'ok', status: r.status };
      } catch (e) {
        return { state: 'broken', status: 0, note: errorNote(e) };
      }
    })();
    cache.set(url, p);
    return p;
  }

  async function runPool(items, worker) {
    let i = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await worker(items[idx]);
      }
    });
    await Promise.all(runners);
  }

  /**
   * Returns {
   *   checked, broken: string[], unverified: string[],
   *   pageBlocked: boolean, blockReason?: string
   * }
   */
  async function checkPageLinks(pageUrl, maxLinks = 30) {
    if (throttle.shouldAbort(pageUrl)) {
      return { checked: 0, broken: [], unverified: [], pageBlocked: true, blockReason: 'site kept blocking the checker' };
    }

    let page;
    try {
      page = await request(pageUrl, { readBody: 'always' });
    } catch (e) {
      return { checked: 0, broken: [`${pageUrl} (page itself failed to load: ${errorNote(e)})`], unverified: [], pageBlocked: false };
    }

    const title = (page.bodyText.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    const pageBlock = detectBlock({ status: page.status, headers: page.headers, title, bodyText: page.bodyText });
    throttle.record(pageUrl, pageBlock);
    if (pageBlock) {
      return { checked: 0, broken: [], unverified: [], pageBlocked: true, blockReason: pageBlock.reason };
    }
    if (page.status >= 400) {
      return { checked: 0, broken: [`${pageUrl} (page itself returned HTTP ${page.status})`], unverified: [], pageBlocked: false };
    }
    // The page's own successful load counts as a checked "ok" for the cache.
    cache.set(pageUrl, Promise.resolve({ state: 'ok', status: page.status }));

    const sources = extractLinkSources(page.bodyText, page.finalUrl);
    const links = Array.from(sources.keys())
      .filter((u) => u !== pageUrl && u !== page.finalUrl)
      .slice(0, maxLinks);
    // Only label non-obvious sources (meta tags, <link>, scripts…); plain <a> links need no tag.
    const where = (u) => (sources.get(u) && sources.get(u) !== 'a' ? ` [in ${sources.get(u)}]` : '');

    const results = new Map();
    await runPool(links, async (u) => { results.set(u, await checkUrl(u)); });

    const broken = [];
    const unverified = [];
    for (const u of links) {
      const r = results.get(u);
      if (!r) continue;
      if (r.state === 'broken') {
        const why = r.note ? (r.status ? `${r.status}, ${r.note}` : r.note) : (r.status || 'unreachable');
        broken.push(`${u} (${why})${where(u)}`);
      } else if (r.state === 'unverified') {
        unverified.push(`${u} (${r.note})${where(u)}`);
      }
    }
    return { checked: links.length, broken, unverified, pageBlocked: false };
  }

  return {
    checkPageLinks,
    checkUrl,
    isHostBlocked: (url) => throttle.shouldAbort(url),
  };
}

/**
 * Backwards-compatible one-off check (no cache sharing between calls).
 * Prefer createLinkChecker() once per scan run.
 */
async function checkPageLinks(pageUrl, maxLinks = 30) {
  return createLinkChecker().checkPageLinks(pageUrl, maxLinks);
}

module.exports = { checkPageLinks, createLinkChecker, extractLinks, extractLinkSources, softNotFound };
