// Post-2A.1 execution safety checkpoint: the at-most-once auto-send
// execution boundary, extracted into a pure(ish) orchestration over an
// injected `io` interface so it is exercisable under `node --test` with
// fakes — no Deno, no network, no real Resend/Supabase connection — while
// remaining the exact same code path the real Deno scheduler and manual
// approval Edge Function both call. This is what makes "scheduler auto-send
// AND founder Approve & Send use the same durable execution boundary" true
// structurally, not just by convention: both call runClaimedSend().
//
// This module imports the byte-identical Deno copy of the Phase 2A.1
// authority engine (./nextActionAuthority.js) — never a second, simplified
// authority check invented for this boundary.
import { ACTION_TYPE_SEND_REMINDER, buildExecutionIdentity, buildIdempotencyKey } from './executionClaim.js'
import { evaluateNextActionAuthority, revalidateAuthority } from './nextActionAuthority.js'

export const SEND_OUTCOME = Object.freeze({
  SENT: 'sent',
  NO_EMAIL_FALLBACK: 'no_email_fallback',
  CLAIM_LOST: 'claim_lost',
  STALE_AUTHORITY: 'stale_authority',
  PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
})

/**
 * io — injected dependencies. Real implementations (Deno, Supabase-backed)
 * live in autopilot-scheduler/index.ts and send-reminder-email/index.ts;
 * tests supply in-memory fakes.
 *
 *   fetchAuthorityInputs({ invoiceId }) ->
 *     { invoice, rules, autopilotSettings, handledKeys, pendingInvoiceIds }
 *   isProviderConfigured() -> boolean
 *   acquireClaim({ userId, invoiceId, ruleId, actionType, idempotencyKey }) ->
 *     { claimId, acquired }
 *   resolveClaim({ claimId, status, providerMessageId, evidence }) -> void
 *     (status is 'sent' | 'send_failed' | 'uncertain'; throws on write failure)
 *   sendEmail({ to, subject, text, idempotencyKey }) -> { id } | { error }
 *   recordSentEvidence({ claimId, sendResult }) -> void
 *   recordFailureEvidence({ claimId, error }) -> void
 *   recordUncertainEvidence({ claimId, error }) -> void
 *   queueForReview({ reason }) -> void   (no-email fallback only)
 */

// The shared tail: HIGH 1's provable-pre-send-precondition-before-claim
// ordering, the atomic claim, the send, and truthful resolution/evidence.
// Both executeAutoSend and executeApprovalSend call this identically once
// current authority has already been confirmed by their own (different)
// re-check — this is the literal shared execution boundary BLOCKER 1
// requires.
async function runClaimedSend({ userId, invoiceId, ruleId, invoice, subject, text, io }) {
  const to = invoice?.clients?.email
  if (!to) {
    await io.queueForReview({ reason: 'no_email_on_file' })
    return { outcome: SEND_OUTCOME.NO_EMAIL_FALLBACK }
  }

  // HIGH 1: provable pre-send preconditions (checkable without an external
  // request) must be verified BEFORE claim acquisition, so a failure here
  // never permanently consumes the execution identity — it's naturally
  // retryable next time because no claim row is ever created.
  if (!io.isProviderConfigured()) {
    return { outcome: SEND_OUTCOME.PROVIDER_NOT_CONFIGURED }
  }

  const identity = buildExecutionIdentity({ userId, invoiceId, ruleId, actionType: ACTION_TYPE_SEND_REMINDER })
  const idempotencyKey = buildIdempotencyKey(identity)
  if (!identity || !idempotencyKey) {
    throw new Error(`Cannot acquire an execution claim: malformed identity for invoice ${invoiceId}, rule ${ruleId}`)
  }

  const claim = await io.acquireClaim({
    userId,
    invoiceId,
    ruleId,
    actionType: ACTION_TYPE_SEND_REMINDER,
    idempotencyKey,
  })
  if (!claim?.acquired) {
    // Lost the race, or already durably handled. Zero provider-send calls
    // below — sendEmail is never referenced on this path.
    return { outcome: SEND_OUTCOME.CLAIM_LOST }
  }

  let sendResult
  try {
    sendResult = await io.sendEmail({ to, subject, text, idempotencyKey })
  } catch (err) {
    // An exception means we cannot prove whether the provider received the
    // request — genuinely uncertain, never automatically retried (the
    // claim row's mere existence is what blocks reacquisition, regardless
    // of this status).
    const message = err instanceof Error ? err.message : String(err)
    await io.resolveClaim({ claimId: claim.claimId, status: 'uncertain', evidence: { error: message } })
    // HIGH 2: an uncertain attempt must leave visible durable evidence that
    // Duewatch stopped and will not auto-retry, distinct from both "sent"
    // and a definite failure — never silent.
    await io.recordUncertainEvidence({ claimId: claim.claimId, error: message })
    throw err
  }

  if (sendResult.error) {
    // A clean response reporting a definite failure — still never
    // auto-retried by a later run/approval attempt.
    await io.resolveClaim({
      claimId: claim.claimId,
      status: 'send_failed',
      evidence: { error: sendResult.error },
    })
    await io.recordFailureEvidence({ claimId: claim.claimId, error: sendResult.error })
    throw new Error(sendResult.error)
  }

  await io.resolveClaim({
    claimId: claim.claimId,
    status: 'sent',
    providerMessageId: sendResult.id || null,
    evidence: { resend_id: sendResult.id || null },
  })
  await io.recordSentEvidence({ claimId: claim.claimId, sendResult })

  return { outcome: SEND_OUTCOME.SENT, claimId: claim.claimId, providerMessageId: sendResult.id || null }
}

/**
 * The scheduler's auto-send boundary. `invoiceId`/`ruleId` are the
 * candidate already selected by planRun() at plan-time — BLOCKER 2
 * requires that candidate be re-proven against CURRENT authority
 * immediately before any claim/send, never trusted from plan-time alone.
 */
export async function executeAutoSend({ userId, invoiceId, ruleId, subject, text, now, io }) {
  const inputs = await io.fetchAuthorityInputs({ invoiceId })
  const evaluation = evaluateNextActionAuthority({
    userId,
    invoice: inputs.invoice,
    rules: inputs.rules,
    autopilotSettings: inputs.autopilotSettings,
    handledKeys: inputs.handledKeys,
    pendingInvoiceIds: inputs.pendingInvoiceIds,
    now,
  })

  if (
    !evaluation.authority.authorized ||
    evaluation.authority.basis.ruleId !== ruleId ||
    !evaluation.permission.canActAutomatically
  ) {
    return { outcome: SEND_OUTCOME.STALE_AUTHORITY, detail: evaluation.authority.blockedReason || 'permission_denied' }
  }

  return runClaimedSend({ userId, invoiceId, ruleId, invoice: inputs.invoice, subject, text, io })
}

/**
 * The founder-approval boundary (Approve & Send). `priorAuthority` is the
 * authority receipt persisted on the awaiting_signature row at
 * draft-creation time — never invented here. A row without one (legacy,
 * pre-checkpoint) must be rejected by the caller before this is ever
 * invoked; this function itself fails closed on a malformed priorAuthority
 * via revalidateAuthority's own PRIOR_AUTHORITY_INVALID outcome.
 */
export async function executeApprovalSend({ userId, priorAuthority, invoiceId, subject, text, now, io }) {
  const inputs = await io.fetchAuthorityInputs({ invoiceId })
  const revalidation = revalidateAuthority({
    userId,
    priorAuthority,
    invoice: inputs.invoice,
    currentRules: inputs.rules,
    currentAutopilotSettings: inputs.autopilotSettings,
    currentHandledKeys: inputs.handledKeys,
    currentPendingInvoiceIds: inputs.pendingInvoiceIds,
    now,
  })

  if (revalidation.outcome !== 'valid') {
    return { outcome: SEND_OUTCOME.STALE_AUTHORITY, detail: revalidation.outcome }
  }

  return runClaimedSend({
    userId,
    invoiceId,
    ruleId: revalidation.checkedRuleId,
    invoice: inputs.invoice,
    subject,
    text,
    io,
  })
}
