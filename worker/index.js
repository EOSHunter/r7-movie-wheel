// Backend for R7 Movie Wheel: the chat proxy (keeps your OpenAI key server side) and list sync (keeps your list on every device).
//
//   POST /        { messages, context }        -> { reply }          chat (also POST /chat)
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

const SYSTEM = `You are the movie assistant inside the owner's personal Movie Wheel app.
You can see their full movie history below: what they have watched (with their own star ratings and short reviews), what is still on their to-watch list, genres, lengths and release years.
Answer using that data. Be specific: name titles, give counts and hours, and say when something is not in the data instead of guessing.
You may recommend films from outside the list when asked, but say they are not on the list. When you recommend from the to-watch list, use exactly the titles shown.
Keep answers short and plain. Do not use emoji. Rating scale is 1 to 5 stars; 4 and 5 stars count as favorites.`;

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
  const ctx = typeof context === 'string' ? context.slice(0, MAX_CONTEXT_CHARS) : '';

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.OPENAI_API_KEY },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || 'gpt-4o-mini',
        max_completion_tokens: MAX_REPLY_TOKENS,
        messages: [{ role: 'system', content: SYSTEM + '\n\n--- MOVIE DATA ---\n' + ctx }, ...clean],
      }),
    });
  } catch {
    return json({ error: 'Could not reach OpenAI.' }, 502, origin);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? String(data.error.message).slice(0, 300) : 'OpenAI returned status ' + res.status + '.';
    return json({ error: 'OpenAI said: ' + msg }, 502, origin);
  }
  const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!reply) return json({ error: 'OpenAI sent an empty answer.' }, 502, origin);
  return json({ reply }, 200, origin);
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
