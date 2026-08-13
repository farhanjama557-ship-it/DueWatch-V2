// Post-2A.1 execution safety checkpoint: the at-most-once auto-send
// execution boundary, extracted into a pure(ish) orchestration over an
// injected `io` interface so it is exercisable under `node --test` with
// fakes — no Deno, no network, no real Resend/Supabase connection — while
// remaining the exact same code path the real Deno scheduler and manual
// approval Edge Function (Approve & Send AND Edit First) both call. This
// is what makes "scheduler auto-send AND founder-approved sends use the
// same durable execution boundary" true structurally, not just by
// convention: all three call runClaimedSend().
//
// This module imports the byte-identical Deno copy of the Phase 2A.1
// authority engine (./nextActionAuthority.js) — never a second, simplified
// authority check invented for this boundary. The execution IDENTITY
// (user_id, invoice_id, rule_id, action_type) is untouched by this file —
// see executionClaim.js for that.
import { ACTION_TYPE_SEND_REMINDER, buildExecutionIdentity, buildIdempotencyKey } from './executionClaim.js'
import {
  evaluateNextActionAuthority,
  revalidateAuthority,
  buildRuleSnapshot,
  RULE_SNAPSHOT_FIELDS,
} from './nextActionAuthority.js'

export const SEND_OUTCOME = Object.freeze({
  SENT: 'sent',
  NO_EMAIL_FALLBACK: 'no_email_fallback',
  CLAIM_LOST: 'claim_lost',
  STALE_AUTHORITY: 'stale_authority',
  PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
})

// Small, deterministic, dependency-free formatters — deliberately the
// single source of truth for the invoice-fact strings actually baked into
// a draft's text, so the persisted factual-basis snapshot (below) can
// never drift from what the draft actually says: both are derived from
// this exact function, never computed twice independently.
function formatMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n) || 0)
}

function formatShortDate(value) {
  if (!value) return '—'
  const [y, m, d] = String(value).split('-').map(Number)
  if (!y || !m || !d) return '—'
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Second review-fix pass, BLOCKER: the material invoice facts a draft's
// wording depends on (balance, due date, client name) must be captured
// from the SAME fresh invoice state that authorized the draft, and
// re-derived at execution time to detect drift (a partial payment
// changing the balance, a due-date correction, a client rename) — never
// inferred by parsing the draft's own natural-language text.
export function deriveFactualBasis(invoice) {
  return {
    invoiceId: invoice.id,
    invNum: invoice.inv_num ?? null,
    balance: formatMoney((Number(invoice.amount) || 0) - (Number(invoice.amount_paid) || 0)),
    dueDate: formatShortDate(invoice.due_date),
    clientName: invoice.clients?.name || 'No client',
  }
}

export function factualBasisMatches(prior, current) {
  if (!prior || !current) return false
  return (
    prior.invoiceId === current.invoiceId &&
    prior.invNum === current.invNum &&
    prior.balance === current.balance &&
    prior.dueDate === current.dueDate &&
    prior.clientName === current.clientName
  )
}

// Second review-fix pass, MEDIUM (persisted rule snapshot integrity):
// Phase 2A.1's own ruleSnapshotHash doc comment says persisted
// action-receipt material should be reassessed for collision-resistance.
// revalidateAuthority() (untouched, locked) already does its own
// hash-based staleness check; this is a defense-in-depth exact-field
// comparison against the SAME canonical fields, run independently at the
// execution-core layer, so persisted receipts never rely on the 64-bit
// FNV hash alone once they're durable rather than ephemeral.
export function ruleSnapshotsMatch(prior, current) {
  if (!prior || !current) return false
  return RULE_SNAPSHOT_FIELDS.every((key) => prior[key] === current[key])
}

/**
 * io — injected dependencies. Real implementations (Deno, Supabase-backed)
 * live in autopilot-scheduler/index.ts and send-reminder-email/index.ts;
 * tests supply in-memory fakes.
 *
 *   fetchAuthorityInputs({ invoiceId }) ->
 *     { invoice, rules, autopilotSettings, handledKeys, pendingInvoiceIds }
 *   isProviderConfigured() -> boolean
 *   acquireClaim({ userId, invoiceId, ruleId, actionType, idempotencyKey }) ->
 *     { claimId, acquired, existingStatus? }
 *     (existingStatus is the PRIOR claim's real status when acquired is
 *     false — 'sent' | 'send_failed' | 'uncertain' | 'in_flight' — so a
 *     blocked caller can say what's actually known instead of a generic
 *     "already handled.")
 *   resolveClaim({ claimId, status, providerMessageId, evidence }) -> void
 *     (status is 'sent' | 'send_failed' | 'uncertain'; throws on write failure)
 *   sendEmail({ to, subject, text, idempotencyKey }) -> { id } | { error }
 *   recordSentEvidence({ claimId, sendResult, authority, reason, text }) -> void
 *   recordFailureEvidence({ claimId, error, authority, reason, text }) -> void
 *   recordUncertainEvidence({ claimId, error, authority, reason, text }) -> void
 *   queueForReview({ reason, draft, draftReason, tone, authority, factualBasis }) -> void
 *     (no-email fallback only; `reason` is the fixed fallback classification
 *     'no_email_on_file', `draft`/`draftReason`/`tone` are the message that
 *     would have been sent and its human-readable "why" explanation)
 */

// The shared tail: HIGH 1's provable-pre-send-precondition-before-claim
// ordering, the atomic claim, the send, and truthful resolution/evidence.
// Both executeAutoSend and executeApprovalSend call this identically once
// current authority (and, for approvals, current material facts) has
// already been confirmed by their own (different) re-check — this is the
// literal shared execution boundary BLOCKER 1 requires.
async function runClaimedSend({ userId, invoiceId, ruleId, invoice, subject, text, reason, tone, authority, io }) {
  const to = invoice?.clients?.email
  if (!to) {
    await io.queueForReview({
      reason: 'no_email_on_file',
      draft: text,
      draftReason: reason,
      tone,
      authority,
      factualBasis: deriveFactualBasis(invoice),
    })
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
    // below — sendEmail is never referenced on this path. existingStatus
    // (when the real io supplies it) lets the caller say what's actually
    // known rather than a generic "already handled."
    return { outcome: SEND_OUTCOME.CLAIM_LOST, existingStatus: claim?.existingStatus ?? null }
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
    // HIGH 2 (first pass): an uncertain attempt must leave visible durable
    // evidence that Duewatch stopped and will not auto-retry, distinct
    // from both "sent" and a definite failure — never silent.
    await io.recordUncertainEvidence({ claimId: claim.claimId, error: message, authority, reason, text })
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
    await io.recordFailureEvidence({ claimId: claim.claimId, error: sendResult.error, authority, reason, text })
    throw new Error(sendResult.error)
  }

  await io.resolveClaim({
    claimId: claim.claimId,
    status: 'sent',
    providerMessageId: sendResult.id || null,
    evidence: { resend_id: sendResult.id || null },
  })
  await io.recordSentEvidence({ claimId: claim.claimId, sendResult, authority, reason, text })

  return { outcome: SEND_OUTCOME.SENT, claimId: claim.claimId, providerMessageId: sendResult.id || null }
}

/**
 * The scheduler's auto-send boundary. `invoiceId`/`ruleId` are the
 * candidate already selected by planRun() at plan-time — BLOCKER 2
 * requires that candidate be re-proven against CURRENT authority
 * immediately before any claim/send, never trusted from plan-time alone.
 * `buildMessage(freshInvoice, freshRule, factualBasis)` builds the
 * subject/text FROM the fresh state this function re-establishes — never
 * from a plan-time snapshot (second pass, BLOCKER: fresh authority must
 * never be paired with a stale draft).
 */
export async function executeAutoSend({ userId, invoiceId, ruleId, buildMessage, now, io }) {
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

  const rule = inputs.rules.find((r) => r.id === evaluation.authority.basis.ruleId)
  const factualBasis = deriveFactualBasis(inputs.invoice)
  const { subject, text, reason } = buildMessage(inputs.invoice, rule, factualBasis)

  return runClaimedSend({
    userId,
    invoiceId,
    ruleId,
    invoice: inputs.invoice,
    subject,
    text,
    reason,
    tone: rule.tone,
    authority: evaluation.authority,
    io,
  })
}

/**
 * The founder-approval boundary (Approve & Send, and Edit First's
 * founder-edited variant — `text` may be edited wording, but never an
 * edited identity/authority). `priorAuthority`/`priorFactualBasis`/
 * `priorRuleSnapshot` are the receipts persisted on the awaiting_signature
 * row at draft-creation time — never invented here. A row missing any of
 * them (legacy, pre-checkpoint, or pre-this-pass) fails closed via
 * revalidateAuthority's own PRIOR_AUTHORITY_INVALID outcome, or via the
 * factual-basis/rule-snapshot checks below returning stale, exactly as if
 * the underlying state had genuinely changed — "no proof it hasn't
 * changed" and "proof it changed" are treated identically: never send.
 */
export async function executeApprovalSend({
  userId,
  priorAuthority,
  priorFactualBasis,
  priorRuleSnapshot,
  invoiceId,
  text,
  reason,
  now,
  io,
}) {
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

  const ruleId = revalidation.checkedRuleId
  const currentRule = inputs.rules.find((r) => r.id === ruleId)
  if (!ruleSnapshotsMatch(priorRuleSnapshot, buildRuleSnapshot(currentRule))) {
    return { outcome: SEND_OUTCOME.STALE_AUTHORITY, detail: 'rule_changed' }
  }

  const currentFactualBasis = deriveFactualBasis(inputs.invoice)
  if (!factualBasisMatches(priorFactualBasis, currentFactualBasis)) {
    return { outcome: SEND_OUTCOME.STALE_AUTHORITY, detail: 'material_facts_changed' }
  }

  return runClaimedSend({
    userId,
    invoiceId,
    ruleId,
    invoice: inputs.invoice,
    subject: `Regarding invoice ${inputs.invoice.inv_num || ''}`.trim(),
    text,
    reason,
    authority: revalidation.authority,
    io,
  })
}
