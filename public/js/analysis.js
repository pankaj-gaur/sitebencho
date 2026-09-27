/* analysis.js — behaviour for analysis.html (Site Analysis).
 * Shared helpers come from main.js and the combination files via window.Miti. */
(function(){
  "use strict";
  const { $, escapeHtml, refreshIcons, setHidden, isHidden, parseUrlListText, pathFromUrl, confirmDialog, setProgress, getProgress } = window.Miti;

  const state = {
    pages: [],
    linkResults: {},
    lhResults: {},
    linkScanStarted: false,
    lighthouseStarted: false,
    lighthouseCap: 0,
    mode: "crawl",
    listRegistered: false,
  };

  // Client-only instant preview of the pasted list. Does NOT mean the list
  // has been rendered/registered server-side — see state.listRegistered,
  // which actually gates whether the Scan buttons trigger a fresh crawl
  // before doing their work.
  function previewListMode(){
    if(state.mode !== "list") return;
    state.listRegistered = false;
    const urls = parseUrlListText($("siteUrlList").value);
    state.pages = urls.map(u => ({ title: "(not yet rendered)", url: u, path: pathFromUrl(u) }));
    renderTable();
    updateDashboard();
  }

  function setMode(mode){
    state.mode = mode;
    state.listRegistered = false;
    const toggle = $("siteModeToggle");
    toggle.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.getAttribute("data-mode") === mode));
    setHidden($("siteUrl"), !(mode === "crawl"));
    setHidden($("siteListInput"), !(mode === "list"));
    setHidden($("siteHistoryInput"), !(mode === "history"));
    document.querySelector(".control-card .controls").classList.toggle("list-mode", mode === "list");
    if(mode === "list"){
      previewListMode();
    }else if(mode === "history"){
      loadHistoryOptions();
      state.pages = [];
      renderTable();
      updateDashboard();
    }else{
      state.pages = [];
      renderTable();
      updateDashboard();
    }
    updateButtonStates();
    refreshIcons();
  }

  // ---- Mode-switch reset ---------------------------------------------------

  // What's currently running. The link scan and the Lighthouse scan are
  // tracked separately so they can run IN PARALLEL (a single shared flag
  // made the second button silently do nothing while the first ran).
  // Mode switching is blocked while ANY of these is running.
  const running = { crawl: false, links: false, lighthouse: false };
  function isBusy(){ return running.crawl || running.links || running.lighthouse; }

  // Small promise-based dialog. showCancel:false turns it into a plain
  // notice (single OK button) — used when a switch is blocked.

  // True if there's anything on screen a reset would throw away.
  function hasSessionState(){
    return state.pages.length > 0
      || state.linkScanStarted
      || state.lighthouseStarted
      || !isHidden($("aiSummaryWrap"))
      || getProgress($("crawlBar")) > 0
      || getProgress($("linkScanBar")) > 0
      || getProgress($("lighthouseBar")) > 0;
  }

  // Puts every piece of on-screen session state back to how it looks on a
  // fresh page load — pages table, link + Lighthouse results, KPI numbers,
  // ALL three progress bars and status lines, the AI summary panel, and any
  // open details popup. The typed URL / pasted list is kept.
  function resetClientState(){
    if(aiPollTimer){ clearInterval(aiPollTimer); aiPollTimer = null; }
    setHidden($("aiSummaryWrap"), true);
    $("aiSummaryBody").innerHTML = "";

    closeDetailsModal();

    state.pages = [];
    state.linkResults = {};
    state.lhResults = {};
    state.linkScanStarted = false;
    state.lighthouseStarted = false;
    state.lighthouseCap = 0;
    state.listRegistered = false;

    setBar("crawlBar", 0, "");
    $("crawlStatus").textContent = "Enter a URL and press Crawl site.";
    $("crawlStatus").className = "status-line";

    setBar("linkScanBar", 0, "");
    setHidden($("linkScanTrack"), true);
    setHidden($("linkScanStatus"), true);
    $("linkScanStatus").textContent = "";
    $("linkScanStatus").className = "status-line";

    setBar("lighthouseBar", 0, "");
    setHidden($("lighthouseTrack"), true);
    setHidden($("lighthouseStatus"), true);
    $("lighthouseStatus").textContent = "";
    $("lighthouseStatus").className = "status-line";

    $("statBroken").textContent = "–";
    $("statClean").textContent = "–";
    $("statAvgMobile").textContent = "–";
    $("statAvgDesktop").textContent = "–";

    renderTable();
    updateDashboard();
    updateButtonStates();
  }

  const MODE_LABELS = { crawl: "Crawl a site", list: "Use a URL list", history: "Load from history" };

  async function requestModeChange(mode){
    if(mode === state.mode) return;

    if(isBusy()){
      await confirmDialog({
        title: "Scan in progress",
        message: "A crawl or scan is still running. Wait for it to finish before switching modes.",
        okLabel: "OK",
        showCancel: false,
      });
      return;
    }

    if(hasSessionState()){
      const ok = await confirmDialog({
        title: "Reset test bench?",
        message: `Switching to "${MODE_LABELS[mode]}" will reset the test bench — crawled pages, broken link and page score results, progress and the AI summary will be cleared. Your entered URLs are kept.`,
      });
      if(!ok) return; // Cancel — preserve everything exactly as it is
    }

    try{
      await api("/api/reset/analysis", { method: "POST", body: JSON.stringify({}) });
    }catch(e){
      await confirmDialog({ title: "Couldn't reset", message: e.message, okLabel: "OK", showCancel: false });
      return; // server refused (e.g. a scan still running) — keep current state
    }

    resetClientState();
    setMode(mode);
  }

  function setupModeToggle(){
    const toggle = $("siteModeToggle");
    toggle.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", () => requestModeChange(btn.getAttribute("data-mode")));
    });
  }

  async function loadHistoryOptions(){
    const select = $("siteHistorySelect");
    select.innerHTML = `<option value="">Loading saved crawls…</option>`;
    try{
      const result = await api("/api/history/pagesets");
      const opts = result.options || [];
      if(opts.length === 0){
        select.innerHTML = `<option value="">No saved crawls yet</option>`;
        return;
      }
      select.innerHTML = `<option value="">Select a saved crawl…</option>` +
        opts.map(o => `<option value="${escapeHtml(o.key)}">${escapeHtml(o.label)}</option>`).join("");
    }catch(e){
      select.innerHTML = `<option value="">Failed to load saved crawls</option>`;
    }
  }

  function setupHistorySelect(){
    const select = $("siteHistorySelect");
    select.addEventListener("change", async () => {
      updateButtonStates();
      if(!select.value) return;
      await crawlSite();
    });
  }

  function setupFileUpload(){
    const fileInput = $("siteUrlFile");
    const textarea = $("siteUrlList");
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const parsed = parseUrlListText(String(reader.result || ""));
        const existing = textarea.value.trim();
        textarea.value = existing ? existing + "\n" + parsed.join("\n") : parsed.join("\n");
        fileInput.value = "";
        previewListMode();
      };
      reader.onerror = () => alert("Failed to read that file.");
      reader.readAsText(file);
    });
  }

  async function api(path, opts){
    const res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
    let body;
    try { body = await res.json(); } catch(e){ body = { ok:false, error:"Server returned a non-JSON response." }; }
    if(!res.ok || body.ok === false){
      const err = new Error(body.error || `Request failed (HTTP ${res.status})`);
      err.partialPages = body.partialPages;
      throw err;
    }
    return body;
  }

  let aiPollTimer = null;

  function renderAiSummary(result){
    const wrap = $("aiSummaryWrap");
    const body = $("aiSummaryBody");
    const entries = Array.isArray(result.entries) ? result.entries : [];
    if(result.status === "idle" && entries.length === 0){
      setHidden(wrap, true);
      return;
    }
    setHidden(wrap, false);

    const entriesHtml = entries.map(e => {
      const when = e.createdAt ? new Date(e.createdAt).toLocaleString() : "";
      const html = e.html || `<p>${escapeHtml(e.text || "")}</p>`;
      return `<div class="ai-summary-entry">
        <div class="ai-summary-entry-head">
          <span class="ai-summary-phase">${escapeHtml(e.reportType || "AI Summary")}</span>
          ${when ? `<span class="ai-summary-time">${escapeHtml(when)}</span>` : ""}
        </div>
        <div class="ai-summary-html">${html}</div>
      </div>`;
    }).join("");

    let statusHtml = "";
    if(result.status === "generating"){
      statusHtml = `<div class="ai-summary-entry"><span class="spinner"></span> <span class="ai-summary-status">Synthesizing performance AI summary…</span></div>`;
    }else if(result.status === "error"){
      statusHtml = `<div class="ai-summary-entry">
        <div class="ai-summary-error">AI summary unavailable: ${escapeHtml(result.error || "unknown error")}</div>
        ${result.canRetry ? `<button type="button" class="ai-summary-retry-btn" id="aiSummaryRetryBtn">Retry</button>` : ""}
      </div>`;
    }

    body.innerHTML = entriesHtml + statusHtml || `<div class="ai-summary-entry"><span class="ai-summary-status">No summary yet.</span></div>`;

    const retryBtn = $("aiSummaryRetryBtn");
    if(retryBtn) retryBtn.addEventListener("click", retryAiSummary);
    refreshIcons();
  }

  async function retryAiSummary(){
    const btn = $("aiSummaryRetryBtn");
    if(btn){ btn.disabled = true; btn.textContent = "Retrying…"; }
    try{
      await api("/api/ai-summary/analysis/retry", { method: "POST", body: JSON.stringify({}) });
    }catch(e){ }
    pollAiSummary();
  }

  async function pollAiSummary(){
    try{
      const result = await api("/api/ai-summary/analysis");
      renderAiSummary(result);
      if(result.status === "generating"){
        if(!aiPollTimer) aiPollTimer = setInterval(pollAiSummary, 2500);
      }else if(aiPollTimer){
        clearInterval(aiPollTimer);
        aiPollTimer = null;
      }
    }catch(e){ }
  }

  function linkCellHtml(path){
    if(!state.linkScanStarted) return '<span class="pill pill-dim">not scanned</span>';
    const r = state.linkResults[path];
    if(!r) return '<span class="spinner" title="Scanning links…"></span>';
    if(r.blocked){
      return `<span class="pill pill-blue" title="The site's bot protection refused the scanner">Blocked</span>`;
    }
    const unv = (r.unverified || []).length;
    const unvNote = unv ? ` <span class="pill pill-blue" title="Links the scanner could not verify (bot protection / access denied) — check manually">${unv} unverified</span>` : "";
    if(r.status === "green"){
      return `<span class="pill pill-green">OK (${r.checked})</span>${unvNote}`;
    }
    return `<span class="pill pill-red">Broken (${r.broken.length})</span>${unvNote}`;
  }

  function linkDetailHtml(path){
    const r = state.linkResults[path];
    if(!r) return "";
    const unverified = (r.unverified || []).length
      ? `<div class="unverified-detail">Could not verify (bot protection / access denied):<br>${r.unverified.map(escapeHtml).join("<br>")}</div>`
      : "";
    if(r.status !== "red" || !r.broken.length) return unverified;
    return `<div class="broken-detail">${r.broken.map(escapeHtml).join("<br>")}</div>${unverified}`;
  }

  function scoreBadgeHtml(entry, label){
    if(!entry){
      return `<span class="spinner" title="Scoring (${label})…"></span>`;
    }
    if(entry.error || entry.score === null || entry.score === undefined){
      return `<span class="score-na" title="${escapeHtml(entry.error || "failed")}">${label[0]}: n/a</span>`;
    }
    const cls = entry.score >= 90 ? "score-good" : (entry.score >= 50 ? "score-mid" : "score-poor");
    return `<span class="score-badge ${cls}" title="${label}">${label[0]}:${entry.score}</span>`;
  }

  const VITAL_LABELS = { lcp: "LCP", fcp: "FCP", cls: "CLS", tbt: "TBT", speedIndex: "Speed Index" };
  let detailsModalPath = null;
  let forecastPollTimer = null;

  function vitalValueHtml(vital){
    if(!vital || vital.displayValue === null || vital.displayValue === undefined) return '<span class="vital-na">n/a</span>';
    const cls = vital.score === null || vital.score === undefined ? "" :
      (vital.score >= 0.9 ? "vital-good" : (vital.score >= 0.5 ? "vital-mid" : "vital-poor"));
    return `<span class="vital-value ${cls}">${escapeHtml(vital.displayValue)}</span>`;
  }

  function renderVitalsColumn(entry){
    const mobileVitals = (entry && entry.mobile && entry.mobile.vitals) || {};
    const desktopVitals = (entry && entry.desktop && entry.desktop.vitals) || {};
    const rows = Object.keys(VITAL_LABELS).map(key => `
      <tr>
        <td class="vital-metric">${VITAL_LABELS[key]}</td>
        <td>${vitalValueHtml(mobileVitals[key])}</td>
        <td>${vitalValueHtml(desktopVitals[key])}</td>
      </tr>
    `).join("");
    $("detailsModalVitals").innerHTML = `
      <table class="vitals-table">
        <thead><tr><th>Metric</th><th>Mobile</th><th>Desktop</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function recCardsHtml(recommendations){
    if(!recommendations || recommendations.length === 0){
      return `<div class="rec-empty">No critical optimization opportunities detected.</div>`;
    }
    return recommendations.map(r => `
      <div class="rec-card">
        <div class="rec-title">${escapeHtml(r.title)}</div>
        ${r.description ? `<div class="rec-desc">${escapeHtml(r.description)}</div>` : ""}
        ${r.displayValue ? `<div class="rec-savings">${escapeHtml(r.displayValue)}</div>` : ""}
      </div>
    `).join("");
  }

  function renderRecommendationsColumn(entry){
    const mobileRecs = (entry && entry.mobile && entry.mobile.recommendations) || [];
    const desktopRecs = (entry && entry.desktop && entry.desktop.recommendations) || [];
    $("detailsModalRecs").innerHTML = `
      <div class="rec-group-label">Mobile Optimizations</div>
      ${recCardsHtml(mobileRecs)}
      <div class="rec-group-label">Desktop Optimizations</div>
      ${recCardsHtml(desktopRecs)}
    `;
  }

  function renderForecastColumn(result){
    const el = $("detailsModalForecast");
    if(!result || result.status === "idle"){
      el.innerHTML = `<span class="ai-summary-status">Not requested yet.</span>`;
      return;
    }
    if(result.status === "generating"){
      el.innerHTML = `<span class="spinner"></span> <span class="ai-summary-status">Assessing performance with AI…</span>`;
      return;
    }
    if(result.status === "error"){
      el.innerHTML = `
        <div class="ai-summary-error">AI forecast unavailable: ${escapeHtml(result.error || "unknown error")}</div>
        <button type="button" class="ai-summary-retry-btn" id="detailsForecastRetryBtn">Retry</button>
      `;
      const btn = $("detailsForecastRetryBtn");
      if(btn) btn.addEventListener("click", () => requestPageForecast(detailsModalPath));
      return;
    }
    el.innerHTML = `<div class="forecast-html">${result.html || `<p>${escapeHtml(result.text || "")}</p>`}</div>`;
  }

  async function pollPageForecast(pagePath){
    try{
      const result = await api(`/api/analysis/page-forecast?path=${encodeURIComponent(pagePath)}`);
      if(detailsModalPath !== pagePath) return;
      renderForecastColumn(result);
      if(result.status === "generating"){
        if(!forecastPollTimer) forecastPollTimer = setInterval(() => pollPageForecast(pagePath), 2000);
      }else if(forecastPollTimer){
        clearInterval(forecastPollTimer);
        forecastPollTimer = null;
      }
    }catch(e){ }
  }

  async function requestPageForecast(pagePath){
    renderForecastColumn({ status: "generating" });
    try{
      await api("/api/analysis/page-forecast", { method: "POST", body: JSON.stringify({ path: pagePath }) });
    }catch(e){ }
    pollPageForecast(pagePath);
  }

  function openDetailsModal(pagePath){
    const entry = state.lhResults[pagePath];
    if(!entry) return;
    detailsModalPath = pagePath;
    const page = state.pages.find(p => p.path === pagePath);
    $("detailsModalTitle").textContent = page ? page.title : pagePath;
    $("detailsModalPath").textContent = pagePath;
    renderVitalsColumn(entry);
    renderRecommendationsColumn(entry);
    $("detailsModalOverlay").classList.add("open");
    document.body.classList.add("modal-open");
    requestPageForecast(pagePath);
  }

  function closeDetailsModal(){
    detailsModalPath = null;
    $("detailsModalOverlay").classList.remove("open");
    document.body.classList.remove("modal-open");
    if(forecastPollTimer){ clearInterval(forecastPollTimer); forecastPollTimer = null; }
  }

  $("pagesBody").addEventListener("click", (e) => {
    const btn = e.target.closest(".details-icon-btn[data-details-path]");
    if(!btn) return;
    openDetailsModal(btn.getAttribute("data-details-path"));
  });
  $("detailsModalCloseBtn").addEventListener("click", closeDetailsModal);
  $("detailsModalOverlay").addEventListener("click", (e) => {
    if(e.target.id === "detailsModalOverlay") closeDetailsModal();
  });
  document.addEventListener("keydown", (e) => {
    if(e.key === "Escape" && $("detailsModalOverlay").classList.contains("open")) closeDetailsModal();
  });

  function perfCellHtml(path, idx){
    if(!state.lighthouseStarted) return '<span class="score-na">not scored</span>';
    if(idx >= state.lighthouseCap) return '<span class="score-na">not scored</span>';
    const r = state.lhResults[path];
    const mobile = scoreBadgeHtml(r && r.mobile, "Mobile");
    const desktop = scoreBadgeHtml(r && r.desktop, "Desktop");
    return `<div class="perf-pair">${mobile}${desktop}</div>`;
  }

  function detailsCellHtml(path){
    const r = state.lhResults[path];
    const hasData = r && (r.mobile || r.desktop);
    if(!hasData){
      return `<button type="button" class="details-icon-btn" disabled title="Run &quot;Scan for Page Score&quot; first"><i data-lucide="info"></i></button>`;
    }
    return `<button type="button" class="details-icon-btn" data-details-path="${escapeHtml(path)}" title="View Core Web Vitals and recommendations"><i data-lucide="info"></i></button>`;
  }

  function renderTable(){
    if(state.pages.length === 0){
      $("pagesBody").innerHTML = `<tr><td colspan="6"><div class="empty">No pages indexed yet — crawl a site to get started.</div></td></tr>`;
      refreshIcons();
      return;
    }
    $("pagesBody").innerHTML = state.pages.map((p, i) => `
      <tr>
        <td class="idx">${i+1}</td>
        <td class="ptitle">${escapeHtml(p.title)}</td>
        <td class="ppath"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.path)}</a></td>
        <td>${linkCellHtml(p.path)}${linkDetailHtml(p.path)}</td>
        <td>${perfCellHtml(p.path, i)}</td>
        <td class="col-details">${detailsCellHtml(p.path)}</td>
      </tr>
    `).join("");
    refreshIcons();
  }

  function updateDashboard(){
    $("statTotal").textContent = state.pages.length;
    if(state.linkScanStarted){
      let broken = 0, clean = 0;
      state.pages.forEach(p => {
        const r = state.linkResults[p.path];
        if(!r) return;
        if(r.blocked) return; // blocked pages are neither broken nor clean
        if(r.status === "red") broken++; else clean++;
      });
      $("statBroken").textContent = broken;
      $("statClean").textContent = clean;
    }
    if(state.lighthouseStarted){
      const entries = Object.values(state.lhResults);
      const mobileScores = entries.map(r => r.mobile && r.mobile.score).filter(s => typeof s === "number");
      const desktopScores = entries.map(r => r.desktop && r.desktop.score).filter(s => typeof s === "number");
      const avg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0) / arr.length) : "–";
      $("statAvgMobile").textContent = avg(mobileScores);
      $("statAvgDesktop").textContent = avg(desktopScores);
    }
    refreshIcons();
  }

  function setBar(id, pct, mode){
    const bar = $(id);
    setProgress(bar, pct);
    bar.className = "progress-fill" + (mode ? " " + mode : "");
  }

  function hasSiteInput(){
    if(state.mode === "list") return $("siteUrlList").value.trim().length > 0;
    if(state.mode === "history") return $("siteHistorySelect").value.length > 0;
    return $("siteUrl").value.trim().length > 0;
  }

  function updateButtonStates(){
    const hasPages = state.pages.length > 0;
    if(state.mode === "list"){
      // Crawl renders ONLY the listed URLs (real titles). The Scan buttons
      // also work directly — they render the list first if it hasn't been yet.
      const ready = hasSiteInput();
      $("btnCrawl").disabled = !ready;
      $("btnCrawl").title = "Renders only the URLs in the list — no sitemap, no link-following.";
      $("btnScanLinks").disabled = !ready;
      $("btnLighthouse").disabled = !ready;
    }else if(state.mode === "history"){
      $("btnCrawl").disabled = true;
      $("btnCrawl").title = "Not needed in this mode — press a Scan button directly.";
      $("btnScanLinks").disabled = !hasPages;
      $("btnLighthouse").disabled = !hasPages;
    }else{
      const hasUrl = $("siteUrl").value.trim().length > 0;
      $("btnCrawl").disabled = !hasUrl;
      $("btnCrawl").title = "";
      $("btnScanLinks").disabled = !hasPages;
      $("btnLighthouse").disabled = !hasPages;
    }
    // Keep a running scan's own button disabled — the OTHER scan finishing
    // calls this, and must not re-enable a button whose scan is still going.
    if(running.links) $("btnScanLinks").disabled = true;
    if(running.lighthouse) $("btnLighthouse").disabled = true;
    if(running.crawl) $("btnCrawl").disabled = true;
    $("dlCsv").classList.toggle("disabled", !hasPages);
    $("dlPdf").classList.toggle("disabled", !hasPages);
  }

  async function pollCrawlProgress(){
    try{
      const p = await api("/api/progress/site");
      if(Array.isArray(p.pages) && p.pages.length !== state.pages.length){
        state.pages = p.pages;
        renderTable();
        updateDashboard();
        updateButtonStates();
      }
      if(p.total > 0){
        const pct = p.status === "done" ? 100 : Math.min(99, Math.round((p.found / p.total) * 100));
        setBar("crawlBar", pct, p.status === "error" ? "err" : (p.status === "done" ? "done" : ""));
        if(p.status === "running") $("crawlStatus").textContent = `Crawling — ${p.found} of ~${p.total} page(s) rendered…`;
      } else if(p.status === "running"){
        $("crawlStatus").textContent = "Analyzing sitemap and page routes…";
      }
    }catch(e){ }
  }

  async function crawlSite(){
    // Re-entrant: scanLinks/runLighthouseScan call this (list mode) before scanning.
    const owner = !running.crawl;
    running.crawl = true;
    try{ await runCrawlSite(); }
    finally{ if(owner) running.crawl = false; }
  }

  async function runCrawlSite(){
    const mode = state.mode;
    let body;
    if(mode === "list"){
      const urls = parseUrlListText($("siteUrlList").value);
      if(urls.length === 0){
        $("crawlStatus").textContent = "Enter at least one URL in the list.";
        $("crawlStatus").className = "status-line err";
        return;
      }
      const maxPages = parseInt($("maxPages").value, 10) || 200;
      body = { mode: "list", urls, maxPages };
    }else if(mode === "history"){
      const sel = $("siteHistorySelect").value;
      if(!sel){
        $("crawlStatus").textContent = "Select a saved crawl from the list.";
        $("crawlStatus").className = "status-line err";
        return;
      }
      const [historyType, historyId, historySide] = sel.split(":");
      const maxPages = parseInt($("maxPages").value, 10) || 200;
      body = { mode: "history", historyType, historyId, historySide: historySide || null, maxPages };
    }else{
      const url = $("siteUrl").value.trim();
      if(!url){
        $("crawlStatus").textContent = "Enter a URL first.";
        $("crawlStatus").className = "status-line err";
        return;
      }
      const maxPages = parseInt($("maxPages").value, 10) || 200;
      body = { url, maxPages };
    }

    $("btnCrawl").disabled = true;
    state.pages = [];
    state.linkResults = {};
    state.lhResults = {};
    state.linkScanStarted = false;
    state.lighthouseStarted = false;
    closeDetailsModal();
    renderTable();
    updateDashboard();
    updateButtonStates();
    $("statBroken").textContent = "–";
    $("statClean").textContent = "–";
    $("statAvgMobile").textContent = "–";
    $("statAvgDesktop").textContent = "–";
    setBar("crawlBar", 0, "");
    $("crawlStatus").textContent = "Starting…";
    $("crawlStatus").className = "status-line";
    setHidden($("linkScanStatus"), true);
    setHidden($("linkScanTrack"), true);
    setHidden($("lighthouseStatus"), true);
    setHidden($("lighthouseTrack"), true);

    const pollTimer = setInterval(pollCrawlProgress, 700);
    try{
      const result = await api("/api/crawl/site", { method:"POST", body: JSON.stringify(body) });
      state.pages = result.pages;
      if(mode === "list") state.listRegistered = true;
      renderTable();
      updateDashboard();
      updateButtonStates();
      setBar("crawlBar", 100, "done");
      const invalidNote = result.invalidCount ? ` (${result.invalidCount} invalid URL(s) skipped)` : "";
      const verb = mode === "list" ? "rendered from the list" : "rendered and indexed";
      $("crawlStatus").textContent = `Done — ${result.count} page(s) ${verb}.${invalidNote}`;
      $("crawlStatus").className = "status-line ok";
    }catch(e){
      if(e.partialPages && e.partialPages.length){
        state.pages = e.partialPages;
        renderTable();
        updateDashboard();
        updateButtonStates();
      }
      setBar("crawlBar", 100, "err");
      const count = state.pages.length;
      $("crawlStatus").textContent = `Failed: ${e.message}${count ? ` — kept ${count} page(s) found before this happened.` : ""}`;
      $("crawlStatus").className = "status-line err";
    }finally{
      clearInterval(pollTimer);
      updateButtonStates();
      pollAiSummary();
      refreshIcons();
    }
  }

  async function pollLinkScan(){
    try{
      const p = await api("/api/analysis/linkscan/progress");
      if(p.results){
        state.linkResults = p.results;
        renderTable();
        updateDashboard();
      }
      if(p.total > 0){
        const el = $("linkScanStatus");
        setHidden(el, false);
        setHidden($("linkScanTrack"), false);
        if(p.status === "running"){
          el.textContent = `Scanning links — ${p.done} of ${p.total} page(s)…`;
          setBar("linkScanBar", Math.min(99, Math.round((p.done / p.total) * 100)), "");
        }
      }
    }catch(e){ }
  }

  async function scanLinks(){
    if(running.links || running.crawl) return;
    running.links = true;
    try{ await runScanLinks(); }
    finally{ running.links = false; updateButtonStates(); }
  }

  async function runScanLinks(){
    if(state.mode === "list" && !state.listRegistered){
      $("btnScanLinks").disabled = true;
      $("btnLighthouse").disabled = true;
      await crawlSite();
      if(state.pages.length === 0){
        updateButtonStates();
        return;
      }
    }

    state.linkScanStarted = true;
    state.linkResults = {};
    renderTable();
    $("btnScanLinks").disabled = true;
    const el = $("linkScanStatus");
    setHidden(el, false);
    el.className = "status-line";
    el.textContent = "Starting link health audit…";
    setHidden($("linkScanTrack"), false);
    setBar("linkScanBar", 0, "");

    const pollTimer = setInterval(pollLinkScan, 600);
    try{
      const result = await api("/api/analysis/linkscan", { method:"POST", body: JSON.stringify({}) });
      state.linkResults = result.results;
      renderTable();
      updateDashboard();
      setBar("linkScanBar", 100, "done");
      el.textContent = `Completed — ${state.pages.length} page(s) audited for link health.`;
      el.className = "status-line ok";
    }catch(e){
      if(e.partialResults){
        state.linkResults = e.partialResults;
        renderTable();
        updateDashboard();
      }
      setBar("linkScanBar", 100, "err");
      el.textContent = `Failed: ${e.message}`;
      el.className = "status-line err";
    }finally{
      clearInterval(pollTimer);
      $("btnScanLinks").disabled = false;
      pollAiSummary();
      refreshIcons();
    }
  }

  async function pollLighthouse(){
    try{
      const p = await api("/api/analysis/lighthouse/progress");
      if(p.results){
        state.lhResults = p.results;
        renderTable();
        updateDashboard();
      }
      if(p.total > 0){
        const el = $("lighthouseStatus");
        setHidden(el, false);
        setHidden($("lighthouseTrack"), false);
        if(p.status === "running"){
          el.textContent = `Running Lighthouse — audit ${p.done} of ${p.total} (2 per page: mobile + desktop)…`;
          setBar("lighthouseBar", Math.min(99, Math.round((p.done / p.total) * 100)), "");
        }
      }
    }catch(e){ }
  }

  async function runLighthouseScan(){
    if(running.lighthouse || running.crawl) return;
    running.lighthouse = true;
    try{ await runLighthouseScanInner(); }
    finally{ running.lighthouse = false; updateButtonStates(); }
  }

  async function runLighthouseScanInner(){
    if(state.mode === "list" && !state.listRegistered){
      $("btnScanLinks").disabled = true;
      $("btnLighthouse").disabled = true;
      await crawlSite();
      if(state.pages.length === 0){
        updateButtonStates();
        return;
      }
    }

    const cap = state.pages.length;
    state.lighthouseStarted = true;
    state.lighthouseCap = cap;
    state.lhResults = {};
    closeDetailsModal();
    renderTable();
    $("btnLighthouse").disabled = true;
    const el = $("lighthouseStatus");
    setHidden(el, false);
    el.className = "status-line";
    el.textContent = "Starting Lighthouse performance audits…";
    setHidden($("lighthouseTrack"), false);
    setBar("lighthouseBar", 0, "");

    const pollTimer = setInterval(pollLighthouse, 800);
    try{
      const result = await api("/api/analysis/lighthouse", { method:"POST", body: JSON.stringify({ maxPages: cap }) });
      state.lhResults = result.results;
      renderTable();
      updateDashboard();
      setBar("lighthouseBar", 100, "done");
      el.textContent = `Completed — ${result.scannedCount} of ${result.totalPages} page(s) scored.`;
      el.className = "status-line ok";
    }catch(e){
      if(e.partialResults){
        state.lhResults = e.partialResults;
        renderTable();
        updateDashboard();
      }
      setBar("lighthouseBar", 100, "err");
      el.textContent = `Failed: ${e.message}`;
      el.className = "status-line err";
    }finally{
      clearInterval(pollTimer);
      $("btnLighthouse").disabled = false;
      pollAiSummary();
      refreshIcons();
    }
  }

  $("btnCrawl").addEventListener("click", crawlSite);
  $("btnScanLinks").addEventListener("click", scanLinks);
  $("btnLighthouse").addEventListener("click", runLighthouseScan);
  $("maxPages").addEventListener("input", function(){
    const cleaned = this.value.replace(/[^0-9]/g, "");
    this.value = cleaned;
    this.classList.toggle("invalid", cleaned.length === 0);
  });
  $("siteUrl").addEventListener("input", () => updateButtonStates());
  $("siteUrl").addEventListener("keydown", e => { if(e.key === "Enter" && !$("btnCrawl").disabled) $("btnCrawl").click(); });
  $("siteUrlList").addEventListener("input", () => { updateButtonStates(); previewListMode(); });
  setupModeToggle();
  setupFileUpload();
  setupHistorySelect();
  updateButtonStates();
  pollAiSummary();
  refreshIcons();

})();
