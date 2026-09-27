/*
 * Keycard account bar for Miti pages.
 * Add to any page:  <script src="/keycard-nav.js" defer></script>
 *
 * - Shows the signed-in email, an Admin link (admins and licence managers only) and Sign out.
 * - If a session ends while a page is open, the next /api call sends the person to sign in
 *   instead of showing a confusing error.
 */
(function () {
  'use strict';
  var AUTH = '/auth';

  // Redirect to sign-in when an API call reports the session is gone.
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    return realFetch(input, init).then(function (res) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var sameSite = url.charAt(0) === '/' || url.indexOf(location.origin) === 0;
      if (sameSite && url.indexOf(AUTH + '/') === -1 && (res.status === 401 || res.status === 403)) {
        res.clone().json().then(function (body) {
          if (body && body.error === 'not_signed_in') location.href = AUTH + '/login?next=' + encodeURIComponent(location.pathname + location.search);
          else if (body && body.error === 'access_ended') location.href = AUTH + '/access-ended';
        }, function () {});
      }
      return res;
    });
  };

  function build(user, canAdmin) {
    var css = document.createElement('style');
    css.textContent =
      '.kc-bar{position:fixed;left:14px;bottom:14px;z-index:9999;display:flex;align-items:center;gap:10px;' +
      'font:13px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#fff;color:#17212b;' +
      'border:1px solid #d5dce3;border-radius:999px;padding:6px 8px 6px 12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}' +
      '.kc-bar span{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#5a6672}' +
      '.kc-bar a,.kc-bar button{font:inherit;color:#24527a;background:none;border:0;padding:3px 6px;cursor:pointer;text-decoration:none;border-radius:6px}' +
      '.kc-bar a:hover,.kc-bar button:hover{background:#eef3f8}' +
      '@media print{.kc-bar{display:none}}';
    document.head.appendChild(css);
    var bar = document.createElement('div');
    bar.className = 'kc-bar';
    bar.setAttribute('role', 'navigation');
    bar.setAttribute('aria-label', 'Account');
    var email = document.createElement('span');
    email.textContent = user.email;
    email.title = user.email;
    bar.appendChild(email);
    if (canAdmin) {
      var admin = document.createElement('a');
      admin.href = AUTH + '/admin';
      admin.textContent = 'Admin';
      bar.appendChild(admin);
    }
    var out = document.createElement('button');
    out.type = 'button';
    out.textContent = 'Sign out';
    out.onclick = function () {
      realFetch(AUTH + '/logout', { method: 'POST', credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (r) { location.href = r.redirect || AUTH + '/login'; }, function () { location.href = AUTH + '/login'; });
    };
    bar.appendChild(out);
    document.body.appendChild(bar);
  }

  realFetch(AUTH + '/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      if (!me || !me.user) return;
      if (me.user.isAdmin) return build(me.user, true);
      // Licence managers also get the Admin link (their panel is limited to their licences).
      realFetch(AUTH + '/admin/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { build(me.user, r.ok); }, function () { build(me.user, false); });
    }, function () {});
})();
