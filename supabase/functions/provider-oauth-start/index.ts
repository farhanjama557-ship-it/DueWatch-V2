// Stripe Connect Standard OAuth initiation.
// Browser-callable and JWT-gated. The authenticated user establishes the
// tenant only for the short-lived OAuth state row. No provider credential or
// Stripe secret is ever returned to the browser.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeadersForRequest, handleCorsPreflight } from '../_shared/cors.js'
import { consumeRateLimits } from '../_shared/rateLimit.js'

const STRIPE_AUTHORIZE_URL = 'https://connect.stripe.com/oauth/authorize'
const STATE_TTL_MS = 10 * 60 * 1000

function json(body: unknown, status: number, req: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeadersForRequest(req),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

function randomState() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handleCorsPreflight(req)
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, req)

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!jwt) return json({ error: 'Not authenticated' }, 401, req)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const clientId = Deno.env.get('STRIPE_CONNECT_CLIENT_ID') || ''
  const redirectUri = Deno.env.get('STRIPE_CONNECT_REDIRECT_URI') || ''

  if (!supabaseUrl || !serviceRoleKey || !clientId || !redirectUri) {
    return json({ error: 'Stripe connection is not configured.' }, 503, req)
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const {
    data: { user },
    error: userError,
  } = await admin.auth.getUser(jwt)

  if (userError || !user) return json({ error: 'Not authenticated' }, 401, req)

  const quota = await consumeRateLimits({
    database: admin,
    userId: user.id,
    limits: [
      { scope: 'provider_oauth_start_minute', limit: 6, windowSeconds: 60 },
      { scope: 'provider_oauth_start_day', limit: 30, windowSeconds: 86400 },
    ],
  })
  if (!quota.allowed) {
    return json({ error: 'Too many connection attempts. Try again later.' }, 429, req)
  }

  const state = randomState()
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString()

  const { error: insertError } = await admin.from('provider_oauth_states').insert({
    user_id: user.id,
    provider: 'stripe',
    state_token: state,
    code_verifier: null,
    expires_at: expiresAt,
  })

  if (insertError) {
    console.error('provider OAuth state creation failed', insertError.code || 'unknown')
    return json({ error: 'Could not start Stripe connection.' }, 500, req)
  }

  const url = new URL(STRIPE_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('scope', 'read_only')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)

  return json({
    provider: 'stripe',
    authorizationUrl: url.toString(),
    expiresAt,
  }, 200, req)
})
