// List sync for R7 Movie Wheel. Keeps your list on your Worker (see worker/) so every device shows the same one.
// It uses the same Worker address and passphrase as the chat (Chat > Connection settings).
(function () {
  var URL_KEY = 'movie-wheel-chat-url', PASS_KEY = 'movie-wheel-chat-pass', ST_KEY = 'movie-wheel-sync';
  var api = null, busy = false, again = false, seq = 0, timer = null, st = load();

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function load() {
    try { var s = JSON.parse(localStorage.getItem(ST_KEY) || '{}'); return { savedAt: +s.savedAt || 0, removed: s.removed || {}, dirty: !!s.dirty }; }
    catch (e) { return { savedAt: 0, removed: {}, dirty: false }; }
  }
  function save() { try { localStorage.setItem(ST_KEY, JSON.stringify(st)); } catch (e) {} }
  function base() { return (lsGet(URL_KEY) || (window.MW_CONFIG && window.MW_CONFIG.workerUrl) || '').trim().replace(/\/+$/, ''); }
  function enabled() { return !!base() && !!lsGet(PASS_KEY); }
  function say(t) { if (api && api.status) api.status(t); }

  function req(method, body) {
    return fetch(base() + '/list', {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-Passphrase': lsGet(PASS_KEY) },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); });
  }

  function adopt(d, keepLocal) {
    st.savedAt = d.savedAt; st.removed = d.removed || {};
    if (!keepLocal) api.set(d.list);
    save();
  }

  function sync() {
    if (!api) return Promise.resolve();
    if (!enabled()) { say('Sync is off. Add your Worker address and passphrase under Chat > Connection settings to keep your list on every device.'); return Promise.resolve(); }
    if (busy) { again = true; return Promise.resolve(); }
    busy = true; say('Syncing…');
    var mySeq = seq, p;
    if (st.dirty || !st.savedAt) {
      // The first sync also pushes, so a device's list is never lost; the Worker merges it with what is already stored.
      p = req('PUT', { list: api.get(), removed: st.removed, base: st.savedAt || null }).then(function (x) {
        if (!(x.ok && x.d.list)) throw x;
        var changedMeanwhile = seq !== mySeq;
        adopt(x.d, changedMeanwhile);
        st.dirty = changedMeanwhile; save();
        if (changedMeanwhile) again = true;
      });
    } else {
      p = req('GET').then(function (x) {
        if (!x.ok) throw x;
        if (x.d.list === null) { st.dirty = true; save(); again = true; return; }      // nothing stored yet: push next
        if (seq === mySeq && x.d.savedAt !== st.savedAt) adopt(x.d, false);
      });
    }
    return p.then(function () { say('Synced at ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.'); })
      .catch(function (x) {
        if (x && x.status === 401) say('Sync paused: the passphrase does not match the Worker.');
        else if (x && x.status === 403) say('Sync paused: the Worker does not allow this address. Add ' + location.origin + ' to ALLOWED_ORIGINS and deploy again.');
        else if (x && x.status === 501) say('Sync paused: the Worker has no storage yet. Deploy it again with the MOVIES storage in wrangler.toml.');
        else if (x && x.status === 429) say('Sync paused for a minute: too many requests.');
        else if (x && x.d && x.d.error) say('Sync paused: ' + x.d.error);
        else say('Offline or the Worker is unreachable. Your changes are saved here and will sync later.');
      })
      .then(function () { busy = false; if (again) { again = false; schedule(1500); } });
  }

  function schedule(ms) { clearTimeout(timer); timer = setTimeout(sync, ms == null ? 800 : ms); }

  window.MW_SYNC = {
    start: function (a) {
      api = a;                                         // {get, set, status}
      sync();
      setInterval(sync, 60000);
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') sync(); });
      window.addEventListener('focus', sync);
    },
    changed: function () { seq++; st.dirty = true; save(); if (enabled()) schedule(); },
    removed: function (id) { st.removed[id] = Date.now(); st.dirty = true; save(); },
    sync: function () { schedule(300); },
    enabled: enabled
  };
})();
