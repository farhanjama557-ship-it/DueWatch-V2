// Callable Edge Function — the ONLY place that talks to Resend on behalf of
// a signed-in founder's manual/approved sends (SignatureCard "Approve & Send"
// and "Edit First", InvoiceDetailPanel "Send reminder"). The React app never
// holds RESEND_API_KEY; it calls this function instead.
//
// Post-2A.1 execution safety checkpoint (review-fix passes):
// - BLOCKER 1 (first pass): founder approval of an Autopilot rule-backed
//   draft (SignatureCard "Approve & Send") routes through the SAME durable
//   execution boundary (autopilotExecutionCore.executeApprovalSend) the
//   scheduler's auto-send uses — a persisted awaitingSignatureId is
//   required, and the tenant/invoice/rule authority basis is loaded and
//   revalidated server-side, never trusted from the browser.
// - BLOCKER (second pass): "Edit First" is the SAME approval flow with
//   founder-edited wording — it now ALSO routes through this exact path
//   (optional `editedBody`), instead of the legacy ad-hoc invoiceId+body
//   path. The founder may edit the message text; the browser never
//   supplies authority/rule/user identity, which is always loaded and
//   revalidated server-side from the persisted awaiting_signature row.
// - BLOCKER (second pass): the awaiting_signature row currently being
//   approved is excluded from its OWN pending/handled calculation
//   (excludeAwaitingSignatureId), so revalidation of the exact row being
//   approved no longer self-blocks on PENDING_ACTION_EXISTS/ALREADY_HANDLED.
// - BLOCKER (second pass): the persisted factual-basis/rule-snapshot
//   receipts are re-verified here too, not just authority — a partial
//   payment or rule edit since the draft was queued fails the approval
//   closed rather than sending stale money facts.
// - MEDIUM (second pass): a blocked (CLAIM_LOST) outcome now surfaces the
//   REAL prior claim status (sent/send_failed/uncertain/in_flight) so the
//   founder sees an accurate message, never a generic "already handled."
//
// The pre-existing ad-hoc path (arbitrary invoiceId + body, with no
// backing awaiting_signature/rule — InvoiceDetailPanel/CognitiveCompose's
// fully founder-composed sends) is UNCHANGED — it is not "founder approval
// of an Autopilot rule-backed draft" and was explicitly out of scope.
//
// Deploy: supabase functions deploy send-reminder-email
// Invoke from the app: supabase.functions.invoke('send-reminder-email', { body: {...} })
//
// Request body: EITHER { awaitingSignatureId, editedBody? } (approval-backed
// path, covers both "Approve & Send" and "Edit First") OR
// { invoiceId, subject?, body } (ad-hoc path, unchanged).
// Requires a valid user session (Authorization header) — verifies
// ownership server-side before sending anything, on both paths.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { sendEmail, isProviderConfigured } from '../_shared/resend.js'
import { corsHeaders } from '../_shared/cors.js'
import { executeApprovalSend, SEND_OUTCOME } from '../_shared/autopilotExecutionCore.js'
import { fetchAuthorityInputs } from '../_shared/autopilotAuthorityInputs.js'
import { resolveExistingClaimStatus, claimLostMessage } from '../_shared/executionClaim.js'

Deno.serve(async (req) => {
  // Browser preflight — must return the CORS headers with no auth check,
  // or the actual POST never gets sent by the browser at all.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (req.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405)
    }

    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    if (!jwt) {
      return json({ error: 'Not authenticated' }, 401)
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL'),
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    )

    const {
      data: { user },
      error: userErr,
    } = await admin.auth.getUser(jwt)
    if (userErr || !user) {
      return json({ error: 'Not authenticated' }, 401)
    }

    const requestBody = await req.json()

    if (requestBody.awaitingSignatureId) {
      return await handleApprovalSend({
        admin,
        userId: user.id,
        awaitingSignatureId: requestBody.awaitingSignatureId,
        editedBody: typeof requestBody.editedBody === 'string' ? requestBody.editedBody : null,
      })
    }

    const { invoiceId, subject, body } = requestBody
    if (!invoiceId || !body) {
      return json({ error: 'invoiceId and body are required' }, 400)
    }

    const { data: invoice, error: invErr } = await admin
      .from('invoices')
      .select('id, user_id, inv_num, clients(email, name)')
      .eq('id', invoiceId)
      .maybeSingle()

    if (invErr || !invoice) {
      return json({ error: 'Invoice not found' }, 404)
    }
    if (invoice.user_id !== user.id) {
      return json({ error: 'Not authorized for this invoice' }, 403)
    }

    // ASSUMPTION: clients.email is the real recipient column. Flagged for
    // the founder to confirm — if it errors here, this is the one line to fix.
    const to = invoice.clients?.email
    if (!to) {
      return json(
        { error: `${invoice.clients?.name || 'This client'} has no email on file.` },
        422
      )
    }

    const result = await sendEmail({
      to,
      subject: subject || `Regarding invoice ${invoice.inv_num || ''}`.trim(),
      text: body,
    })

    if (result.error) {
      return json({ error: result.error }, 502)
    }

    return json({ ok: true, id: result.id, status: result.status })
  } catch (err) {
    return json({ error: err?.message || 'Unexpected error' }, 500)
  }
})

// Founder approval of an Autopilot rule-backed draft — SignatureCard
// "Approve & Send" (editedBody omitted) and "Edit First" (editedBody
// supplied). Loads the awaiting_signature row's authority/factual-basis/
// rule-snapshot provenance server-side — never trusts a browser-supplied
// invoiceId/ruleId/draft. The founder may only ever influence the TEXT
// (editedBody); every identity/authority field is loaded and revalidated
// here, from the persisted row and fresh database state.
async function handleApprovalSend({ admin, userId, awaitingSignatureId, editedBody }) {
  const { data: row, error: rowErr } = await admin
    .from('awaiting_signature')
    .select('id, user_id, invoice_id, status, draft_content, ai_reason, ai_context')
    .eq('id', awaitingSignatureId)
    .maybeSingle()

  if (rowErr || !row) {
    return json({ error: 'Approval request not found' }, 404)
  }
  if (row.user_id !== userId) {
    return json({ error: 'Not authorized for this request' }, 403)
  }
  if (row.status !== 'pending') {
    return json({ error: 'This request has already been resolved' }, 409)
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
    // Legacy row created before this checkpoint (or before the factual-
    // basis/rule-snapshot fields existed) has insufficient provenance to
    // revalidate — fail closed rather than inventing any of it.
    return json(
      {
        error:
          'This request predates execution-safety tracking and cannot be safely approved automatically. Ask Duewatch to draft a new reminder for this invoice.',
      },
      409
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
  } catch (err) {
    return json({ error: err?.message || 'Send failed' }, 502)
  }

  switch (result.outcome) {
    case SEND_OUTCOME.SENT:
      return json({ ok: true, id: result.providerMessageId })
    case SEND_OUTCOME.CLAIM_LOST:
      // MEDIUM: never collapse sent/send_failed/uncertain/in_flight into
      // one generic message — a prior UNCERTAIN claim must never tell the
      // founder to generate another automatic contact.
      return json({ error: claimLostMessage(result.existingStatus) }, 409)
    case SEND_OUTCOME.STALE_AUTHORITY:
      return json(
        { error: `This reminder is no longer valid to send (${result.detail}). Ask Duewatch to draft a new one.` },
        409
      )
    case SEND_OUTCOME.PROVIDER_NOT_CONFIGURED:
      return json({ error: 'Email sending is not configured right now. Please try again shortly.' }, 502)
    case SEND_OUTCOME.NO_EMAIL_FALLBACK:
      return json({ error: 'This client has no email on file.' }, 422)
    default:
      return json({ error: 'Unexpected outcome' }, 500)
  }
}

// Real, Supabase-backed implementation of autopilotExecutionCore's `io`
// interface for the approval-backed path. Every write's error is checked
// and thrown, not silently ignored.
function buildApprovalIo({ admin, userId, row }) {
  const nowIso = () => new Date().toISOString()

  return {
    async fetchAuthorityInputs({ invoiceId }) {
      // BLOCKER (second pass): exclude ONLY this exact row from its own
      // pending/handled calculation, so revalidating the row being
      // approved doesn't self-block via PENDING_ACTION_EXISTS/
      // ALREADY_HANDLED. Every other row/history remains visible.
      return fetchAuthorityInputs(admin, { userId, invoiceId, excludeAwaitingSignatureId: row.id })
    },
    isProviderConfigured,
    async acquireClaim({ userId: uid, invoiceId, ruleId, actionType, idempotencyKey, receipt }) {
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
      if (claimRow?.acquired) {
        return { claimId: claimRow.claim_id, acquired: true }
      }
      // Third pass, MEDIUM: a failed status lookup must never be silently
      // read as "no status" (see resolveExistingClaimStatus's doc comment).
      let existingStatus = null
      if (claimRow?.claim_id) {
        const { data: existing, error: statusErr } = await admin
          .from('autopilot_execution_claims')
          .select('status')
          .eq('id', claimRow.claim_id)
          .maybeSingle()
        existingStatus = resolveExistingClaimStatus({ error: statusErr, status: existing?.status })
      }
      return { claimId: claimRow?.claim_id, acquired: false, existingStatus }
    },
    async resolveClaim({ claimId, status, providerMessageId, evidence }) {
      // Third pass, HIGH: resolution MERGES into the claim's evidence (via
      // the SQL function) rather than overwriting it, so the receipt
      // written at acquireClaim time is never clobbered.
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
      // An approval-backed send should already have a known email (it was
      // known at draft time); if it's since been removed, fail closed
      // rather than silently creating a duplicate draft.
      throw new Error('This client has no email on file.')
    },
    async recordSentEvidence({ claimId, sendResult, authority, reason, text, ruleSnapshot }) {
      const { error: remErr } = await admin.from('reminders').insert({
        invoice_id: row.invoice_id,
        user_id: userId,
        title: 'Reminder sent',
        detail: text,
      })
      if (remErr) throw remErr

      const { error: invErr } = await admin.from('invoices').update({ last_reminder: nowIso() }).eq('id', row.invoice_id)
      if (invErr) throw invErr

      const { error: sigErr } = await admin
        .from('awaiting_signature')
        .update({ status: 'approved', resolved_at: nowIso() })
        .eq('id', row.id)
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
          // MEDIUM (third pass): the full canonical rule snapshot alongside
          // its hash — defense-in-depth durable evidence, not a replacement.
          rule_snapshot: ruleSnapshot ?? null,
          authorized_at: authority?.evaluatedAt ?? null,
        },
      })
      if (evErr) throw evErr
    },
    async recordFailureEvidence({ claimId, error, authority, reason, ruleSnapshot }) {
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
          // MEDIUM (third pass): the full canonical rule snapshot alongside
          // its hash — defense-in-depth durable evidence, not a replacement.
          rule_snapshot: ruleSnapshot ?? null,
          authorized_at: authority?.evaluatedAt ?? null,
        },
      })
      if (evErr) throw evErr
    },
    async recordUncertainEvidence({ claimId, error, authority, reason, ruleSnapshot }) {
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
          delivery_status: 'Duewatch stopped automatically; completion could not be proven, so no retry was attempted.',
          error,
          execution_claim_id: claimId,
          rule_id: authority?.basis?.ruleId ?? null,
          rule_name: authority?.basis?.ruleName ?? null,
          rule_snapshot_hash: authority?.ruleSnapshotHash ?? null,
          // MEDIUM (third pass): the full canonical rule snapshot alongside
          // its hash — defense-in-depth durable evidence, not a replacement.
          rule_snapshot: ruleSnapshot ?? null,
          authorized_at: authority?.evaluatedAt ?? null,
        },
      })
      if (evErr) throw evErr
    },
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}
