// ── App shell: event sidebar, cloud sync, passcode lock, import ──
// On Vercel the page saves each event to /api/state (Upstash Redis). With no API
// (opened from disk, GitHub Pages) everything keeps working from localStorage.
// Relies on globals from the main script (EVENT, EVENTS, completions, ...).

const PASS_KEY = 'edit-passcode';
const SB_KEY = 'sidebar-open';
const DIRTY_KEY = LS + 'dirty'; // edits on this device not yet saved to the cloud
const shell = { mode: 'connecting', locked: true, saving: false, timer: null, error: '', savedAt: null };

// ── API ──
function shellPass() {
  return localStorage.getItem(PASS_KEY) || '';
}
async function api(path, opts = {}) {
  const res = await fetch('/api/' + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(shellPass() ? { 'x-edit-passcode': shellPass() } : {}),
    },
  });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json() : null;
  if (!res.ok || !isJson) {
    if (res.status === 401) {
      localStorage.removeItem(PASS_KEY);
      shell.locked = true;
    }
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = isJson ? res.status : 404; // non-JSON means there's no API here
    throw err;
  }
  return body;
}

// ── Event state ──
function eventState() {
  return {
    completions,
    positions,
    customWorkouts,
    deletedSessions: [...deletedSessions],
    projections,
  };
}
function writeLocalState(prefix, st) {
  localStorage.setItem(prefix + 'completions', JSON.stringify(st.completions || {}));
  localStorage.setItem(prefix + 'positions', JSON.stringify(st.positions || {}));
  localStorage.setItem(prefix + 'custom', JSON.stringify(st.customWorkouts || {}));
  localStorage.setItem(prefix + 'deleted', JSON.stringify(st.deletedSessions || []));
  if (st.projections) localStorage.setItem(prefix + 'projections', JSON.stringify(st.projections));
}
function applyEventState(st) {
  completions = st.completions || {};
  positions = st.positions || {};
  customWorkouts = st.customWorkouts || {};
  deletedSessions = new Set(st.deletedSessions || []);
  projections = st.projections || JSON.parse(JSON.stringify(PROJ_DEFAULTS));
  writeLocalState(LS, st);
  renderStats();
  renderTodayTomorrow();
  renderCalendar();
  renderProjections();
  renderStickyNav();
  maybeRefreshChart();
}
function saveEventsLocal() {
  localStorage.setItem('events', JSON.stringify(EVENTS));
}

// ── Sync ──
window.cloudQueueSync = () => {
  localStorage.setItem(DIRTY_KEY, '1');
  if (shell.mode === 'cloud' && !shell.locked) {
    clearTimeout(shell.timer);
    shell.timer = setTimeout(pushState, 800);
  }
  renderSyncStatus();
};
async function pushState() {
  clearTimeout(shell.timer);
  shell.timer = null;
  shell.saving = true;
  renderSyncStatus();
  try {
    await api('state?event=' + encodeURIComponent(EVENT.id), {
      method: 'PUT',
      body: JSON.stringify({ state: eventState() }),
    });
    localStorage.removeItem(DIRTY_KEY);
    shell.savedAt = new Date();
    shell.error = '';
  } catch (e) {
    shell.error = e.message;
  } finally {
    shell.saving = false;
    renderSyncStatus();
  }
}
async function pushEvents() {
  await api('state', { method: 'PUT', body: JSON.stringify({ events: EVENTS }) });
}
// Don't lose a queued save when the tab closes
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || !shell.timer) return;
  clearTimeout(shell.timer);
  shell.timer = null;
  fetch('/api/state?event=' + encodeURIComponent(EVENT.id), {
    method: 'PUT',
    keepalive: true,
    headers: { 'content-type': 'application/json', 'x-edit-passcode': shellPass() },
    body: JSON.stringify({ state: eventState() }),
  });
});

function renderSyncStatus() {
  const el = document.getElementById('sb-sync');
  const dot = document.getElementById('sync-dot');
  const btn = document.getElementById('sb-lock-btn');
  const dirty = !!localStorage.getItem(DIRTY_KEY);
  let text, cls;
  if (shell.mode === 'connecting') [text, cls] = ['Connecting…', ''];
  else if (shell.mode === 'local') [text, cls] = ['Saved on this device only (no cloud here)', ''];
  else if (shell.mode === 'error') [text, cls] = ['Cloud unavailable: ' + shell.error, 'error'];
  else if (shell.locked) [text, cls] = [dirty ? 'View only · changes on this device are not saved — unlock to save' : 'View only · unlock to edit', dirty ? 'pending' : ''];
  else if (shell.saving || shell.timer) [text, cls] = ['Saving…', 'pending'];
  else if (shell.error) [text, cls] = ['Save failed: ' + shell.error, 'error'];
  else
    [text, cls] = [
      'Saved to cloud' + (shell.savedAt ? ' · ' + shell.savedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''),
      'saved',
    ];
  if (el) el.textContent = text;
  if (dot) dot.className = 'sync-dot ' + cls;
  if (btn) {
    btn.style.display = shell.mode === 'cloud' ? '' : 'none';
    btn.innerHTML = shell.locked ? '&#x1F512; Unlock' : '&#x1F513; Lock';
  }
}

async function bootShell() {
  renderSidebar();
  renderSyncStatus();
  if (location.protocol === 'file:') {
    shell.mode = 'local';
    return renderSyncStatus();
  }
  let remote;
  try {
    remote = await api('state');
  } catch (e) {
    shell.mode = e.status === 404 || !e.status ? 'local' : 'error';
    shell.error = e.message;
    return renderSyncStatus();
  }
  shell.mode = 'cloud';
  if (shellPass()) {
    try {
      await api('auth', { method: 'POST', body: JSON.stringify({ passcode: shellPass() }) });
      shell.locked = false;
    } catch (e) {}
  }
  if (remote.events && remote.events.length) {
    const mine = JSON.stringify(EVENTS.find((e) => e.id === EVENT.id));
    EVENTS = remote.events;
    saveEventsLocal();
    renderSidebar();
    const theirs = EVENTS.find((e) => e.id === EVENT.id);
    // This event was edited elsewhere (dates/type change the whole layout)
    if (theirs && JSON.stringify(theirs) !== mine) return location.reload();
    // A link to an event this device hadn't heard of yet
    const linked = (location.hash.match(/event=([^&]+)/) || [])[1];
    if (linked && decodeURIComponent(linked) !== EVENT.id && EVENTS.some((e) => e.id === decodeURIComponent(linked)))
      return location.reload();
  } else if (!shell.locked) {
    await pushEvents().catch(() => {});
  }
  try {
    const doc = await api('state?event=' + encodeURIComponent(EVENT.id));
    if (localStorage.getItem(DIRTY_KEY)) {
      // Unsynced edits made on this device win over the cloud copy
      if (!shell.locked) await pushState();
    } else if (doc.state) applyEventState(doc.state);
  } catch (e) {
    shell.error = e.message;
  }
  renderSyncStatus();
}

// ── Passcode lock ──
function unlock() {
  return new Promise((resolve) => {
    const m = shellModal(
      'Unlock editing',
      `<p class="shell-msg">Enter the edit passcode (the <code>EDIT_PASSCODE</code> set in Vercel). It's remembered on this device.</p>
       <input class="proj-inp" id="sh-pass" type="password" autocomplete="current-password" style="margin-top:12px" />
       <div class="shell-err" id="sh-err"></div>`,
      [
        { label: 'Cancel', onClick: () => (m.close(), resolve(false)) },
        {
          label: 'Unlock',
          primary: true,
          onClick: async () => {
            const pass = document.getElementById('sh-pass').value;
            try {
              await api('auth', { method: 'POST', body: JSON.stringify({ passcode: pass }) });
              localStorage.setItem(PASS_KEY, pass);
              shell.locked = false;
              shell.error = '';
              m.close();
              await afterUnlock();
              resolve(true);
            } catch (e) {
              document.getElementById('sh-err').textContent =
                e.status === 401 ? 'Wrong passcode' : e.message;
            }
          },
        },
      ],
    );
    const inp = document.getElementById('sh-pass');
    inp.focus();
    inp.addEventListener('keydown', (e) => e.key === 'Enter' && m.root.querySelector('.log-btn').click());
  });
}
async function afterUnlock() {
  renderSyncStatus();
  try {
    const remote = await api('state');
    if (!remote.events || !remote.events.length) await pushEvents();
  } catch (e) {}
  if (localStorage.getItem(DIRTY_KEY)) await pushState();
}
function toggleLock() {
  if (shell.locked) return unlock();
  localStorage.removeItem(PASS_KEY);
  shell.locked = true;
  renderSyncStatus();
}
// Resolves true when edits can be saved (or there's no cloud to save to)
async function ensureEditable() {
  if (shell.mode !== 'cloud' || !shell.locked) return true;
  return unlock();
}

// ── Small modal helper (reuses the projection modal styles) ──
function shellModal(title, bodyHTML, actions) {
  const root = document.createElement('div');
  root.className = 'proj-modal-overlay';
  root.innerHTML = `<div class="proj-modal" style="width:min(420px,92vw)">
    <div class="proj-modal-hdr"><div style="font-family:var(--oswald);font-size:21px;font-weight:700;letter-spacing:0.04em">${esc(title)}</div>
    <button class="sb-close" aria-label="Close">&#x2715;</button></div>
    <div class="proj-modal-body">${bodyHTML}</div>
    <div class="proj-modal-actions"></div></div>`;
  const close = () => root.remove();
  root.querySelector('.sb-close').onclick = close;
  root.addEventListener('click', (e) => e.target === root && close());
  const bar = root.querySelector('.proj-modal-actions');
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = a.primary ? 'log-btn' : 'proj-update-btn';
    if (a.primary) b.style.marginLeft = 'auto';
    if (a.danger) b.style.color = 'var(--run)';
    b.textContent = a.label;
    b.onclick = a.onClick;
    bar.appendChild(b);
  });
  document.body.appendChild(root);
  return { root, close };
}

// ── Sidebar ──
function toggleSidebar(open) {
  const on = open != null ? open : !document.body.classList.contains('sb-open');
  document.body.classList.toggle('sb-open', on);
  localStorage.setItem(SB_KEY, on ? '1' : '');
}
function renderSidebar() {
  const today = localDate(0);
  const sorted = [...EVENTS].sort((a, b) => (a.raceDate < b.raceDate ? -1 : 1));
  const upcoming = sorted.filter((e) => e.raceDate >= today);
  const past = sorted.filter((e) => e.raceDate < today).reverse();
  const item = (e) => {
    const t = EVENT_TYPES[e.type] || EVENT_TYPES.other;
    const meta = `${fmtEventDate(e.raceDate, { month: 'short', day: 'numeric', year: 'numeric' })} · ${t.label}`;
    return `<div class="sb-item${e.id === EVENT.id ? ' active' : ''}" onclick="switchEvent('${esc(e.id)}')">
      <div class="sb-item-main"><div class="sb-item-name">${esc(e.name)}</div><div class="sb-item-meta">${esc(meta)}</div></div>
      <button class="sb-edit" title="Edit event" onclick="event.stopPropagation();openEventModal('${esc(e.id)}')">&#x270E;</button>
    </div>`;
  };
  document.getElementById('sb-list').innerHTML =
    (upcoming.length ? '<div class="sb-group">Upcoming</div>' + upcoming.map(item).join('') : '') +
    (past.length ? '<div class="sb-group">Past</div>' + past.map(item).join('') : '');
}
function switchEvent(id) {
  if (id === EVENT.id) return toggleSidebar(false);
  localStorage.setItem('active-event', id);
  location.hash = 'event=' + encodeURIComponent(id);
  location.reload();
}

// ── Add / edit events ──
function slugify(str) {
  return (
    String(str)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'event'
  );
}
function openEventModal(id) {
  const ev = id ? EVENTS.find((e) => e.id === id) : null;
  // IMFL's dates and type are baked into its coached plan
  const fixed = ev && ev.id === 'imfl-2026';
  const v = ev || { name: '', type: 'full', raceDate: '', startDate: '', location: '', goal: '' };
  const groups = [...new Set(Object.values(EVENT_TYPES).map((t) => t.group))];
  const typeOpts = groups
    .map(
      (g) =>
        `<optgroup label="${esc(g)}">` +
        Object.entries(EVENT_TYPES)
          .filter(([, t]) => t.group === g)
          .map(([k, t]) => `<option value="${k}"${k === v.type ? ' selected' : ''}>${esc(t.label)}</option>`)
          .join('') +
        '</optgroup>',
    )
    .join('');
  const m = shellModal(
    ev ? 'Edit event' : 'New event',
    `<div class="ev-form">
      <label class="wide">Name<input class="proj-inp" id="ev-name" value="${esc(v.name)}" placeholder="IRONMAN Musselman 2027" /></label>
      <label>Type<select class="proj-inp" id="ev-type"${fixed ? ' disabled' : ''}>${typeOpts}</select></label>
      <label>Race date<input class="proj-inp" id="ev-race" type="date" value="${esc(v.raceDate)}"${fixed ? ' disabled' : ''} /></label>
      <label>Training starts<input class="proj-inp" id="ev-start" type="date" value="${esc(v.startDate)}"${fixed ? ' disabled' : ''} /></label>
      <label>Location<input class="proj-inp" id="ev-loc" value="${esc(v.location || '')}" placeholder="Geneva, NY" /></label>
      <label class="wide">Goal<input class="proj-inp" id="ev-goal" value="${esc(v.goal || '')}" placeholder="Sub-12:00:00" /></label>
    </div>
    <div class="shell-err" id="ev-err"></div>`,
    [
      ...(ev && !fixed ? [{ label: 'Delete', danger: true, onClick: () => deleteEvent(ev, m) }] : []),
      { label: 'Cancel', onClick: () => m.close() },
      { label: ev ? 'Save' : 'Create', primary: true, onClick: () => saveEvent(ev, m) },
    ],
  );
  // Suggest a start date from the race date until the user picks one
  const startEl = document.getElementById('ev-start');
  let startTouched = !!v.startDate;
  startEl.addEventListener('input', () => (startTouched = true));
  const suggest = () => {
    const race = document.getElementById('ev-race').value;
    if (startTouched || !race) return;
    startEl.value = addDays(race, -7 * (EVENT_TYPES[document.getElementById('ev-type').value] || EVENT_TYPES.other).weeks);
  };
  document.getElementById('ev-race').addEventListener('input', suggest);
  document.getElementById('ev-type').addEventListener('change', suggest);
  document.getElementById('ev-name').focus();
}
async function saveEvent(ev, m) {
  const err = document.getElementById('ev-err');
  const val = (id) => document.getElementById(id).value.trim();
  const next = {
    ...(ev || {}),
    name: val('ev-name'),
    type: val('ev-type'),
    raceDate: val('ev-race'),
    startDate: val('ev-start'),
    location: val('ev-loc'),
    goal: val('ev-goal'),
  };
  if (!next.name) return (err.textContent = 'Give the event a name');
  if (!next.raceDate || !next.startDate) return (err.textContent = 'Race date and training start are required');
  if (next.startDate >= next.raceDate) return (err.textContent = 'Training has to start before race day');
  if (!(await ensureEditable())) return;
  if (!ev) {
    let id = slugify(next.name),
      n = 2;
    while (EVENTS.some((e) => e.id === id)) id = slugify(next.name) + '-' + n++;
    next.id = id;
  }
  const prevEvents = EVENTS;
  EVENTS = ev ? EVENTS.map((e) => (e.id === ev.id ? next : e)) : [...EVENTS, next];
  try {
    if (shell.mode === 'cloud') await pushEvents();
  } catch (e) {
    EVENTS = prevEvents;
    return (err.textContent = 'Could not save: ' + e.message);
  }
  saveEventsLocal();
  m.close();
  if (!ev) return switchEvent(next.id);
  if (ev.id === EVENT.id) location.reload();
  else renderSidebar();
}
async function deleteEvent(ev, m) {
  if (!confirm(`Delete "${ev.name}" and all of its training data? This can't be undone.`)) return;
  if (!(await ensureEditable())) return;
  const prevEvents = EVENTS;
  EVENTS = EVENTS.filter((e) => e.id !== ev.id);
  try {
    if (shell.mode === 'cloud') {
      await pushEvents();
      await api('state?event=' + encodeURIComponent(ev.id), { method: 'DELETE' });
    }
  } catch (e) {
    EVENTS = prevEvents;
    return (document.getElementById('ev-err').textContent = 'Could not delete: ' + e.message);
  }
  saveEventsLocal();
  const prefix = lsPrefixFor(ev.id);
  Object.keys(localStorage)
    .filter((k) => k.startsWith(prefix))
    .forEach((k) => localStorage.removeItem(k));
  m.close();
  if (ev.id === EVENT.id) switchEvent((EVENTS.find((e) => e.id === 'imfl-2026') || EVENTS[0]).id);
  else renderSidebar();
}

// ── Import (from the Export button's raw-data JSON, or its .zip) ──
function openImportPicker() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,.zip,application/json,application/zip';
  inp.onchange = () => inp.files[0] && importFile(inp.files[0]).catch((e) => alert('Import failed: ' + e.message));
  inp.click();
}
async function readExportFile(file) {
  if (/\.zip$/i.test(file.name) || /zip/.test(file.type)) {
    await exLoadScript(EX_LIBS.jszip);
    const zip = await JSZip.loadAsync(file);
    const files = Object.values(zip.files).filter((f) => !f.dir && /\.json$/i.test(f.name));
    const entry = files.find((f) => /raw-data\.json$/i.test(f.name)) || files[0];
    if (!entry) throw new Error('No .json export found inside the zip');
    return JSON.parse(await entry.async('string'));
  }
  return JSON.parse(await file.text());
}
async function importFile(file) {
  const data = await readExportFile(file);
  const raw = data && data.raw;
  if (!raw || typeof raw.completions !== 'object') throw new Error("This doesn't look like a training export (no raw data)");
  // Exports name their event; the first export format only had race info (IMFL 2026)
  const fileEvent =
    data.event || (data.race && data.race.date === '2026-11-07' ? DEFAULT_EVENTS[0] : null);
  const target = fileEvent ? EVENTS.find((e) => e.id === fileEvent.id) || fileEvent : EVENT;
  const isNew = !EVENTS.some((e) => e.id === target.id);
  const nLogged =
    Object.keys(raw.completions || {}).length +
    Object.values(raw.customWorkouts || {}).filter((w) => w.done).length;
  const when = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString('en-US', { dateStyle: 'medium' }) : 'unknown date';
  const msg =
    `Import ${nLogged} logged sessions (exported ${when}) into "${target.name}"?` +
    (isNew ? '\n\nThis event will be added to your events.' : `\n\nThis replaces all training data currently saved for "${target.name}".`);
  if (!confirm(msg)) return;
  if (!(await ensureEditable())) return;

  const st = {
    completions: raw.completions || {},
    positions: raw.positions || {},
    customWorkouts: raw.customWorkouts || {},
    deletedSessions: raw.deletedSessions || [],
    projections: raw.projections,
  };
  if (isNew) {
    EVENTS = [...EVENTS, target];
    saveEventsLocal();
    if (shell.mode === 'cloud') await pushEvents();
  }
  if (target.id === EVENT.id) {
    applyEventState(st);
    if (shell.mode === 'cloud') {
      await pushState();
      if (shell.error) throw new Error(shell.error);
    }
    alert(`Imported ${nLogged} sessions into "${target.name}".`);
    return;
  }
  writeLocalState(lsPrefixFor(target.id), st);
  if (shell.mode === 'cloud')
    await api('state?event=' + encodeURIComponent(target.id), { method: 'PUT', body: JSON.stringify({ state: st }) });
  switchEvent(target.id);
}

if (localStorage.getItem(SB_KEY)) document.body.classList.add('sb-open');
bootShell();
