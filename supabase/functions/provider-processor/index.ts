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
import { deriveStripeInvoiceLinkDecision } from '../_shared/providerLinkingCore.js'

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

async function syncInvoiceLinkProposals({
  admin,
  connection,
  providerObject,
}: {
  admin: any
  connection: any
  providerObject: any
}) {
  if (!['invoice', 'charge'].includes(providerObject.object_type)) {
    return { ok: true, decision: null }
  }

  const { data: invoices, error: invoiceError } = await admin
    .from('invoices')
    .select('id,inv_num,amount,amount_paid,paid,currency')
    .eq('user_id', connection.user_id)
    .eq('paid', false)

  if (invoiceError) {
    return { ok: false, error: 'LINKING_INVOICE_READ_FAILED' }
  }

  const confirmedProviderInvoiceLinks: Record<string, string> = {}
  const stripeInvoiceId = providerObject.object_type === 'charge'
    && typeof providerObject.object_state?.invoice === 'string'
    ? providerObject.object_state.invoice
    : null

  if (stripeInvoiceId) {
    const { data: stripeInvoiceObject, error: stripeInvoiceError } = await admin
      .from('provider_objects')
      .select('id')
      .eq('user_id', connection.user_id)
      .eq('connection_id', connection.id)
      .eq('object_type', 'invoice')
      .eq('provider_object_id', stripeInvoiceId)
      .maybeSingle()

    if (stripeInvoiceError) {
      return { ok: false, error: 'LINKING_PROVIDER_INVOICE_READ_FAILED' }
    }

    if (stripeInvoiceObject?.id) {
      const { data: confirmedLink, error: linkReadError } = await admin
        .from('provider_object_links')
        .select('entity_id')
        .eq('user_id', connection.user_id)
        .eq('provider_object_id', stripeInvoiceObject.id)
        .eq('entity_type', 'invoice')
        .not('confirmed_at', 'is', null)
        .maybeSingle()

      if (linkReadError) {
        return { ok: false, error: 'LINKING_CONFIRMED_LINK_READ_FAILED' }
      }
      if (confirmedLink?.entity_id) {
        confirmedProviderInvoiceLinks[stripeInvoiceId] = confirmedLink.entity_id
      }
    }
  }

  const decision = deriveStripeInvoiceLinkDecision({
    providerObject,
    invoices: invoices || [],
    confirmedProviderInvoiceLinks,
  })

  const { error: clearProposalError } = await admin
    .from('provider_object_links')
    .delete()
    .eq('user_id', connection.user_id)
    .eq('provider_object_id', providerObject.id)
    .eq('entity_type', 'invoice')
    .is('confirmed_at', null)

  if (clearProposalError) {
    return { ok: false, error: 'LINKING_STALE_PROPOSAL_CLEAR_FAILED' }
  }

  if (decision.proposals.length > 0) {
    const rows = decision.proposals.map((entityId: string) => ({
      user_id: connection.user_id,
      provider_object_id: providerObject.id,
      entity_type: 'invoice',
      entity_id: entityId,
      match_basis: 'proposal',
      confirmed_by: null,
      confirmed_at: null,
    }))

    const { error: proposalError } = await admin
      .from('provider_object_links')
      .upsert(rows, {
        onConflict: 'user_id,provider_object_id,entity_type,entity_id',
        ignoreDuplicates: false,
      })

    if (proposalError) {
      return { ok: false, error: 'LINKING_PROPOSAL_WRITE_FAILED' }
    }
  }

  if (decision.exceptionReason) {
    const candidates = decision.proposals.map((entityId: string) => ({
      entity_type: 'invoice',
      entity_id: entityId,
    }))

    const { data: existingException, error: exceptionReadError } = await admin
      .from('provider_reconciliation_exceptions')
      .select('id')
      .eq('user_id', connection.user_id)
      .eq('provider_object_id', providerObject.id)
      .eq('reason', decision.exceptionReason)
      .is('resolved_at', null)
      .maybeSingle()

    if (exceptionReadError) {
      return { ok: false, error: 'LINKING_EXCEPTION_READ_FAILED' }
    }

    if (existingException?.id) {
      const { error: exceptionUpdateError } = await admin
        .from('provider_reconciliation_exceptions')
        .update({ candidates })
        .eq('id', existingException.id)
        .eq('user_id', connection.user_id)

      if (exceptionUpdateError) {
        return { ok: false, error: 'LINKING_EXCEPTION_UPDATE_FAILED' }
      }
    } else {
      const { error: exceptionInsertError } = await admin
        .from('provider_reconciliation_exceptions')
        .insert({
          user_id: connection.user_id,
          provider_object_id: providerObject.id,
          reason: decision.exceptionReason,
          candidates,
        })

      if (exceptionInsertError && exceptionInsertError.code !== '23505') {
        return { ok: false, error: 'LINKING_EXCEPTION_WRITE_FAILED' }
      }
    }
  } else {
    // The latest provider state is no longer ambiguous. Open reconciliation
    // queue rows are ephemeral work items, not provider evidence; provider
    // evidence itself remains durably retained in provider_objects.
    const { error: clearExceptionError } = await admin
      .from('provider_reconciliation_exceptions')
      .delete()
      .eq('user_id', connection.user_id)
      .eq('provider_object_id', providerObject.id)
      .is('resolved_at', null)

    if (clearExceptionError) {
      return { ok: false, error: 'LINKING_STALE_EXCEPTION_CLEAR_FAILED' }
    }
  }

  return { ok: true, decision }
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
    const { data: providerObject, error: objectError } = await admin
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
      .select('id,user_id,connection_id,object_type,provider_object_id,object_state,evidence_class')
      .single()

    if (objectError || !providerObject) {
      await park('PROVIDER_OBJECT_WRITE_FAILED')
      continue
    }

    const linking = await syncInvoiceLinkProposals({
      admin,
      connection,
      providerObject,
    })
    if (!linking.ok) {
      await admin
        .from('provider_webhook_events')
        .update({ processing_error: linking.error })
        .eq('id', receipt.id)
      results.push({
        id: receipt.id,
        processed: false,
        parked: false,
        reason: linking.error,
      })
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
      linking: linking.decision ? {
        deterministic: linking.decision.deterministic,
        proposalCount: linking.decision.proposals.length,
        exceptionReason: linking.decision.exceptionReason,
      } : null,
    })
  }

  const allProcessed = results.every((result) => result.processed === true || result.parked === true)
  return json({ ok: allProcessed, results }, allProcessed ? 200 : 207)
})
