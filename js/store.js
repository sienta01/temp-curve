// Where patients live. Served by the container, they are kept on the server and shared
// between devices; opened as a plain file, they are kept in this browser only.
// View settings always stay on the device.
const Store = (() => {
  'use strict';

  const LOCAL_KEY = 'temp-curve/v2';
  const LOCAL_KEY_V1 = 'temp-curve/v1';
  const PREFS_KEY = 'temp-curve/prefs';
  // Absolute, because fetch refuses relative addresses on a user:password@host page.
  const API = location.origin + location.pathname.replace(/[^/]*$/, '') + 'api/patients';
  const SAVE_DELAY = 400;
  const RETRY_DELAY = 3000;
  const POLL_EVERY = 8000;

  let mode = 'local';
  let patients = [];
  let prefs = {};
  let onStatus = () => {};
  let onRemote = () => {};

  const find = (id) => patients.find((p) => p.id === id);

  // ---- device settings ------------------------------------------------------

  function readJSON(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function loadPrefs() {
    const saved = readJSON(PREFS_KEY) ?? {};
    const rows = (v, fallback) => (Number.isInteger(v) && v > 0 ? v : fallback);
    prefs = {
      activeId: typeof saved.activeId === 'string' ? saved.activeId : '',
      perRow: { 180: rows(saved.perRow?.[180], 7), 60: rows(saved.perRow?.[60], 2) },
      showValues: saved.showValues === true,
    };
  }

  const savePrefs = () => writeJSON(PREFS_KEY, prefs);

  // ---- start ----------------------------------------------------------------

  async function init(handlers) {
    ({ onStatus, onRemote } = handlers);
    loadPrefs();
    if (location.protocol.startsWith('http')) {
      const res = await fetch(API, { cache: 'no-store' });
      if (res.ok) {
        mode = 'server';
        etag = res.headers.get('ETag');
        for (const { rev, patient } of (await res.json()).patients) adopt(patient, rev);
        startSync();
      } else if (res.status !== 404) {
        // Only a plain web server without this API may fall back to browser storage.
        // Doing so on a fault would quietly split the data in two.
        throw new Error(`Server menjawab ${res.status}`);
      }
    }
    if (mode === 'local') loadLocal();
    report();
  }

  // ---- changes made on this device ------------------------------------------

  function add(p) {
    patients.push(p);
    if (mode === 'server') meta.set(p.id, freshMeta(p, 0));
  }

  function changed(p) {
    if (mode === 'local') return saveLocal();
    meta.get(p.id).dirty = true;
    schedule(p.id, SAVE_DELAY);
    report();
  }

  async function remove(id) {
    if (mode === 'server') {
      const m = meta.get(id);
      if (m.saving) await m.saving;
      if (m.rev > 0) {
        const res = await fetch(`${API}/${id}?rev=${m.rev}`, { method: 'DELETE' });
        if (res.status === 409) {
          applyRemote(id, (await res.json()).current, true);
          return false;
        }
        if (!res.ok && res.status !== 404) throw new Error(`Server menjawab ${res.status}`);
      }
      forget(id);
    } else {
      patients = patients.filter((p) => p.id !== id);
      saveLocal();
    }
    report();
    return true;
  }

  // ---- browser storage ------------------------------------------------------

  let localOK = true;

  function loadLocal() {
    const saved = readJSON(LOCAL_KEY) ?? readJSON(LOCAL_KEY_V1);
    patients = Array.isArray(saved?.patients) ? saved.patients.map(Model.cleanPatient) : [];
    if (!prefs.activeId && typeof saved?.activeId === 'string') prefs.activeId = saved.activeId;
    // Another tab saved: pick up its version rather than overwrite it later.
    window.addEventListener('storage', (e) => {
      if (e.key !== LOCAL_KEY || !e.newValue) return;
      patients = (readJSON(LOCAL_KEY)?.patients ?? []).map(Model.cleanPatient);
      onRemote(null);
    });
  }

  function saveLocal() {
    localOK = writeJSON(LOCAL_KEY, { patients });
    if (localOK) localStorage.removeItem(LOCAL_KEY_V1); // superseded; leave no stale copy behind
    report();
  }

  // ---- server sync ----------------------------------------------------------
  // Each patient carries the server's revision number. A save based on an old revision
  // is refused, the newer version is merged in cell by cell, and the save is repeated.

  const meta = new Map(); // id -> { rev, base, dirty, saving, savedAt, timer }
  let etag = null;
  let offline = false;
  let startedSync = false;

  const freshMeta = (p, rev) => ({ rev, base: Model.clone(p), dirty: false, saving: null, savedAt: 0, timer: 0 });

  function adopt(raw, rev) {
    const p = Model.cleanPatient(raw);
    patients.push(p);
    meta.set(p.id, freshMeta(p, rev));
  }

  function forget(id) {
    clearTimeout(meta.get(id)?.timer);
    meta.delete(id);
    patients = patients.filter((p) => p.id !== id);
  }

  function schedule(id, delay) {
    const m = meta.get(id);
    if (!m) return;
    clearTimeout(m.timer);
    m.timer = setTimeout(() => push(id), delay);
  }

  function push(id, { keepalive = false } = {}) {
    const p = find(id);
    const m = meta.get(id);
    if (!p || !m?.dirty || m.saving) return;
    clearTimeout(m.timer);
    m.dirty = false;
    const sent = Model.clone(p);
    const body = JSON.stringify({ rev: m.rev, patient: sent });
    m.saving = (async () => {
      try {
        const res = await fetch(`${API}/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: keepalive && body.length < 60000,
        });
        if (res.ok) {
          m.rev = (await res.json()).rev;
          m.base = sent;
          m.savedAt = Date.now();
        } else if (res.status === 409) {
          m.dirty = true;
          applyRemote(id, (await res.json()).current, true);
        } else {
          throw new Error(`Server menjawab ${res.status}`);
        }
        offline = false;
      } catch (err) {
        console.error(err);
        m.dirty = true;
        offline = true;
      }
      m.saving = null;
      if (m.dirty) schedule(id, offline ? RETRY_DELAY : SAVE_DELAY);
      report();
    })();
    report();
  }

  // Take in another device's version, keeping whatever is still unsaved here.
  function applyRemote(id, remote, force = false) {
    const p = find(id);
    const m = meta.get(id);
    if (!remote) {
      forget(id);
      onRemote(id, 'deleted');
      return;
    }
    if (!p) {
      adopt(remote.patient, remote.rev);
      onRemote(id, 'added');
      return;
    }
    if (remote.rev <= m.rev && !force) return;
    const theirs = Model.cleanPatient(remote.patient);
    const next = m.dirty ? Model.merge(m.base, p, theirs) : theirs;
    for (const k of Object.keys(p)) delete p[k];
    Object.assign(p, Model.clone(next));
    m.base = theirs;
    m.rev = remote.rev;
    onRemote(id, 'changed');
  }

  async function poll() {
    const startedAt = Date.now();
    try {
      const res = await fetch(API, { cache: 'no-store', headers: etag ? { 'If-None-Match': etag } : {} });
      if (res.status !== 304) {
        if (!res.ok) throw new Error(`Server menjawab ${res.status}`);
        const list = (await res.json()).patients;
        etag = res.headers.get('ETag');
        const seen = new Set();
        for (const remote of list) {
          seen.add(remote.patient.id);
          if (!meta.get(remote.patient.id)?.saving) applyRemote(remote.patient.id, remote);
        }
        for (const [id, m] of [...meta]) {
          // Gone from the server, unless it was saved after this answer was prepared.
          if (!seen.has(id) && m.rev > 0 && !m.saving && m.savedAt < startedAt) applyRemote(id, null);
        }
      }
      offline = false;
    } catch {
      offline = true;
    }
    report();
  }

  function startSync() {
    if (startedSync) return;
    startedSync = true;
    setInterval(() => { if (!document.hidden) poll(); }, POLL_EVERY);
    window.addEventListener('focus', poll);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return poll();
      for (const id of meta.keys()) push(id, { keepalive: true });
    });
    window.addEventListener('beforeunload', (e) => {
      if (unsaved()) e.preventDefault();
    });
  }

  const unsaved = () => [...meta.values()].some((m) => m.dirty || m.saving);

  // ---- status ---------------------------------------------------------------

  function report() {
    if (mode === 'local') return onStatus(localOK ? 'local' : 'local-failed');
    if (offline) return onStatus(unsaved() ? 'unsaved' : 'offline');
    onStatus(unsaved() ? 'saving' : 'saved');
  }

  return {
    init, add, changed, remove, find, savePrefs, poll,
    get mode() { return mode; },
    get patients() { return patients; },
    get prefs() { return prefs; },
  };
})();
