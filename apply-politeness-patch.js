#!/usr/bin/env node
/**
 * One-off patcher: wires politeness.js / the new linkcheck.js into server.js
 * and teaches report.js about "Blocked" results.
 *
 * Usage (from the project root):
 *   node apply-politeness-patch.js          # dry run: reports what would change
 *   node apply-politeness-patch.js --write  # applies, keeping server.js.bak / report.js.bak
 *
 * Every edit is matched by pattern (whitespace-tolerant). If a REQUIRED edit
 * can't be found, nothing is written for that file and the script tells you
 * which one — so it can never half-patch a file. Re-running is safe: edits
 * already applied are detected and skipped.
 */
const fs = require('fs');
const path = require('path');

const WRITE = process.argv.includes('--write');

const PATCHES = {
  'server.js': [
    {
      name: 'require politeness + link checker factory',
      done: /require\('\.\/politeness'\)/,
      find: /const \{ checkPageLinks \} = require\('\.\/linkcheck'\);/,
      replace: () =>
        "const { checkPageLinks, createLinkChecker } = require('./linkcheck');\n" +
        "const { getUserAgent, DEFAULT_HEADERS, HostThrottle, pageBlockInfo, hostOf } = require('./politeness');",
    },
    {
      name: 'crawl User-Agent (drop "Bot" string; default now in politeness.js)',
      done: /politeness-patch:ua/,
      find: /userAgent:\s*process\.env\.CRAWLER_USER_AGENT\s*\|\|\s*`SiteDiffInspectorBot[^`]*`\s*,/g,
      replace: () => 'userAgent: process.env.CRAWLER_USER_AGENT || undefined, /* politeness-patch:ua */',
    },
    {
      name: 'diff test: browser context with UA + headers, throttle',
      done: /politeness-patch:test-context/,
      find: /browser = await chromium\.launch\(\);(\s*)const context = await browser\.newContext\(\);/,
      replace: (m, ws) =>
        `browser = await chromium.launch();${ws}` +
        `const context = await browser.newContext({ userAgent: await getUserAgent(), extraHTTPHeaders: DEFAULT_HEADERS, locale: 'en-US' }); /* politeness-patch:test-context */${ws}` +
        `const testThrottle = new HostThrottle({ baseCooldownMs: 15000, abortAfter: 3 });`,
    },
    {
      name: 'diff test: block-info variables',
      done: /politeness-patch:block-vars/,
      find: /let benchTitle = '', candTitle = '';(\s*)/,
      replace: (m, ws) => `let benchTitle = '', candTitle = '';${ws}let benchBlock = null, candBlock = null; /* politeness-patch:block-vars */${ws}`,
    },
    {
      name: 'diff test: benchmark navigation (cooldown + block detection)',
      done: /politeness-patch:bench-goto/,
      find: /const r1 = await p1\.goto\(benchPage\.url, (\{[^}]*\})\);(\s*)benchStatus = r1 \? r1\.status\(\) : 0;(\s*)benchOk = !!r1 && r1\.ok\(\);/,
      replace: (m, opts, ws1, ws2) =>
        `await testThrottle.waitFor(benchPage.url); /* politeness-patch:bench-goto */${ws1}` +
        `const r1 = await p1.goto(benchPage.url, ${opts});${ws1}` +
        `benchStatus = r1 ? r1.status() : 0;${ws2}` +
        `benchOk = !!r1 && r1.ok();${ws2}` +
        `benchBlock = await pageBlockInfo(p1, r1);${ws2}` +
        `testThrottle.record(benchPage.url, benchBlock);${ws2}` +
        `if (benchBlock) benchOk = false;`,
    },
    {
      name: 'diff test: candidate navigation (cooldown + block detection)',
      done: /politeness-patch:cand-goto/,
      find: /const r2 = await p2\.goto\(candPage\.url, (\{[^}]*\})\);(\s*)candStatus = r2 \? r2\.status\(\) : 0;(\s*)candOk = !!r2 && r2\.ok\(\);/,
      replace: (m, opts, ws1, ws2) =>
        `await testThrottle.waitFor(candPage.url); /* politeness-patch:cand-goto */${ws1}` +
        `const r2 = await p2.goto(candPage.url, ${opts});${ws1}` +
        `candStatus = r2 ? r2.status() : 0;${ws2}` +
        `candOk = !!r2 && r2.ok();${ws2}` +
        `candBlock = await pageBlockInfo(p2, r2);${ws2}` +
        `testThrottle.record(candPage.url, candBlock);${ws2}` +
        `if (candBlock) candOk = false;`,
    },
    {
      name: 'diff test: "Blocked" result instead of "unreachable/changed"',
      done: /politeness-patch:blocked-status/,
      find: /if \(!benchOk \|\| !candOk\) \{(\s*)status = 'red';(\s*)const whom = /,
      replace: (m, ws1, ws2) =>
        `let blocked = false; /* politeness-patch:blocked-status */\n      if (benchBlock || candBlock) {${ws1}` +
        `status = 'red';${ws1}` +
        `blocked = true;${ws1}` +
        `const whomBlocked = benchBlock && candBlock ? 'Both pages were' : benchBlock ? 'Benchmark page was' : 'Candidate page was';${ws1}` +
        'detail = `${whomBlocked} blocked by bot protection (${(candBlock || benchBlock).reason}), so content was not compared. This is not a content change.`;' +
        `\n      } else if (!benchOk || !candOk) {${ws1}status = 'red';${ws2}const whom = `,
    },
    {
      name: 'diff test: include "blocked" flag in each result',
      done: /politeness-patch:blocked-field/,
      find: /diffSnippet,(\s*)assetDiff,(\s*)\}\);/,
      replace: (m, ws1, ws2) => `diffSnippet,${ws1}assetDiff,${ws1}blocked, /* politeness-patch:blocked-field */${ws2}});`,
    },
    {
      name: 'diff test: stop after 3 blocks in a row',
      done: /politeness-patch:test-abort/,
      find: /testState\.done = results\.length;(\s*)testState\.results = results\.slice\(\);/,
      replace: (m, ws) =>
        `${m}${ws}if (testThrottle.shouldAbort(benchPage.url) || testThrottle.shouldAbort(candPage.url)) { /* politeness-patch:test-abort */${ws}` +
        `  const blockedHost = testThrottle.shouldAbort(candPage.url) ? hostOf(candPage.url) : hostOf(benchPage.url);${ws}` +
        '  throw new Error(`Stopped early: ${blockedHost} blocked the tester 3 times in a row (bot protection). Results so far are kept. If you control this site, allowlist the tool\'s User-Agent (contains "SiteDiffInspector") in its WAF.`);' +
        `${ws}}`,
    },
    {
      name: 'page-details capture: UA + headers',
      done: /politeness-patch:capture-page/,
      find: /browser = await chromium\.launch\(\);(\s*)const page = await browser\.newPage\(\);/g,
      replace: (m, ws) =>
        `browser = await chromium.launch();${ws}` +
        `const page = await browser.newPage({ userAgent: await getUserAgent(), extraHTTPHeaders: DEFAULT_HEADERS, locale: 'en-US' }); /* politeness-patch:capture-page */`,
    },
    {
      name: 'link scan: one cached checker per run',
      done: /politeness-patch:link-checker/,
      find: /const pages = Array\.from\(site\.pages\.values\(\)\);(\s*)linkScanRunning = true;/,
      replace: (m, ws) =>
        `const pages = Array.from(site.pages.values());${ws}` +
        `const linkChecker = createLinkChecker(); /* politeness-patch:link-checker */${ws}` +
        `linkScanRunning = true;`,
    },
    {
      name: 'link scan: use checker, handle blocked pages, stop hitting a blocking site',
      done: /politeness-patch:link-scan/,
      find: /await new Promise\(\(r\) => setTimeout\(r, 300\)\);(\s*)try \{(\s*)const linkResult = await withTimeout\(checkPageLinks\(page\.url, 50\), 45000, `Link scan for \$\{page\.url\}`\);(\s*)linkScanState\.results\[page\.path\] = \{\s*checked: linkResult\.checked,\s*broken: linkResult\.broken,\s*status: linkResult\.broken\.length > 0 \? 'red' : 'green',\s*\};/,
      replace: (m, ws1, ws2, ws3) =>
        `await new Promise((r) => setTimeout(r, 300));${ws1}` +
        `if (linkChecker.isHostBlocked(page.url)) { /* politeness-patch:link-scan */${ws1}` +
        `  linkScanState.results[page.path] = { checked: 0, broken: ['Skipped: this site kept blocking the scanner (bot protection), so the scan stopped requesting it.'], unverified: [], status: 'red', blocked: true };${ws1}` +
        `  linkScanState.done += 1;${ws1}` +
        `  continue;${ws1}` +
        `}${ws1}` +
        `try {${ws2}` +
        'const linkResult = await withTimeout(linkChecker.checkPageLinks(page.url, 50), 120000, `Link scan for ${page.url}`);' +
        `${ws3}linkScanState.results[page.path] = linkResult.pageBlocked${ws3}` +
        '  ? { checked: 0, broken: [`Page blocked by bot protection (${linkResult.blockReason}), links not checked.`], unverified: [], status: \'red\', blocked: true }' +
        `${ws3}  : { checked: linkResult.checked, broken: linkResult.broken, unverified: linkResult.unverified || [], status: linkResult.broken.length > 0 ? 'red' : 'green' };`,
    },
    {
      name: 'AI summary counts: leave blocked pages out of "broken"',
      optional: true,
      done: /politeness-patch:ai-count/,
      find: /if \(!r\) return;(\s*)if \(r\.status === 'red'\) \{(\s*)broken\+\+;/g,
      replace: (m, ws1, ws2) => `if (!r) return;${ws1}if (r.blocked) return; /* politeness-patch:ai-count */${ws1}if (r.status === 'red') {${ws2}broken++;`,
    },
  ],

  'report.js': [
    {
      name: 'diff report labels: "Blocked"',
      done: /r\.blocked \? 'Blocked'/,
      find: /r\.status === 'green' \? 'Equal' : r\.status === 'red' \? 'Changed' : 'Links Differ'/g,
      replace: () => "(r.blocked ? 'Blocked' : r.status === 'green' ? 'Equal' : r.status === 'red' ? 'Changed' : 'Links Differ')",
    },
    {
      name: 'analysis CSV link status: "Blocked"',
      done: /link\.blocked \? 'Blocked'/,
      find: /link \? \(link\.status === 'green' \? 'OK' : 'Broken'\) : 'Not scanned'/,
      replace: () => "link ? (link.blocked ? 'Blocked' : link.status === 'green' ? 'OK' : 'Broken') : 'Not scanned'",
    },
    {
      name: 'analysis PDF link cell: "Blocked"',
      done: /link && link\.blocked\s*\?/,
      find: /const linkCell = link(\s*)\? link\.status === 'green'/,
      replace: (m, ws) => `const linkCell = link && link.blocked${ws}? '<span class="pill amber">Blocked</span>'${ws}: link${ws}? link.status === 'green'`,
    },
    {
      name: 'analysis summary: blocked pages are neither broken nor clean',
      done: /if \(r\.blocked\) \{ \/\* blocked/,
      find: /if \(r\) \{ linkScanned\+\+; if \(r\.status === 'red'\) broken\+\+; else clean\+\+; \}/,
      replace: () => "if (r) { linkScanned++; if (r.blocked) { /* blocked: neither broken nor clean */ } else if (r.status === 'red') broken++; else clean++; }",
    },
  ],
};

let failed = false;

for (const [file, patches] of Object.entries(PATCHES)) {
  const full = path.join(process.cwd(), file);
  if (!fs.existsSync(full)) {
    console.error(`✗ ${file} not found in ${process.cwd()} — run this from the project root.`);
    failed = true;
    continue;
  }
  let src = fs.readFileSync(full, 'utf8');
  const original = src;
  const problems = [];

  for (const p of patches) {
    if (p.done.test(src)) {
      console.log(`  = ${file}: ${p.name} (already applied)`);
      continue;
    }
    const matches = src.match(p.find.global ? p.find : new RegExp(p.find.source, p.find.flags + 'g'));
    const count = matches ? matches.length : 0;
    if (count === 0) {
      if (p.optional) {
        console.log(`  ~ ${file}: ${p.name} (pattern not found, optional — skipped)`);
        continue;
      }
      problems.push(`${p.name}: pattern not found`);
      continue;
    }
    if (!p.find.global && count > 1) {
      problems.push(`${p.name}: pattern matched ${count} places, expected 1`);
      continue;
    }
    src = src.replace(p.find, p.replace);
    console.log(`  ✓ ${file}: ${p.name}${count > 1 ? ` (${count} places)` : ''}`);
  }

  if (problems.length) {
    failed = true;
    console.error(`✗ ${file}: NOT written — ${problems.length} required edit(s) could not be applied:`);
    problems.forEach((x) => console.error(`    - ${x}`));
    continue;
  }
  if (src === original) {
    console.log(`  ${file}: nothing to change.`);
    continue;
  }
  if (WRITE) {
    fs.writeFileSync(`${full}.bak`, original, 'utf8');
    fs.writeFileSync(full, src, 'utf8');
    console.log(`→ ${file} written (backup: ${file}.bak)`);
  } else {
    console.log(`→ ${file}: dry run, not written (add --write to apply)`);
  }
}

if (failed) {
  console.error('\nSome edits could not be applied — send the messages above back and they can be fixed by hand.');
  process.exit(1);
}
