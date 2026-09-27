/*
 * parity-analysis-snapshot.js — behaviour shared by exactly these pages:
 *   - index.html (Site Parity)
 *   - analysis.html (Site Analysis)
 *   - snapshots.html (Daily Snapshots)
 * Adds its helpers to window.Miti (created by main.js).
 */
(function(){
  "use strict";

  // Progress bars: the width comes from a data-pct="0…100" attribute that
  // parity-analysis-snapshot.css maps to a width — no inline style.width.
  function setProgress(el, pct){
    if(!el) return;
    const n = Math.round(Math.max(0, Math.min(100, Number(pct) || 0)));
    el.dataset.pct = String(n);
  }

  function getProgress(el){
    return el ? Number(el.dataset.pct || 0) : 0;
  }

  Object.assign(window.Miti, { setProgress, getProgress });
})();
