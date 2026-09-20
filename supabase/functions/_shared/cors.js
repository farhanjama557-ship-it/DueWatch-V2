const DEFAULT_ALLOWED_ORIGINS = [
  'https://due-watch-v2.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]

function configuredOrigins() {
  const configured = (Deno.env.get('DUEWATCH_ALLOWED_ORIGINS') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return new Set(configured.length ? configured : DEFAULT_ALLOWED_ORIGINS)
}

function baseHeaders() {
  return {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

export function corsHeadersForRequest(req) {
  const headers = baseHeaders()
  const origin = req?.headers?.get?.('Origin')
  if (!origin) return headers
  if (configuredOrigins().has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

export function handleCorsPreflight(req) {
  const origin = req.headers.get('Origin')
  const headers = corsHeadersForRequest(req)
  if (origin && !headers['Access-Control-Allow-Origin']) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  }
  return new Response('ok', { status: 204, headers })
}

// Backward-compatible export for any older code paths that still import the
// constant. It deliberately carries no wildcard Access-Control-Allow-Origin.
export const corsHeaders = baseHeaders()
