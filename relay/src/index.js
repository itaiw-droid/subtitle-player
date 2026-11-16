// Claude relay for Subtitle Player (Cloudflare Worker).
// Keeps the Anthropic API key private, only answers the Subtitle Player site, enforces a daily
// request cap, and lets the owner switch AI on/off for everyone.
//
// Secrets (set in the Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY  – the Anthropic API key
//   ADMIN_TOKEN        – owner passcode for turning AI on/off
// Vars (wrangler.toml): ALLOWED_ORIGINS, DAILY_LIMIT
// KV binding: SETTINGS  (keys: "enabled", "count:<YYYY-MM-DD>")

import Anthropic from '@anthropic-ai/sdk';

const TEXT_MODEL = 'claude-haiku-5-5';   // corrects OCR text + translates with context
const IMAGE_MODEL = 'claude-sonnet-5-5'; // reads lines the OCR couldn't, from the picture

const SYSTEM = [
  'You are a professional subtitler for Israeli TV.',
  'You receive Hebrew subtitle lines that were read from video frames by OCR, so letters may be wrong, missing or swapped',
  '(common: ך/ן, ר/ד, ב/כ, ה/ח, ו/ז, ם/ס, merged or split words).',
  'Restore the intended Hebrew from context and write natural, idiomatic English subtitles.',
  'Translate meaning and tone, not word by word. Keep it as short as subtitles need to be.',
  'A sentence may continue across consecutive lines — translate each line so the lines read naturally in sequence.',
  'Keep names and recurring terms consistent with the earlier lines you are given.',
  'Line breaks inside a line are written as \\n; keep the same number of lines in English where natural.',
].join(' ');

const POLISH_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          hebrew: { type: 'string', description: 'corrected Hebrew' },
          english: { type: 'string' },
          unsure: { type: 'boolean', description: 'true if the OCR text is too garbled to know what it says' },
        },
        required: ['n', 'hebrew', 'english', 'unsure'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const READ_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          hebrew: { type: 'string' },
          english: { type: 'string' },
          not_text: { type: 'boolean', description: 'true if the image has no readable text' },
        },
        required: ['n', 'hebrew', 'english', 'not_text'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

function cors(origin, allowed) {
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const today = () => new Date().toISOString().slice(0, 10);

function contextText(body) {
  const out = [];
  if (body.show) out.push(`Show: ${String(body.show).slice(0, 200)}`);
  if (Array.isArray(body.before) && body.before.length) {
    out.push('Earlier lines (already done):');
    for (const b of body.before.slice(-8)) out.push(`  ${String(b.he).replace(/\n/g, ' / ')}  =>  ${String(b.en || '').replace(/\n/g, ' / ')}`);
  }
  if (Array.isArray(body.after) && body.after.length) {
    out.push('Following lines (raw OCR, context only):');
    for (const a of body.after.slice(0, 4)) out.push(`  ${String(a).replace(/\n/g, ' / ')}`);
  }
  return out.join('\n');
}

function parseJson(msg) {
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined this request'), { status: 422 });
  const block = msg.content.find((b) => b.type === 'text');
  if (!block) throw new Error('No answer');
  return JSON.parse(block.text);
}

async function polish(client, body) {
  const lines = (body.lines || []).slice(0, 25);
  if (!lines.length) return { items: [] };
  const list = lines.map((l) => `[${l.n}] ${String(l.he).slice(0, 400)}`).join('\n');
  const msg = await client.messages.create({
    model: TEXT_MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: POLISH_SCHEMA } },
    messages: [{ role: 'user', content: `${contextText(body)}\n\nOCR lines to fix and translate, in order:\n${list}\n\nReturn every line by its number.` }],
  });
  return parseJson(msg);
}

async function read(client, body) {
  const lines = (body.lines || []).slice(0, 10);
  if (!lines.length) return { items: [] };
  const content = [];
  const ctx = contextText(body);
  if (ctx) content.push({ type: 'text', text: ctx });
  content.push({ type: 'text', text: 'Each image is the bottom of a video frame with a burned-in subtitle. The OCR guess is given too but may be wrong.' });
  for (const l of lines) {
    content.push({ type: 'text', text: `[${l.n}] OCR guess: ${String(l.he || '').slice(0, 300)}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(l.img) } });
  }
  content.push({ type: 'text', text: 'For every image return n, the exact Hebrew (line breaks as \\n) and the English subtitle. If an image has no readable text, set not_text true.' });
  const msg = await client.beta.messages.create({
    model: IMAGE_MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: READ_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  return parseJson(msg);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowedList = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const allowed = allowedList.includes(origin);
    const headers = { ...cors(origin, allowed), 'Content-Type': 'application/json' };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!allowed) return reply({ error: 'Not allowed' }, 403);

    const enabled = (await env.SETTINGS.get('enabled')) !== 'off';
    const limit = Number(env.DAILY_LIMIT || 400);
    const countKey = 'count:' + today();
    const used = Number((await env.SETTINGS.get(countKey)) || 0);

    if (url.pathname === '/status') return reply({ enabled, remaining: Math.max(0, limit - used), configured: !!env.ANTHROPIC_API_KEY });

    if (url.pathname === '/admin' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      if (!env.ADMIN_TOKEN || body.token !== env.ADMIN_TOKEN) return reply({ error: 'Wrong passcode' }, 401);
      if (typeof body.enabled === 'boolean') await env.SETTINGS.put('enabled', body.enabled ? 'on' : 'off');
      return reply({ enabled: typeof body.enabled === 'boolean' ? body.enabled : enabled, remaining: Math.max(0, limit - used) });
    }

    if ((url.pathname === '/polish' || url.pathname === '/read') && req.method === 'POST') {
      if (!enabled) return reply({ error: 'AI is switched off' }, 503);
      if (!env.ANTHROPIC_API_KEY) return reply({ error: 'Relay has no API key yet' }, 503);
      if (used >= limit) return reply({ error: 'Daily AI limit reached' }, 429);
      await env.SETTINGS.put(countKey, String(used + 1), { expirationTtl: 3 * 86400 });
      const body = await req.json().catch(() => ({}));
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
      try {
        const out = url.pathname === '/polish' ? await polish(client, body) : await read(client, body);
        return reply(out);
      } catch (e) {
        if (e instanceof Anthropic.RateLimitError) return reply({ error: 'Claude is busy, try again shortly' }, 429);
        if (e instanceof Anthropic.AuthenticationError) return reply({ error: 'Relay API key is invalid' }, 503);
        if (e instanceof Anthropic.APIError) return reply({ error: `Claude error ${e.status}` }, 502);
        return reply({ error: String(e.message || e).slice(0, 200) }, e.status || 500);
      }
    }
    return reply({ error: 'Not found' }, 404);
  },
};
