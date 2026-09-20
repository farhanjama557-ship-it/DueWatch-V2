// Browser-callable reminder delivery boundary.
//
// Security properties:
// - Supabase gateway JWT verification + server-side auth.getUser()
// - exact tenant ownership check on every invoice/approval
// - bounded JSON/message sizes
// - server-side per-user rate limits
// - dynamic origin allowlist (no wildcard CORS)
// - Autopilot approvals use the canonical rule-scoped execution claims
// - founder-composed reminders use a separate durable external-action claim
// - ambiguous provider outcomes are never treated as safe-to-retry failures
// - service/provider secrets never enter the browser bundle
import { createClient } from 'npm:@supabase/supabase-js@2'
import { sendEmail, isProviderConfigured } from '../_shared/resend.js'
import { corsHeadersForRequest, handleCorsPreflight } from '../_shared/cors.js'
import { consumeRateLimits } from '../_shared/rateLimit.js'
import { isUuid, readBoundedJson, sha256Hex } from '../_shared/requestSecurity.js'
import { executeApprovalSend, SEND_OUTCOME } from '../_shared/autopilotExecutionCore.js'
import { fetchAuthorityInputs } from '../_shared/autopilotAuthorityInputs.js'
import { resolveExistingClaimStatus, claimLostMessage } from '../_shared/executionClaim.js'

const MAX_REQUEST_BYTES = 24 * 1024
const MAX_MESSAGE_CHARS = 8_000
const MAX_SUBJECT_CHARS = 180
const MANUAL_ACTION_TYPE = 'manual_reminder_email'
const MANUAL_DEDUPE_WINDOW_MS = 5 * 60 * 1000

type AnyRecord = Record<string, any>

type ApprovalSendArgs = {
  admin: any
  userId: string
  awaitingSignatureId: string
  editedBody: string | null
  req: Request
}

type ApprovalIoArgs = {
  admin: any
  userId: string
  row: AnyRecord
}

function statusFromError(error: unknown) {
  if (error && typeof error === 'object' && 'status' in error) {
    return Number((error as { status?: unknown }).status) || 400
  }
  return 400
}

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function codeFromError(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code?: unknown }).code || 'unknown')
  }
  return error instanceof Error ? error.name : 'unknown'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handleCorsPreflight(req)
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, req)

  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!jwt) return json({ error: 'Not authenticated' }, 401, req)

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: 'Server configuration is incomplete.' }, 503, req)
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const {
      data: { user },
      error: userErr,
    } = await admin.auth.getUser(jwt)
    if (userErr || !user) return json({ error: 'Not authenticated' }, 401, req)

    const quota = await consumeRateLimits({
      database: admin,
      userId: user.id,
      limits: [
        { scope: 'reminder_send_minute', limit: 8, windowSeconds: 60 },
        { scope: 'reminder_send_day', limit: 75, windowSeconds: 86400 },
      ],
    })
    if (!quota.allowed) {
      return json(
        { error: 'Too many reminder-send attempts. Try again later.', code: 'RATE_LIMITED' },
        429,
        req,
        { 'Retry-After': String(quota.retryAfterSeconds || 60) }
      )
    }

    let requestBody: AnyRecord
    try {
      requestBody = await readBoundedJson(req, MAX_REQUEST_BYTES)
    } catch (error) {
      const status = statusFromError(error)
      return json(
        {
          error: status === 413 ? 'Request is too large.' : 'Request body must be valid JSON.',
          code: messageFromError(error, 'INVALID_REQUEST'),
        },
        status,
        req
      )
    }

    if (requestBody.awaitingSignatureId) {
      const awaitingSignatureId = String(requestBody.awaitingSignatureId)
      if (!isUuid(awaitingSignatureId)) {
        return json({ error: 'Invalid approval request.' }, 400, req)
      }

      const editedBody =
        typeof requestBody.editedBody === 'string' ? requestBody.editedBody.trim() : null
      if (editedBody != null && (editedBody.length < 1 || editedBody.length > MAX_MESSAGE_CHARS)) {
        return json({ error: 'Reminder text must be between 1 and 8000 characters.' }, 400, req)
      }

      return await handleApprovalSend({
        admin,
        userId: user.id,
        awaitingSignatureId,
        editedBody,
        req,
      })
    }

    const invoiceId = String(requestBody.invoiceId || '')
    const body = typeof requestBody.body === 'string' ? requestBody.body.trim() : ''
    const requestedSubject =
      typeof requestBody.subject === 'string' ? requestBody.subject.trim() : ''

    if (!isUuid(invoiceId) || !body) {
      return json({ error: 'A valid invoiceId and body are required.' }, 400, req)
    }
    if (body.length > MAX_MESSAGE_CHARS) {
      return json({ error: 'Reminder text is too long.' }, 400, req)
    }
    if (requestedSubject.length > MAX_SUBJECT_CHARS) {
      return json({ error: 'Reminder subject is too long.' }, 400, req)
    }

    const { data: invoice, error: invErr } = await admin
      .from('invoices')
      .select('id, user_id, inv_num, clients(email, name)')
      .eq('id', invoiceId)
      .maybeSingle()

    if (invErr || !invoice) return json({ error: 'Invoice not found' }, 404, req)
    if (invoice.user_id !== user.id) {
      return json({ error: 'Not authorized for this invoice' }, 403, req)
    }

    const client = Array.isArray(invoice.clients) ? invoice.clients[0] : invoice.clients
    const to = client?.email
    if (!to) {
      return json(
        { error: `${client?.name || 'This client'} has no email on file.` },
        422,
        req
      )
    }
    if (!isProviderConfigured()) {
      return json({ error: 'Email sending is not configured right now.' }, 503, req)
    }

    const subject =
      requestedSubject || `Regarding invoice ${invoice.inv_num || ''}`.trim()
    const messageHash = await sha256Hex(`${invoice.id}\n${subject}\n${body}`)
    const bucket = Math.floor(Date.now() / MANUAL_DEDUPE_WINDOW_MS)
    const idempotencyKey = `manual-reminder:${invoice.id}:${messageHash}:${bucket}`

    const { data: claimRows, error: claimError } = await admin.rpc(
      'acquire_external_action_claim',
      {
        p_user_id: user.id,
        p_invoice_id: invoice.id,
        p_action_type: MANUAL_ACTION_TYPE,
        p_idempotency_key: idempotencyKey,
        p_message_hash: messageHash,
        p_receipt: {
          userId: user.id,
          invoiceId: invoice.id,
          actionType: MANUAL_ACTION_TYPE,
          idempotencyKey,
          messageHash,
          recipient: to,
          subject,
          claimedAt: new Date().toISOString(),
        },
      }
    )
    if (claimError) throw claimError

    const claim = claimRows?.[0]
    if (!claim?.acquired) {
      return json(
        { error: manualClaimMessage(claim?.existing_status), code: 'DUPLICATE_OR_UNCERTAIN_SEND' },
        409,
        req
      )
    }

    const sendResult = await sendEmail({
      to,
      subject,
      text: body,
      idempotencyKey,
      from: undefined,
    })

    if (sendResult.error) {
      const status = sendResult.ambiguous === true ? 'uncertain' : 'send_failed'
      const { error: resolveError } = await admin.rpc('resolve_external_action_claim', {
        p_claim_id: claim.claim_id,
        p_status: status,
        p_provider: 'resend',
        p_provider_message_id: null,
        p_evidence: { error: sendResult.error, providerStatusCode: sendResult.statusCode ?? null },
      })
      if (resolveError) throw resolveError

      return json(
        {
          error:
            status === 'uncertain'
              ? 'DueWatch could not prove whether the email provider accepted this reminder. It will not retry automatically.'
              : 'The email provider rejected this reminder.',
          code: status === 'uncertain' ? 'SEND_UNCERTAIN' : 'SEND_FAILED',
        },
        502,
        req
      )
    }

    const { error: resolveError } = await admin.rpc('resolve_external_action_claim', {
      p_claim_id: claim.claim_id,
      p_status: 'sent',
      p_provider: 'resend',
      p_provider_message_id: sendResult.id || null,
      p_evidence: { resend_id: sendResult.id || null },
    })
    if (resolveError) {
      // Provider success without durable resolution is not safe to present as
      // a retryable failure. Surface an uncertainty response and do not send
      // another email automatically.
      console.error('manual reminder claim resolution failed', resolveError.code || 'unknown')
      return json(
        {
          error:
            'The reminder may have been sent, but DueWatch could not finish its durable receipt. Do not resend automatically.',
          code: 'SEND_RECEIPT_UNCERTAIN',
        },
        500,
        req
      )
    }

    // These are projections of the canonical claim, not the proof that the
    // external send occurred. A projection failure must never cause a retry.
    const nowIso = new Date().toISOString()
    const projectionResults = await Promise.all([
      admin.from('reminders').insert({
        invoice_id: invoice.id,
        user_id: user.id,
        title: 'Reminder sent',
        detail: body,
      }),
      admin
        .from('invoices')
        .update({ last_reminder: nowIso })
        .eq('id', invoice.id)
        .eq('user_id', user.id),
      admin.from('events').insert({
        user_id: user.id,
        event_type: 'reminder_sent',
        invoice_id: invoice.id,
        lifecycle_stage: 'sent',
        lifecycle_state: 'completed',
        evidence: {
          approved_by: 'You',
          resend_id: sendResult.id || null,
          delivery_status: 'sent',
          external_action_claim_id: claim.claim_id,
        },
      }),
    ])

    const projectionFailed = projectionResults.some((result) => result.error)
    if (projectionFailed) {
      console.error(
        'manual reminder projection incomplete',
        projectionResults.map((result) => result.error?.code || null)
      )
    }

    return json(
      {
        ok: true,
        id: sendResult.id,
        status: 'sent',
        receiptId: claim.claim_id,
        projectionComplete: !projectionFailed,
      },
      200,
      req
    )
  } catch (error) {
    console.error('send-reminder-email failed', codeFromError(error))
    return json({ error: 'Unexpected reminder delivery error.' }, 500, req)
  }
})

function manualClaimMessage(status: unknown) {
  if (status === 'sent') return 'This reminder was already sent.'
  if (status === 'uncertain') {
    return 'A prior attempt has an uncertain provider outcome. DueWatch will not risk sending a duplicate.'
  }
  if (status === 'in_flight') return 'This reminder is already being sent.'
  if (status === 'send_failed') {
    return 'A recent attempt failed. Wait briefly before trying again.'
  }
  return 'This reminder action is already being handled.'
}

async function handleApprovalSend({ admin, userId, awaitingSignatureId, editedBody, req }: ApprovalSendArgs) {
  const { data: row, error: rowErr } = await admin
    .from('awaiting_signature')
    .select('id, user_id, invoice_id, status, draft_content, ai_reason, ai_context')
    .eq('id', awaitingSignatureId)
    .maybeSingle()

  if (rowErr || !row) return json({ error: 'Approval request not found' }, 404, req)
  if (row.user_id !== userId) {
    return json({ error: 'Not authorized for this request' }, 403, req)
  }
  if (row.status !== 'pending') {
    return json({ error: 'This request has already been resolved' }, 409, req)
  }

  const priorAuthority = row.ai_context?.authority
  const priorFactualBasis = row.ai_context?.factualBasis
  const priorRuleSnapshot = row.ai_context?.ruleSnapshot
  if (
    !priorAuthority ||
    priorAuthority.authorized !== true ||
    !priorAuthority.basis ||
    priorAuthority.basis.ruleId == null ||
    !priorAuthority.ruleSnapshotHash ||
    !priorFactualBasis ||
    !priorRuleSnapshot
  ) {
    return json(
      {
        error:
          'This request predates execution-safety tracking and cannot be safely approved automatically. Ask Duewatch to draft a new reminder for this invoice.',
      },
      409,
      req
    )
  }

  const io = buildApprovalIo({ admin, userId, row })

  let result
  try {
    result = await executeApprovalSend({
      userId,
      priorAuthority,
      priorFactualBasis,
      priorRuleSnapshot,
      invoiceId: row.invoice_id,
      text: editedBody ?? row.draft_content,
      reason: row.ai_reason,
      now: new Date(),
      io,
    })
  } catch (error) {
    console.error('approval send failed', codeFromError(error))
    return json(
      {
        error:
          'DueWatch could not safely complete this approval. Check its current execution status before trying again.',
      },
      502,
      req
    )
  }

  switch (result.outcome) {
    case SEND_OUTCOME.SENT:
      return json({ ok: true, id: result.providerMessageId }, 200, req)
    case SEND_OUTCOME.CLAIM_LOST:
      return json({ error: claimLostMessage(result.existingStatus) }, 409, req)
    case SEND_OUTCOME.STALE_AUTHORITY:
      return json(
        {
          error: `This reminder is no longer valid to send (${result.detail}). Ask Duewatch to draft a new one.`,
        },
        409,
        req
      )
    case SEND_OUTCOME.PROVIDER_NOT_CONFIGURED:
      return json({ error: 'Email sending is not configured right now.' }, 503, req)
    case SEND_OUTCOME.NO_EMAIL_FALLBACK:
      return json({ error: 'This client has no email on file.' }, 422, req)
    default:
      return json({ error: 'Unexpected approval outcome' }, 500, req)
  }
}

function buildApprovalIo({ admin, userId, row }: ApprovalIoArgs) {
  const nowIso = () => new Date().toISOString()

  return {
    async fetchAuthorityInputs({ invoiceId }: { invoiceId: string }) {
      return (fetchAuthorityInputs as any)(admin, {
        userId,
        invoiceId,
        excludeAwaitingSignatureId: row.id,
      })
    },
    isProviderConfigured,
    async acquireClaim({ userId: uid, invoiceId, ruleId, actionType, idempotencyKey, receipt }: AnyRecord) {
      const { data, error } = await admin.rpc('acquire_autopilot_execution_claim', {
        p_user_id: uid,
        p_invoice_id: invoiceId,
        p_rule_id: ruleId,
        p_action_type: actionType,
        p_idempotency_key: idempotencyKey,
        p_receipt: receipt ?? {},
      })
      if (error) throw error
      const claimRow = data?.[0]
      if (claimRow?.acquired) return { claimId: claimRow.claim_id, acquired: true }

      let existingStatus = null
      if (claimRow?.claim_id) {
        const { data: existing, error: statusErr } = await admin
          .from('autopilot_execution_claims')
          .select('status')
          .eq('id', claimRow.claim_id)
          .maybeSingle()
        existingStatus = resolveExistingClaimStatus({
          error: statusErr,
          status: existing?.status,
        })
      }
      return { claimId: claimRow?.claim_id, acquired: false, existingStatus }
    },
    async resolveClaim({ claimId, status, providerMessageId, evidence }: AnyRecord) {
      const { error } = await admin.rpc('resolve_autopilot_execution_claim', {
        p_claim_id: claimId,
        p_status: status,
        p_provider_message_id: providerMessageId ?? null,
        p_evidence: evidence ?? {},
      })
      if (error) throw error
    },
    sendEmail,
    async queueForReview() {
      throw new Error('This client has no email on file.')
    },
    async recordSentEvidence({ claimId, sendResult, authority, reason, text, ruleSnapshot }: AnyRecord) {
      const { error: remErr } = await admin.from('reminders').insert({
        invoice_id: row.invoice_id,
        user_id: userId,
        title: 'Reminder sent',
        detail: text,
      })
      if (remErr) throw remErr

      const { error: invErr } = await admin
        .from('invoices')
        .update({ last_reminder: nowIso() })
        .eq('id', row.invoice_id)
        .eq('user_id', userId)
      if (invErr) throw invErr

      const { error: sigErr } = await admin
        .from('awaiting_signature')
        .update({ status: 'approved', resolved_at: nowIso() })
        .eq('id', row.id)
        .eq('user_id', userId)
      if (sigErr) throw sigErr

      const { error: evErr } = await admin.from('events').insert({
        user_id: userId,
        event_type: 'reminder_sent',
        invoice_id: row.invoice_id,
        lifecycle_stage: 'sent',
        lifecycle_state: 'completed',
        evidence: {
          reason,
          trigger: authority?.basis?.ruleName ?? 'Autopilot recommendation',
          approved_by: 'You',
          resend_id: sendResult.id || null,
          delivery_status: 'sent',
          execution_claim_id: claimId,
          rule_id: authority?.basis?.ruleId ?? null,
          rule_name: authority?.basis?.ruleName ?? null,
          rule_snapshot_hash: authority?.ruleSnapshotHash ?? null,
          rule_snapshot: ruleSnapshot ?? null,
          authorized_at: authority?.evaluatedAt ?? null,
        },
      })
      if (evErr) throw evErr
    },
    async recordFailureEvidence({ claimId, error, authority, reason, ruleSnapshot }: AnyRecord) {
      const { error: evErr } = await admin.from('events').insert({
        user_id: userId,
        event_type: 'reminder_send_failed',
        invoice_id: row.invoice_id,
        lifecycle_stage: 'sent',
        lifecycle_state: 'error',
        evidence: {
          reason,
          trigger: authority?.basis?.ruleName ?? 'Autopilot recommendation',
          approved_by: 'You',
          delivery_status: error,
          execution_claim_id: claimId,
          rule_id: authority?.basis?.ruleId ?? null,
          rule_name: authority?.basis?.ruleName ?? null,
          rule_snapshot_hash: authority?.ruleSnapshotHash ?? null,
          rule_snapshot: ruleSnapshot ?? null,
          authorized_at: authority?.evaluatedAt ?? null,
        },
      })
      if (evErr) throw evErr
    },
    async recordUncertainEvidence({ claimId, error, authority, reason, ruleSnapshot }: AnyRecord) {
      const { error: evErr } = await admin.from('events').insert({
        user_id: userId,
        event_type: 'reminder_send_uncertain',
        invoice_id: row.invoice_id,
        lifecycle_stage: 'sent',
        lifecycle_state: 'error',
        evidence: {
          reason,
          trigger: authority?.basis?.ruleName ?? 'Autopilot recommendation',
          approved_by: 'You',
          delivery_status:
            'Duewatch stopped automatically; completion could not be proven, so no retry was attempted.',
          error,
          execution_claim_id: claimId,
          rule_id: authority?.basis?.ruleId ?? null,
          rule_name: authority?.basis?.ruleName ?? null,
          rule_snapshot_hash: authority?.ruleSnapshotHash ?? null,
          rule_snapshot: ruleSnapshot ?? null,
          authorized_at: authority?.evaluatedAt ?? null,
        },
      })
      if (evErr) throw evErr
    },
  }
}

function json(
  payload: Record<string, unknown>,
  status: number,
  req: Request,
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeadersForRequest(req),
      ...extraHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}
