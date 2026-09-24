const { chromium } = require('playwright');
const { markdownToHtml, stripMarkdown } = require('./ai-summary');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toCsvValue(v) {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(rows) {
  return rows.map((row) => row.map(toCsvValue).join(',')).join('\r\n');
}

/**
 * Renders an HTML string to a PDF buffer via a real headless browser
 * (Playwright's own Chromium — same binary the rest of the app already
 * uses, no extra dependency). Used for both reports below.
 */
async function renderPdfFromHtml(html) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await browser.close();
  }
}

const REPORT_STYLE = `
  body{font-family: Arial, Helvetica, sans-serif; font-size:10.5px; color:#23262B; margin:0;}
  h1{font-size:17px;margin:0 0 4px;}
  h2{font-size:13px;margin:18px 0 6px;}
  h2:first-of-type{margin-top:14px;}
  .meta{font-size:10.5px;color:#5B5A52;margin-bottom:10px;line-height:1.6;}
  .dashboard{display:flex;flex-wrap:wrap;gap:0;border:1px solid #D9D2C0;margin-bottom:14px;}
  .dashboard .stat{flex:1 1 110px;padding:8px 10px;border-right:1px solid #D9D2C0;}
  .dashboard .stat:last-child{border-right:none;}
  .dashboard .stat .num{font-size:16px;font-weight:bold;}
  .dashboard .stat .lbl{font-size:8.5px;color:#5B5A52;text-transform:uppercase;letter-spacing:0.03em;margin-top:2px;}
  .status-note{font-size:10px;font-style:italic;color:#5B5A52;background:#F4F1E8;border:1px solid #D9D2C0;padding:7px 10px;margin:10px 0 4px;}
  table{width:100%;border-collapse:collapse;}
  th,td{border:1px solid #D9D2C0;padding:5px 7px;text-align:left;vertical-align:top;word-break:break-word;}
  th{background:#EFEAE0;font-size:9.5px;text-transform:uppercase;letter-spacing:0.03em;}
  tr{page-break-inside:avoid;}
  .pill{display:inline-block;font-size:9px;font-weight:bold;padding:2px 6px;border-radius:2px;}
  .green{background:#E3EEE2;color:#3C7A4C;}
  .red{background:#F3E2DF;color:#B23A32;}
  .amber{background:#F3E7D4;color:#B8792C;}
  .ai-summary{background:#F4F1FC;border:1px solid #DCD2F5;border-radius:6px;padding:9px 14px 12px;margin:0 0 14px;}
  .ai-summary h2{margin:0 0 8px;font-size:12.5px;color:#5B3FA0;display:flex;align-items:center;gap:6px;}
  .ai-summary .ai-badge{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:#7A5FC7;color:#fff;font-size:9px;line-height:1;}
  .ai-summary .entry{margin-bottom:10px;padding-bottom:10px;border-bottom:1px dashed #DCD2F5;}
  .ai-summary .entry:last-child{margin-bottom:0;padding-bottom:0;border-bottom:none;}
  .ai-summary .entry .phase{font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:0.03em;color:#7A5FC7;}
  .ai-summary .entry .timestamp{font-size:8.5px;color:#8B85A0;margin-bottom:4px;}
  .ai-summary .entry p{margin:3px 0;}
  .ai-summary .entry ul,.ai-summary .entry ol{margin:3px 0 3px 16px;padding:0;}
  .ai-summary .entry li{margin-bottom:2px;}
`;

/**
 * Renders every AI summary generated so far for this run (crawl, test/scan,
 * etc.) as one stacked, styled callout — each phase keeps its own entry
 * rather than later phases overwriting earlier ones. Returns '' (renders
 * nothing) when AI summaries aren't configured/available, so the report
 * looks identical to before for anyone not using the feature.
 */
function buildAiSummarySection(aiSummaries) {
  if (!aiSummaries || aiSummaries.length === 0) return '';
  const entriesHtml = aiSummaries
    .map((entry) => {
      const when = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '';
      const body = entry.html || markdownToHtml(entry.text || '');
      return `<div class="entry">
        <div class="phase">${escapeHtml(entry.reportType || 'AI Summary')}</div>
        ${when ? `<div class="timestamp">${escapeHtml(when)}</div>` : ''}
        ${body}
      </div>`;
    })
    .join('');
  return `<div class="ai-summary"><h2><span class="ai-badge">&#10024;</span> AI Summary</h2>${entriesHtml}</div>`;
}

/**
 * Plain-text CSV equivalent of the section above — one row per phase header,
 * then each line of that phase's summary as its own row (markdown stripped,
 * since raw "**bold**" characters look broken in a spreadsheet cell).
 */
function aiSummaryCsvRows(aiSummaries) {
  const rows = [];
  if (!aiSummaries || aiSummaries.length === 0) return rows;
  rows.push([]);
  rows.push(['-- AI Summary --']);
  aiSummaries.forEach((entry) => {
    const when = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '';
    rows.push([entry.reportType || 'AI Summary', when]);
    stripMarkdown(entry.text || '')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .forEach((line) => rows.push(['', line]));
    rows.push([]);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Diff Inspector report (page lists + comparison ledger)
// ---------------------------------------------------------------------------

function diffCounts(results) {
  const counts = { green: 0, red: 0, amber: 0 };
  (results || []).forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  return counts;
}

function buildDiffCsv({ results, benchOrigin, candOrigin, benchPages, candPages, aiSummaries }) {
  const hasResults = results && results.length > 0;
  const counts = diffCounts(results);
  const rows = [
    ['Benchmark', benchOrigin || ''],
    ['Candidate', candOrigin || ''],
    ['Benchmark pages', (benchPages || []).length],
    ['Candidate pages', (candPages || []).length],
    ['Generated', new Date().toISOString()],
    ['Testing completed', hasResults ? 'Yes' : 'No'],
  ];
  if (hasResults) {
    rows.push(['Matched pages', results.length]);
    rows.push(['Equal', counts.green]);
    rows.push(['Changed', counts.red]);
    rows.push(['Links differ', counts.amber]);
  }
  rows.push(...aiSummaryCsvRows(aiSummaries));
  rows.push([]);
  rows.push(['-- Benchmark Pages --']);
  rows.push(['Title', 'Path', 'URL']);
  (benchPages || []).forEach((p) => rows.push([p.title, p.path, p.url]));

  rows.push([]);
  rows.push(['-- Candidate Pages --']);
  rows.push(['Title', 'Path', 'URL']);
  (candPages || []).forEach((p) => rows.push([p.title, p.path, p.url]));

  if (hasResults) {
    rows.push([]);
    rows.push(['-- Comparison Ledger --']);
    rows.push(['Benchmark Path', 'Candidate Path', 'Status', 'Detail', 'Benchmark URL', 'Candidate URL', 'Link Differences', 'Static Asset (CSS/JS) Differences']);
    results.forEach((r) => {
      const assetParts = r.assetDiff
        ? [
            ...(r.assetDiff.onlyInBench || []).map((a) => `- ${a}`),
            ...(r.assetDiff.onlyInCand || []).map((a) => `+ ${a}`),
          ]
        : [];
      rows.push([
        r.benchPath,
        r.candPath,
        r.status === 'green' ? 'Equal' : r.status === 'red' ? 'Changed' : 'Links Differ',
        r.detail,
        r.benchUrl,
        r.candUrl,
        (r.broken || []).join(' | '),
        assetParts.join(' | '),
      ]);
    });
  }
  return toCsv(rows);
}

function buildDiffPdfHtml({ results, benchOrigin, candOrigin, benchPages, candPages, aiSummaries }) {
  const hasResults = results && results.length > 0;
  const counts = diffCounts(results);

  function pageRows(pages) {
    return (
      (pages || []).map((p) => `<tr><td>${escapeHtml(p.title)}</td><td>${escapeHtml(p.path)}</td></tr>`).join('') ||
      '<tr><td colspan="2">No pages.</td></tr>'
    );
  }

  const dashboard = `<div class="dashboard">
    <div class="stat"><div class="num">${(benchPages || []).length}</div><div class="lbl">Benchmark Pages</div></div>
    <div class="stat"><div class="num">${(candPages || []).length}</div><div class="lbl">Candidate Pages</div></div>
    <div class="stat"><div class="num">${hasResults ? results.length : '\u2014'}</div><div class="lbl">Matched</div></div>
    <div class="stat"><div class="num">${hasResults ? counts.green : '\u2014'}</div><div class="lbl">Equal</div></div>
    <div class="stat"><div class="num">${hasResults ? counts.red : '\u2014'}</div><div class="lbl">Changed</div></div>
    <div class="stat"><div class="num">${hasResults ? counts.amber : '\u2014'}</div><div class="lbl">Links Differ</div></div>
  </div>`;

  const statusNote = hasResults
    ? 'This report reflects a completed crawl and test — the comparison ledger below includes all matched pages.'
    : 'This report reflects a crawl only — testing has not been run yet, so no comparison ledger is included below.';

  const ledgerSection = hasResults
    ? `<h2>Comparison Ledger</h2>
       <table>
         <thead><tr><th style="width:26%">Path</th><th style="width:11%">Status</th><th>Detail</th></tr></thead>
         <tbody>${results
           .map((r) => {
             const label = r.status === 'green' ? 'Equal' : r.status === 'red' ? 'Changed' : 'Links Differ';
             const pathCell = r.benchPath === r.candPath
               ? escapeHtml(r.benchPath)
               : `${escapeHtml(r.benchPath)} &rarr; ${escapeHtml(r.candPath)}`;
             const assetNote = r.assetDiff
               ? `<div style="margin-top:4px;font-size:9px;color:#1F5C6B;">Static assets differ: ${
                   [
                     ...(r.assetDiff.onlyInBench || []).map((a) => `&minus; ${escapeHtml(a)}`),
                     ...(r.assetDiff.onlyInCand || []).map((a) => `+ ${escapeHtml(a)}`),
                   ].join('<br>')
                 }</div>`
               : '';
             return `<tr><td>${pathCell}</td><td><span class="pill ${r.status}">${label}</span></td><td>${escapeHtml(r.detail)}${assetNote}</td></tr>`;
           })
           .join('')}</tbody>
       </table>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${REPORT_STYLE}</style></head><body>
    <h1>Site Diff Inspector &mdash; Report</h1>
    <div class="meta">
      Benchmark: ${escapeHtml(benchOrigin || '\u2014')}<br>
      Candidate: ${escapeHtml(candOrigin || '\u2014')}<br>
      Generated: ${new Date().toLocaleString()}
    </div>
    ${buildAiSummarySection(aiSummaries)}
    ${dashboard}
    <div class="status-note">${statusNote}</div>

    <h2>Benchmark Pages</h2>
    <table><thead><tr><th style="width:50%">Title</th><th>Path</th></tr></thead><tbody>${pageRows(benchPages)}</tbody></table>

    <h2>Candidate Pages</h2>
    <table><thead><tr><th style="width:50%">Title</th><th>Path</th></tr></thead><tbody>${pageRows(candPages)}</tbody></table>

    ${ledgerSection}
  </body></html>`;
}

// ---------------------------------------------------------------------------
// Site Analysis report (dashboard + pages, link status, performance scores)
// ---------------------------------------------------------------------------

function analysisSummary(pages, linkResults, lhResults) {
  let linkScanned = 0, broken = 0, clean = 0;
  (pages || []).forEach((p) => {
    const r = (linkResults || {})[p.path];
    if (r) { linkScanned++; if (r.status === 'red') broken++; else clean++; }
  });
  const lhEntries = Object.values(lhResults || {});
  const mobileScores = lhEntries.map((r) => r.mobile && r.mobile.score).filter((s) => typeof s === 'number');
  const desktopScores = lhEntries.map((r) => r.desktop && r.desktop.score).filter((s) => typeof s === 'number');
  const lighthouseScanned = Object.keys(lhResults || {}).length;
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  return {
    totalPages: (pages || []).length,
    linkScanned,
    broken,
    clean,
    lighthouseScanned,
    avgMobile: avg(mobileScores),
    avgDesktop: avg(desktopScores),
  };
}

function analysisStatusStatement(summary) {
  const linksRun = summary.linkScanned > 0;
  const scoreRun = summary.lighthouseScanned > 0;
  if (!linksRun && !scoreRun) {
    return 'This report reflects a crawl only — broken link scanning and page score analysis have not been run.';
  }
  if (linksRun && !scoreRun) {
    return 'This report reflects a crawl and broken link scan — page score analysis has not been run.';
  }
  if (!linksRun && scoreRun) {
    return 'This report reflects a crawl and page score analysis — broken link scanning has not been run.';
  }
  return 'This report reflects a full analysis — crawl, broken link scan, and page score analysis all completed.';
}

function buildAnalysisCsv({ pages, linkResults, lhResults, siteOrigin, aiSummaries }) {
  const summary = analysisSummary(pages, linkResults, lhResults);
  const rows = [
    ['Site', siteOrigin || ''],
    ['Generated', new Date().toISOString()],
    ['Pages found', summary.totalPages],
    ['Pages with broken links', summary.linkScanned > 0 ? summary.broken : 'not scanned'],
    ['Pages fully clean', summary.linkScanned > 0 ? summary.clean : 'not scanned'],
    ['Avg. mobile score', summary.avgMobile !== null ? summary.avgMobile : 'not scored'],
    ['Avg. desktop score', summary.avgDesktop !== null ? summary.avgDesktop : 'not scored'],
    ['Status', analysisStatusStatement(summary)],
  ];
  rows.push(...aiSummaryCsvRows(aiSummaries));
  rows.push(
    [],
    ['Title', 'Path', 'URL', 'Link Status', 'Broken Links', 'Mobile Score', 'Mobile Error', 'Desktop Score', 'Desktop Error']
  );
  (pages || []).forEach((p) => {
    const link = (linkResults || {})[p.path];
    const lh = (lhResults || {})[p.path] || {};
    rows.push([
      p.title,
      p.path,
      p.url,
      link ? (link.status === 'green' ? 'OK' : 'Broken') : 'Not scanned',
      link && link.broken ? link.broken.join(' | ') : '',
      lh.mobile && typeof lh.mobile.score === 'number' ? lh.mobile.score : '',
      lh.mobile && lh.mobile.error ? lh.mobile.error : '',
      lh.desktop && typeof lh.desktop.score === 'number' ? lh.desktop.score : '',
      lh.desktop && lh.desktop.error ? lh.desktop.error : '',
    ]);
  });
  return toCsv(rows);
}

function buildAnalysisPdfHtml({ pages, linkResults, lhResults, siteOrigin, aiSummaries }) {
  const summary = analysisSummary(pages, linkResults, lhResults);

  function scoreCell(entry) {
    if (!entry) return '\u2014';
    if (typeof entry.score !== 'number') return '<span class="pill red">n/a</span>';
    const cls = entry.score >= 90 ? 'green' : entry.score >= 50 ? 'amber' : 'red';
    return `<span class="pill ${cls}">${entry.score}</span>`;
  }
  const rowsHtml = (pages || [])
    .map((p) => {
      const link = (linkResults || {})[p.path];
      const lh = (lhResults || {})[p.path] || {};
      const linkCell = link
        ? link.status === 'green'
          ? '<span class="pill green">OK</span>'
          : `<span class="pill red">Broken (${(link.broken || []).length})</span>`
        : '\u2014';
      return `<tr>
        <td>${escapeHtml(p.title)}</td>
        <td>${escapeHtml(p.path)}</td>
        <td>${linkCell}</td>
        <td>${scoreCell(lh.mobile)}</td>
        <td>${scoreCell(lh.desktop)}</td>
      </tr>`;
    })
    .join('');

  const dashboard = `<div class="dashboard">
    <div class="stat"><div class="num">${summary.totalPages}</div><div class="lbl">Pages Found</div></div>
    <div class="stat"><div class="num">${summary.linkScanned > 0 ? summary.broken : '\u2014'}</div><div class="lbl">Broken Links</div></div>
    <div class="stat"><div class="num">${summary.linkScanned > 0 ? summary.clean : '\u2014'}</div><div class="lbl">Fully Clean</div></div>
    <div class="stat"><div class="num">${summary.avgMobile !== null ? summary.avgMobile : '\u2014'}</div><div class="lbl">Avg. Mobile Score</div></div>
    <div class="stat"><div class="num">${summary.avgDesktop !== null ? summary.avgDesktop : '\u2014'}</div><div class="lbl">Avg. Desktop Score</div></div>
  </div>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${REPORT_STYLE}</style></head><body>
    <h1>Site Analysis Report</h1>
    <div class="meta">
      Site: ${escapeHtml(siteOrigin || '\u2014')}<br>
      Generated: ${new Date().toLocaleString()}
    </div>
    ${buildAiSummarySection(aiSummaries)}
    ${dashboard}
    <div class="status-note">${analysisStatusStatement(summary)}</div>
    <table>
      <thead>
        <tr>
          <th rowspan="2" style="width:26%">Title</th>
          <th rowspan="2" style="width:26%">Path</th>
          <th rowspan="2" style="width:16%">Link Status</th>
          <th colspan="2" style="width:32%;text-align:center;">Page Score</th>
        </tr>
        <tr>
          <th style="width:16%">Mobile</th>
          <th style="width:16%">Desktop</th>
        </tr>
      </thead>
      <tbody>${rowsHtml || '<tr><td colspan="5">No pages yet.</td></tr>'}</tbody>
    </table>
  </body></html>`;
}

module.exports = {
  toCsv,
  renderPdfFromHtml,
  buildDiffCsv,
  buildDiffPdfHtml,
  buildAnalysisCsv,
  buildAnalysisPdfHtml,
};
