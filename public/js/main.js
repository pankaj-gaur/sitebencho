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
 * "Max Pages to Scan" at their limit. Window.Miti.me resolves to
 * /api/account ({ mode, user, plan, limits }); with sign-in off there is no menu.
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

  // Account info from the server: { mode, user, plan, limits }.
  //   mode "full": sign-in with plans; "signin": sign-in only; "off": no sign-in.
  const me = nativeFetch("/api/account", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(r => (r.ok ? r.json() : null), () => null);

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

  // Account pill at the end of the header toolbar: email · plan · Admin · Sign out.
  function initAccountMenu(account, showAdmin){
    const toolbar = document.querySelector(".miti-header .toolbar");
    if(!toolbar) return;
    const user = account.user;
    const menu = document.createElement("div");
    menu.className = "account-menu";
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", "Account");

    const email = document.createElement("span");
    email.className = "account-email";
    email.textContent = user.email;
    email.title = user.email;
    menu.appendChild(email);

    // Current plan → plans page (only when plans are on).
    if(account.plan){
      const p = account.plan;
      const plan = document.createElement("a");
      plan.href = `${AUTH}/plans`;
      plan.className = "account-plan";
      if(p.name === "Free") plan.textContent = "Free · Upgrade";
      else if(p.name === "Trial") plan.textContent = `Trial · ${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left`;
      else plan.textContent = p.name;
      plan.title = "See plans, upgrade, invoices and support";
      menu.appendChild(plan);
    }

    if(showAdmin){
      const admin = document.createElement("a");
      admin.href = `${AUTH}/admin`;
      admin.className = "account-icon";
      admin.title = "Admin";
      admin.setAttribute("aria-label", "Admin");
      admin.innerHTML = '<i data-lucide="shield" aria-hidden="true"></i><span class="account-label">Admin</span>';
      menu.appendChild(admin);
    }
    const out = document.createElement("button");
    out.type = "button";
    out.className = "account-icon";
    out.title = "Sign out";
    out.setAttribute("aria-label", "Sign out");
    out.innerHTML = '<i data-lucide="log-out" aria-hidden="true"></i><span class="account-label">Sign out</span>';
    out.addEventListener("click", signOut);
    menu.appendChild(out);

    toolbar.appendChild(menu);
    refreshIcons();
  }

  // "Max Pages to Scan" can't go above the limit (the server enforces it too).
  function initPageLimit(limit){
    const input = $("maxPages");
    if(!input || typeof limit !== "number") return;
    input.title = `You can scan up to ${limit} pages per crawl.`;
    const clamp = () => {
      const n = parseInt(input.value, 10);
      if(!Number.isFinite(n) || n > limit) input.value = String(limit);
    };
    clamp();
    input.addEventListener("change", clamp);
  }

  me.then(account => {
    if(!account) return;
    initPageLimit(account.limits && account.limits.maxPages);
    if(!account.user) return; // sign-in is off: no account menu
    canOpenAdmin(account.user).then(showAdmin => initAccountMenu(account, showAdmin));
  });

  window.Miti = { $, refreshIcons, escapeHtml, me };

  // Scripts are loaded with `defer`, so the DOM is already parsed here.
  initMastheadInfoPopover();
})();
