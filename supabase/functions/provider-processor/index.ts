// Stripe webhook processor.
// Service-role only. Re-fetches current provider object state instead of
// applying event deltas, so arrival order cannot decide financial state.
// Phase 4 still has no canonical payment-ledger write path.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { readBoundedJson, isUuid, verifiedJwtRole } from '../_shared/requestSecurity.js'
import { classifyStripeHttpStatus } from '../_shared/stripeSyncCore.js'
import {
  normalizeStripeWebhookEnvelope,
  stripeRetrieveUrl,
  supportedStripeApiVersion,
  webhookObjectEvidenceClass,
} from '../_shared/stripeWebhookProcessorCore.js'

const MAX_BODY_BYTES = 8 * 1024
const MAX_EVENTS_PER_RUN = 50

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function unixToIso(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0
    ? new Date(Number(value) * 1000).toISOString()
    : null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (verifiedJwtRole(req) !== 'service_role') return json({ error: 'Forbidden' }, 403)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY') || ''
  const supportedVersions = Deno.env.get('STRIPE_SUPPORTED_API_VERSIONS')
    || Deno.env.get('STRIPE_API_VERSION')
    || ''

  if (!supabaseUrl || !serviceRoleKey || !stripeSecretKey) {
    return json({ error: 'Provider processor is not configured.' }, 503)
  }

  let body: Record<string, unknown>
  try {
    body = await readBoundedJson(req, MAX_BODY_BYTES)
  } catch {
    return json({ error: 'Invalid request body.' }, 400)
  }

  const webhookEventId = body.webhookEventId ? String(body.webhookEventId) : null
  if (webhookEventId && !isUuid(webhookEventId)) {
    return json({ error: 'Invalid webhookEventId.' }, 400)
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let query = admin
    .from('provider_webhook_events')
    .select('id,connection_id,user_id,provider,provider_event_id,event_type,api_version,livemode,signature_verified,raw_body,processing_status')
    .eq('provider', 'stripe')
    .eq('signature_verified', true)
    .eq('processing_status', 'pending')
    .order('received_at', { ascending: true })
    .limit(MAX_EVENTS_PER_RUN)

  if (webhookEventId) query = query.eq('id', webhookEventId)

  const { data: receipts, error: receiptError } = await query
  if (receiptError) return json({ error: 'Could not load webhook receipts.' }, 500)

  const results = []

  for (const receipt of receipts || []) {
    const park = async (reason: string) => {
      await admin
        .from('provider_webhook_events')
        .update({
          processing_status: 'parked',
          processing_error: reason,
          processed_at: null,
        })
        .eq('id', receipt.id)
      results.push({ id: receipt.id, processed: false, parked: true, reason })
    }

    let event
    try {
      event = JSON.parse(receipt.raw_body)
    } catch {
      await park('VERIFIED_BODY_INVALID_JSON')
      continue
    }

    const envelope = normalizeStripeWebhookEnvelope(event)
    if (!envelope.valid) {
      await park(envelope.reason)
      continue
    }

    if (!receipt.connection_id || !receipt.user_id) {
      await park('TENANT_UNRESOLVED')
      continue
    }

    if (!supportedStripeApiVersion(envelope.apiVersion, supportedVersions)) {
      await park('UNSUPPORTED_API_VERSION')
      continue
    }

    const expectedEnvironment = envelope.livemode ? 'live' : 'test'
    const { data: connection, error: connectionError } = await admin
      .from('provider_connections')
      .select('id,user_id,provider_account_id,environment,status')
      .eq('id', receipt.connection_id)
      .eq('user_id', receipt.user_id)
      .maybeSingle()

    if (
      connectionError ||
      !connection ||
      connection.provider_account_id !== envelope.account ||
      connection.environment !== expectedEnvironment ||
      connection.status === 'disconnected'
    ) {
      await park('CONNECTION_IDENTITY_CHANGED')
      continue
    }

    const retrieveUrl = stripeRetrieveUrl(envelope.objectType, envelope.objectId)
    const evidenceClass = webhookObjectEvidenceClass(envelope.objectType)
    if (!retrieveUrl || !evidenceClass) {
      await park('UNSUPPORTED_OBJECT_TYPE')
      continue
    }

    let response: Response
    try {
      response = await fetch(retrieveUrl, {
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          'Stripe-Account': connection.provider_account_id,
          'Stripe-Version': envelope.apiVersion,
        },
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      await admin
        .from('provider_webhook_events')
        .update({ processing_error: 'PROVIDER_UNAVAILABLE' })
        .eq('id', receipt.id)
      results.push({ id: receipt.id, processed: false, parked: false, reason: 'PROVIDER_UNAVAILABLE' })
      continue
    }

    if (response.status === 401 || response.status === 403) {
      await admin
        .from('provider_connections')
        .update({ status: 'needs_reconnect' })
        .eq('id', connection.id)
        .eq('user_id', connection.user_id)
      await park('PROVIDER_AUTH_FAILED')
      continue
    }

    if (!response.ok) {
      const category = classifyStripeHttpStatus(response.status)
      if (category === 'RATE_LIMIT' || category === 'UNAVAILABLE') {
        await admin
          .from('provider_webhook_events')
          .update({ processing_error: category })
          .eq('id', receipt.id)
        results.push({ id: receipt.id, processed: false, parked: false, reason: category })
      } else {
        await park(`PROVIDER_HTTP_${response.status}`)
      }
      continue
    }

    let object
    try {
      object = await response.json()
    } catch {
      await park('PROVIDER_OBJECT_UNVERIFIABLE')
      continue
    }

    if (
      object?.id !== envelope.objectId ||
      object?.object !== envelope.objectType ||
      (typeof object?.livemode === 'boolean' && object.livemode !== envelope.livemode)
    ) {
      await park('PROVIDER_OBJECT_IDENTITY_MISMATCH')
      continue
    }

    const observedAt = new Date().toISOString()
    const { error: objectError } = await admin
      .from('provider_objects')
      .upsert({
        user_id: connection.user_id,
        connection_id: connection.id,
        object_type: envelope.objectType,
        provider_object_id: envelope.objectId,
        object_state: object,
        provider_created_at: unixToIso(object.created),
        observed_at: observedAt,
        evidence_class: evidenceClass,
      }, {
        onConflict: 'user_id,connection_id,object_type,provider_object_id',
        ignoreDuplicates: false,
      })

    if (objectError) {
      await park('PROVIDER_OBJECT_WRITE_FAILED')
      continue
    }

    const { error: completeError } = await admin
      .from('provider_webhook_events')
      .update({
        processing_status: 'processed',
        processing_error: null,
        processed_at: observedAt,
      })
      .eq('id', receipt.id)
      .eq('processing_status', 'pending')

    if (completeError) {
      results.push({ id: receipt.id, processed: false, parked: false, reason: 'PROCESSING_RECEIPT_WRITE_FAILED' })
      continue
    }

    results.push({
      id: receipt.id,
      processed: true,
      objectType: envelope.objectType,
      objectId: envelope.objectId,
    })
  }

  const allProcessed = results.every((result) => result.processed === true || result.parked === true)
  return json({ ok: allProcessed, results }, allProcessed ? 200 : 207)
})
