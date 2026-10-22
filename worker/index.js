// Backend for R7 Movie Wheel: the chat proxy (keeps your OpenAI key server side) and list sync (keeps your list on every device).
//
//   POST /        { messages, context }        -> { reply, followups?, actions? }   chat (also POST /chat)
//   GET  /list                                  -> { list, removed, savedAt }   or { list: null }
//   PUT  /list    { list, removed, base }      -> { list, removed, savedAt }   merged result
//
// Secrets (wrangler secret put): OPENAI_API_KEY, APP_PASSPHRASE
// Variables (wrangler.toml):     ALLOWED_ORIGINS, OPENAI_MODEL
// Storage (wrangler.toml):       a KV namespace bound as MOVIES (only needed for list sync)

const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 4000;
const MAX_CONTEXT_CHARS = 80000;
const MAX_REPLY_TOKENS = 900;
const MAX_MOVIES = 3000;
const MAX_BODY_BYTES = 700_000;
const REMOVED_KEEP_MS = 90 * 24 * 3600 * 1000;

// Best-effort limiter per Worker instance. For a hard limit, add a Cloudflare rate limiting binding (see wrangler.toml).
const hits = new Map();
function tooMany(ip) {
  const now = Date.now(), windowMs = 60_000, limit = 60;
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) hits.clear();
  return recent.length > limit;
}

function sameText(a, b) {
  const enc = new TextEncoder(), x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Passphrase',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(origin ? corsHeaders(origin) : {}) },
  });
}

/* ---------- list sync ---------- */

function cleanMovie(x) {
  if (!x || typeof x !== 'object') return null;
  const title = String(x.title || '').trim().slice(0, 120);
  const id = String(x.id || '').slice(0, 64);
  if (!title || !id) return null;
  return {
    id, title, watched: !!x.watched,
    genres: (Array.isArray(x.genres) ? x.genres : []).map((g) => String(g).trim().slice(0, 24)).filter(Boolean).slice(0, 12),
    runtime: Math.max(0, Math.min(999, Math.round(+x.runtime) || 0)),
    year: Math.max(0, Math.min(2100, Math.round(+x.year) || 0)),
    rating: Math.min(5, Math.max(0, Math.round(+x.rating) || 0)),
    review: String(x.review || '').slice(0, 280),
    addedAt: +x.addedAt || 0, watchedAt: +x.watchedAt || 0, updatedAt: +x.updatedAt || 0,
    addedBy: /^[a-z0-9_-]{1,24}$/.test(String(x.addedBy || '')) ? String(x.addedBy) : '',
  };
}
function cleanRemoved(r, now) {
  const out = {};
  if (r && typeof r === 'object') {
    for (const [id, ts] of Object.entries(r).slice(0, 5000)) {
      const t = +ts;
      if (id.length <= 64 && t > 0 && now - t < REMOVED_KEEP_MS) out[id] = t;
    }
  }
  return out;
}

// Merge two copies of the list. A movie is kept from whichever copy changed it last; a removal wins over an older copy of the movie.
export function mergeLists(a, b) {
  const removed = { ...a.removed };
  for (const [id, ts] of Object.entries(b.removed)) removed[id] = Math.max(removed[id] || 0, ts);
  const byId = new Map();
  for (const m of [...a.list, ...b.list]) {
    const cur = byId.get(m.id);
    if (!cur || m.updatedAt >= cur.updatedAt) byId.set(m.id, m);
  }
  const list = [...byId.values()].filter((m) => !(removed[m.id] && removed[m.id] >= m.updatedAt));
  list.sort((x, y) => x.addedAt - y.addedAt);
  return { list, removed };
}

async function handleList(request, env, origin) {
  if (!env.MOVIES) return json({ error: 'List sync is not set up on the Worker yet. See the README (KV storage).' }, 501, origin);
  const current = (await env.MOVIES.get('list', 'json')) || null;
  if (request.method === 'GET') {
    return json(current ? { list: current.list, removed: current.removed || {}, savedAt: current.savedAt } : { list: null }, 200, origin);
  }
  if (request.method !== 'PUT') return json({ error: 'Use GET or PUT.' }, 405, origin);

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: 'That list is too large.' }, 413, origin);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'Send JSON.' }, 400, origin); }
  if (!body || !Array.isArray(body.list) || body.list.length > MAX_MOVIES) return json({ error: 'Send a list of up to ' + MAX_MOVIES + ' movies.' }, 400, origin);

  const now = Date.now();
  const incoming = { list: body.list.map(cleanMovie).filter(Boolean), removed: cleanRemoved(body.removed, now) };
  let next = incoming;
  if (current && body.base !== current.savedAt) {
    next = mergeLists({ list: current.list || [], removed: current.removed || {} }, incoming);   // someone else saved in between
  }
  const doc = { list: next.list, removed: cleanRemoved(next.removed, now), savedAt: now };
  await env.MOVIES.put('list', JSON.stringify(doc));
  return json(doc, 200, origin);
}

/* ---------- chat ---------- */

const SYSTEM = `You are R7, the movie assistant inside the owner's personal Movie Wheel app. If asked your name, say you are R7.
You can see their full movie history below: what they have watched (with their own star ratings and short reviews), what is still on their to-watch list, genres, lengths and release years.
Answer using that data. Be specific: name titles, give counts and hours, and say when something is not in the data instead of guessing.
You may recommend films from outside the list when asked, but say they are not on the list. When you recommend from the to-watch list, use exactly the titles shown.
Keep answers short and plain. Do not use emoji. Rating scale is 1 to 5 stars; 4 and 5 stars count as favorites.
Format with simple Markdown: **bold** for movie titles and key numbers, and a numbered or bulleted list when naming several movies. No tables and no headings.
When asked to recommend movies to add or watch, first check every title against the WATCHED and TO WATCH lists, and never suggest a movie that appears in either one.
You can add movies to the to-watch list with the add_movies tool. Use it only when the user asks you to add movies (or to add what you just recommended). Never add movies on your own, and never add a title that is already on either list. After adding, say in one short sentence which movies you added.
After your answer, add one last line in exactly this form, with nothing after it: [[followups: first | second | third]]
Give 2 or 3 short things the user could say next, written as the user would say them and under 60 characters each: a next step, a recommendation, or a related question. When you have just recommended movies, make one of them ask you to add them to the list. Never mention or explain this line.`;

// What R7 may do to the list. The Worker only passes the request on; the page carries it out (and shows an Undo).
const TOOLS = [{
  type: 'function',
  function: {
    name: 'add_movies',
    description: "Add movies to the user's to-watch list. Only when the user asks you to add movies. Never add a title that is already on the WATCHED or TO WATCH lists.",
    parameters: {
      type: 'object',
      properties: {
        movies: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'The movie title, as it is usually written.' },
              year: { type: 'integer', description: 'The release year, if you are sure of it.' },
            },
            required: ['title'],
          },
        },
      },
      required: ['movies'],
    },
  },
}];

// The movies in an add_movies call, cleaned: up to 10, a title of up to 120 characters, a plausible year.
export function cleanAddMovies(args) {
  let parsed = args;
  if (typeof args === 'string') { try { parsed = JSON.parse(args); } catch { return []; } }
  const list = parsed && parsed.movies;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list.slice(0, 50)) {
    const title = String((m && m.title) || '').trim().slice(0, 120);
    if (!title) continue;
    const year = Math.round(Number(m && m.year));
    out.push(year >= 1880 && year <= 2100 ? { title, year } : { title });
  }
  return out.slice(0, 10);
}

// Takes the "[[followups: a | b | c]]" line off the end of a reply: the reply without it, and up to 3 short follow-up messages.
export function splitFollowups(text) {
  const m = /\[\[\s*followups\s*:([\s\S]*?)\]\]\s*$/i.exec(text);
  if (!m) return { reply: text.replace(/\[\[\s*followups[\s\S]*$/i, '').trimEnd(), followups: [] };
  const followups = m[1].split('|').map((x) => x.replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 80)).filter(Boolean).slice(0, 3);
  return { reply: text.slice(0, m.index).trimEnd(), followups };
}

async function handleChat(request, env, origin) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, origin);
  if (!env.OPENAI_API_KEY) return json({ error: 'The Worker is missing its OpenAI key. See the README.' }, 500, origin);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Send JSON.' }, 400, origin); }
  const { messages, context } = body || {};
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) return json({ error: 'Send between 1 and ' + MAX_MESSAGES + ' messages.' }, 400, origin);
  const clean = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim() || m.content.length > MAX_MESSAGE_CHARS) {
      return json({ error: 'Each message needs a role of user or assistant and text under ' + MAX_MESSAGE_CHARS + ' characters.' }, 400, origin);
    }
    clean.push({ role: m.role, content: m.content });
  }
  if (clean[clean.length - 1].role !== 'user') return json({ error: 'The last message must be from the user.' }, 400, origin);
  const system = { role: 'system', content: SYSTEM + '\n\n--- MOVIE DATA ---\n' + (typeof context === 'string' ? context.slice(0, MAX_CONTEXT_CHARS) : '') };

  const ask = async (payload) => {
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.OPENAI_API_KEY },
        body: JSON.stringify({ model: env.OPENAI_MODEL || 'gpt-4o-mini', max_completion_tokens: MAX_REPLY_TOKENS, ...payload }),
      });
    } catch {
      return { error: json({ error: 'Could not reach OpenAI.' }, 502, origin) };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data && data.error && data.error.message ? String(data.error.message).slice(0, 300) : 'OpenAI returned status ' + res.status + '.';
      return { error: json({ error: 'OpenAI said: ' + msg }, 502, origin) };
    }
    return { data };
  };

  const first = await ask({ messages: [system, ...clean], tools: TOOLS });
  if (first.error) return first.error;
  const message = first.data && first.data.choices && first.data.choices[0] && first.data.choices[0].message;
  const calls = ((message && message.tool_calls) || []).filter((c) => c && c.type === 'function');
  if (!calls.length) {
    const raw = message && message.content;
    if (!raw) return json({ error: 'OpenAI sent an empty answer.' }, 502, origin);
    const { reply, followups } = splitFollowups(raw);
    return json(followups.length ? { reply, followups } : { reply }, 200, origin);
  }

  // R7 asked to add movies. The page does the adding; the model is told it was done and writes the short confirmation.
  const actions = [];
  const results = calls.map((c) => {
    if (!c.function || c.function.name !== 'add_movies') return { role: 'tool', tool_call_id: c.id, content: 'That tool does not exist.' };
    const movies = cleanAddMovies(c.function.arguments);
    if (!movies.length) return { role: 'tool', tool_call_id: c.id, content: 'No valid movies were given, so nothing was added.' };
    actions.push({ type: 'add_movies', movies });
    return { role: 'tool', tool_call_id: c.id, content: 'Done. The app adds them to the to-watch list and skips any title that is already on it.' };
  });
  const names = actions.flatMap((a) => a.movies.map((m) => m.title));
  const second = await ask({ messages: [system, ...clean, { role: 'assistant', content: (message && message.content) || null, tool_calls: calls }, ...results] });
  const text = second.error ? '' : (second.data && second.data.choices && second.data.choices[0] && second.data.choices[0].message && second.data.choices[0].message.content) || '';
  const split = splitFollowups(text);
  const reply = split.reply || (names.length ? "I'll add " + names.join(', ') + ' to your list.' : "I couldn't add anything from that.");
  return json({ reply, ...(split.followups.length ? { followups: split.followups } : {}), ...(actions.length ? { actions } : {}) }, 200, origin);
}

/* ---------- entry ---------- */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

    if (request.method === 'OPTIONS') {
      return allowed.includes(origin) ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response(null, { status: 403 });
    }
    if (!allowed.includes(origin)) return json({ error: 'This origin is not allowed.' }, 403, '');

    if (!env.APP_PASSPHRASE) return json({ error: 'The Worker is missing its passphrase. See the README.' }, 500, origin);
    if (!sameText(request.headers.get('X-Passphrase') || '', env.APP_PASSPHRASE)) return json({ error: 'Wrong passphrase.' }, 401, origin);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (env.RATE ? !(await env.RATE.limit({ key: ip })).success : tooMany(ip)) return json({ error: 'Slow down for a minute.' }, 429, origin);

    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    if (path === '/list') return handleList(request, env, origin);
    if (path === '/' || path === '/chat') return handleChat(request, env, origin);
    return json({ error: 'Not found.' }, 404, origin);
  },
};
