// Chat view for R7 Movie Wheel: "R7", a movie assistant that knows your list, with your past chats on the left (a menu on a phone).
// It sends your question plus your movie history to the chat endpoint, which adds the OpenAI key and returns the answer. Nothing here sees the key.
// Two backends: on r7orbit.io the page and its API are one site behind Cloudflare Access (MW_CONFIG.api), and chats are saved there so every device
// has them; with a Worker instead (README), chats are saved in this browser.
(function () {
  var URL_KEY = 'movie-wheel-chat-url', PASS_KEY = 'movie-wheel-chat-pass', CHATS_KEY = 'movie-wheel-chats-v1';
  var host = null, api = null, busy = false, ui = {};
  var chats = [];            // saved chats, newest first: { id, title, createdAt, updatedAt }
  var cur = null;            // the open chat: { id, title, messages: [{ role, content, ... }], createdAt }
  var pendingDelete = '', deleteTimer = null;

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function apiBase() { return (window.MW_CONFIG && window.MW_CONFIG.api) || ''; }   // same-site API behind Cloudflare Access: no address or passphrase
  function workerUrl() { return (apiBase() || lsGet(URL_KEY) || (window.MW_CONFIG && window.MW_CONFIG.workerUrl) || '').trim().replace(/\/+$/, ''); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function newId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ---------- the history the assistant reads, as compact text: a summary, then one line per movie ---------- */
  function buildContext() {
    var movies = api.movies(), gens = api.gens, gname = api.gname, fmtLen = api.fmtLen;
    var watched = movies.filter(function (m) { return m.watched; });
    var todo = movies.filter(function (m) { return !m.watched; });
    var withLen = watched.filter(function (m) { return m.runtime > 0; });
    var mins = withLen.reduce(function (s, m) { return s + m.runtime; }, 0);
    var rated = watched.filter(function (m) { return m.rating > 0; });
    var avg = rated.length ? (rated.reduce(function (s, m) { return s + m.rating; }, 0) / rated.length).toFixed(2) : 'n/a';
    var gc = {}, who = {};
    watched.forEach(function (m) { gens(m).forEach(function (g) { var n = gname(g); gc[n] = (gc[n] || 0) + 1; }); });
    movies.forEach(function (m) { var w = api.who ? api.who(m) : ''; if (w) who[w] = (who[w] || 0) + 1; });
    var top = Object.keys(gc).sort(function (a, b) { return gc[b] - gc[a]; }).slice(0, 12).map(function (n) { return n + ' ' + gc[n]; }).join(', ') || 'none';
    var adders = Object.keys(who).map(function (n) { return n + ' ' + who[n]; }).join(', ');
    function line(m) {
      var parts = [m.title, m.year || 'year unknown', m.runtime ? fmtLen(m.runtime) : 'length unknown', gens(m).map(gname).join('/') || 'no genres'];
      if (m.watched) parts.push(m.rating ? m.rating + '/5' : 'unrated');
      if (m.review) parts.push('review: ' + m.review);
      var w = api.who ? api.who(m) : '';
      if (w) parts.push('added by ' + w);
      return parts.join(' | ');
    }
    var out = [];
    out.push('TODAY: ' + new Date().toISOString().slice(0, 10));
    out.push('SUMMARY');
    out.push('Watched: ' + watched.length + ' films. To watch: ' + todo.length + ' films.');
    out.push('Time watched: ' + Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm, counted from ' + withLen.length + ' films with a known length.');
    out.push('Average rating: ' + avg + ' from ' + rated.length + ' rated films. Favorites (4 or 5 stars): ' + rated.filter(function (m) { return m.rating >= 4; }).length + '.');
    out.push('Genres by number of watched films: ' + top + '.');
    if (adders) out.push('Movies on the list by who added them: ' + adders + '. ("Earlier" means from before names were tracked; R7 is you, the assistant.)');
    out.push('');
    out.push('WATCHED (title | year | length | genres | stars | review | added by)');
    watched.forEach(function (m) { out.push(line(m)); });
    out.push('');
    out.push('TO WATCH (title | year | length | genres | added by)');
    todo.forEach(function (m) { out.push(line(m)); });
    return out.join('\n');
  }

  /* ---------- text: **bold**, *italic*, `code`, lists, paragraphs ---------- */
  // Inline marks. Everything else is plain text; text is added as text nodes, so nothing the model sends can inject markup.
  function inline(text, parent) {
    var re = /\*\*([^*]+?)\*\*|\*([^*\s][^*]*?)\*|`([^`]+)`/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1] !== undefined) parent.append(el('strong', null, m[1]));
      else if (m[2] !== undefined) parent.append(el('em', null, m[2]));
      else parent.append(el('code', null, m[3]));
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
  }
  // Blocks: paragraphs, numbered and bulleted lists, headings (drawn as a heading line). Anything else reads as a paragraph.
  function markdown(text, into) {
    var lines = String(text).replace(/\r/g, '').split('\n'), i = 0;
    var isOl = function (l) { return /^\s*\d+[.)]\s+/.test(l); };
    var isUl = function (l) { return /^\s*[-*•]\s+/.test(l); };
    var isHead = function (l) { return /^\s*#{1,6}\s+/.test(l); };
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (isHead(line)) { var h = el('div', 'h'); inline(line.replace(/^\s*#{1,6}\s+/, ''), h); into.append(h); i++; continue; }
      if (isOl(line) || isUl(line)) {
        var ordered = isOl(line), list = el(ordered ? 'ol' : 'ul');
        while (i < lines.length && (ordered ? isOl(lines[i]) : isUl(lines[i]))) {
          var li = el('li'); inline(lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/, ''), li); list.append(li); i++;
        }
        into.append(list); continue;
      }
      var p = el('p'), first = true;
      while (i < lines.length && lines[i].trim() && !isHead(lines[i]) && !isOl(lines[i]) && !isUl(lines[i])) {
        if (!first) p.append(document.createElement('br'));
        inline(lines[i], p); first = false; i++;
      }
      into.append(p);
    }
  }

  /* ---------- saving chats ---------- */
  function http(method, path, body) {
    return fetch(apiBase() + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw d; return d; }); });
  }
  function localChats() { try { return JSON.parse(lsGet(CHATS_KEY) || '{}') || {}; } catch (e) { return {}; } }
  var store = {
    list: function () {
      if (apiBase()) return http('GET', '/chats').then(function (d) { return d.chats || []; });
      var all = localChats();
      return Promise.resolve(Object.keys(all).map(function (k) { var c = all[k]; return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt }; })
        .sort(function (a, b) { return b.updatedAt - a.updatedAt; }));
    },
    load: function (id) {
      if (apiBase()) return http('GET', '/chats?id=' + encodeURIComponent(id)).then(function (d) { return d.chat; });
      var c = localChats()[id]; return c ? Promise.resolve(c) : Promise.reject({});
    },
    save: function (chat) {
      if (apiBase()) return http('PUT', '/chats', { id: chat.id, title: chat.title, messages: chat.messages }).then(function (d) { return d.chat; });
      var all = localChats(), now = Date.now();
      all[chat.id] = { id: chat.id, title: chat.title, messages: chat.messages, createdAt: chat.createdAt || now, updatedAt: now };
      lsSet(CHATS_KEY, JSON.stringify(all));
      return Promise.resolve({ id: chat.id, title: chat.title, createdAt: all[chat.id].createdAt, updatedAt: now });
    },
    remove: function (id) {
      if (apiBase()) return http('DELETE', '/chats?id=' + encodeURIComponent(id));
      var all = localChats(); delete all[id]; lsSet(CHATS_KEY, JSON.stringify(all)); return Promise.resolve({});
    }
  };

  var CSS = '' +
    '.ch{display:grid;grid-template-columns:268px minmax(0,1fr);gap:var(--s-4);height:calc(100dvh - 210px);min-height:460px;max-width:1040px}' +
    '.ch .side{display:flex;flex-direction:column;gap:var(--s-3);min-height:0;background:var(--surface-1);border:1px solid var(--line);border-radius:var(--r-lg);padding:var(--s-3)}' +
    '.ch .side .newc{width:100%;height:40px}' +
    '.ch .hist{flex:1;min-height:0;overflow-y:auto;display:block;list-style:none;margin:0;padding:0;border:0;border-radius:0;max-height:none;background:transparent}' +
    '.ch .hist li{display:block;padding:0;min-height:0;border:0;background:transparent}' +
    '.ch .hist li+li{border-top:0}' +
    '.ch .hist li:hover{background:transparent}' +
    '.ch .grp{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--text-3);padding:var(--s-3) var(--s-2) var(--s-1)}' +
    '.ch .hi{display:flex;align-items:center;gap:var(--s-1);border-radius:var(--r-sm)}' +
    '.ch .hi:hover,.ch .hi.on{background:var(--surface-3)}' +
    '.ch .hi .open{flex:1;min-width:0;text-align:left;background:transparent;border:0;color:var(--text-2);font:400 13px/1.3 var(--ui);padding:10px var(--s-2);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-height:40px}' +
    '.ch .hi.on .open{color:var(--brass-bright)}' +
    '.ch .hi .del{flex:none;background:transparent;border:1px solid transparent;color:var(--text-3);border-radius:var(--r-sm);min-width:40px;min-height:40px;font:400 16px var(--ui);cursor:pointer;opacity:0}' +
    '.ch .hi:hover .del,.ch .hi:focus-within .del,.ch .hi.on .del,.ch .hi .del.ask{opacity:1}' +
    '.ch .hi .del.ask{color:var(--danger-text);border-color:var(--st-failed);font-size:12px;padding:0 var(--s-2)}' +
    '.ch .none2{padding:var(--s-3) var(--s-2);color:var(--text-3);font-size:12px}' +
    '.ch .conv{display:flex;flex-direction:column;gap:var(--s-3);min-width:0;min-height:0;background:var(--surface-1);border:1px solid var(--line);border-radius:var(--r-lg);padding:var(--s-3) var(--s-4) var(--s-4)}' +
    '.ch .bar{display:flex;align-items:center;gap:var(--s-2);min-height:36px}' +
    '.ch .bar .ttl{flex:1;min-width:0;font:500 20px/1.2 var(--display);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.ch .bar .menu{display:none;height:40px;min-width:40px}' +
    '.ch details{background:var(--bg);border:1px solid var(--line);border-radius:var(--r-md);padding:var(--s-3) var(--s-4)}' +
    '.ch summary{cursor:pointer;color:var(--text-2);font-size:12px}' +
    '.ch .set{display:flex;flex-direction:column;gap:var(--s-2);margin-top:var(--s-3)}' +
    '.ch label{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--text-3)}' +
    '.ch .log{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:var(--s-3);padding-right:2px}' +
    '.ch .msg{max-width:min(88%,640px);padding:var(--s-3) var(--s-4);border-radius:var(--r-lg);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;font-size:15px}' +
    '.ch .msg.user{align-self:flex-end;background:var(--brass-wash-strong);border:1px solid var(--line-brass)}' +
    '.ch .msg.bot{align-self:flex-start;background:var(--bg);border:1px solid var(--line);white-space:normal;display:flex;flex-direction:column;gap:var(--s-2)}' +
    '.ch .msg.bot .who{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--brass)}' +
    '.ch .msg.bot .body{display:flex;flex-direction:column;gap:var(--s-2)}' +
    '.ch .msg.bot p{margin:0}' +
    '.ch .msg.bot strong{color:var(--brass-bright);font-weight:600}' +
    '.ch .msg.bot em{font-style:italic;color:var(--text)}' +
    '.ch .msg.bot code{font:400 12px var(--mono);color:var(--brass-bright);background:var(--surface-3);padding:1px 5px;border-radius:var(--r-sm)}' +
    '.ch .msg.bot ol,.ch .msg.bot ul{margin:0;padding:0 0 0 1.4em;display:block;border:0;border-radius:0;overflow:visible;max-height:none;background:transparent}' +
    '.ch .msg.bot ol{list-style:decimal}' +
    '.ch .msg.bot ul{list-style:disc}' +
    '.ch .msg.bot li{display:list-item;min-height:0;padding:0 0 var(--s-1) 2px;border:0;background:transparent}' +
    '.ch .msg.bot li:last-child{padding-bottom:0}' +
    '.ch .msg.bot li:hover{background:transparent}' +
    '.ch .msg.bot li::marker{color:var(--brass-dim)}' +
    '.ch .msg.bot .h{font:500 18px/1.2 var(--display);color:var(--text)}' +
    '.ch .msg.err{align-self:flex-start;border:1px solid var(--st-failed);color:var(--danger-text);background:transparent}' +
    '.ch .msg.wait{color:var(--text-3)}' +
    '.ch .note{align-self:flex-start;max-width:min(88%,640px);display:flex;flex-wrap:wrap;align-items:center;gap:var(--s-2) var(--s-3);padding:var(--s-3) var(--s-4);border-radius:var(--r-md);background:var(--brass-wash);border:1px solid var(--line-brass);font-size:14px;line-height:1.45}' +
    '.ch .note .nt{flex:1 1 220px;min-width:0;overflow-wrap:anywhere}' +
    '.ch .note strong{color:var(--brass-bright);font-weight:600}' +
    '.ch .note .btn{height:40px}' +
    '.ch .ask{display:flex;gap:var(--s-2);align-items:stretch}' +
    '.ch .ask textarea{flex:1;min-width:0;height:48px;box-sizing:border-box;resize:none;background:var(--bg);color:var(--text);border:1px solid var(--line-strong);border-radius:var(--r-md);padding:var(--s-3);font:400 16px/1.4 var(--ui)}' +
    '.ch .ask textarea:focus{border-color:var(--brass);outline:none}' +
    '.ch .ask .btn{height:48px;box-sizing:border-box}' +
    '.ch .sugg{display:flex;flex-wrap:wrap;gap:var(--s-2)}' +
    '.ch .sugg .gchip{height:auto;min-height:36px;padding:6px 12px;text-align:left;font-size:12px;line-height:1.3}' +
    '.ch .savestate{font-size:11px;color:var(--text-3)}' +
    '.ch .fu{align-self:flex-start;max-width:min(94%,640px);display:flex;flex-wrap:wrap;gap:var(--s-2)}' +
    '.ch .fu .gchip{height:auto;min-height:40px;padding:8px 14px;text-align:left;font-size:13px;line-height:1.3;color:var(--text);border-color:var(--line-brass);background:var(--brass-wash)}' +
    '.ch .fu .gchip:hover{background:var(--brass-wash-strong)}' +
    '.ch .scrim{display:none}' +
    '@media(max-width:820px){' +
      '.ch{grid-template-columns:minmax(0,1fr);height:calc(100dvh - 150px);min-height:420px}' +
      '.ch .conv{padding:var(--s-3)}' +
      '.ch .bar .menu{display:inline-flex;align-items:center;justify-content:center}' +
      '.ch .side{position:fixed;left:0;top:0;bottom:0;width:min(86vw,320px);z-index:60;border-radius:0 var(--r-lg) var(--r-lg) 0;padding:calc(var(--s-4) + env(safe-area-inset-top,0px)) var(--s-3) calc(var(--s-4) + env(safe-area-inset-bottom,0px));transform:translateX(-102%);transition:transform 240ms var(--ease);box-shadow:0 18px 50px rgba(0,0,0,.55)}' +
      '.ch.open .side{transform:none}' +
      '.ch .scrim{position:fixed;inset:0;z-index:50;background:var(--scrim);border:0;padding:0}' +
      '.ch.open .scrim{display:block}' +
      '.ch .msg,.ch .note{max-width:94%}' +
      '.ch .hi .del{opacity:1}' +
    '}';

  /* ---------- the conversation ---------- */
  function scrollDown() { ui.log.scrollTop = ui.log.scrollHeight; }

  function addBot(text) {
    var m = el('div', 'msg bot'), body = el('div', 'body');
    m.append(el('span', 'who', 'R7'), body); markdown(text, body);
    ui.log.append(m); scrollDown(); return m;
  }
  function addUser(text) { var m = el('div', 'msg user', text); ui.log.append(m); scrollDown(); return m; }
  function addError(text) { var m = el('div', 'msg err', text); ui.log.append(m); scrollDown(); return m; }

  // What R7 did to the list, kept in the chat so the Undo still works after a reload.
  function addNote(msg) {
    var box = el('div', 'note'), text = el('div', 'nt');
    var names = function (arr) { arr.forEach(function (t, i) { if (i) text.append(', '); text.append(el('strong', null, t)); }); };
    if (msg.undone) { text.append('Undone. Removed '); names(msg.titles || []); text.append(' from your list.'); }
    else if ((msg.titles || []).length) {
      text.append('Added to your to-watch list: '); names(msg.titles); text.append('.');
      if ((msg.skipped || []).length) { text.append(' Already on your list: '); names(msg.skipped); text.append('.'); }
    } else { text.append('Nothing new to add. Already on your list: '); names(msg.skipped || []); text.append('.'); }
    box.append(text);
    if (!msg.undone && (msg.ids || []).length && api.removeMovies) {
      var undo = el('button', 'btn', 'Undo'); undo.type = 'button';
      undo.onclick = function () { api.removeMovies(msg.ids); msg.undone = true; var fresh = addNote(msg); box.replaceWith(fresh); persist(); };
      box.append(undo);
    }
    if (box.parentNode === null) { ui.log.append(box); scrollDown(); }
    return box;
  }

  // Suggested next messages under R7's latest reply (a next step, a recommendation, a related question). Tap one to send it.
  function clearFollowups() { var f = ui.log.querySelector('.fu'); if (f) f.remove(); }
  function drawFollowups() {
    clearFollowups();
    var i = cur.messages.length - 1;
    while (i >= 0 && cur.messages[i].role === 'note') i--;
    var m = cur.messages[i];
    if (!m || m.role !== 'assistant' || !m.followups || !m.followups.length) return;
    var row = el('div', 'fu'); row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Suggested replies');
    m.followups.forEach(function (q) { var b = el('button', 'gchip', q); b.type = 'button'; b.onclick = function () { send(q); }; row.append(b); });
    ui.log.append(row); scrollDown();
  }

  function renderMessage(m) { if (m.role === 'user') addUser(m.content); else if (m.role === 'assistant') addBot(m.content); else if (m.role === 'note') addNote(m); }

  function greeting() { return addBot("**I'm R7**, your movie assistant. What do you want to chat about?"); }

  function drawLog() {
    ui.log.innerHTML = '';
    if (!cur.messages.length) greeting(); else cur.messages.forEach(renderMessage);
    ui.sugg.hidden = cur.messages.length > 0;
    ui.title.textContent = cur.title || 'New chat';
    drawFollowups();
    scrollDown();
  }

  function shortTitle(text) { var t = text.replace(/\s+/g, ' ').trim(); return t.length > 48 ? t.slice(0, 47).trimEnd() + '…' : t; }

  function persist() {
    if (!cur.messages.length) return;
    ui.state.textContent = '';
    store.save(cur).then(function (c) {
      var i = chats.findIndex(function (x) { return x.id === c.id; });
      if (i >= 0) chats.splice(i, 1);
      chats.unshift(c); drawHistory();
    }).catch(function (e) {
      ui.state.textContent = e && e.error ? e.error : 'This chat could not be saved. Check your connection.';
    });
  }

  function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    var url = workerUrl(), pass = lsGet(PASS_KEY);
    if (!apiBase()) {
      if (!url) { ui.settings.open = true; addError('Add your Worker address in Connection settings first.'); return; }
      if (!pass) { ui.settings.open = true; addError('Add your passphrase in Connection settings first.'); return; }
    }
    busy = true; ui.send.disabled = true; ui.sugg.hidden = true; clearFollowups();
    if (!cur.messages.length) { cur.title = shortTitle(text); ui.title.textContent = cur.title; }
    cur.messages.push({ role: 'user', content: text });
    addUser(text); ui.input.value = '';
    var wait = el('div', 'msg bot wait', 'R7 is thinking…'); ui.log.append(wait); scrollDown();
    var thread = cur.messages.filter(function (m) { return m.role === 'user' || m.role === 'assistant'; }).slice(-20).map(function (m) { return { role: m.role, content: m.content }; });
    var headers = { 'Content-Type': 'application/json' };
    if (!apiBase()) headers['X-Passphrase'] = pass;
    fetch(url + '/chat', { method: 'POST', headers: headers, body: JSON.stringify({ messages: thread, context: buildContext() }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        wait.remove();
        if (x.ok && x.d.reply) {
          var reply = { role: 'assistant', content: x.d.reply };
          if (Array.isArray(x.d.followups) && x.d.followups.length) reply.followups = x.d.followups.slice(0, 3);
          cur.messages.push(reply);
          addBot(x.d.reply);
          (x.d.actions || []).forEach(function (a) {
            if (a && a.type === 'add_movies' && api.addMovies) {
              var res = api.addMovies(a.movies || []);
              var note = { role: 'note', content: '', ids: res.added.map(function (m) { return m.id; }), titles: res.added.map(function (m) { return m.title; }), skipped: res.skipped, undone: false };
              cur.messages.push(note); addNote(note);
            }
          });
          drawFollowups();
          persist();
        } else { cur.messages.pop(); addError((x.d && x.d.error) || 'Something went wrong.'); }
      })
      .catch(function () {
        wait.remove(); cur.messages.pop();
        addError(apiBase() ? 'Could not reach the server. If you are signed out, reload the page to sign in again.' : 'Could not reach the Worker. Check the address, and that its ALLOWED_ORIGINS includes ' + location.origin + '.');
      })
      .then(function () { busy = false; ui.send.disabled = false; ui.input.focus(); });
  }

  /* ---------- the history list (left; a menu on a phone) ---------- */
  function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function groupOf(t) {
    var today = dayStart(new Date()), day = 24 * 3600 * 1000;
    if (t >= today) return 'Today';
    if (t >= today - day) return 'Yesterday';
    if (t >= today - 7 * day) return 'Previous 7 days';
    if (t >= today - 30 * day) return 'Previous 30 days';
    return 'Older';
  }

  function drawHistory() {
    ui.hist.innerHTML = '';
    if (!chats.length) { ui.hist.append(el('div', 'none2', 'Your chats with R7 are saved here.')); return; }
    var last = '';
    chats.forEach(function (c) {
      var g = groupOf(c.updatedAt);
      if (g !== last) { var gl = el('li'); gl.append(el('div', 'grp', g)); ui.hist.append(gl); last = g; }
      var li = el('li'), row = el('div', 'hi' + (cur && cur.id === c.id ? ' on' : ''));
      var open = el('button', 'open', c.title || 'New chat'); open.type = 'button'; open.title = c.title || '';
      if (cur && cur.id === c.id) open.setAttribute('aria-current', 'true');
      open.onclick = function () { openChat(c.id); };
      var del = el('button', 'del', pendingDelete === c.id ? 'Delete?' : '×'); del.type = 'button';
      del.setAttribute('aria-label', (pendingDelete === c.id ? 'Confirm deleting ' : 'Delete ') + (c.title || 'chat'));
      if (pendingDelete === c.id) del.classList.add('ask');
      del.onclick = function () {
        if (pendingDelete !== c.id) { pendingDelete = c.id; clearTimeout(deleteTimer); deleteTimer = setTimeout(function () { pendingDelete = ''; drawHistory(); }, 3500); drawHistory(); return; }
        pendingDelete = ''; clearTimeout(deleteTimer);
        store.remove(c.id).then(function () {
          chats = chats.filter(function (x) { return x.id !== c.id; });
          if (cur && cur.id === c.id) startChat(); else drawHistory();
        }).catch(function () { ui.state.textContent = 'That chat could not be deleted. Check your connection.'; drawHistory(); });
      };
      row.append(open, del); li.append(row); ui.hist.append(li);
    });
  }

  function setDrawer(on) {
    ui.root.classList.toggle('open', on);
    ui.menu.setAttribute('aria-expanded', String(on));
  }

  function startChat() {
    cur = { id: newId(), title: '', messages: [], createdAt: Date.now() };
    pendingDelete = ''; ui.state.textContent = '';
    drawLog(); drawHistory(); setDrawer(false);
    if (!window.matchMedia || !matchMedia('(max-width: 820px)').matches) ui.input.focus();
  }

  function openChat(id) {
    if (busy) return;
    if (cur && cur.id === id) { setDrawer(false); return; }
    store.load(id).then(function (c) {
      cur = { id: c.id, title: c.title, messages: Array.isArray(c.messages) ? c.messages : [], createdAt: c.createdAt };
      pendingDelete = ''; ui.state.textContent = '';
      drawLog(); drawHistory(); setDrawer(false);
    }).catch(function () { ui.state.textContent = 'That chat could not be opened.'; });
  }

  /* ---------- the page ---------- */
  function render(h, a) {
    api = a;
    if (host === h && h.firstChild) { return; }
    host = h; h.innerHTML = '';
    if (!document.getElementById('ch-style')) { var st = el('style'); st.id = 'ch-style'; st.textContent = CSS; document.head.append(st); }

    var root = el('div', 'ch'); ui.root = root;

    // left: history
    var side = el('nav', 'side'); side.setAttribute('aria-label', 'Chat history');
    var nc = el('button', 'btn solid newc', '+ New chat'); nc.type = 'button'; nc.onclick = function () { startChat(); };
    ui.hist = el('ul', 'hist');
    side.append(nc, ui.hist);
    var scrim = el('button', 'scrim'); scrim.type = 'button'; scrim.setAttribute('aria-label', 'Close chat history'); scrim.onclick = function () { setDrawer(false); };

    // right: the conversation
    var main = el('section', 'conv'); main.setAttribute('aria-label', 'Chat with R7');
    var bar = el('div', 'bar');
    ui.menu = el('button', 'btn menu', '☰ History'); ui.menu.type = 'button'; ui.menu.setAttribute('aria-expanded', 'false'); ui.menu.setAttribute('aria-label', 'Show chat history');
    ui.menu.onclick = function () { setDrawer(!root.classList.contains('open')); };
    ui.title = el('div', 'ttl', 'New chat');
    var nc2 = el('button', 'btn quiet menu', '+ New'); nc2.type = 'button'; nc2.onclick = function () { startChat(); };
    bar.append(ui.menu, ui.title, nc2);
    main.append(bar);

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
    if (!apiBase()) { main.append(det); if (!workerUrl() || !lsGet(PASS_KEY)) det.open = true; }

    ui.log = el('div', 'log'); ui.log.setAttribute('aria-live', 'polite');
    ui.sugg = el('div', 'sugg');
    ['What genre do I watch most?', 'Pick something from my to-watch list for tonight.', 'Recommend 3 movies I would like and add them to my list.', 'How many hours of movies have I watched?']
      .forEach(function (q) { var b = el('button', 'gchip', q); b.type = 'button'; b.onclick = function () { send(q); }; ui.sugg.append(b); });

    var form = el('form', 'ask');
    ui.input = el('textarea'); ui.input.placeholder = 'Message R7'; ui.input.setAttribute('aria-label', 'Message R7'); ui.input.maxLength = 1000; ui.input.rows = 1;
    ui.input.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey && !(window.matchMedia && matchMedia('(max-width: 820px)').matches)) { e.preventDefault(); send(ui.input.value); } };
    ui.send = el('button', 'btn solid', 'Send'); ui.send.type = 'submit';
    form.append(ui.input, ui.send);
    form.onsubmit = function (e) { e.preventDefault(); send(ui.input.value); };
    ui.state = el('div', 'savestate'); ui.state.setAttribute('role', 'status');

    main.append(ui.log, ui.sugg, form, ui.state);
    root.append(side, scrim, main);
    h.append(root);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setDrawer(false); });

    startChat();
    store.list().then(function (list) { chats = list; drawHistory(); }).catch(function () { ui.state.textContent = 'Your saved chats could not be loaded.'; });
  }

  window.MW_CHAT = { render: render, context: function () { return buildContext(); }, markdown: markdown };
})();
