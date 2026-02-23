/**
 * athu — Gemini API Proxy
 * Deploy this as a Cloudflare Worker.
 * Set GEMINI_API_KEY as an environment secret (not in code).
 *
 * Deploy steps:
 *   1. npm install -g wrangler
 *   2. wrangler login
 *   3. wrangler secret put GEMINI_API_KEY   ← paste your key when prompted
 *   4. wrangler deploy
 */

const GEMINI_MODEL   = 'gemini-2.0-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const ALLOWED_ORIGINS = [
  'https://athumoz.github.io',
  // Add your custom domain here once you have one:
  // 'https://athu.mz',
  // 'https://www.athu.mz',
];

const SYSTEM_INSTRUCTION = `
Tu és athu, um assistente de inteligência cívica especializado em governação de Moçambique.
Responde APENAS em JSON válido, sem texto fora do JSON e sem blocos de código markdown.
A estrutura deve ser exactamente:
{
  "chips": ["etiqueta1", "etiqueta2", "etiqueta3"],
  "summary": "Síntese clara e factual com <strong>valores importantes</strong> em negrito HTML",
  "facts": [
    {"key": "CATEGORIA", "value": "Facto específico"},
    {"key": "CATEGORIA", "value": "Facto específico"},
    {"key": "CATEGORIA", "value": "Facto específico"}
  ],
  "sources": ["Fonte 1", "Fonte 2", "Fonte 3"],
  "confidence": 75,
  "confidence_label": "Alta"
}
Regras:
- chips: 3-4 etiquetas curtas de fontes ou categorias relevantes (ex: "OE 2026", "MINED", "Boletim da República")
- summary: 2-4 frases factuais com dados concretos quando disponíveis; usa <strong> para destacar números ou termos-chave
- facts: 3-4 pares chave-valor com factos estruturados e concisos
- sources: 2-4 fontes primárias relevantes (documentos, ministérios, portais oficiais moçambicanos)
- confidence: número inteiro entre 40-95
- confidence_label: "Moderada", "Alta" ou "Muito Alta" conforme o valor
- Se a pergunta estiver numa língua local moçambicana (Macua, Changana, Sena, etc.), responde em português mas reconhece a língua nos chips
- Neutralidade política absoluta — apenas factos e fontes, sem opiniões
`.trim();

/* ─── Rate limiter: max 20 requests/minute per IP ─── */
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now  = Date.now();
  const win  = 60_000;   // 1 minute window
  const max  = 20;       // max requests per window

  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > win) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count > max;
}

/* ─── CORS helpers ─── */
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function json(body, status = 200, origin = '') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

/* ─── Main handler ─── */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    /* Preflight */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    /* Only POST to /api/query */
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/api/query') {
      return json({ error: 'Not found' }, 404, origin);
    }

    /* Rate limiting */
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isRateLimited(ip)) {
      return json({ error: 'Demasiados pedidos. Tente novamente em 1 minuto.' }, 429, origin);
    }

    /* Parse body */
    let query;
    try {
      const body = await request.json();
      query = (body.query || '').trim().slice(0, 500); // hard cap at 500 chars
      if (!query) throw new Error('empty');
    } catch {
      return json({ error: 'Pergunta inválida ou ausente.' }, 400, origin);
    }

    /* Call Gemini */
    const geminiRes = await fetch(`${GEMINI_ENDPOINT}?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents:           [{ parts: [{ text: query }] }],
        generationConfig:   { temperature: 0.3, maxOutputTokens: 1024 },
      }),
    });

    if (!geminiRes.ok) {
      const err = await geminiRes.json().catch(() => ({}));
      console.error('Gemini error:', geminiRes.status, err);
      return json({ error: 'Erro ao processar a pergunta. Tente novamente.' }, 502, origin);
    }

    const data = await geminiRes.json();
    let rawText = '';
    try {
      rawText = data.candidates[0].content.parts[0].text.trim();
    } catch {
      return json({ error: 'Resposta inesperada do servidor.' }, 502, origin);
    }

    /* Strip possible markdown fences */
    const clean = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return json({ error: 'Não foi possível interpretar a resposta. Tente novamente.' }, 502, origin);
    }

    return json(parsed, 200, origin);
  },
};
