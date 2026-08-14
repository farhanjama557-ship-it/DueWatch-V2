// Phase 2A.2 — "Pulse Consumes Authority."
//
// FACTS MAY BE DERIVED. POLICY MUST BE GRANTED.
//
// Pulse (Dashboard) must not invent its own recommendation logic — every
// non-null recommendation it shows has to come from the same deterministic
// evaluateNextActionAuthority() contract the scheduler and manual-approval
// Edge Function already use (see nextActionAuthority.js's own header
// comment). This module computes exactly ONE evaluation per invoice and
// hands back a lookup Pulse's components share, so no two parts of the
// Dashboard can independently "re-decide" a different answer for the same
// invoice — a second recommendation engine is exactly what this checkpoint
// exists to remove, not add.
import { evaluateNextActionAuthority } from './nextActionAuthority.js'

// handledKeys/pendingInvoiceIds are passed straight through, unmodified,
// to evaluateNextActionAuthority for every invoice. Callers must pass real
// Set instances only when the underlying query actually succeeded — pass
// null/undefined (never an invented empty Set) when a load-bearing query
// failed, and evaluateNextActionAuthority's own isValidExecutionHistory()
// check will fail every evaluation closed with
// blockedReason: 'execution_history_unavailable', exactly as the Deno
// execution boundary already does. This module never launders that
// distinction away.
export function evaluatePulseAuthority({
  userId,
  invoices,
  rules,
  autopilotSettings,
  handledKeys,
  pendingInvoiceIds,
  now = new Date(),
}) {
  const byInvoiceId = new Map()
  for (const invoice of invoices || []) {
    byInvoiceId.set(
      invoice.id,
      evaluateNextActionAuthority({
        userId,
        invoice,
        rules,
        autopilotSettings,
        handledKeys,
        pendingInvoiceIds,
        now,
      })
    )
  }
  return byInvoiceId
}

// True only when this invoice is BOTH currently authorized by a real
// founder rule AND permitted to be acted on without approval. Authorized
// alone is not enough — an authorized-but-approval-required invoice is not
// "handled automatically," it is queued for a founder decision.
export function isAuthorizedForAutomaticHandling(evaluation) {
  return evaluation?.authority?.authorized === true && evaluation?.permission?.canActAutomatically === true
}

// Phase 2A.2 — the load-bearing success/failure distinction pulled out as
// its own pure, testable unit: `rows === null` means the query FAILED (see
// DataContext.jsx's awaitingHistoryPromise/executionClaimsPromise), and
// that must produce `null` here too — never an empty Set that would read
// as "checked, found none." A real (possibly empty) array produces a real
// Set. `awaitingRows` here is the FULL, all-status awaiting_signature
// history (not pre-filtered to pending) — pendingInvoiceIds filters to
// `status === 'pending'` itself.
export function toPendingInvoiceIds(awaitingRows) {
  if (awaitingRows === null) return null
  return new Set(awaitingRows.filter((r) => r.status === 'pending').map((r) => r.invoice_id))
}

// HIGH fix, parity with supabase/functions/_shared/autopilotAuthorityInputs.js's
// fetchHandledState(): a rule is "already handled" for an invoice if EITHER
// a durable execution claim exists OR any awaiting_signature row of ANY
// status (pending, approved, skipped/rejected — a founder decision was
// already made, or is in flight) carries that rule's id in ai_context. This
// is intentionally the same union both sources of truth compute, so Pulse
// and the real execution boundary can never disagree about what's already
// been decided. A row without ai_context.rule_id (legacy/ad-hoc, no
// authority provenance) contributes nothing — never invented.
//
// The Deno version additionally supports `excludeAwaitingSignatureId`, for
// the one caller (the approval Edge Function) that is revalidating the
// exact row it's about to act on and would otherwise self-block on its own
// pending/handled contribution. Pulse is read-only display, never
// revalidating a specific row it's mid-approving, so it always uses every
// current row — no self-exclusion parameter here.
export function toHandledKeys(executionClaimRows, awaitingRows) {
  if (executionClaimRows === null || awaitingRows === null) return null
  const keys = new Set(executionClaimRows.map((c) => `${c.invoice_id}:${c.rule_id}`))
  for (const row of awaitingRows) {
    const ruleId = row?.ai_context?.rule_id
    if (ruleId) keys.add(`${row.invoice_id}:${ruleId}`)
  }
  return keys
}
