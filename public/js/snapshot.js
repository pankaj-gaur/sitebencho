/* snapshot.js — behaviour for snapshots.html (Daily Snapshots).
 * Shared helpers come from main.js and the combination files via window.Miti. */
(function () {
  const { $, escapeHtml, refreshIcons, setProgress } = window.Miti;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  const state = {
    config: null,
    draft: [],            // editable copy of urls in the accordion
    urlId: null,
    year: new Date().getUTCFullYear(),
    month: 'all',
    index: { days: {}, benchmark: null, years: [] },
    weekIdx: {},          // month number -> selected week index
    lb: { date: null, compare: false, pairLeft: null },   // pairLeft: older date when comparing two captures
    cmp: { on: false, picks: [], info: {} },               // picks in click order; info caches day data across year switches
    wasRunning: false,
    lastFinishedAt: null,   // last completed run already reflected on screen
    serviceMissing: false,
  };

  // Local short names for the shared helpers in main.js
  const esc = escapeHtml;
  const icons = refreshIcons;
  function ymd(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  // Capture runs on a fixed GMT/UTC schedule, so "today" and "this month"
  // are also read in UTC — otherwise a viewer west of GMT would see a day
  // still marked "scheduled" after it was already captured, or vice versa.
  function nowUTC() {
    const n = new Date();
    return { year: n.getUTCFullYear(), month: n.getUTCMonth(), date: n.getUTCDate() };
  }
  function todayStrUTC() {
    const n = nowUTC();
    const p = (x) => String(x).padStart(2, '0');
    return `${n.year}-${p(n.month + 1)}-${p(n.date)}`;
  }
  function prettyDate(s, withYear = true) {
    if (!s) return '';
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return `${DOW[dt.getDay()]} ${d} ${MONTHS[m - 1].slice(0, 3)}${withYear ? ' ' + y : ''}`;
  }
  async function api(url, opts = {}) {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!r.ok || !j.ok) {
      const err = new Error(j.error || `HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return j;
  }
  function fileUrl(id, name, v) {
    return `/snapshot-files/${encodeURIComponent(id)}/${name}${v ? '?v=' + encodeURIComponent(v) : ''}`;
  }

  // ------------------------------------------------------------------
  // Section 1 — setup accordion
  // ------------------------------------------------------------------
  function setAccordion(open) {
    $('setup').classList.toggle('open', open);
    $('setupToggle').setAttribute('aria-expanded', String(open));
  }
  $('setupToggle').addEventListener('click', () => setAccordion(!$('setup').classList.contains('open')));

  function renderSummary() {
    const c = state.config;
    const max = c && c.limits && c.limits.maxUrls;
    const planNote = max ? ` Your plan allows up to ${max} page${max === 1 ? '' : 's'}.` : '';
    if (!c || !c.urls.length) { $('setupSummary').textContent = `No pages yet — add the pages to capture each day.${planNote}`; return; }
    const n = c.urls.length;
    const count = max ? `${n} of ${max} pages` : `${n} page${n === 1 ? '' : 's'}`;
    $('setupSummary').textContent = `${count}, captured daily at ${c.captureTime} GMT. Open to add, rename or remove pages.`;
  }

  function renderRows() {
    const tb = $('urlRows');
    if (!state.draft.length) {
      tb.innerHTML = '<tr class="empty-row"><td colspan="4">No pages yet. Add one below, or paste a list.</td></tr>';
      return;
    }
    tb.innerHTML = state.draft.map((u, i) => {
      const bm = u.benchmark
        ? `<span class="bench-mini"><img src="${fileUrl(u.id, 'benchmark-thumb.jpg', u.benchmark.setAt || u.benchmark.capturedAt)}" alt="">${esc(prettyDate(u.benchmark.sourceDate || '', false))}</span>`
        : `<span class="bench-mini">${u.id ? 'Pending' : 'After save'}</span>`;
      return `<tr>
        <td><input type="text" data-i="${i}" data-k="label" value="${esc(u.label)}" placeholder="Optional name" aria-label="Name"></td>
        <td><input type="url" data-i="${i}" data-k="url" value="${esc(u.url)}" placeholder="https://example.com/page" aria-label="URL" ${u.id ? 'readonly title="To change a URL, remove it and add the new one"' : ''}></td>
        <td class="bench-cell">${bm}</td>
        <td class="col-remove"><button class="btn icon-btn danger" type="button" data-remove="${i}" aria-label="Remove ${esc(u.label || u.url)}"><i data-lucide="trash-2"></i></button></td>
      </tr>`;
    }).join('');
    icons();
  }

  $('urlRows').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.i === undefined) return;
    state.draft[+t.dataset.i][t.dataset.k] = t.value;
  });
  $('urlRows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    state.draft.splice(+b.dataset.remove, 1);
    renderRows();
  });
  $('btnAddRow').addEventListener('click', () => {
    state.draft.push({ url: '', label: '' });
    renderRows();
    const inputs = $('urlRows').querySelectorAll('input[data-k="url"]');
    inputs[inputs.length - 1].focus();
  });
  $('btnBulk').addEventListener('click', () => { $('bulk').classList.add('show'); $('bulkText').focus(); });
  $('btnBulkCancel').addEventListener('click', () => { $('bulk').classList.remove('show'); $('bulkText').value = ''; });
  $('btnBulkAdd').addEventListener('click', () => {
    const lines = $('bulkText').value.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
    // drop empty placeholder rows before appending
    state.draft = state.draft.filter((u) => u.id || u.url.trim());
    lines.forEach((url) => state.draft.push({ url, label: '' }));
    $('bulkText').value = '';
    $('bulk').classList.remove('show');
    renderRows();
  });
  $('btnCancel').addEventListener('click', () => { loadDraftFromConfig(); $('setupMsg').textContent = ''; });

  function loadDraftFromConfig() {
    const c = state.config;
    state.draft = c.urls.map((u) => ({ ...u }));
    $('captureTime').value = c.captureTime;
    $('retentionDays').value = c.retentionDays;
    // The plan caps how long screenshots are kept ("0 = forever" only without a cap).
    const maxKeep = c.limits && c.limits.maxRetentionDays;
    if (maxKeep) {
      $('retentionDays').max = String(maxKeep);
      $('retentionDays').min = '1';
      $('retentionDays').title = `Your plan keeps screenshots for up to ${maxKeep} days.`;
    }
    renderRows();
  }

  $('btnSave').addEventListener('click', async () => {
    const msg = $('setupMsg');
    msg.className = 'msg';
    msg.textContent = '';
    try {
      const urls = state.draft.filter((u) => u.id || (u.url || '').trim()).map((u) => ({ id: u.id, url: (u.url || '').trim(), label: u.label }));
      const keep = new Set(urls.filter((u) => u.id).map((u) => u.id));
      // state.config may not have loaded (e.g. the initial fetch failed) —
      // in that case there's nothing to compare against, so just save.
      const removed = state.config ? state.config.urls.filter((u) => !keep.has(u.id)) : [];
      if (removed.length && !confirm(`Removing ${removed.map((u) => u.label || u.url).join(', ')} also deletes all of its stored screenshots. Continue?`)) return;

      $('btnSave').disabled = true;
      const r = await api('/api/snapshots/config', {
        method: 'PUT',
        body: JSON.stringify({ urls, captureTime: $('captureTime').value, retentionDays: Number($('retentionDays').value) }),
      });
      msg.className = 'msg ok';
      msg.textContent = r.capturingNew
        ? `Saved. Capturing ${r.capturingNew} new page${r.capturingNew === 1 ? '' : 's'} now — the first capture becomes the benchmark.`
        : 'Saved.';
      await loadConfig();
      if (state.config && state.config.urls.length) setTimeout(() => setAccordion(false), 1200);
      // Make sure the capture this save just started is picked up and shown
      // when it finishes, even if it completes before the first poll.
      if (state.lastFinishedAt === null) state.lastFinishedAt = 'pending';
      pollStatus();
    } catch (e) {
      // Whatever went wrong — a network failure, a bad response, or a bug —
      // the person always sees something here instead of a silent no-op.
      msg.className = 'msg err';
      msg.textContent = `Couldn't save: ${e && e.message ? e.message : e}`;
    } finally {
      $('btnSave').disabled = state.serviceMissing;
    }
  });

  async function loadConfig() {
    state.config = await api('/api/snapshots/config');
    $('setupLoadErr').hidden = true;
    loadDraftFromConfig();
    renderSummary();
    const has = state.config.urls.length > 0;
    $('tlSection').hidden = !has;
    $('tlEmpty').hidden = has;
    $('runbar').hidden = !has;
    if (!has) { setAccordion(true); return; }
    const sel = $('selUrl');
    if (!state.config.urls.some((u) => u.id === state.urlId)) state.urlId = state.config.urls[0].id;
    sel.innerHTML = state.config.urls.map((u) => `<option value="${esc(u.id)}">${esc(u.label)} — ${esc(u.url)}</option>`).join('');
    sel.value = state.urlId;
    await loadIndex();
  }
  function showLoadError(e) {
    const missing = e && e.status === 404;
    state.serviceMissing = missing;
    $('setupLoadErrText').innerHTML = missing
      ? 'the Daily Snapshots service isn\'t running on the server. Add <code>mountSnapshots(app, { logErr })</code> to <code>server.js</code> and restart it, then click Retry.'
      : esc(e && e.message ? e.message : String(e));
    $('setupLoadErrLead').textContent = missing ? 'Not connected yet:' : "Couldn't load your saved pages:";
    $('setupSummary').textContent = missing ? 'Daily Snapshots service not connected' : "Couldn't load your saved pages";
    $('setupLoadErr').hidden = false;
    $('btnSave').disabled = missing;
    $('tlEmpty').hidden = false;
    setAccordion(true);
    icons();
  }
  $('btnRetryLoad').addEventListener('click', async () => {
    $('btnRetryLoad').disabled = true;
    try {
      await loadConfig();
      state.serviceMissing = false;
      $('btnSave').disabled = false;
      if (state.config.urls.length) pollStatus();
    } catch (e) {
      showLoadError(e);
    } finally {
      $('btnRetryLoad').disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // run status
  // ------------------------------------------------------------------
  let pollTimer = null;
  async function pollStatus() {
    clearTimeout(pollTimer);
    let s;
    try { s = await api('/api/snapshots/status'); } catch (e) { pollTimer = setTimeout(pollStatus, 10000); return; }
    const running = s.status === 'running';
    $('btnRunNow').disabled = running;
    $('runTrack').hidden = !running;
    if (running) {
      const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
      setProgress($('runFill'), pct);
      $('runText').innerHTML = `Capturing ${Math.min(s.done + 1, s.total)} of ${s.total}<span class="mono"> ${esc(s.current || '')}</span>`;
      $('runIconWrap').innerHTML = '<i data-lucide="loader-2" class="spin"></i>';
    } else {
      const next = s.nextRunAt ? new Date(s.nextRunAt) : null;
      let t = '';
      if (next && next - Date.now() < 120000) t = "Today's capture is due and starts within a minute.";
      else if (next) t = `Next capture ${next.toDateString() === new Date().toDateString() ? 'today' : 'tomorrow'} at ${s.captureTime} GMT.`;
      if (s.finishedAt) t += ` Last run finished ${new Date(s.finishedAt).toLocaleString()}.`;
      if (s.lastErrors && s.lastErrors.length) t += ` ${s.lastErrors.length} page${s.lastErrors.length === 1 ? '' : 's'} failed in the last run.`;
      $('runText').textContent = t.trim() || 'Idle.';
      $('runIconWrap').innerHTML = '<i data-lucide="clock"></i>';
    }
    icons();

    const newRunFinished = !running && s.finishedAt && s.finishedAt !== state.lastFinishedAt;
    if (newRunFinished) {
      const firstPoll = state.lastFinishedAt === null && !state.wasRunning;
      state.lastFinishedAt = s.finishedAt;
      if (!firstPoll) await loadConfig();   // a capture landed — show it
    }
    state.wasRunning = running;
    const msToNext = s.nextRunAt ? new Date(s.nextRunAt) - Date.now() : Infinity;
    const delay = running ? 1500 : msToNext < 3 * 60000 ? 5000 : 30000;
    pollTimer = setTimeout(pollStatus, delay);
  }
  $('btnRunNow').addEventListener('click', async () => {
    $('btnRunNow').disabled = true;
    try { await api('/api/snapshots/run', { method: 'POST', body: '{}' }); } catch (e) { alert(e.message); }
    pollStatus();
  });

  // ------------------------------------------------------------------
  // Section 2 — timeline
  // ------------------------------------------------------------------
  async function loadIndex() {
    if (!state.urlId) return;
    state.index = await api(`/api/snapshots/index?urlId=${encodeURIComponent(state.urlId)}&year=${state.year}`);
    const ys = new Set(state.index.years.map(Number));
    ys.add(state.year);
    $('selYear').innerHTML = Array.from(ys).sort((a, b) => b - a).map((y) => `<option value="${y}">${y}</option>`).join('');
    $('selYear').value = String(state.year);
    renderBenchmark();
    renderTimeline();
    if (!state.didInitialScroll) { state.didInitialScroll = true; scrollToCurrentMonth(); }
  }

  // On first load, bring the current month into view. Only once — later
  // refreshes (a capture landing, Page/Year changes) leave the scroll alone.
  function scrollToCurrentMonth() {
    requestAnimationFrame(() => {
      const el = document.querySelector('#timeline .tl-month.is-current');
      if (!el) return;
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    });
  }

  function renderBenchmark() {
    const bm = state.index.benchmark;
    $('benchCard').hidden = !bm;
    if (!bm) return;
    $('benchImg').src = fileUrl(state.urlId, 'benchmark-thumb.jpg', bm.setAt || bm.capturedAt);
    $('benchDate').textContent = bm.sourceDate ? `From ${prettyDate(bm.sourceDate)}` : '';
  }

  // Weeks are 7-day windows from the 1st of the month (1–7, 8–14, 15–21,
  // 22–28, 29–end), so every page of a month shows that month's own days.
  function weeksOf(year, month) {
    const last = new Date(year, month + 1, 0).getDate();
    const weeks = [];
    for (let d = 1; d <= last; d += 7) weeks.push(new Date(year, month, d));
    return weeks;
  }
  function defaultWeek(year, month, weeks) {
    const today = nowUTC();
    if (today.year === year && today.month === month) {
      return Math.min(Math.floor((today.date - 1) / 7), weeks.length - 1);
    }
    // otherwise the latest week of the month that has a capture, else the first
    for (let i = weeks.length - 1; i >= 0; i--) {
      for (let k = 0; k < 7; k++) {
        const d = new Date(weeks[i]); d.setDate(d.getDate() + k);
        if (d.getMonth() === month && state.index.days[ymd(d)]) return i;
      }
    }
    return 0;
  }

  function renderMonth(month) {
    const year = state.year;
    const weeks = weeksOf(year, month);
    if (state.weekIdx[month] === undefined || state.weekIdx[month] >= weeks.length) state.weekIdx[month] = defaultWeek(year, month, weeks);
    const wi = state.weekIdx[month];
    const todayStr = todayStrUTC();
    const now = nowUTC();
    const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
    const count = Object.keys(state.index.days).filter((d) => d.startsWith(monthKey) && state.index.days[d].hasImage).length;
    const isFuture = year > now.year || (year === now.year && month > now.month);
    const isCurrent = year === now.year && month === now.month;
    const bmDate = state.index.benchmark && state.index.benchmark.sourceDate;

    let days = '';
    let firstIn = null, lastIn = null;
    for (let k = 0; k < 7; k++) {
      const d = new Date(weeks[wi]); d.setDate(d.getDate() + k);
      const ds = ymd(d);
      const inMonth = d.getMonth() === month;
      if (inMonth) { firstIn = firstIn || d; lastIn = d; }
      const info = inMonth ? state.index.days[ds] : null;
      const cls = ['day'];
      let inner = '';
      if (!inMonth) cls.push('outside');
      if (ds === todayStr) cls.push('today');
      const selLetter = inMonth ? cmpLetter(ds) : '';
      if (info && info.hasImage) {
        cls.push('has-img', info.ok ? 'ok' : 'err');
        if (selLetter) cls.push('selected');
        inner = `<img loading="lazy" src="${fileUrl(state.urlId, ds + '-thumb.jpg', info.capturedAt)}" alt="">`
          + `<span class="badge ${info.ok ? 'ok' : 'err'}"></span>`
          + (ds === bmDate ? '<span class="badge bm">BENCH</span>' : '')
          + (selLetter ? `<span class="badge sel">${selLetter}</span>` : '');
      } else if (info && info.error) {
        cls.push('err');
        inner = `<span class="ph">Capture failed<br>${esc(info.error.slice(0, 40))}</span>`;
      } else if (ds > todayStr) {
        cls.push('future');
        inner = '<span class="ph">Scheduled</span>';
      } else {
        cls.push('missing');
        inner = '<span class="ph">No capture</span>';
      }
      const clickable = info && info.hasImage;
      const clickHint = state.cmp.on ? (selLetter ? `, selected as ${selLetter} for compare` : ', select for compare') : ', open screenshot';
      const aria = `${prettyDate(ds)}${clickable ? clickHint : info && info.error ? ', capture failed' : ''}`;
      days += `<div class="${cls.join(' ')}" ${inMonth ? '' : 'aria-hidden="true"'}>
          <button class="thumb" type="button" ${clickable ? `data-open="${ds}"` : 'tabindex="-1"'} ${clickable && state.cmp.on ? `aria-pressed="${!!selLetter}"` : ''} aria-label="${esc(aria)}" title="${esc(info && info.error ? info.error : '')}">${inner}</button>
          <span class="tick"></span>
          <div class="date"><b>${d.getDate()}</b><span>${DOW[d.getDay()]}</span></div>
        </div>`;
    }
    const caption = firstIn && lastIn
      ? `${firstIn.getDate()}–${lastIn.getDate()} ${MONTHS[month].slice(0, 3)} · week ${wi + 1} of ${weeks.length}`
      : '';

    return `<div class="tl-month ${count ? 'has-data' : ''} ${isCurrent ? 'is-current' : ''} ${isFuture ? 'is-future' : ''}">
      <div class="tl-label"><b>${MONTHS[month]}</b><span>${count ? `${count} capture${count === 1 ? '' : 's'}` : isFuture ? 'Upcoming' : 'No captures'}</span></div>
      <div class="tl-node"><i></i></div>
      <div class="strip">
        <button class="btn icon-btn nav-btn" type="button" data-week="${month}" data-dir="-1" ${wi === 0 ? 'disabled' : ''} aria-label="Previous week of ${MONTHS[month]}"><i data-lucide="chevron-left"></i></button>
        <div class="week">${days}</div>
        <button class="btn icon-btn nav-btn" type="button" data-week="${month}" data-dir="1" ${wi >= weeks.length - 1 ? 'disabled' : ''} aria-label="Next week of ${MONTHS[month]}"><i data-lucide="chevron-right"></i></button>
        <div class="week-caption">${esc(caption)}</div>
      </div>
    </div>`;
  }

  function renderTimeline() {
    const months = state.month === 'all' ? [...Array(12).keys()] : [Number(state.month)];
    $('timeline').classList.toggle('single', months.length === 1);
    $('timeline').classList.toggle('cmp-mode', state.cmp.on);
    $('timeline').innerHTML = months.map(renderMonth).join('');
    icons();
  }

  $('timeline').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-week]');
    if (nav) {
      const m = +nav.dataset.week;
      state.weekIdx[m] = (state.weekIdx[m] || 0) + Number(nav.dataset.dir);
      renderTimeline();
      return;
    }
    const open = e.target.closest('[data-open]');
    if (!open) return;
    // Compare mode, or Ctrl/⌘-click anytime: select instead of opening.
    if (state.cmp.on || e.ctrlKey || e.metaKey) { e.preventDefault(); togglePick(open.dataset.open); return; }
    openLightbox(open.dataset.open);
  });

  // ------------------------------------------------------------------
  // compare two dates (timeline selection + tray)
  // ------------------------------------------------------------------
  // A is always the older date and B the newer, whichever order they were clicked.
  function sortedPicks() { return state.cmp.picks.slice().sort(); }
  function cmpLetter(ds) { const i = sortedPicks().indexOf(ds); return i < 0 ? '' : 'AB'[i]; }

  function togglePick(ds) {
    const picks = state.cmp.picks;
    const at = picks.indexOf(ds);
    if (at >= 0) {
      picks.splice(at, 1);                       // clicking a selected day unselects it
      delete state.cmp.info[ds];
    } else {
      if (picks.length >= 2) delete state.cmp.info[picks.pop()];   // third click: keep the first pick, replace the second
      picks.push(ds);
      state.cmp.info[ds] = state.index.days[ds]; // survives a Year switch, so Dec vs Jan works
    }
    renderTimeline();
    renderTray();
  }

  function setCmpMode(on) {
    state.cmp.on = on;
    $('btnCmpMode').classList.toggle('toggled', on);
    $('btnCmpMode').setAttribute('aria-pressed', String(on));
    if (!on) { state.cmp.picks = []; state.cmp.info = {}; }
    renderTimeline();
    renderTray();
  }

  function renderTray() {
    const tray = $('cmpTray');
    const [a, b] = sortedPicks();
    const show = state.cmp.on || state.cmp.picks.length > 0;
    tray.hidden = !show;
    document.body.classList.toggle('cmp-tray-open', show);
    if (!show) return;
    const withYear = !!(a && b && a.slice(0, 4) !== b.slice(0, 4));
    const slot = (ds, ph) => ds
      ? `<span class="cmp-slot">${esc(prettyDate(ds, withYear))}</span>`
      : `<span class="cmp-slot empty">${ph}</span>`;
    tray.innerHTML = slot(a, 'Pick a day') + '<i data-lucide="arrow-left-right"></i>' + slot(b, 'Pick another day')
      + `<button class="btn primary" id="cmpGo" type="button" ${a && b ? '' : 'disabled'}><i data-lucide="columns-2"></i> Compare</button>`
      + '<button class="btn icon-btn" id="cmpClear" type="button" aria-label="Cancel compare" title="Cancel compare"><i data-lucide="x"></i></button>';
    icons();
  }

  function openCompare() {
    const [a, b] = sortedPicks();
    if (!a || !b) return;
    state.lb.pairLeft = a;
    state.lb.compare = false;
    openLightbox(b);
  }

  $('btnCmpMode').addEventListener('click', () => setCmpMode(!state.cmp.on));
  $('cmpTray').addEventListener('click', (e) => {
    if (e.target.closest('#cmpGo')) openCompare();
    else if (e.target.closest('#cmpClear')) setCmpMode(false);
  });

  $('selMonth').innerHTML += MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join('');
  $('selUrl').addEventListener('change', async (e) => {
    state.urlId = e.target.value; state.weekIdx = {};
    state.cmp.picks = []; state.cmp.info = {};   // a selection only makes sense within one page
    renderTray();
    await loadIndex();
  });
  $('selYear').addEventListener('change', async (e) => { state.year = Number(e.target.value); state.weekIdx = {}; await loadIndex(); });
  $('selMonth').addEventListener('change', (e) => { state.month = e.target.value; renderTimeline(); });

  // ------------------------------------------------------------------
  // lightbox
  // ------------------------------------------------------------------
  function capturedDates() {
    return Object.keys(state.index.days).filter((d) => state.index.days[d].hasImage).sort();
  }
  function dayInfo(ds) { return state.index.days[ds] || state.cmp.info[ds] || {}; }
  function dayCol(ds, info) {
    return `<div class="lb-col"><div class="lb-cap">${esc(prettyDate(ds))}</div><img src="${fileUrl(state.urlId, ds + '.jpg', info.capturedAt)}" alt="Full-page screenshot, ${esc(prettyDate(ds))}"></div>`;
  }
  function renderLightbox() {
    const ds = state.lb.date;
    const left = state.lb.pairLeft;              // set when opened from the compare tray
    const u = state.config.urls.find((x) => x.id === state.urlId);
    const info = dayInfo(ds);
    const bm = state.index.benchmark;
    const list = capturedDates();
    const i = list.indexOf(ds);

    $('lbTitle').textContent = u ? u.label : '';
    const time = info.capturedAt ? ' at ' + new Date(info.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const clip = info.truncated ? ' · clipped at 15,000 px' : '';
    $('lbMeta').textContent = left ? `${prettyDate(left)} ↔ ${prettyDate(ds)}${time}${clip}` : `${prettyDate(ds)}${time}${clip}`;
    $('lbPill').innerHTML = info.ok
      ? `<span class="pill ok">HTTP ${esc(info.httpStatus)}</span>`
      : `<span class="pill err">${esc(info.error || 'Error')}</span>`;
    $('lbPrev').disabled = i <= 0;               // ‹ › step the right-hand (newer) side; left stays pinned
    $('lbNext').disabled = i < 0 || i >= list.length - 1;

    // In date-pair mode the existing Compare button becomes the way back to a single view.
    $('lbCompare').disabled = !left && !bm;
    $('lbCompare').classList.toggle('toggled', !!left || (state.lb.compare && !!bm));
    $('lbCompare').lastChild.textContent = left ? ' Exit compare' : ' Compare with benchmark';

    const isBm = bm && bm.sourceDate === ds;
    $('lbSetBm').disabled = !!isBm;
    $('lbSetBm').lastChild.textContent = isBm ? ' This is the benchmark' : ' Make this the benchmark';
    $('lbOpen').href = fileUrl(state.urlId, ds + '.jpg', info.capturedAt);

    let leftCol = '';
    if (left) {
      leftCol = dayCol(left, dayInfo(left));
    } else if (state.lb.compare && bm) {
      leftCol = `<div class="lb-col"><div class="lb-cap">Benchmark · ${esc(prettyDate(bm.sourceDate || ''))}</div><img src="${fileUrl(state.urlId, 'benchmark.jpg', bm.setAt || bm.capturedAt)}" alt="Benchmark screenshot"></div>`;
    }
    $('lbBody').classList.toggle('compare', !!leftCol);
    $('lbBody').innerHTML = leftCol + dayCol(ds, info);
  }
  function openLightbox(ds) {
    state.lb.date = ds;
    renderLightbox();
    $('lb').classList.add('show');
    $('lbBody').scrollTop = 0;
    $('lbClose').focus();
  }
  function closeLightbox() { $('lb').classList.remove('show'); state.lb.pairLeft = null; }
  function step(dir) {
    const list = capturedDates();
    const i = list.indexOf(state.lb.date) + dir;
    if (i >= 0 && i < list.length) { state.lb.date = list[i]; renderLightbox(); $('lbBody').scrollTop = 0; }
  }
  $('lbClose').addEventListener('click', closeLightbox);
  $('lb').addEventListener('click', (e) => { if (e.target === $('lb')) closeLightbox(); });
  $('lbPrev').addEventListener('click', () => step(-1));
  $('lbNext').addEventListener('click', () => step(1));
  $('lbCompare').addEventListener('click', () => {
    if (state.lb.pairLeft) state.lb.pairLeft = null;   // Exit compare → single view of the right-hand date
    else state.lb.compare = !state.lb.compare;
    renderLightbox();
  });
  $('lbSetBm').addEventListener('click', async () => {
    try {
      await api('/api/snapshots/benchmark', { method: 'POST', body: JSON.stringify({ urlId: state.urlId, date: state.lb.date }) });
      await loadConfig();
      renderLightbox();
    } catch (e) { alert(e.message); }
  });
  document.addEventListener('keydown', (e) => {
    if (!$('lb').classList.contains('show')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  const openBenchmark = () => {
    const bm = state.index.benchmark;
    if (!bm) return;
    if (bm.sourceDate && state.index.days[bm.sourceDate]) { state.lb.compare = false; openLightbox(bm.sourceDate); }
    else window.open(fileUrl(state.urlId, 'benchmark.jpg', bm.setAt), '_blank');
  };
  $('benchCard').addEventListener('click', openBenchmark);
  $('benchCard').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBenchmark(); } });

  // ------------------------------------------------------------------
  // masthead info popover
  // ------------------------------------------------------------------

  icons();
  loadConfig()
    .then(() => { if (state.config.urls.length) pollStatus(); })
    .catch((e) => {
      showLoadError(e);
    });

  // Last resort: if something on this page throws outside a try/catch
  // (a bug, a browser quirk), don't fail totally silently — surface it in
  // the setup message area so at least it's visible instead of invisible.
  window.addEventListener('unhandledrejection', (e) => {
    const msg = $('setupMsg');
    if (!msg) return;
    msg.className = 'msg err';
    msg.textContent = `Something went wrong: ${e.reason && e.reason.message ? e.reason.message : e.reason}`;
  });
})();
