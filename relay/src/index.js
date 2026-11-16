// Claude relay for Subtitle Player (Cloudflare Worker).
// Keeps the Anthropic API key private, only answers the Subtitle Player site, tracks token usage
// and cost, and lets the owner switch AI on/off and tune it for everyone.
//
// Secrets (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY  – the Anthropic API key
//   ADMIN_TOKEN        – owner passcode
// Vars (wrangler.toml): ALLOWED_ORIGINS
// KV binding SETTINGS: "enabled", "settings" (JSON), "usage:<YYYY-MM-DD>" (JSON)

import Anthropic from '@anthropic-ai/sdk';

const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' };
// USD per million tokens (input, output). Haiku 5.5's rate for prompts up to 100K tokens — ours are far smaller.
const PRICE = { 'claude-haiku-5-5': [0.10, 0.50], 'claude-sonnet-5-5': [2, 10] };

// Owner-tunable defaults (changed from the site's owner panel).
// Measured on a real episode (~900 lines): clean OCR lines fixed + translated from text with thinking off
// (~$0.03/episode); messy lines read from the subtitle picture by Haiku (~1/20 the cost of Sonnet,
// nearly as good). Together ≈ $0.05/episode.
const DEFAULT_SETTINGS = {
  imageModel: 'haiku',  // reads messy lines from the picture: 'haiku' | 'sonnet' | 'off' (text only)
  threshold: 0.85,      // OCR confidence below this → read from the picture
  think: 'off',         // extended thinking for text polishing: 'off' (cheapest) | 'on'
};

const SYSTEM = [
  'You are a professional subtitler for Israeli TV.',
  'You receive Hebrew subtitle lines read from video frames by OCR, so letters may be wrong, missing or swapped',
  '(common: ך/ן, ר/ד, ב/כ, ה/ח, ו/ז, ם/ס, merged or split words).',
  'Restore the intended Hebrew from context and write natural, idiomatic English subtitles.',
  'Translate meaning and tone, not word by word, as short as subtitles need to be.',
  'A sentence may continue across consecutive lines; translate each line so they read naturally in sequence.',
  'Keep names and recurring terms consistent with earlier lines.',
  'Use a real line break (not the characters \\n or " / ") where a subtitle has two lines.',
].join(' ');

// Compact answer: corrected Hebrew only when it differs from the OCR (output tokens are what cost money).
const POLISH_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          fix: { type: 'string', description: 'corrected Hebrew, or empty string if the OCR line was already right' },
          en: { type: 'string', description: 'English subtitle' },
          unsure: { type: 'boolean', description: 'true only if the OCR text is too garbled to know what it says' },
        },
        required: ['n', 'fix', 'en', 'unsure'],
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
          he: { type: 'string' },
          en: { type: 'string' },
          not_text: { type: 'boolean', description: 'true if the image has no readable text' },
        },
        required: ['n', 'he', 'en', 'not_text'],
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

async function getSettings(env) {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse((await env.SETTINGS.get('settings')) || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; }
}

function costOf(model, usage) {
  const [pi, po] = PRICE[model] || [0, 0];
  const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  return { input, output: usage.output_tokens || 0, cost: (input * pi + (usage.output_tokens || 0) * po) / 1e6 };
}

async function record(env, model, usage, lines) {
  const key = 'usage:' + today();
  const u = JSON.parse((await env.SETTINGS.get(key)) || '{"requests":0,"lines":0,"input":0,"output":0,"cost":0}');
  const c = costOf(model, usage);
  u.requests++; u.lines += lines; u.input += c.input; u.output += c.output; u.cost += c.cost;
  await env.SETTINGS.put(key, JSON.stringify(u), { expirationTtl: 120 * 86400 });
  return c;
}

function contextText(body) {
  const out = [];
  if (body.show) out.push(`Show: ${String(body.show).slice(0, 200)}`);
  if (Array.isArray(body.before) && body.before.length) {
    out.push('Earlier lines (already done):');
    for (const b of body.before.slice(-6)) out.push(`  ${String(b.he).replace(/\n/g, ' ')} => ${String(b.en || '').replace(/\n/g, ' ')}`);
  }
  if (Array.isArray(body.after) && body.after.length) {
    out.push('Following lines (raw OCR, context only):');
    for (const a of body.after.slice(0, 3)) out.push(`  ${String(a).replace(/\n/g, ' ')}`);
  }
  return out.join('\n');
}

function parseJson(msg) {
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined this request'), { status: 422 });
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('Answer was cut off'), { status: 502 });
  const block = msg.content.find((b) => b.type === 'text');
  if (!block) throw new Error('No answer');
  return JSON.parse(block.text);
}

async function polish(client, env, body, settings) {
  const lines = (body.lines || []).slice(0, 80);
  if (!lines.length) return { items: [] };
  const model = MODELS.haiku;
  const list = lines.map((l) => `[${l.n}] ${String(l.he).slice(0, 400)}`).join('\n');
  const msg = await client.messages.create({
    model,
    max_tokens: 16000,
    system: SYSTEM,
    // Thinking off by default: for fixing + translating subtitle lines it mostly adds cost and delay.
    ...((body.think ?? settings.think) === 'on' ? {} : { thinking: { type: 'disabled' } }),
    output_config: { effort: 'low', format: { type: 'json_schema', schema: POLISH_SCHEMA } },
    messages: [{ role: 'user', content: `${contextText(body)}\n\nOCR lines to fix and translate, in order:\n${list}\n\nReturn every line by its number.` }],
  });
  const out = parseJson(msg);
  // Fill in full fields server-side so the page gets complete lines without paying output tokens for them.
  out.items = (out.items || []).map((it) => {
    const src = lines.find((l) => l.n === it.n);
    return { n: it.n, hebrew: (it.fix && it.fix.trim()) || (src ? String(src.he) : ''), fixed: !!(it.fix && it.fix.trim()), english: it.en, unsure: it.unsure };
  });
  out.usage = await record(env, model, msg.usage, lines.length);
  return out;
}

async function read(client, env, body, settings) {
  const which = ['haiku', 'sonnet'].includes(body.model) ? body.model : settings.imageModel;
  if (which === 'off') return { items: [], off: true };
  const model = MODELS[which];
  const lines = (body.lines || []).slice(0, 12);
  if (!lines.length) return { items: [] };
  const content = [];
  const ctx = contextText(body);
  if (ctx) content.push({ type: 'text', text: ctx });
  content.push({ type: 'text', text: 'Each image is the bottom of a video frame with a burned-in subtitle. The OCR guess is given too but may be wrong.' });
  for (const l of lines) {
    content.push({ type: 'text', text: `[${l.n}] OCR guess: ${String(l.he || '').slice(0, 300)}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(l.img) } });
  }
  content.push({ type: 'text', text: 'For every image return n, the exact text it shows (Hebrew, or the original language if it is not Hebrew), and the English subtitle. If an image has no readable subtitle text, set not_text true.' });
  const params = {
    model,
    max_tokens: 8000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: READ_SCHEMA } },
    messages: [{ role: 'user', content }],
  };
  const msg = which === 'sonnet'
    ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await client.messages.create(params);
  const out = parseJson(msg);
  out.items = (out.items || []).map((it) => ({ n: it.n, hebrew: it.he, english: it.en, not_text: it.not_text }));
  out.usage = await record(env, model, msg.usage, lines.length);
  return out;
}

async function usageSummary(env) {
  const days = [];
  let month = { requests: 0, lines: 0, cost: 0 };
  const now = new Date();
  for (let i = 0; i < 31; i++) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    const u = JSON.parse((await env.SETTINGS.get('usage:' + d)) || 'null');
    if (!u) continue;
    days.push({ day: d, ...u });
    month.requests += u.requests; month.lines += u.lines; month.cost += u.cost;
  }
  return { today: days.find((d) => d.day === today()) || { requests: 0, lines: 0, cost: 0 }, last30: month };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).includes(origin);
    const headers = { ...cors(origin, allowed), 'Content-Type': 'application/json' };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!allowed) return reply({ error: 'Not allowed' }, 403);

    const enabled = (await env.SETTINGS.get('enabled')) !== 'off';
    const settings = await getSettings(env);

    if (url.pathname === '/status') return reply({ enabled, configured: !!env.ANTHROPIC_API_KEY, settings, remaining: 1e9 }); // no daily cap

    if (url.pathname === '/admin' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      if (!env.ADMIN_TOKEN || body.token !== env.ADMIN_TOKEN) return reply({ error: 'Wrong passcode' }, 401);
      if (typeof body.enabled === 'boolean') await env.SETTINGS.put('enabled', body.enabled ? 'on' : 'off');
      let s = settings;
      if (body.settings && typeof body.settings === 'object') {
        const n = body.settings;
        s = { ...settings };
        if (['haiku', 'sonnet', 'off'].includes(n.imageModel)) s.imageModel = n.imageModel;
        if (['on', 'off'].includes(n.think)) s.think = n.think;
        if (Number(n.threshold) >= 0 && Number(n.threshold) <= 1.01) s.threshold = Number(n.threshold);
        await env.SETTINGS.put('settings', JSON.stringify(s));
      }
      return reply({ enabled: typeof body.enabled === 'boolean' ? body.enabled : enabled, settings: s, usage: await usageSummary(env) });
    }

    if ((url.pathname === '/polish' || url.pathname === '/read') && req.method === 'POST') {
      if (!enabled) return reply({ error: 'AI is switched off' }, 503);
      if (!env.ANTHROPIC_API_KEY) return reply({ error: 'Relay has no API key yet' }, 503);
      const body = await req.json().catch(() => ({}));
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
      try {
        return reply(url.pathname === '/polish' ? await polish(client, env, body, settings) : await read(client, env, body, settings));
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
