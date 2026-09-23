const { check } = require('linkinator');

/**
 * Checks every link found on a single page (relative hrefs are resolved to
 * absolute using that page's own URL — this is exactly "construct relative
 * URL to absolute URL using the main domain").
 *
 * recurse:false means it only checks links FOUND on this page, it does not
 * follow them and crawl further — matches "list if any link is broken"
 * scoped to the candidate page itself.
 */
async function checkPageLinks(pageUrl, maxLinks = 30) {
  const result = await check({
    path: pageUrl,
    recurse: false,
    concurrency: 5,
    timeout: 12000,
    // retry:true would resend rate-limited/blocked requests with backoff —
    // fine on a healthy site, but if a WAF starts blocking mid-scan (which
    // has happened with real sites this tool's been tested against), every
    // single link on every remaining page gets retried, turning a page that
    // should fail fast into one that takes minutes. Fail fast instead —
    // the caller has its own outer timeout as a second layer of protection.
    retry: false,
  });

  const linksOnPage = result.links
    .filter((l) => l.url !== pageUrl && l.state !== 'SKIPPED')
    .slice(0, maxLinks);

  const broken = linksOnPage
    .filter((l) => l.state === 'BROKEN')
    .map((l) => `${l.url} (${l.status || 'unreachable'})`);

  return { checked: linksOnPage.length, broken };
}

module.exports = { checkPageLinks };
