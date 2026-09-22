// Read-only Stripe provider sync.
// Gateway JWT verification is required and the function additionally requires
// a verified service_role claim. This function writes provider evidence and
// freshness only. It has no canonical payment-ledger write path.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { readBoundedJson, isUuid, verifiedJwtRole } from '../_shared/requestSecurity.js'
import {
  STRIPE_SYNC_RESOURCES,
  buildStripeListUrl,
  classifyStripeHttpStatus,
  collectCompleteStripeResource,
  expectedLivemode,
} from '../_shared/stripeSyncCore.js'

const MAX_BODY_BYTES = 8 * 1024
const MAX_CONNECTIONS_PER_RUN = 20
const PAGE_LIMIT = 1000

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
  const stripeApiVersion = Deno.env.get('STRIPE_API_VERSION') || ''

  if (!supabaseUrl || !serviceRoleKey || !stripeSecretKey) {
    return json({ error: 'Provider sync is not configured.' }, 503)
  }

  let body: Record<string, unknown>
  try {
    body = await readBoundedJson(req, MAX_BODY_BYTES)
  } catch {
    return json({ error: 'Invalid request body.' }, 400)
  }

  const connectionId = body.connectionId ? String(body.connectionId) : null
  if (connectionId && !isUuid(connectionId)) {
    return json({ error: 'Invalid connectionId.' }, 400)
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let query = admin
    .from('provider_connections')
    .select('id,user_id,provider,provider_account_id,environment,status')
    .eq('provider', 'stripe')
    .eq('status', 'connected')
    .order('connected_at', { ascending: true })
    .limit(MAX_CONNECTIONS_PER_RUN)

  if (connectionId) query = query.eq('id', connectionId)

  const { data: connections, error: connectionError } = await query
  if (connectionError) return json({ error: 'Could not load provider connections.' }, 500)
  if (connectionId && (connections || []).length === 0) {
    return json({ error: 'Stripe connection not found.' }, 404)
  }

  const results = []

  for (const connection of connections || []) {
    const connectionResult: Record<string, unknown> = {
      connectionId: connection.id,
      providerAccountId: connection.provider_account_id,
      environment: connection.environment,
      resources: {},
    }

    for (const [resource, config] of Object.entries(STRIPE_SYNC_RESOURCES)) {
      const nowIso = new Date().toISOString()
      const { data: priorState, error: stateReadError } = await admin
        .from('provider_sync_state')
        .select('id,last_success_at,last_complete_cursor,last_error_category')
        .eq('user_id', connection.user_id)
        .eq('connection_id', connection.id)
        .eq('resource', resource)
        .maybeSingle()

      if (stateReadError) {
        connectionResult.resources[resource] = { complete: false, error: 'SYNC_STATE_READ_FAILED' }
        continue
      }

      const { error: attemptError } = await admin
        .from('provider_sync_state')
        .upsert({
          user_id: connection.user_id,
          connection_id: connection.id,
          resource,
          last_attempt_at: nowIso,
          last_success_at: priorState?.last_success_at ?? null,
          last_complete_cursor: priorState?.last_complete_cursor ?? null,
          last_error_category: priorState?.last_error_category ?? null,
        }, { onConflict: 'user_id,connection_id,resource' })

      if (attemptError) {
        connectionResult.resources[resource] = { complete: false, error: 'SYNC_ATTEMPT_WRITE_FAILED' }
        continue
      }

      const collected = await collectCompleteStripeResource({
        resource,
        previousCompleteCursor: priorState?.last_complete_cursor ?? null,
        pageLimit: PAGE_LIMIT,
        requestPage: async ({ startingAfter, previousCompleteCursor }) => {
          const url = buildStripeListUrl({
            resource,
            startingAfter,
            previousCompleteCursor,
            limit: 100,
          })

          let response: Response
          try {
            response = await fetch(url, {
              headers: {
                Authorization: `Bearer ${stripeSecretKey}`,
                'Stripe-Account': connection.provider_account_id,
                ...(stripeApiVersion ? { 'Stripe-Version': stripeApiVersion } : {}),
              },
              signal: AbortSignal.timeout(15_000),
            })
          } catch {
            const error = new Error('STRIPE_UNAVAILABLE')
            error.category = 'UNAVAILABLE'
            throw error
          }

          if (!response.ok) {
            const error = new Error(`STRIPE_HTTP_${response.status}`)
            error.category = classifyStripeHttpStatus(response.status)
            throw error
          }

          let page: Record<string, unknown>
          try {
            page = await response.json()
          } catch {
            const error = new Error('STRIPE_RESPONSE_UNVERIFIABLE')
            error.category = 'SCHEMA'
            throw error
          }
          return page
        },
      })

      if (!collected.complete) {
        await admin
          .from('provider_sync_state')
          .update({ last_error_category: collected.errorCategory || 'UNKNOWN' })
          .eq('user_id', connection.user_id)
          .eq('connection_id', connection.id)
          .eq('resource', resource)

        connectionResult.resources[resource] = {
          complete: false,
          error: collected.errorCode,
          errorCategory: collected.errorCategory,
          pages: collected.pageCount,
        }
        continue
      }

      const expectedMode = expectedLivemode(connection.environment)
      const rows = []
      let modeMismatch = false

      for (const item of collected.items) {
        if (typeof item?.livemode === 'boolean' && item.livemode !== expectedMode) {
          modeMismatch = true
          break
        }
        rows.push({
          user_id: connection.user_id,
          connection_id: connection.id,
          object_type: config.objectType,
          provider_object_id: item.id,
          object_state: item,
          provider_created_at: unixToIso(item.created),
          observed_at: nowIso,
          evidence_class: config.evidenceClass,
        })
      }

      if (modeMismatch) {
        await admin
          .from('provider_sync_state')
          .update({ last_error_category: 'SCHEMA' })
          .eq('user_id', connection.user_id)
          .eq('connection_id', connection.id)
          .eq('resource', resource)

        connectionResult.resources[resource] = {
          complete: false,
          error: 'STRIPE_MODE_MISMATCH',
          errorCategory: 'SCHEMA',
        }
        continue
      }

      if (rows.length > 0) {
        const { error: objectError } = await admin
          .from('provider_objects')
          .upsert(rows, {
            onConflict: 'user_id,connection_id,object_type,provider_object_id',
            ignoreDuplicates: false,
          })

        if (objectError) {
          await admin
            .from('provider_sync_state')
            .update({ last_error_category: 'UNKNOWN' })
            .eq('user_id', connection.user_id)
            .eq('connection_id', connection.id)
            .eq('resource', resource)

          connectionResult.resources[resource] = {
            complete: false,
            error: 'PROVIDER_OBJECT_WRITE_FAILED',
            errorCategory: 'UNKNOWN',
          }
          continue
        }
      }

      const { error: successError } = await admin
        .from('provider_sync_state')
        .update({
          last_success_at: nowIso,
          last_complete_cursor: collected.nextCompleteCursor,
          last_error_category: null,
        })
        .eq('user_id', connection.user_id)
        .eq('connection_id', connection.id)
        .eq('resource', resource)

      connectionResult.resources[resource] = successError
        ? { complete: false, error: 'SYNC_SUCCESS_RECEIPT_FAILED', errorCategory: 'UNKNOWN' }
        : {
            complete: true,
            count: rows.length,
            pages: collected.pageCount,
            completeCursor: collected.nextCompleteCursor,
          }
    }

    results.push(connectionResult)
  }

  const allComplete = results.every((connection: any) =>
    Object.values(connection.resources).every((resource: any) => resource.complete === true)
  )

  return json({ ok: allComplete, results }, allComplete ? 200 : 207)
})
