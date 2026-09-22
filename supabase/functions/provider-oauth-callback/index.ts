// Stripe Connect Standard OAuth callback.
// Third-party callback: verify_jwt MUST remain false. Tenant identity comes
// only from the single-use OAuth state row, never query params or a user JWT.

import { createClient } from 'npm:@supabase/supabase-js@2'

const STRIPE_TOKEN_URL = 'https://connect.stripe.com/oauth/token'
const ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/

function html(message: string, status = 200) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>DueWatch</title></head><body><p>${escapeHtml(message)}</p></body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  )
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function appRedirect(appUrl: string, params: Record<string, string>) {
  const target = new URL('/integrations', appUrl)
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
  return Response.redirect(target.toString(), 302)
}

Deno.serve(async (req) => {
  if (req.method !== 'GET') return html('Method not allowed', 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY') || ''
  const redirectUri = Deno.env.get('STRIPE_CONNECT_REDIRECT_URI') || ''
  const appUrl = Deno.env.get('DUEWATCH_APP_URL') || ''

  if (!supabaseUrl || !serviceRoleKey || !stripeSecretKey || !redirectUri || !appUrl) {
    return html('Stripe connection is not configured.', 503)
  }

  const requestUrl = new URL(req.url)
  const stateToken = requestUrl.searchParams.get('state') || ''
  const code = requestUrl.searchParams.get('code') || ''
  const providerError = requestUrl.searchParams.get('error') || ''
  const providerErrorDescription = requestUrl.searchParams.get('error_description') || ''

  if (!stateToken) return html('Missing OAuth state.', 400)

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // This preflight lookup does not establish tenant authority for any write.
  // It only determines whether there is a live, unconsumed server-created
  // state worth exchanging. The later conditional UPDATE is the single-use
  // consumption boundary.
  const { data: pendingState, error: stateReadError } = await admin
    .from('provider_oauth_states')
    .select('id,user_id,provider,expires_at,consumed_at')
    .eq('state_token', stateToken)
    .maybeSingle()

  if (
    stateReadError ||
    !pendingState ||
    pendingState.provider !== 'stripe' ||
    pendingState.consumed_at ||
    Date.parse(pendingState.expires_at) <= Date.now()
  ) {
    return html('This Stripe connection link is invalid or expired.', 400)
  }

  if (providerError) {
    const { data: consumed } = await admin
      .from('provider_oauth_states')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', pendingState.id)
      .is('consumed_at', null)
      .gt('expires_at', new Date().toISOString())
      .select('id')
      .maybeSingle()

    if (!consumed) return html('This Stripe connection link was already used.', 409)
    return appRedirect(appUrl, {
      stripe: 'cancelled',
      reason: providerErrorDescription || providerError,
    })
  }

  if (!code) return html('Missing Stripe authorization code.', 400)

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_secret: stripeSecretKey,
  })

  let tokenResponse: Response
  try {
    tokenResponse = await fetch(STRIPE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(12_000),
    })
  } catch {
    return html('Stripe could not be reached. Start the connection again.', 503)
  }

  let tokenResult: Record<string, unknown>
  try {
    tokenResult = await tokenResponse.json()
  } catch {
    return html('Stripe returned an unverifiable OAuth response.', 502)
  }

  if (!tokenResponse.ok) {
    return html('Stripe rejected the authorization code. Start the connection again.', 400)
  }

  // Intentionally extract only non-secret connection facts. access_token,
  // refresh_token and publishable-key fields from the OAuth response are never
  // persisted, returned or logged.
  const stripeAccountId = typeof tokenResult.stripe_user_id === 'string'
    ? tokenResult.stripe_user_id
    : ''
  const livemode = tokenResult.livemode
  const scope = typeof tokenResult.scope === 'string' ? tokenResult.scope : ''

  if (!ACCOUNT_ID.test(stripeAccountId) || typeof livemode !== 'boolean') {
    return html('Stripe returned an unverifiable account identity.', 502)
  }

  const consumedAt = new Date().toISOString()
  const { data: consumedState, error: consumeError } = await admin
    .from('provider_oauth_states')
    .update({ consumed_at: consumedAt })
    .eq('id', pendingState.id)
    .is('consumed_at', null)
    .gt('expires_at', consumedAt)
    .select('id,user_id,provider')
    .maybeSingle()

  if (consumeError || !consumedState) {
    return html('This Stripe connection link was already used or expired.', 409)
  }

  const grantedScopes = scope.split(/[ ,]+/).map((value) => value.trim()).filter(Boolean)
  const environment = livemode ? 'live' : 'test'

  const { data: connection, error: connectionError } = await admin
    .from('provider_connections')
    .upsert(
      {
        user_id: consumedState.user_id,
        provider: 'stripe',
        provider_account_id: stripeAccountId,
        environment,
        status: 'connected',
        granted_scopes: grantedScopes,
        connected_at: consumedAt,
        disconnected_at: null,
      },
      {
        onConflict: 'user_id,provider,provider_account_id,environment',
        ignoreDuplicates: false,
      },
    )
    .select('id,user_id,provider,provider_account_id,environment,status')
    .single()

  if (connectionError || !connection) {
    console.error('Stripe connection persistence failed', connectionError?.code || 'unknown')
    return html('Stripe was authorized, but DueWatch could not save the connection. Start again.', 500)
  }

  return appRedirect(appUrl, {
    stripe: 'connected',
    connection: connection.id,
  })
})
