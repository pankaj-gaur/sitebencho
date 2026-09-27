/*
 * main.js — behaviour shared by ALL four pages.
 * Creates the window.Miti namespace; the shared combination scripts
 * (parity-analysis.js, parity-analysis-snapshot.js) add to it, and each
 * page script picks what it needs, e.g.
 *   const { $, escapeHtml, refreshIcons } = window.Miti;
 * Load order: lucide → main.js → combination scripts → page script (all `defer`).
 */
(function(){
  "use strict";

  const $ = id => document.getElementById(id);

  // Re-render any <i data-lucide="…"> placeholders into SVG icons.
  function refreshIcons(){
    if(window.lucide && typeof window.lucide.createIcons === "function"){
      window.lucide.createIcons();
    }
  }

  function escapeHtml(s){
    return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  // Masthead "i" button + popover — identical on every page.
  function initMastheadInfoPopover(){
    const btn = $("mastheadInfoBtn");
    const popover = $("mastheadInfoPopover");
    if(!btn || !popover) return;
    function closePopover(){
      popover.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
    }
    function togglePopover(e){
      e.stopPropagation();
      const isOpen = popover.classList.toggle("open");
      btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    }
    btn.addEventListener("click", togglePopover);
    document.addEventListener("click", (e) => {
      if(popover.classList.contains("open") && !popover.contains(e.target) && e.target !== btn){
        closePopover();
      }
    });
    document.addEventListener("keydown", (e) => {
      if(e.key === "Escape" && popover.classList.contains("open")) closePopover();
    });
  }

  window.Miti = { $, refreshIcons, escapeHtml };

  // Scripts are loaded with `defer`, so the DOM is already parsed here.
  initMastheadInfoPopover();
})();
