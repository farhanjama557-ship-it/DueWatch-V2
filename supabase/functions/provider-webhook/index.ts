// Stripe Connect webhook ingress.
// Third-party endpoint: verify_jwt MUST remain false. It verifies the exact raw
// body, persists the receipt, and acknowledges. It never normalizes objects,
// mutates the payment ledger, or invokes any send/action boundary.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { sha256Hex } from '../_shared/requestSecurity.js'
import { verifyStripeWebhookSignature } from '../_shared/stripeWebhookSignature.js'

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

async function persistReceipt(admin: any, row: Record<string, unknown>) {
  const { error } = await admin.from('provider_webhook_events').insert(row)
  if (!error) return { inserted: true, duplicate: false }
  if (error.code === '23505') return { inserted: false, duplicate: true }
  throw error
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') || ''

  if (!supabaseUrl || !serviceRoleKey || !webhookSecret) {
    return json({ error: 'Webhook receiver is not configured.' }, 503)
  }

  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) {
    return json({ error: 'Payload too large' }, 413)
  }

  const rawBody = await req.text()
  if (new TextEncoder().encode(rawBody).length > MAX_WEBHOOK_BYTES) {
    return json({ error: 'Payload too large' }, 413)
  }

  const signatureHeader = req.headers.get('Stripe-Signature') || ''
  const verification = await verifyStripeWebhookSignature({
    rawBody,
    signatureHeader,
    secret: webhookSecret,
  })

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const rawHash = await sha256Hex(rawBody)
  const storedHeaders = {
    'stripe-signature': signatureHeader,
    'content-type': req.headers.get('content-type') || null,
    'user-agent': req.headers.get('user-agent') || null,
  }

  if (!verification.verified) {
    await persistReceipt(admin, {
      connection_id: null,
      user_id: null,
      provider: 'stripe',
      provider_event_id: `unverified:${rawHash}`,
      event_type: 'unverified',
      api_version: null,
      livemode: null,
      signature_verified: false,
      raw_body: rawBody,
      request_headers: storedHeaders,
      processing_status: 'quarantined',
      processing_error: verification.reason,
    })
    return json({ received: true }, 200)
  }

  let event: Record<string, any>
  try {
    event = JSON.parse(rawBody)
  } catch {
    await persistReceipt(admin, {
      connection_id: null,
      user_id: null,
      provider: 'stripe',
      provider_event_id: `verified-invalid-json:${rawHash}`,
      event_type: 'invalid_json',
      api_version: null,
      livemode: null,
      signature_verified: true,
      raw_body: rawBody,
      request_headers: storedHeaders,
      processing_status: 'parked',
      processing_error: 'VERIFIED_BODY_INVALID_JSON',
    })
    return json({ received: true }, 200)
  }

  const eventId = typeof event.id === 'string' && event.id ? event.id : `verified:${rawHash}`
  const eventType = typeof event.type === 'string' && event.type ? event.type : 'unknown'
  const apiVersion = typeof event.api_version === 'string' ? event.api_version : null
  const livemode = typeof event.livemode === 'boolean' ? event.livemode : null
  const account = typeof event.account === 'string' && event.account ? event.account : null

  if (!account || livemode === null) {
    await persistReceipt(admin, {
      connection_id: null,
      user_id: null,
      provider: 'stripe',
      provider_event_id: eventId,
      event_type: eventType,
      api_version: apiVersion,
      livemode,
      signature_verified: true,
      raw_body: rawBody,
      request_headers: storedHeaders,
      processing_status: 'parked',
      processing_error: !account ? 'STRIPE_ACCOUNT_MISSING' : 'STRIPE_LIVEMODE_MISSING',
    })
    return json({ received: true }, 200)
  }

  const environment = livemode ? 'live' : 'test'
  const { data: connections, error: connectionError } = await admin
    .from('provider_connections')
    .select('id,user_id,status,environment')
    .eq('provider', 'stripe')
    .eq('provider_account_id', account)
    .eq('environment', environment)
    .neq('status', 'disconnected')
    .limit(2)

  if (connectionError) {
    return json({ error: 'Could not resolve webhook connection.' }, 503)
  }

  if ((connections || []).length !== 1) {
    await persistReceipt(admin, {
      connection_id: null,
      user_id: null,
      provider: 'stripe',
      provider_event_id: eventId,
      event_type: eventType,
      api_version: apiVersion,
      livemode,
      signature_verified: true,
      raw_body: rawBody,
      request_headers: storedHeaders,
      processing_status: 'parked',
      processing_error: (connections || []).length === 0
        ? 'STRIPE_ACCOUNT_UNATTRIBUTED'
        : 'STRIPE_ACCOUNT_AMBIGUOUS',
    })
    return json({ received: true }, 200)
  }

  const connection = connections[0]
  await persistReceipt(admin, {
    connection_id: connection.id,
    user_id: connection.user_id,
    provider: 'stripe',
    provider_event_id: eventId,
    event_type: eventType,
    api_version: apiVersion,
    livemode,
    signature_verified: true,
    raw_body: rawBody,
    request_headers: storedHeaders,
    processing_status: 'pending',
    processing_error: null,
  })

  return json({ received: true }, 200)
})
