// Chat view for R7 Movie Wheel. It sends your question plus your movie history to your own Worker (see worker/),
// which adds your OpenAI key and returns the answer. Nothing here ever sees the key.
(function () {
  var URL_KEY = 'movie-wheel-chat-url', PASS_KEY = 'movie-wheel-chat-pass';
  var host = null, api = null, history = [], busy = false;
  var ui = {};

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function apiBase() { return (window.MW_CONFIG && window.MW_CONFIG.api) || ''; }   // same-site API behind Cloudflare Access: no address or passphrase
  function workerUrl() { return (apiBase() || lsGet(URL_KEY) || (window.MW_CONFIG && window.MW_CONFIG.workerUrl) || '').trim().replace(/\/+$/, ''); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  /* The history the assistant reads, as compact text: a summary, then one line per movie. */
  function buildContext() {
    var movies = api.movies(), gens = api.gens, gname = api.gname, fmtLen = api.fmtLen;
    var watched = movies.filter(function (m) { return m.watched; });
    var todo = movies.filter(function (m) { return !m.watched; });
    var withLen = watched.filter(function (m) { return m.runtime > 0; });
    var mins = withLen.reduce(function (s, m) { return s + m.runtime; }, 0);
    var rated = watched.filter(function (m) { return m.rating > 0; });
    var avg = rated.length ? (rated.reduce(function (s, m) { return s + m.rating; }, 0) / rated.length).toFixed(2) : 'n/a';
    var gc = {};
    watched.forEach(function (m) { gens(m).forEach(function (g) { var n = gname(g); gc[n] = (gc[n] || 0) + 1; }); });
    var top = Object.keys(gc).sort(function (a, b) { return gc[b] - gc[a]; }).slice(0, 12).map(function (n) { return n + ' ' + gc[n]; }).join(', ') || 'none';
    function line(m) {
      var parts = [m.title, m.year || 'year unknown', m.runtime ? fmtLen(m.runtime) : 'length unknown', gens(m).map(gname).join('/') || 'no genres'];
      if (m.watched) parts.push(m.rating ? m.rating + '/5' : 'unrated');
      if (m.review) parts.push('review: ' + m.review);
      return parts.join(' | ');
    }
    var out = [];
    out.push('TODAY: ' + new Date().toISOString().slice(0, 10));
    out.push('SUMMARY');
    out.push('Watched: ' + watched.length + ' films. To watch: ' + todo.length + ' films.');
    out.push('Time watched: ' + Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm, counted from ' + withLen.length + ' films with a known length.');
    out.push('Average rating: ' + avg + ' from ' + rated.length + ' rated films. Favorites (4 or 5 stars): ' + rated.filter(function (m) { return m.rating >= 4; }).length + '.');
    out.push('Genres by number of watched films: ' + top + '.');
    out.push('');
    out.push('WATCHED (title | year | length | genres | stars | review)');
    watched.forEach(function (m) { out.push(line(m)); });
    out.push('');
    out.push('TO WATCH (title | year | length | genres)');
    todo.forEach(function (m) { out.push(line(m)); });
    return out.join('\n');
  }

  var CSS = '' +
    '.ch{display:flex;flex-direction:column;gap:var(--s-4);max-width:760px}' +
    '.ch details{background:var(--surface-1);border:1px solid var(--line);border-radius:var(--r-md);padding:var(--s-3) var(--s-4)}' +
    '.ch summary{cursor:pointer;color:var(--text-2);font-size:12px}' +
    '.ch .set{display:flex;flex-direction:column;gap:var(--s-2);margin-top:var(--s-3)}' +
    '.ch label{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--text-3)}' +
    '.ch .log{display:flex;flex-direction:column;gap:var(--s-3);min-height:160px}' +
    '.ch .msg{max-width:88%;padding:var(--s-3) var(--s-4);border-radius:var(--r-lg);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;font-size:14px}' +
    '.ch .msg.user{align-self:flex-end;background:var(--brass-wash-strong);border:1px solid var(--line-brass)}' +
    '.ch .msg.bot{align-self:flex-start;background:var(--surface-1);border:1px solid var(--line)}' +
    '.ch .msg.err{align-self:flex-start;border:1px solid var(--st-failed);color:var(--danger-text);background:transparent}' +
    '.ch .msg.wait{color:var(--text-3)}' +
    '.ch .ask{display:flex;gap:var(--s-2);align-items:flex-end}' +
    '.ch .ask textarea{flex:1;min-width:0;height:48px;resize:vertical;background:var(--bg);color:var(--text);border:1px solid var(--line-strong);border-radius:var(--r-sm);padding:var(--s-2) var(--s-3);font:400 14px/1.4 var(--ui)}' +
    '.ch .ask textarea:focus{border-color:var(--brass);outline:none}' +
    '.ch .sugg{display:flex;flex-wrap:wrap;gap:6px}';

  function say(text, cls) { var m = el('div', 'msg ' + cls, text); ui.log.append(m); m.scrollIntoView({ block: 'nearest' }); return m; }

  function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    var url = workerUrl(), pass = lsGet(PASS_KEY);
    if (!apiBase()) {
      if (!url) { ui.settings.open = true; say('Add your Worker address in Connection settings first.', 'err'); return; }
      if (!pass) { ui.settings.open = true; say('Add your passphrase in Connection settings first.', 'err'); return; }
    }
    busy = true; ui.send.disabled = true; ui.sugg.hidden = true;
    say(text, 'user'); ui.input.value = '';
    history.push({ role: 'user', content: text });
    var wait = say('Thinking…', 'bot wait');
    var headers = { 'Content-Type': 'application/json' };
    if (!apiBase()) headers['X-Passphrase'] = pass;
    fetch(url + '/chat', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ messages: history.slice(-20), context: buildContext() })
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        wait.remove();
        if (x.ok && x.d.reply) { history.push({ role: 'assistant', content: x.d.reply }); say(x.d.reply, 'bot'); }
        else { history.pop(); say((x.d && x.d.error) || 'The Worker returned an error.', 'err'); }
      })
      .catch(function () {
        wait.remove(); history.pop();
        say(apiBase() ? 'Could not reach the server. If you are signed out, reload the page to sign in again.' : 'Could not reach the Worker. Check the address, and that its ALLOWED_ORIGINS includes ' + location.origin + '.', 'err');
      })
      .then(function () { busy = false; ui.send.disabled = false; ui.input.focus(); });
  }

  function render(h, a) {
    api = a;
    if (host === h && h.firstChild) return;
    host = h; h.innerHTML = '';
    if (!document.getElementById('ch-style')) { var st = el('style'); st.id = 'ch-style'; st.textContent = CSS; document.head.append(st); }
    var root = el('div', 'ch');

    var det = el('details'); ui.settings = det;
    det.append(el('summary', null, 'Connection settings'));
    var set = el('div', 'set');
    var l1 = el('label', null, 'Worker address'); l1.htmlFor = 'chUrl';
    var u = el('input', 'field'); u.id = 'chUrl'; u.type = 'url'; u.placeholder = 'https://r7-movie-wheel-chat.your-name.workers.dev'; u.value = workerUrl();
    u.oninput = function () { lsSet(URL_KEY, u.value.trim()); if (window.MW_SYNC) window.MW_SYNC.sync(); };
    var l2 = el('label', null, 'Passphrase'); l2.htmlFor = 'chPass';
    var p = el('input', 'field'); p.id = 'chPass'; p.type = 'password'; p.autocomplete = 'off'; p.placeholder = 'The APP_PASSPHRASE you set on the Worker'; p.value = lsGet(PASS_KEY);
    p.oninput = function () { lsSet(PASS_KEY, p.value); if (window.MW_SYNC) window.MW_SYNC.sync(); };
    set.append(l1, u, l2, p, el('div', 'fine', 'Saved in this browser only. Your OpenAI key is never in this page; it lives on the Worker.'));
    det.append(set);
    if (!apiBase() && (!workerUrl() || !lsGet(PASS_KEY))) det.open = true;

    ui.log = el('div', 'log'); ui.log.setAttribute('aria-live', 'polite');
    ui.sugg = el('div', 'sugg');
    ['What genre do I watch most?', 'Pick something from my to-watch list for tonight.', 'What are my favorites, and what do they have in common?', 'How many hours of movies have I watched?']
      .forEach(function (q) { var b = el('button', 'gchip', q); b.type = 'button'; b.onclick = function () { send(q); }; ui.sugg.append(b); });

    var form = el('form', 'ask');
    ui.input = el('textarea'); ui.input.placeholder = 'Ask about your movies'; ui.input.setAttribute('aria-label', 'Your question'); ui.input.maxLength = 1000;
    ui.input.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ui.input.value); } };
    ui.send = el('button', 'btn solid', 'Send'); ui.send.type = 'submit';
    var clear = el('button', 'btn quiet', 'Clear'); clear.type = 'button';
    clear.onclick = function () { history = []; ui.log.innerHTML = ''; ui.sugg.hidden = false; };
    form.append(ui.input, ui.send, clear);
    form.onsubmit = function (e) { e.preventDefault(); send(ui.input.value); };

    if (!apiBase()) root.append(det);
    root.append(ui.log, ui.sugg, form, el('div', 'fine', apiBase() ? 'Your list, ratings and reviews are sent to your own site and then to OpenAI with each question.' : 'Your list, ratings and reviews are sent to your own Worker and then to OpenAI with each question.'));
    h.append(root);
  }

  window.MW_CHAT = { render: render, context: function () { return buildContext(); } };
})();
