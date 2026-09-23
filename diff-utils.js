// Produces a side-by-side, line-aligned diff between two HTML documents —
// used by the Site Diff "view details" popup to show benchmark source next
// to candidate source with differences highlighted, the same way a code
// review diff view works (unchanged lines aligned on both sides, removed
// lines only on the left, added lines only on the right).

// Rendered HTML from a real page is often one enormous line (or a handful
// of very long ones) — a raw line-by-line diff on that would just say
// "these two giant lines differ" and highlight nothing useful. Inserting a
// break after every tag boundary gives the diff something meaningful to
// align on, without needing a full HTML pretty-printer.
function normalizeToLines(html) {
  const withBreaks = String(html || '').replace(/>\s*</g, '>\n<');
  return withBreaks
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Cap how many lines get diffed — the DP table below is O(n*m) in both time
// and memory, so an uncapped pair of huge pages could be slow or use a lot
// of memory for what is, after all, an on-demand debugging view. Comparing
// the first MAX_LINES of each is still meaningful for real-world pages;
// pages that exceed it get a clear "truncated" flag rather than silently
// comparing something incomplete without saying so.
const MAX_LINES = 2500;

/**
 * Computes a side-by-side diff between two HTML strings. Returns
 * { rows, truncated, identical }.
 *
 * Each row is one of:
 *   { type: 'same',    left: <line>, right: <line> }
 *   { type: 'removed', left: <line>, right: null }
 *   { type: 'added',   left: null,   right: <line> }
 *
 * `identical` is true only when every row is 'same' — the caller uses this
 * to skip rendering a (possibly long) line-by-line view entirely when
 * there's nothing to show.
 */
function diffHtml(htmlA, htmlB) {
  let linesA = normalizeToLines(htmlA);
  let linesB = normalizeToLines(htmlB);
  let truncated = false;
  if (linesA.length > MAX_LINES) {
    linesA = linesA.slice(0, MAX_LINES);
    truncated = true;
  }
  if (linesB.length > MAX_LINES) {
    linesB = linesB.slice(0, MAX_LINES);
    truncated = true;
  }

  const rows = diffLines(linesA, linesB);
  const identical = rows.every((r) => r.type === 'same');
  return { rows, truncated, identical };
}

/**
 * Classic LCS-based diff: build the longest-common-subsequence length table
 * bottom-up, then walk it forward to emit an aligned same/removed/added
 * sequence. O(n*m) time and space — bounded by MAX_LINES above.
 */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of the LCS of a[i..n) and b[j..m)
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', left: a[i], right: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'removed', left: a[i], right: null });
      i++;
    } else {
      rows.push({ type: 'added', left: null, right: b[j] });
      j++;
    }
  }
  while (i < n) {
    rows.push({ type: 'removed', left: a[i], right: null });
    i++;
  }
  while (j < m) {
    rows.push({ type: 'added', left: null, right: b[j] });
    j++;
  }
  return rows;
}

module.exports = { diffHtml, normalizeToLines, diffLines, MAX_LINES };
