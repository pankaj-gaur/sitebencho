/*
 * main.js — behaviour shared by ALL four pages.
 * Creates the window.Miti namespace; the shared combination scripts
 * (parity-analysis.js, parity-analysis-snapshot.js) add to it, and each
 * page script picks what it needs, e.g.
 *   const { $, escapeHtml, refreshIcons } = window.Miti;
 * Load order: lucide → main.js → combination scripts → page script (all `defer`).
 *
 * Also handles sign-in (Keycard): the account menu in the header, sending the
 * person to the sign-in page when their session ends, and capping
 * "Max Pages to Scan" at their plan's limit. Window.Miti.me resolves to the
 * signed-in user.
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

  // ---------- Sign-in (Keycard) ----------
  const AUTH = "/auth";
  const nativeFetch = window.fetch.bind(window);

  // If the session ends while a page is open (signed out elsewhere, licence
  // expired), the next API call sends the person to the right page instead of
  // showing a confusing error. "Not in your plan" (403 not_entitled) is left
  // for the page to show.
  window.fetch = function(input, init){
    return nativeFetch(input, init).then(res => {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const sameSite = url.charAt(0) === "/" || url.indexOf(location.origin) === 0 || !/^[a-z]+:/i.test(url);
      if(sameSite && url.indexOf(AUTH + "/") === -1 && (res.status === 401 || res.status === 403)){
        res.clone().json().then(body => {
          if(body && body.error === "not_signed_in"){
            location.href = `${AUTH}/login?next=${encodeURIComponent(location.pathname + location.search)}`;
          }else if(body && body.error === "access_ended"){
            location.href = `${AUTH}/access-ended`;
          }
        }, () => {});
      }
      return res;
    });
  };

  // Signed-in user: { email, isAdmin, access: { entitlements, license } }, or null.
  const me = nativeFetch(`${AUTH}/me`, { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(r => (r.ok ? r.json() : null))
    .then(d => (d && d.user) || null, () => null);

  // Licence managers aren't admins but still get the (limited) admin panel.
  function canOpenAdmin(user){
    if(user.isAdmin) return Promise.resolve(true);
    return nativeFetch(`${AUTH}/admin/api/me`, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(r => r.ok, () => false);
  }

  function signOut(){
    nativeFetch(`${AUTH}/logout`, { method: "POST", credentials: "same-origin" })
      .then(r => r.json())
      .then(r => { location.href = r.redirect || `${AUTH}/login`; }, () => { location.href = `${AUTH}/login`; });
  }

  // Account pill at the end of the header toolbar: email · Admin · Sign out.
  function initAccountMenu(user, showAdmin){
    const toolbar = document.querySelector(".miti-header .toolbar");
    if(!toolbar) return;
    const menu = document.createElement("div");
    menu.className = "account-menu";
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", "Account");

    const email = document.createElement("span");
    email.className = "account-email";
    email.textContent = user.email;
    email.title = user.access && user.access.license
      ? `${user.email} · ${user.access.license.planName || "Licence"} until ${new Date(user.access.license.expiresAt).toLocaleDateString()}`
      : user.email;
    menu.appendChild(email);

    if(showAdmin){
      const admin = document.createElement("a");
      admin.href = `${AUTH}/admin`;
      admin.innerHTML = '<i data-lucide="shield"></i> Admin';
      menu.appendChild(admin);
    }
    const out = document.createElement("button");
    out.type = "button";
    out.innerHTML = '<i data-lucide="log-out"></i> Sign out';
    out.addEventListener("click", signOut);
    menu.appendChild(out);

    toolbar.appendChild(menu);
    refreshIcons();
  }

  // "Max Pages to Scan" can't go above the plan's limit (the server enforces it too).
  function initPageLimit(user){
    const input = $("maxPages");
    const limit = user.access && user.access.entitlements ? user.access.entitlements.maxPages : null;
    if(!input || typeof limit !== "number") return;
    input.title = `Your plan allows up to ${limit} pages per crawl.`;
    const clamp = () => {
      const n = parseInt(input.value, 10);
      if(!Number.isFinite(n) || n > limit) input.value = String(limit);
    };
    clamp();
    input.addEventListener("change", clamp);
  }

  me.then(user => {
    if(!user) return;
    initPageLimit(user);
    canOpenAdmin(user).then(showAdmin => initAccountMenu(user, showAdmin));
  });

  window.Miti = { $, refreshIcons, escapeHtml, me };

  // Scripts are loaded with `defer`, so the DOM is already parsed here.
  initMastheadInfoPopover();
})();
