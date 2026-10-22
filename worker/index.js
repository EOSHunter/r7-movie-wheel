// Chat proxy for R7 Movie Wheel. It keeps your OpenAI key on the server side so it never reaches the browser.
//
//   POST /   { messages: [{role, content}], context: "<your movie history as text>" }
//   ->       { reply: "..." }
//
// Secrets (set with `wrangler secret put`): OPENAI_API_KEY, APP_PASSPHRASE
// Variables (wrangler.toml):                ALLOWED_ORIGINS, OPENAI_MODEL

const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 4000;
const MAX_CONTEXT_CHARS = 80000;
const MAX_REPLY_TOKENS = 900;

// Best-effort limiter per Worker instance. For a hard limit, add a Cloudflare rate limiting binding (see wrangler.toml).
const hits = new Map();
function tooMany(ip) {
  const now = Date.now(), windowMs = 60_000, limit = 20;
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) hits.clear();
  return recent.length > limit;
}

function sameText(a, b) {          // compare without leaking length-by-timing on the first mismatch
  const enc = new TextEncoder(), x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Passphrase',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(origin ? corsHeaders(origin) : {}) },
  });
}

const SYSTEM = `You are the movie assistant inside the owner's personal Movie Wheel app.
You can see their full movie history below: what they have watched (with their own star ratings and short reviews), what is still on their to-watch list, genres, lengths and release years.
Answer using that data. Be specific: name titles, give counts and hours, and say when something is not in the data instead of guessing.
You may recommend films from outside the list when asked, but say they are not on the list. When you recommend from the to-watch list, use exactly the titles shown.
Keep answers short and plain. Do not use emoji. Rating scale is 1 to 5 stars; 4 and 5 stars count as favorites.`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

    if (request.method === 'OPTIONS') {
      return allowed.includes(origin) ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response(null, { status: 403 });
    }
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, allowed.includes(origin) ? origin : '');
    if (!allowed.includes(origin)) return json({ error: 'This origin is not allowed.' }, 403, '');

    if (!env.OPENAI_API_KEY || !env.APP_PASSPHRASE) return json({ error: 'The Worker is missing its secrets. See the README.' }, 500, origin);
    if (!sameText(request.headers.get('X-Passphrase') || '', env.APP_PASSPHRASE)) return json({ error: 'Wrong passphrase.' }, 401, origin);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (env.RATE ? !(await env.RATE.limit({ key: ip })).success : tooMany(ip)) return json({ error: 'Slow down for a minute.' }, 429, origin);

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
  },
};
