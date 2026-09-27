/* history.js — behaviour for history.html (History).
 * Shared helpers come from main.js and the combination files via window.Miti. */
(function(){
  "use strict";
  const { $, escapeHtml, refreshIcons } = window.Miti;

  function fmtDate(iso){
    try{
      const d = new Date(iso);
      return d.toLocaleString();
    }catch(e){ return iso; }
  }

  async function api(path, opts){
    const res = await fetch(path, opts);
    let body;
    try{ body = await res.json(); }catch(e){ body = { ok:false, error:"Server returned a non-JSON response." }; }
    if(!res.ok || body.ok === false) throw new Error(body.error || `Request failed (HTTP ${res.status})`);
    return body;
  }

  async function loadDiffRuns(){
    const body = $("diffBody");
    try{
      const result = await api("/api/history/diff");
      const runs = result.runs || [];
      if(runs.length === 0){
        body.innerHTML = `<tr><td colspan="7"><div class="empty">No saved runs yet — crawl in Site Parity first.</div></td></tr>`;
        return;
      }
      body.innerHTML = runs.map(r => {
        const status = r.testRun
          ? '<span class="pill pill-green">Crawl + Test</span>'
          : '<span class="pill pill-amber">Crawl only</span>';
        return `
        <tr data-type="diff" data-id="${escapeHtml(r.id)}">
          <td class="ts">${fmtDate(r.timestamp)}</td>
          <td class="origin">${escapeHtml(r.benchOrigin || "—")} <span class="text-muted">(${r.benchCount||0})</span></td>
          <td class="origin">${escapeHtml(r.candOrigin || "—")} <span class="text-muted">(${r.candCount||0})</span></td>
          <td>${status}</td>
          <td>${r.matchedCount || 0}</td>
          <td class="counts">
            <span class="pill pill-green">= ${r.counts ? r.counts.green||0 : 0}</span>
            <span class="pill pill-red">&ne; ${r.counts ? r.counts.red||0 : 0}</span>
            <span class="pill pill-amber">&ne; ${r.counts ? r.counts.amber||0 : 0}</span>
          </td>
          <td class="actions">
            <a class="report-link" href="/api/history/diff/${encodeURIComponent(r.id)}/csv"><i data-lucide="download"></i> CSV</a>
            <a class="report-link" href="/api/history/diff/${encodeURIComponent(r.id)}/pdf"><i data-lucide="download"></i> PDF</a>
            <button class="btn-delete" data-del="diff:${escapeHtml(r.id)}"><i data-lucide="trash-2"></i> Delete</button>
          </td>
        </tr>
      `;}).join("");
      refreshIcons();
    }catch(e){
      body.innerHTML = `<tr><td colspan="7"><div class="empty">Failed to load: ${escapeHtml(e.message)}</div></td></tr>`;
    }
  }

  async function loadAnalysisRuns(){
    const body = $("analysisBody");
    try{
      const result = await api("/api/history/analysis");
      const runs = result.runs || [];
      if(runs.length === 0){
        body.innerHTML = `<tr><td colspan="8"><div class="empty">No saved runs yet — crawl a site in Site Analysis first.</div></td></tr>`;
        return;
      }
      body.innerHTML = runs.map(r => {
        const linkDone = (r.linkScannedCount || 0) > 0;
        const lhDone = (r.lighthouseScannedCount || 0) > 0;
        let status;
        if(lhDone){
          status = '<span class="pill pill-green">Crawl + Links + Score</span>';
        }else if(linkDone){
          status = '<span class="pill pill-amber">Crawl + Links</span>';
        }else{
          status = '<span class="pill pill-amber">Crawl only</span>';
        }
        return `
        <tr data-type="analysis" data-id="${escapeHtml(r.id)}">
          <td class="ts">${fmtDate(r.timestamp)}</td>
          <td class="origin">${escapeHtml(r.siteOrigin || "—")}</td>
          <td>${status}</td>
          <td>${r.pageCount || 0}</td>
          <td class="counts">${linkDone ? `
            <span class="pill pill-green">OK ${r.cleanCount||0}</span>
            <span class="pill pill-red">Broken ${r.brokenCount||0}</span>
          ` : `<span class="pill pill-dim">not scanned</span>`}</td>
          <td>${lhDone && r.avgMobileScore !== null && r.avgMobileScore !== undefined ? r.avgMobileScore : "—"}</td>
          <td>${lhDone && r.avgDesktopScore !== null && r.avgDesktopScore !== undefined ? r.avgDesktopScore : "—"}</td>
          <td class="actions">
            <a class="report-link" href="/api/history/analysis/${encodeURIComponent(r.id)}/csv"><i data-lucide="download"></i> CSV</a>
            <a class="report-link" href="/api/history/analysis/${encodeURIComponent(r.id)}/pdf"><i data-lucide="download"></i> PDF</a>
            <button class="btn-delete" data-del="analysis:${escapeHtml(r.id)}"><i data-lucide="trash-2"></i> Delete</button>
          </td>
        </tr>
      `;}).join("");
      refreshIcons();
    }catch(e){
      body.innerHTML = `<tr><td colspan="8"><div class="empty">Failed to load: ${escapeHtml(e.message)}</div></td></tr>`;
    }
  }

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-del]");
    if(!btn) return;
    const [type, id] = btn.getAttribute("data-del").split(":");
    if(!confirm("Delete this saved run? This can't be undone.")) return;
    btn.disabled = true;
    try{
      await api(`/api/history/${type}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if(type === "diff") loadDiffRuns(); else loadAnalysisRuns();
    }catch(err){
      alert("Failed to delete: " + err.message);
      btn.disabled = false;
    }
  });

  refreshIcons();
  loadDiffRuns();
  loadAnalysisRuns();
})();
