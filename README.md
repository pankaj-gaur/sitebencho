# Site Diff Inspector (Node server + UI)

Crawls a benchmark site and a candidate site with a real headless browser
(Playwright, via Crawlee), matches pages by path, diffs the rendered HTML
(whitespace-insensitive), and checks every link found on each matched
candidate page (via Linkinator). Runs entirely on your machine — no
third-party CORS proxies involved.

## Downloading reports

Both tools have **Download CSV** / **Download PDF** links — Diff Inspector:
above the Benchmark/Candidate panels; Site Analysis: above the pages table.
They enable as soon as crawling finishes, not just after testing/scanning —
a "crawl only" report (page lists, no comparison yet) is already meaningful.
Reports grow richer as later phases complete:

- **Diff Inspector**: crawl-only report has the Benchmark and Candidate page
  lists. Once you run **Start testing**, the same download links now also
  include the Comparison Ledger.
- **Site Analysis**: crawl-only report has the page list. Running **Scan for
  Broken Links** adds link status per page; running **Scan for Page Score**
  adds mobile/desktop performance scores. All three build on the same report.

PDFs are rendered server-side with Playwright's own print-to-PDF — no extra
dependency — and always reflect the *current* state of that tool, so
re-download after re-running a scan to get an updated report.

## AI Summary (optional)

Both tools can call an AI provider (Gemini, Cohere, or OpenAI/ChatGPT) after
each phase completes — crawl, test (Diff Inspector), link scan, or page
score scan (Site Analysis) — and display a plain-language summary. This is
entirely optional; without configuration, the app works exactly as before
and the summary panel simply never appears.

**Setup:**

```bash
cp ai-config.example.json ai-config.json
```

Edit `ai-config.json`:

```json
{
  "primary": {
    "provider": "gemini",
    "apiKey": "YOUR_GEMINI_API_KEY_HERE",
    "model": "gemini-1.5-flash"
  },
  "fallback": {
    "provider": "cohere",
    "apiKey": "YOUR_COHERE_API_KEY_HERE",
    "model": "command-r"
  },
  "promptTemplate": "You are a QA assistant summarizing automated website testing results for a non-technical stakeholder. Write a short, plain-language summary (3-6 sentences or a short bullet list) of the {reportType} results below. Call out the most important findings, any risks, and anything that looks like it needs action. Don't restate raw numbers that are already obvious from the data — interpret them.\n\nResults:\n{data}"
}
```

- `primary`: the provider to try first — `provider` is `"gemini"`, `"cohere"`,
  or `"openai"`; `apiKey` is your key for that provider; `model` is optional
  (defaults to `gemini-1.5-flash`, `command-r`, and `gpt-4o-mini`
  respectively). **Never commit this file** — `ai-config.json` is already in
  `.gitignore`.
- `fallback` (optional): a second provider, same shape as `primary`, used
  only if the primary provider fails (see retry/fallback behavior below).
  Omit it entirely to run with a single provider and no fallback.
- `promptTemplate` (optional): `{reportType}` and `{data}` get substituted
  with a label (e.g. "Site Diff — Comparison Test") and a JSON summary of
  that run's results. Write your own template to change tone, length, or
  focus — omit it entirely to use the default shown above.
- `pageForecastPromptTemplate` (optional): same `{reportType}`/`{data}`
  substitution, used only for the per-page score forecast described below.
  Omit it to use the built-in default.
- **Older config files** with a flat `{ "provider", "apiKey", "model" }`
  shape (no `primary`/`fallback`) still work unchanged — they're treated as
  a primary-only config with no fallback.

**Encrypting API keys at rest:** by default `apiKey` is plaintext, which is
fine for a local/private machine but means anyone with read access to
`ai-config.json` (a backup, a shared server, etc.) can read the key
directly. To encrypt a key instead:

```bash
# 1. Generate a master key ONCE. This is not written to any file — copy it
#    into wherever this app gets its environment variables from (a process
#    manager, systemd EnvironmentFile with restricted permissions, your
#    host's own secret store) as AI_CONFIG_ENCRYPTION_KEY. Never put it in
#    ai-config.json alongside the encrypted values — that defeats the point.
node encrypt-secret.js --generate-key
# -> e.g. 488c0f24f1b24b5620ded5e05b3461e6b37a8de51050c7ea206b54ece293c5cf

# 2. Encrypt each plaintext API key, with the master key available as
#    AI_CONFIG_ENCRYPTION_KEY, and paste the output into ai-config.json.
AI_CONFIG_ENCRYPTION_KEY=488c0f24...293c5cf node encrypt-secret.js "AIzaSy...yourRealKey"
# -> enc:v1:129f042a...:cac7852b...:0787d7ef...
```

```json
{
  "primary": {
    "provider": "gemini",
    "apiKey": "enc:v1:129f042a9570f5e59d54a272:cac7852be5fab6a374b72ebba59b9bba:0787d7ef...",
    "model": "gemini-1.5-flash"
  }
}
```

Then set `AI_CONFIG_ENCRYPTION_KEY` in the environment the app actually runs
in (e.g. `AI_CONFIG_ENCRYPTION_KEY=488c0f24... npm start`, or however your
process manager injects environment variables) — the app decrypts each
`enc:v1:...` value at startup using AES-256-GCM. Encryption is per-key and
opt-in: `primary` and `fallback` can mix plaintext and encrypted values, and
a value with no `enc:v1:` prefix is always treated as plaintext, so you can
migrate one key at a time without breaking the ones you haven't touched
yet. If a key is encrypted but `AI_CONFIG_ENCRYPTION_KEY` is missing, wrong,
or the value has been altered, that provider is dropped with a clear reason
logged to the console — the rest of the config (a plaintext primary, or a
fallback) still works normally rather than crashing the app.

This raises the bar against casual exposure — a leaked `ai-config.json`
alone reveals nothing — but the master key still lives on the same host as
the running process (as it must, since the app is the one decrypting).
It's not equivalent to a dedicated secrets manager with rotation, per-key
access control, and audit logging (Vault, Doppler, AWS/GCP Secrets Manager,
etc.) — if you need those, point `AI_CONFIG_ENCRYPTION_KEY` (or `apiKey`
directly) at whatever that tool injects as an environment variable instead.

**Retry and fallback behavior:** a failed call to a provider is retried up
to 2 times (3 attempts total), waiting 5 seconds between attempts — but only
for *transient* failures (rate limits, temporary outages, timeouts). A
*permanent* failure (invalid API key, malformed request, unknown model)
fails immediately instead of wasting time on retries that can't succeed.
If the primary provider still fails after its retries, and a `fallback` is
configured, the same retry policy runs against the fallback before giving
up. Each request also has a 30-second timeout, so a hung connection can't
block things indefinitely. If every configured provider ultimately fails, a
plain-language error is shown in the summary panel (the full technical
detail is logged to the server console) along with a **Retry** button that
re-runs the same attempt on demand — no need to re-run the whole crawl or
scan just to try the AI summary again.

**How it behaves:** the AI call runs in the background after each phase — it
never blocks or delays the scan itself. Each phase **appends** its own
summary rather than replacing the previous one, so after a crawl, then a
test/scan, you see both — labeled and timestamped, in the order they ran.
The summary panel shows a spinner while a call is in progress and updates
in place once done; a fresh crawl clears the panel and starts the sequence
over for that run.

Nothing in the payload sent to the AI provider includes your API key or any
server internals — only the same summary-level data (page counts, sample
results) that's already visible on the page.

**Per-page score details and AI forecast (Site Analysis only):** once
Lighthouse has scored a page, a small view-details icon appears in its own
column next to the Performance score (it's icon-only — no data lives in
that column, and it's never included in the CSV/PDF report). Clicking it
opens a three-column popup:

1. **Core Web Vitals** — LCP, FCP, CLS, TBT, and Speed Index for mobile and
   desktop, color-coded the same way as the score badges.
2. **Recommendations** — the specific Lighthouse audits (render-blocking
   resources, unused CSS, etc.) that are holding the score back, with each
   one's estimated savings.
3. **AI Forecast** — automatically requested when the popup opens, using
   `pageForecastPromptTemplate` above through the same primary/fallback
   provider chain and retry policy as the phase summaries. It estimates the
   score if the listed recommendations were implemented, the improvement as
   a percentage, and which fixes would matter most. A failed forecast shows
   the same friendly-error-plus-Retry pattern as the phase summaries.

The Core Web Vitals and recommendations aren't shown anywhere else in the
UI as a raw table, but they're still captured for every scanned page (saved
to history alongside the rest of that run's data) and fed into the
site-wide "Site Analysis — Page Performance Scan" AI summary — so the
generated summary can speak to actual bottlenecks and shared/template-level
issues across pages, not just the numeric scores.

## Requirements

- Node.js 18 or newer
- ~300MB free for the Chromium browser Playwright installs
- Lighthouse and chrome-launcher (installed via `npm install` — Lighthouse
  reuses Playwright's already-downloaded Chromium, so no separate Chrome
  install is needed)

## Setup

```bash
cd site-diff-inspector
npm install
```

`npm install` runs a `postinstall` step that downloads Chromium for
Playwright. If that step fails or is skipped, run it manually:

```bash
npx playwright install chromium
```

## Run

```bash
npm start
```

Then open **http://localhost:3000** in your browser. There are two tools,
linked via the nav bar at the top of each page:

- **Diff Inspector** (`index.html`) — the benchmark-vs-candidate comparison
  covered below.
- **Site Analysis** (`analysis.html`) — crawls one site, scans every page's
  links for breaks, and scores page performance with Google Lighthouse
  (color-coded to Google's own thresholds: 90+ green, 50-89 amber, under 50
  red). Both checks run per-page with a live spinner in that page's row
  until its own result is ready — you don't wait for the whole site to
  finish before seeing anything. Lighthouse is genuinely slow (a full
  simulated-throttle audit per page, ~10-20s each), so it's capped to a
  page count you choose rather than auto-running against every page.

- **History** (`history.html`) — one **Crawl sites** / **Crawl Site** click
  starts a session that gets saved automatically right after crawling
  finishes, and the SAME history row is updated (not duplicated) as later
  phases complete — testing for Diff Inspector; link scanning and/or
  Lighthouse for Site Analysis. Each row shows a status badge reflecting how
  far that session got ("Crawl only", "Crawl + Test", "Crawl + Links",
  "Crawl + Links + Score"). Past reports (CSV and PDF) regenerate from that
  saved snapshot, so they stay downloadable even after you've moved on to a
  newer crawl. The most recent 30 sessions of each type are kept; older ones
  are pruned automatically, or delete any entry manually.

## Checking specific pages instead of a whole site

Both tools default to crawling — one URL in, the sitemap (or link-following)
finds the rest. If you already know exactly which pages you want checked,
switch the **"Crawl a site" / "Use a URL list"** toggle next to each URL
field to **Use a URL list**. That swaps the input for a textarea — paste one
URL per line, or upload a `.txt`/`.csv` file (read entirely in your browser;
nothing is uploaded to any third party). No crawling, discovery, or
rendering happens in this mode — the list you provide is registered exactly
as given (same order, no de-duplication, nothing added or removed) and
that's what gets checked. "Max Pages to Scan" doesn't apply here since
you've already specified the exact set.

This works for a single page too — a "list" with one URL in it is a
perfectly normal way to check just one specific page without crawling
anything around it.

As soon as the URL list has content, the panel/table shows those URLs
immediately (path parsed client-side). Pressing Start testing / Scan for
Broken Links / Scan for Page Score registers the list server-side — this is
near-instant (no browser rendering involved, unlike a real crawl) — and then
does the actual work; "Crawl Site(s)" is disabled in this mode since it
isn't needed.

**Diff Inspector pairs by position in this mode, not by path.** Normally
(crawl mode) benchmark and candidate pages are matched because they share
the same path — that assumes both sides are the same site. A URL list has
no such guarantee, so instead the 1st benchmark URL is always compared
against the 1st candidate URL, the 2nd against the 2nd, and so on —
regardless of path, domain, or structure. That means
`contentbloom.com/abc` can be compared directly against
`new.contentbloom.com/xyz/def` just by being on the same line number in
each list. The ledger and downloaded report show both paths side by side
(joined with an arrow when they differ) instead of a single shared path.
If the two lists are different lengths, the extra entries on the longer
side are left unpaired — nothing sensible to compare them against.

## Loading a previous crawl instead of re-crawling

A third mode, **"Load from history"**, lets you reuse a page list from an
earlier session instead of crawling or re-entering a URL list. Every
completed crawl (Diff Inspector's benchmark and candidate sides separately,
or a Site Analysis session) is already saved to `history/` — this mode just
picks one and loads its page list directly. Since it's reading a saved file
rather than rendering anything, it's near-instant: selecting an option in
the dropdown loads the pages right away, and "Start testing" / the Scan
buttons enable immediately afterward, same as a completed crawl.

## Using the Diff Inspector
2. Enter the candidate site's URL in the right panel, press **Crawl**.
   Crawling renders each page in a real browser (waits for JS to settle),
   so it's slower than a plain HTTP fetch — that's expected, and it's what
   lets this catch client-rendered (SPA) content a raw-HTML crawler would
   miss entirely.
3. Once both are crawled, **Start testing** becomes available. It re-renders
   each matched pair fresh, compares source, and — only when the source
   matches — checks every link found on that candidate page.

Diff Inspector also lists and compares each matched pair's static assets
(stylesheets, scripts, favicon, web manifest) — Site Analysis doesn't do
this. It's purely informational (doesn't change the equal/changed/links-
differ status), shown as an extra "Static assets differ" note under any
row where the referenced CSS/JS files aren't identical between benchmark
and candidate.

## If the UI shows "Failed to fetch" mid-crawl

That specific message means the browser lost its connection to this server
entirely — not an error response, a dead connection. That points to the
Node process itself crashing. As of this version:

- Unhandled promise rejections and uncaught exceptions are now caught at the
  top level and **logged instead of crashing the process** (see the top of
  `server.js`). Check the terminal for a line starting with
  `[server] Unhandled promise rejection` or `[server] Uncaught exception`
  right around when it failed — that's the real cause.
- `npm start` now runs Node with `--max-old-space-size=4096` as a safety net
  against heap exhaustion on long crawls. If your machine has less than
  ~6GB RAM free, lower this in `package.json`'s `start` script — too high a
  value on a constrained machine can make things worse, not better.
- If the terminal shows nothing at all and the `node` process itself is just
  gone (check Task Manager / Activity Monitor), that's the OS's own
  out-of-memory killer, not something catchable from inside Node — the fix
  there is more RAM, a lower `maxPages`, or lowering `maxConcurrency` in
  `crawler.js` from 2 to 1.

## If a site returns a 406 / "blocked due to suspicious behavior" page

That's a WAF (Cloudflare, Sucuri, AWS WAF, etc.) pattern-matching the crawl as
bot/attack traffic. The crawler is already tuned to be polite by default
(2 concurrent pages, capped request rate, an honest identifying User-Agent —
see `crawler.js`), but a WAF can still legitimately block automated traffic
it doesn't recognize.

- **If you control the site**: ask whoever manages hosting/security to
  allowlist this tool's outbound IP or its User-Agent string. Set a real
  contact address so the string is meaningful:
  ```bash
  CONTACT_EMAIL=you@yourcompany.com npm start
  ```
  This is the actual fix — no client-side setting reliably gets past a WAF
  that's specifically trained to catch this pattern, and trying harder to
  look "less like a bot" starts to cross from politeness into evading a
  deliberate security control.
- **If you don't control the site**: get explicit permission before testing
  it this way. Treat a 406 as a "no," not an obstacle to route around.
- You can lower `requestsPerMinute` / raise the delay further in
  `crawler.js` and `server.js` if a site is sensitive even to the current
  pace.



- **Page cap per site**: 40 pages by default (`maxPages` in the `/api/crawl/:slot`
  request body in `public/index.html` — raise it there if you need more; very
  large sites will just take proportionally longer).
- **Links checked per page**: capped at 20 (`checkPageLinks` call in `server.js`)
  to keep test runs bounded on pages with huge link counts.
- **Same-domain only**: the crawler follows same-domain links only, so it
  won't wander off benchmarking somebody else's site.
- **In-memory only**: nothing is written to disk except Crawlee's own request
  queue bookkeeping (a `storage/` folder Crawlee creates — safe to delete
  between runs, or add to `.gitignore`).
- **Orphan pages**: a page nothing links to won't be discovered — the crawler
  only follows links it finds, it doesn't guess URLs.
