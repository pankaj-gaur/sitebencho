/* parity.js — behaviour for index.html (Site Parity).
 * Shared helpers come from main.js and the combination files via window.Miti. */
(function(){
  "use strict";
  const { $, escapeHtml, refreshIcons, setHidden, isHidden, parseUrlListText, pathFromUrl, confirmDialog, setProgress, getProgress } = window.Miti;

  // Colours the centre divider node by result tone (red / amber / green);
  // null clears it back to the default colour.
  function setDividerTone(tone){
    const node = $("dividerNode");
    node.classList.remove("tone-red", "tone-amber", "tone-green");
    if(tone) node.classList.add(`tone-${tone}`);
  }

  const state = {
    bench: { pages: [], mode: "crawl", invalidCount: 0, listRegistered: false },
    cand:  { pages: [], mode: "crawl", invalidCount: 0, listRegistered: false },
    results: []
  };

  // The URLs are already known in list mode — no need to wait for an actual
  // render just to LIST them. This gives an instant table preview as soon as
  // the textarea has content; the real crawlOne() call (at Start testing
  // time) overwrites these placeholders with the actually-rendered titles.
  // NOTE: this preview is client-only and does NOT mean the list has been
  // registered/rendered server-side — see state[slot].listRegistered below,
  // which is what actually gates whether a fresh render happens before
  // testing runs.
  function previewListMode(slot){
    if(state[slot].mode !== "list") return;
    state[slot].listRegistered = false;
    const urls = parseUrlListText($(`${slot}UrlList`).value);
    state[slot].pages = urls.map(u => ({ title: "(not yet rendered)", url: u, path: pathFromUrl(u) }));
    state[slot].invalidCount = 0;
    renderPanel(slot);
    updateDashboard();
    updateListMismatchWarning();
  }

  function setMode(mode){
    ["bench", "cand"].forEach(slot => {
      state[slot].mode = mode;
      state[slot].listRegistered = false;
      const toggle = $(`${slot}ModeToggle`);
      toggle.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.getAttribute("data-mode") === mode));
      setHidden($(`${slot}CrawlInput`), !(mode === "crawl"));
      setHidden($(`${slot}ListInput`), !(mode === "list"));
      setHidden($(`${slot}HistoryInput`), !(mode === "history"));
      if(mode === "list"){
        previewListMode(slot);
      }else if(mode === "history"){
        loadHistoryOptions(slot);
        state[slot].pages = [];
        renderPanel(slot);
      }else{
        state[slot].pages = [];
        renderPanel(slot);
      }
    });
    updateDashboard();
    updateListMismatchWarning();
    $("btnCrawl").title = mode === "list"
      ? "Renders only the URLs in each list — no sitemap, no link-following."
      : (mode === "history" ? "Not needed in this mode — press Start testing directly." : "");
    updateCrawlButtonState();
    refreshIcons();
  }

  // ---- Mode-switch reset ---------------------------------------------------

  // Small promise-based dialog. showCancel:false turns it into a plain
  // notice (single OK button) — used when a switch is blocked.

  // True if there's anything on screen a reset would throw away.
  function hasSessionState(){
    return state.bench.pages.length > 0
      || state.cand.pages.length > 0
      || state.results.length > 0
      || !isHidden($("aiSummaryWrap"))
      || getProgress($("benchBar")) > 0
      || getProgress($("candBar")) > 0
      || getProgress($("testBar")) > 0;
  }

  // Puts every piece of on-screen session state back to how it looks on a
  // fresh page load — crawled/listed pages, the comparison ledger, KPI
  // numbers, ALL progress bars and status lines, the AI summary panel, the
  // list-length warning, and any open details popup. Typed URLs / pasted
  // lists are deliberately kept so the person doesn't have to re-enter them.
  function resetClientState(){
    if(aiPollTimer){ clearInterval(aiPollTimer); aiPollTimer = null; }
    setHidden($("aiSummaryWrap"), true);
    $("aiSummaryBody").innerHTML = "";

    closeTestDetailsModal();

    ["bench", "cand"].forEach(slot => {
      state[slot].pages = [];
      state[slot].invalidCount = 0;
      state[slot].listRegistered = false;
      setBar(slot, 0, "");
      const statusEl = $(`${slot}Status`);
      statusEl.textContent = "Enter both URLs, then press Crawl sites.";
      statusEl.className = "status-line";
      renderPanel(slot);
    });

    state.results = [];
    setTestBar(0, "");
    const tp = $("testProgress");
    setHidden(tp, true);
    tp.textContent = "";
    tp.className = "status-line";
    $("ledgerBody").innerHTML = `<tr><td colspan="6"><div class="empty">Crawl both sites, then press Start testing (enabled once both finish).</div></td></tr>`;

    $("statGreen").textContent = "–";
    $("statRed").textContent = "–";
    $("statAmber").textContent = "–";
    $("dividerNode").textContent = "·";
    setDividerTone(null);
    setHidden($("listMismatchWarning"), true);

    updateDashboard();
  }

  const MODE_LABELS = { crawl: "Crawl a site", list: "Use a URL list", history: "Load from history" };

  async function requestModeChange(mode){
    if(mode === state.bench.mode) return;

    if(busy){
      await confirmDialog({
        title: "Test in progress",
        message: "A crawl or comparison test is still running. Wait for it to finish before switching modes.",
        okLabel: "OK",
        showCancel: false,
      });
      return;
    }

    if(hasSessionState()){
      const ok = await confirmDialog({
        title: "Reset test bench?",
        message: `Switching to "${MODE_LABELS[mode]}" will reset the test bench — crawled pages, test results, progress and the AI summary will be cleared. Your entered URLs are kept.`,
      });
      if(!ok) return; // Cancel — preserve everything exactly as it is
    }

    try{
      await api("/api/reset/diff", { method: "POST", body: JSON.stringify({}) });
    }catch(e){
      await confirmDialog({ title: "Couldn't reset", message: e.message, okLabel: "OK", showCancel: false });
      return; // server refused (e.g. a test still running) — keep current state
    }

    resetClientState();
    setMode(mode);
  }

  function setupModeToggle(slot){
    const toggle = $(`${slot}ModeToggle`);
    toggle.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", () => requestModeChange(btn.getAttribute("data-mode")));
    });
  }

  async function loadHistoryOptions(slot){
    const select = $(`${slot}HistorySelect`);
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

  function setupHistorySelect(slot){
    const select = $(`${slot}HistorySelect`);
    select.addEventListener("change", async () => {
      updateCrawlButtonState();
      if(!select.value) return;
      busy = true;
      try{
        await crawlOne(slot, `${slot}Url`, `${slot}Status`);
      }finally{
        busy = false;
      }
      updateDashboard();
      if(state.bench.pages.length || state.cand.pages.length) alignPanels();
      updateCrawlButtonState();
      pollAiSummary();
    });
  }

  function setupFileUpload(slot){
    const fileInput = $(`${slot}UrlFile`);
    const textarea = $(`${slot}UrlList`);
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const parsed = parseUrlListText(String(reader.result || ""));
        const existing = textarea.value.trim();
        textarea.value = existing ? existing + "\n" + parsed.join("\n") : parsed.join("\n");
        fileInput.value = "";
        updateCrawlButtonState();
        previewListMode(slot);
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
      err.partialResults = body.partialResults;
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
      statusHtml = `<div class="ai-summary-entry"><span class="spinner"></span> <span class="ai-summary-status">Synthesizing executive AI summary…</span></div>`;
    }else if(result.status === "error"){
      statusHtml = `<div class="ai-summary-entry">
        <div class="ai-summary-error">AI summary unavailable: ${escapeHtml(result.error || "unknown error")}</div>
        ${result.canRetry ? `<button type="button" class="ai-summary-retry-btn" id="aiSummaryRetryBtn">Retry</button>` : ""}
      </div>`;
    }

    body.innerHTML = entriesHtml + statusHtml || `<div class="ai-summary-entry"><span class="ai-summary-status">No summary generated yet.</span></div>`;

    const retryBtn = $("aiSummaryRetryBtn");
    if(retryBtn) retryBtn.addEventListener("click", retryAiSummary);
    refreshIcons();
  }

  async function retryAiSummary(){
    const btn = $("aiSummaryRetryBtn");
    if(btn){ btn.disabled = true; btn.textContent = "Retrying…"; }
    try{
      await api("/api/ai-summary/diff/retry", { method: "POST", body: JSON.stringify({}) });
    }catch(e){ }
    pollAiSummary();
  }

  async function pollAiSummary(){
    try{
      const result = await api("/api/ai-summary/diff");
      renderAiSummary(result);
      if(result.status === "generating"){
        if(!aiPollTimer) aiPollTimer = setInterval(pollAiSummary, 2500);
      }else if(aiPollTimer){
        clearInterval(aiPollTimer);
        aiPollTimer = null;
      }
    }catch(e){ }
  }

  function pageRowHtml(idx, p){
    return `
      <tr>
        <td class="idx">${idx}</td>
        <td class="ptitle">${escapeHtml(p.title)}</td>
        <td class="ppath"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" class="path-link">${escapeHtml(p.path)}</a></td>
      </tr>`;
  }

  function renderPanel(slot){
    const body = slot === "bench" ? $("benchBody") : $("candBody");
    const pages = state[slot].pages;
    body.innerHTML = pages.map((p,i)=>pageRowHtml(i+1,p)).join("") || `<tr><td colspan="3"><div class="empty">No pages indexed yet.</div></td></tr>`;
    refreshIcons();
  }

  function pathMatchCell(p, matched, idx){
    if(!p){
      return `<tr class="row-missing"><td class="idx">${idx}</td><td colspan="2" class="missing-note">— not present on this target —</td></tr>`;
    }
    return `<tr class="${matched ? "row-matched" : "row-unmatched"}">
      <td class="idx">${idx}</td>
      <td class="ptitle">${escapeHtml(p.title)}</td>
      <td class="ppath"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" class="path-link">${escapeHtml(p.path)}</a></td>
    </tr>`;
  }

  function alignPanelsByPosition(){
    const benchPages = state.bench.pages;
    const candPages = state.cand.pages;
    const maxLen = Math.max(benchPages.length, candPages.length);
    const pairedLen = Math.min(benchPages.length, candPages.length);

    const benchRows = [];
    const candRows = [];
    for(let i = 0; i < maxLen; i++){
      const paired = i < pairedLen;
      benchRows.push(pathMatchCell(benchPages[i], paired, i+1));
      candRows.push(pathMatchCell(candPages[i], paired, i+1));
    }

    $("benchBody").innerHTML = benchRows.join("") || `<tr><td colspan="3"><div class="empty">No pages indexed yet.</div></td></tr>`;
    $("candBody").innerHTML = candRows.join("") || `<tr><td colspan="3"><div class="empty">No pages indexed yet.</div></td></tr>`;
    refreshIcons();
  }

  function alignPanels(){
    if(state.bench.mode === "list"){
      alignPanelsByPosition();
      return;
    }
    const benchByPath = new Map(state.bench.pages.map(p=>[p.path,p]));
    const candByPath = new Map(state.cand.pages.map(p=>[p.path,p]));
    const allPaths = Array.from(new Set([...benchByPath.keys(), ...candByPath.keys()])).sort();

    $("benchBody").innerHTML = allPaths.map((path,i)=>pathMatchCell(benchByPath.get(path), candByPath.has(path), i+1)).join("")
      || `<tr><td colspan="3"><div class="empty">No pages indexed yet.</div></td></tr>`;
    $("candBody").innerHTML = allPaths.map((path,i)=>pathMatchCell(candByPath.get(path), benchByPath.has(path), i+1)).join("")
      || `<tr><td colspan="3"><div class="empty">No pages indexed yet.</div></td></tr>`;
    refreshIcons();
  }

  function updateDashboard(){
    $("statBench").textContent = state.bench.pages.length;
    $("statCand").textContent = state.cand.pages.length;
    let matched;
    if(state.bench.mode === "list"){
      matched = Math.min(state.bench.pages.length, state.cand.pages.length);
    }else{
      const candPaths = new Set(state.cand.pages.map(p=>p.path));
      matched = state.bench.pages.filter(p=>candPaths.has(p.path)).length;
    }
    $("statMatched").textContent = matched;

    const hasCrawled = state.bench.pages.length > 0 && state.cand.pages.length > 0;
    $("dlCsv").classList.toggle("disabled", !hasCrawled);
    $("dlPdf").classList.toggle("disabled", !hasCrawled);
  }

  function hasInput(slot){
    const mode = state[slot].mode;
    if(mode === "list") return $(`${slot}UrlList`).value.trim().length > 0;
    if(mode === "history") return $(`${slot}HistorySelect`).value.length > 0;
    return $(`${slot}Url`).value.trim().length > 0;
  }

  function updateCrawlButtonState(){
    const mode = state.bench.mode;
    const bothReady = hasInput("bench") && hasInput("cand");
    if(mode === "list"){
      // Crawl renders ONLY the listed URLs (real titles). Start testing also
      // works directly — it renders the lists first if they haven't been yet.
      $("btnCrawl").disabled = !bothReady || crawling;
      $("btnTest").disabled = !bothReady || crawling;
    }else if(mode === "history"){
      $("btnCrawl").disabled = true;
      $("btnTest").disabled = !(state.bench.pages.length > 0 && state.cand.pages.length > 0) || crawling;
    }else{
      $("btnCrawl").disabled = !bothReady || crawling;
      $("btnTest").disabled = !(state.bench.pages.length > 0 && state.cand.pages.length > 0) || crawling;
    }
  }

  function setBar(slot, pct, mode){
    const bar = $(slot === "bench" ? "benchBar" : "candBar");
    setProgress(bar, pct);
    bar.className = "progress-fill" + (mode ? " " + mode : "");
  }

  async function pollProgress(slot, statusEl){
    try{
      const p = await api(`/api/progress/${slot}`);
      if(Array.isArray(p.pages) && p.pages.length !== state[slot].pages.length){
        state[slot].pages = p.pages;
        renderPanel(slot);
        updateDashboard();
      }
      if(p.total > 0){
        const pct = p.status === "done" ? 100 : Math.min(99, Math.round((p.found / p.total) * 100));
        setBar(slot, pct, p.status === "error" ? "err" : (p.status === "done" ? "done" : ""));
        if(p.status === "running") statusEl.textContent = `Crawling — ${p.found} of ~${p.total} page(s) rendered…`;
      } else if(p.status === "running"){
        statusEl.textContent = "Parsing sitemap & discovering links…";
      }
      return p;
    }catch(e){
      return null;
    }
  }

  async function crawlOne(slot, urlInputId, statusId){
    const mode = state[slot].mode;
    const statusEl = $(statusId);
    setBar(slot, 0, "");
    state[slot].pages = [];
    renderPanel(slot);
    statusEl.textContent = "Starting…";
    statusEl.className = "status-line";

    const maxPages = parseInt($("maxPages").value, 10) || 200;
    let body;
    if(mode === "list"){
      const urls = parseUrlListText($(`${slot}UrlList`).value);
      if(urls.length === 0){
        statusEl.textContent = "Enter at least one URL in the list.";
        statusEl.className = "status-line err";
        return false;
      }
      body = { mode: "list", urls, maxPages };
    }else if(mode === "history"){
      const sel = $(`${slot}HistorySelect`).value;
      if(!sel){
        statusEl.textContent = "Select a saved crawl from the list.";
        statusEl.className = "status-line err";
        return false;
      }
      const [historyType, historyId, historySide] = sel.split(":");
      body = { mode: "history", historyType, historyId, historySide: historySide || null, maxPages };
    }else{
      const url = $(urlInputId).value.trim();
      if(!url){
        statusEl.textContent = "Enter a URL first.";
        statusEl.className = "status-line err";
        return false;
      }
      body = { url, maxPages };
    }

    const crawlPromise = api(`/api/crawl/${slot}`, { method:"POST", body: JSON.stringify(body) });

    const pollTimer = setInterval(() => pollProgress(slot, statusEl), 700);
    try{
      const result = await crawlPromise;
      state[slot].pages = result.pages;
      state[slot].invalidCount = result.invalidCount || 0;
      if(mode === "list") state[slot].listRegistered = true;
      renderPanel(slot);
      updateDashboard();
      setBar(slot, 100, "done");
      const invalidNote = result.invalidCount ? ` (${result.invalidCount} invalid URL(s) skipped)` : "";
      const verb = mode === "list" ? "rendered from the list" : "rendered and indexed";
      statusEl.textContent = `Done — ${result.count} page(s) ${verb}.${invalidNote}`;
      statusEl.className = "status-line ok";
      return true;
    }catch(e){
      if(e.partialPages && e.partialPages.length){
        state[slot].pages = e.partialPages;
        renderPanel(slot);
        updateDashboard();
      }
      setBar(slot, 100, "err");
      const count = state[slot].pages.length;
      statusEl.textContent = `Failed: ${e.message}${count ? ` — kept ${count} page(s) found before this happened.` : ""}`;
      statusEl.className = "status-line err";
      return false;
    }finally{
      clearInterval(pollTimer);
    }
  }

  let crawling = false;
  // True while ANY crawl / list render / history load / test is running —
  // mode switching is blocked during that time (see requestModeChange).
  let busy = false;

  function updateListMismatchWarning(){
    const el = $("listMismatchWarning");
    if(state.bench.mode !== "list"){
      setHidden(el, true);
      return;
    }
    const benchLen = state.bench.pages.length;
    const candLen = state.cand.pages.length;
    if(benchLen === 0 && candLen === 0){
      setHidden(el, true);
      return;
    }
    if(benchLen === candLen){
      setHidden(el, true);
      return;
    }
    const diff = Math.abs(benchLen - candLen);
    const longer = benchLen > candLen ? "benchmark" : "candidate";
    const invalidParts = [];
    if(state.bench.invalidCount) invalidParts.push(`${state.bench.invalidCount} invalid benchmark line(s) skipped`);
    if(state.cand.invalidCount) invalidParts.push(`${state.cand.invalidCount} invalid candidate line(s) skipped`);
    const invalidNote = invalidParts.length ? ` This may be because ${invalidParts.join(" and ")}.` : "";
    el.innerHTML = `<b>List lengths don't match</b> — benchmark has ${benchLen} URL(s), candidate has ${candLen}. Pages are paired by position, so the last ${diff} URL(s) on the ${longer} side won't be paired with anything and will be skipped.${invalidNote}`;
    setHidden(el, false);
  }

  async function crawlSites(){
    if(crawling) return;
    crawling = true;
    busy = true;
    $("btnCrawl").disabled = true;
    $("btnTest").disabled = true;

    state.results = [];
    renderLedger();
    closeTestDetailsModal();
    $("statGreen").textContent = "–";
    $("statRed").textContent = "–";
    $("statAmber").textContent = "–";
    $("dividerNode").textContent = "·";
    setDividerTone(null);
    setHidden($("testProgress"), true);
    setHidden($("testProgressWrap"), true);
    setTestBar(0, "");
    state.bench.pages = [];
    state.cand.pages = [];
    renderPanel("bench");
    renderPanel("cand");
    updateDashboard();
    updateListMismatchWarning();

    await crawlOne("bench", "benchUrl", "benchStatus");
    await crawlOne("cand", "candUrl", "candStatus");

    if(state.bench.pages.length || state.cand.pages.length){
      alignPanels();
    }
    updateListMismatchWarning();

    crawling = false;
    busy = false;
    updateCrawlButtonState();
    pollAiSummary();
  }

  function renderLedger(){
    const pillFor = r => r.blocked ? "Blocked" : (r.status === "green" ? "Equal" : (r.status === "red" ? "Changed" : "Links Differ"));
    const arrowCellText = (a, b) => a === b
      ? escapeHtml(a)
      : `${escapeHtml(a)} <span class="text-muted">&rarr;</span> ${escapeHtml(b)}`;

    $("ledgerBody").innerHTML = state.results.map((r,i)=>`
      <tr class="row-${r.blocked ? "blocked" : r.status}">
        <td class="idx">${i+1}</td>
        <td class="ptitle">${arrowCellText(r.benchTitle || "(untitled)", r.candTitle || "(untitled)")}</td>
        <td class="path-cell">
          ${arrowCellText(r.benchPath, r.candPath)}
          <br>
          <a href="${escapeHtml(r.benchUrl)}" target="_blank" rel="noopener">benchmark ↗</a>
          <a href="${escapeHtml(r.candUrl)}" target="_blank" rel="noopener">candidate ↗</a>
        </td>
        <td><span class="pill">${pillFor(r)}</span></td>
        <td>
          <div class="detail">${escapeHtml(r.detail)}</div>
          ${r.broken && r.broken.length ? `<div class="brokenlist">${r.broken.map(escapeHtml).join("<br>")}</div>` : ""}
          ${r.diffSnippet ? `<div class="diffsnippet">
            <div><span class="diff-tag bench">bench</span>${escapeHtml(r.diffSnippet.benchSnippet)}</div>
            <div><span class="diff-tag cand">cand</span>${escapeHtml(r.diffSnippet.candSnippet)}</div>
          </div>` : ""}
          ${r.assetDiff ? `<div class="assetdiff">
            <div class="assetdiff-label">Static assets (CSS/JS) differ:</div>
            ${(r.assetDiff.onlyInBench||[]).map(a => `<div>&minus; ${escapeHtml(a)}</div>`).join("")}
            ${(r.assetDiff.onlyInCand||[]).map(a => `<div>+ ${escapeHtml(a)}</div>`).join("")}
          </div>` : ""}
        </td>
        <td class="col-details"><button type="button" class="details-icon-btn" data-details-index="${i}" title="View source diff and layout comparison"><i data-lucide="info"></i></button></td>
      </tr>
    `).join("") || `<tr><td colspan="6"><div class="empty">No matching paths between the two sites — nothing to compare yet.</div></td></tr>`;

    // Blocked pages are counted separately — a WAF refusing the tester says
    // nothing about whether the content changed.
    const counts = { green:0, red:0, amber:0, blocked:0 };
    state.results.forEach(r => { if(r.blocked) counts.blocked++; else counts[r.status]++; });
    $("statGreen").textContent = counts.green;
    $("statRed").textContent = counts.red;
    $("statAmber").textContent = counts.amber;
    $("dividerNode").textContent = counts.red > 0 ? "≠" : (counts.amber > 0 ? "≠" : "=");
    setDividerTone(counts.red > 0 ? "red" : (counts.amber > 0 ? "amber" : "green"));

    refreshIcons();
  }

  function setTestBar(pct, mode){
    const bar = $("testBar");
    setProgress(bar, pct);
    bar.className = "progress-fill" + (mode ? " " + mode : "");
  }

  async function pollTestProgress(){
    try{
      const p = await api("/api/test/progress");
      if(Array.isArray(p.results) && p.results.length !== state.results.length){
        state.results = p.results;
        renderLedger();
      }
      if(p.total > 0){
        const pct = p.status === "done" ? 100 : Math.min(99, Math.round((p.done / p.total) * 100));
        setTestBar(pct, p.status === "error" ? "err" : (p.status === "done" ? "done" : ""));
        if(p.status === "running") $("testProgress").textContent = `Testing — ${p.done} of ${p.total} matched page(s)…`;
      }
      return p;
    }catch(e){
      return null;
    }
  }

  let testDetailsIndex = null;
  let testDetailsPollTimer = null;

  function diffLineHtml(row){
    if(row.type === "same"){
      return {
        left: `<div class="diff-line diff-same">${escapeHtml(row.left)}</div>`,
        right: `<div class="diff-line diff-same">${escapeHtml(row.right)}</div>`,
      };
    }
    if(row.type === "removed"){
      return {
        left: `<div class="diff-line diff-removed">${escapeHtml(row.left)}</div>`,
        right: `<div class="diff-line diff-blank">&nbsp;</div>`,
      };
    }
    return {
      left: `<div class="diff-line diff-blank">&nbsp;</div>`,
      right: `<div class="diff-line diff-added">${escapeHtml(row.right)}</div>`,
    };
  }

  function renderTestDetailsBodies(result){
    const sourceEl = $("testDetailsSourceBody");
    const layoutEl = $("testDetailsLayoutBody");

    if(!result || result.status === "idle"){
      sourceEl.innerHTML = `<div class="diff-empty-msg">Not requested yet.</div>`;
      layoutEl.innerHTML = `<div class="diff-empty-msg">Not requested yet.</div>`;
      return;
    }
    if(result.status === "generating"){
      const loading = `<div class="diff-empty-msg"><span class="spinner"></span> Loading page source comparison and visual screenshots…</div>`;
      sourceEl.innerHTML = loading;
      layoutEl.innerHTML = loading;
      return;
    }
    if(result.status === "error"){
      const errHtml = `<div class="diff-empty-msg">
        <div class="ai-summary-error">Could not load page details: ${escapeHtml(result.error || "unknown error")}</div>
        <button type="button" class="ai-summary-retry-btn test-details-retry-btn">Retry</button>
      </div>`;
      sourceEl.innerHTML = errHtml;
      layoutEl.innerHTML = errHtml;
      document.querySelectorAll(".test-details-retry-btn").forEach(b => {
        b.addEventListener("click", () => requestTestPageDetails(testDetailsIndex));
      });
      return;
    }

    if(result.identical){
      sourceEl.innerHTML = `<div class="diff-empty-msg">Pages are identical — no differences detected in visible rendered source.</div>`;
    }else{
      const truncatedNote = result.truncated
        ? `<div class="diff-truncated-note">Page content exceeded buffer threshold — displaying the first portion of differences.</div>`
        : "";
      const leftLines = [];
      const rightLines = [];
      (result.diffRows || []).forEach(row => {
        const h = diffLineHtml(row);
        leftLines.push(h.left);
        rightLines.push(h.right);
      });
      sourceEl.innerHTML = `${truncatedNote}<div class="diff-columns">
        <div class="diff-pane"><div class="diff-pane-head">Benchmark Page</div>${leftLines.join("")}</div>
        <div class="diff-pane"><div class="diff-pane-head">Candidate Page</div>${rightLines.join("")}</div>
      </div>`;
    }

    const benchImg = result.benchScreenshot
      ? `<img src="${result.benchScreenshot}" alt="Benchmark page screenshot">`
      : `<div class="screenshot-error">${escapeHtml(result.benchError || "Screenshot unavailable")}</div>`;
    const candImg = result.candScreenshot
      ? `<img src="${result.candScreenshot}" alt="Candidate page screenshot">`
      : `<div class="screenshot-error">${escapeHtml(result.candError || "Screenshot unavailable")}</div>`;
    layoutEl.innerHTML = `<div class="screenshot-columns">
      <div class="screenshot-pane"><div class="screenshot-pane-head">Benchmark Layout</div>${benchImg}</div>
      <div class="screenshot-pane"><div class="screenshot-pane-head">Candidate Layout</div>${candImg}</div>
    </div>`;

    refreshIcons();
  }

  async function pollTestPageDetails(index){
    try{
      const result = await api(`/api/test/page-details?index=${encodeURIComponent(index)}`);
      if(testDetailsIndex !== index) return;
      renderTestDetailsBodies(result);
      if(result.status === "generating"){
        if(!testDetailsPollTimer) testDetailsPollTimer = setInterval(() => pollTestPageDetails(index), 1500);
      }else if(testDetailsPollTimer){
        clearInterval(testDetailsPollTimer);
        testDetailsPollTimer = null;
      }
    }catch(e){ }
  }

  async function requestTestPageDetails(index){
    renderTestDetailsBodies({ status: "generating" });
    try{
      await api("/api/test/page-details", { method: "POST", body: JSON.stringify({ index }) });
    }catch(e){ }
    pollTestPageDetails(index);
  }

  function switchTestDetailsTab(tab){
    document.querySelectorAll(".modal-tab-btn").forEach(b => b.classList.toggle("active", b.getAttribute("data-tab") === tab));
    $("testDetailsSourceTab").classList.toggle("active", tab === "source");
    $("testDetailsLayoutTab").classList.toggle("active", tab === "layout");
  }

  function openTestDetailsModal(index){
    const r = state.results[index];
    if(!r) return;
    testDetailsIndex = index;
    const titleText = r.benchTitle === r.candTitle ? (r.benchTitle || "(untitled)") : `${r.benchTitle || "(untitled)"} → ${r.candTitle || "(untitled)"}`;
    $("testDetailsModalTitle").textContent = titleText;
    $("testDetailsModalPath").textContent = r.benchPath === r.candPath ? r.benchPath : `${r.benchPath} → ${r.candPath}`;
    switchTestDetailsTab("layout");
    $("testDetailsModalOverlay").classList.add("open");
    document.body.classList.add("modal-open");
    requestTestPageDetails(index);
  }

  function closeTestDetailsModal(){
    testDetailsIndex = null;
    $("testDetailsModalOverlay").classList.remove("open");
    document.body.classList.remove("modal-open");
    if(testDetailsPollTimer){ clearInterval(testDetailsPollTimer); testDetailsPollTimer = null; }
  }

  $("ledgerBody").addEventListener("click", (e) => {
    const btn = e.target.closest(".details-icon-btn[data-details-index]");
    if(!btn) return;
    openTestDetailsModal(Number(btn.getAttribute("data-details-index")));
  });
  $("testDetailsModalCloseBtn").addEventListener("click", closeTestDetailsModal);
  $("testDetailsModalOverlay").addEventListener("click", (e) => {
    if(e.target.id === "testDetailsModalOverlay") closeTestDetailsModal();
  });
  document.querySelectorAll(".modal-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTestDetailsTab(btn.getAttribute("data-tab")));
  });
  document.addEventListener("keydown", (e) => {
    if(e.key === "Escape" && $("testDetailsModalOverlay").classList.contains("open")) closeTestDetailsModal();
  });

  async function startTesting(){
    if(busy) return;
    busy = true;
    try{
      await runTesting();
    }finally{
      busy = false;
      updateCrawlButtonState();
    }
  }

  async function runTesting(){
    $("ledgerWrap").scrollIntoView({ behavior: "smooth", block: "start" });

    if(state.bench.mode === "list" && (!state.bench.listRegistered || !state.cand.listRegistered)){
      $("btnTest").disabled = true;
      $("btnCrawl").disabled = true;
      await crawlOne("bench", "benchUrl", "benchStatus");
      await crawlOne("cand", "candUrl", "candStatus");
      if(state.bench.pages.length || state.cand.pages.length) alignPanels();
      updateListMismatchWarning();
      if(state.bench.pages.length === 0 || state.cand.pages.length === 0){
        updateCrawlButtonState();
        return;
      }
    }

    $("btnTest").disabled = true;
    $("btnCrawl").disabled = true;
    const progressEl = $("testProgress");
    setHidden($("testProgressWrap"), false);
    setHidden(progressEl, false);
    progressEl.className = "status-line";
    progressEl.textContent = "Starting verification tests…";
    setTestBar(0, "");
    state.results = [];
    closeTestDetailsModal();
    $("ledgerBody").innerHTML = `<tr><td colspan="6"><div class="empty">Comparing matched pages — findings will stream in real time…</div></td></tr>`;

    const pollTimer = setInterval(pollTestProgress, 600);
    try{
      const result = await api("/api/test", { method:"POST", body: JSON.stringify({}) });
      state.results = result.results;
      renderLedger();
      setTestBar(100, "done");
      const blockedCount = result.results.filter(r => r.blocked).length;
      progressEl.textContent = `Completed — ${result.results.length} matched page(s) verified.` +
        (blockedCount ? ` ${blockedCount} page(s) were blocked by the site's bot protection and could not be compared.` : "");
      progressEl.className = "status-line ok";
    }catch(e){
      if(e.partialResults && e.partialResults.length){
        state.results = e.partialResults;
      }
      renderLedger();
      setTestBar(100, "err");
      const count = state.results.length;
      progressEl.textContent = `Failed: ${e.message}${count ? ` — preserved ${count} result(s) captured prior.` : ""}`;
      progressEl.className = "status-line err";
    }finally{
      clearInterval(pollTimer);
      $("btnTest").disabled = false;
      updateCrawlButtonState();
      pollAiSummary();
      refreshIcons();
    }
  }

  $("btnCrawl").addEventListener("click", crawlSites);
  $("btnTest").addEventListener("click", startTesting);
  $("maxPages").addEventListener("input", function(){
    const cleaned = this.value.replace(/[^0-9]/g, "");
    this.value = cleaned;
    this.classList.toggle("invalid", cleaned.length === 0);
  });
  $("benchUrl").addEventListener("input", updateCrawlButtonState);
  $("candUrl").addEventListener("input", updateCrawlButtonState);
  $("benchUrl").addEventListener("keydown", e=>{ if(e.key==="Enter" && !$("btnCrawl").disabled) $("btnCrawl").click(); });
  $("candUrl").addEventListener("keydown", e=>{ if(e.key==="Enter" && !$("btnCrawl").disabled) $("btnCrawl").click(); });
  $("benchUrlList").addEventListener("input", () => { updateCrawlButtonState(); previewListMode("bench"); });
  $("candUrlList").addEventListener("input", () => { updateCrawlButtonState(); previewListMode("cand"); });
  setupModeToggle("bench");
  setupModeToggle("cand");
  setupFileUpload("bench");
  setupFileUpload("cand");
  setupHistorySelect("bench");
  setupHistorySelect("cand");
  pollAiSummary();
  refreshIcons();

})();
