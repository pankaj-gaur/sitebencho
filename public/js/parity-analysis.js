/*
 * parity-analysis.js — behaviour shared by exactly these pages:
 *   - index.html (Site Parity)
 *   - analysis.html (Site Analysis)
 * Adds its helpers to window.Miti (created by main.js).
 */
(function(){
  "use strict";
  const { $, refreshIcons } = window.Miti;

  // Visibility is driven by the `.is-hidden` class (parity-analysis.css)
  // instead of inline style.display, so all presentation stays in CSS.
  function setHidden(el, hidden){
    if(el) el.classList.toggle("is-hidden", !!hidden);
  }

  function isHidden(el){
    return !!el && el.classList.contains("is-hidden");
  }

  function parseUrlListText(text){
    const lines = String(text || "").split(/\r?\n/);
    const urls = [];
    for(const line of lines){
      const trimmed = line.trim();
      if(!trimmed || trimmed.startsWith("#")) continue;
      trimmed.split(",").map(p => p.trim()).filter(Boolean).forEach(p => {
        if(/^https?:\/\//i.test(p) || /^[a-z0-9.-]+\.[a-z]{2,}(\/|$|\?)/i.test(p)) urls.push(p);
      });
    }
    return Array.from(new Set(urls));
  }

  function pathFromUrl(urlStr){
    try{
      const u = new URL(/^https?:\/\//i.test(urlStr) ? urlStr : `https://${urlStr}`);
      let p = u.pathname;
      if(p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
      if(p === "") p = "/";
      return p + u.search;
    }catch(e){ return urlStr; }
  }

  function confirmDialog({ title, message, okLabel = "OK, reset", showCancel = true }){
    return new Promise(resolve => {
      const overlay = $("confirmOverlay");
      $("confirmTitleText").textContent = title;
      $("confirmMsg").textContent = message;
      $("confirmOkBtn").textContent = okLabel;
      setHidden($("confirmCancelBtn"), !(showCancel));
      overlay.classList.add("open");
      refreshIcons();
      $("confirmOkBtn").focus();

      function finish(result){
        overlay.classList.remove("open");
        $("confirmOkBtn").removeEventListener("click", onOk);
        $("confirmCancelBtn").removeEventListener("click", onCancel);
        overlay.removeEventListener("click", onBackdrop);
        document.removeEventListener("keydown", onKey, true);
        resolve(result);
      }
      function onOk(){ finish(true); }
      function onCancel(){ finish(false); }
      function onBackdrop(e){ if(e.target === overlay) finish(false); }
      function onKey(e){
        if(e.key === "Escape"){ e.stopPropagation(); finish(false); }
      }
      $("confirmOkBtn").addEventListener("click", onOk);
      $("confirmCancelBtn").addEventListener("click", onCancel);
      overlay.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKey, true);
    });
  }

  Object.assign(window.Miti, { setHidden, isHidden, parseUrlListText, pathFromUrl, confirmDialog });
})();
