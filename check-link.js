#!/usr/bin/env node
/**
 * Diagnose how the link checker sees ONE URL, from your own machine.
 *
 *   node check-link.js https://www.facebook.com/contentbloomwcm/
 *
 * Prints the raw response (status, redirects, key headers, page title) and
 * the verdict the Site Analysis link scan would give it. Useful when a link
 * you know is broken shows as OK (or the other way round).
 */
const { getUserAgent, FETCH_HEADERS } = require('./politeness');
const { createLinkChecker } = require('./linkcheck');

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node check-link.js <url>');
    process.exit(1);
  }
  const ua = await getUserAgent();
  console.log(`User-Agent: ${ua}\n`);

  try {
    const res = await fetch(url, { redirect: 'follow', headers: { ...FETCH_HEADERS, 'User-Agent': ua } });
    const body = await res.text();
    const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    console.log('Raw response');
    console.log(`  status:        ${res.status}`);
    console.log(`  final URL:     ${res.url}${res.redirected ? '  (redirected)' : ''}`);
    for (const h of ['content-type', 'server', 'location', 'retry-after', 'cf-mitigated']) {
      if (res.headers.get(h)) console.log(`  ${h.padEnd(14)} ${res.headers.get(h)}`);
    }
    console.log(`  title:         ${title.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    console.log(`  body length:   ${body.length} chars`);
    const snippet = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`  text snippet:  ${snippet.slice(0, 300)}\n`);
  } catch (e) {
    console.log(`Raw request failed: ${e.cause && e.cause.code ? e.cause.code : e.message}\n`);
  }

  const verdict = await createLinkChecker({ minGapMs: 0 }).checkUrl(url);
  console.log('Link-scan verdict:', verdict);
})();
