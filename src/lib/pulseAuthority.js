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
import { evaluateNextActionAuthority, AUTHORITY_BLOCK_REASONS } from './nextActionAuthority.js'

// handledKeys/pendingInvoiceIds are passed straight through, unmodified,
// to evaluateNextActionAuthority for every invoice. Callers must pass real
// Set instances only when the underlying query actually succeeded — pass
// null/undefined (never an invented empty Set) when a load-bearing query
// failed, and evaluateNextActionAuthority's own isValidExecutionHistory()
// check will fail every evaluation closed with
// blockedReason: 'execution_history_unavailable', exactly as the Deno
// execution boundary already does. This module never launders that
// distinction away.
//
// HIGH fix (adversarial review): `rules` gets the SAME treatment.
// nextActionAuthority.js's own rule handling silently coerces a non-array
// `rules` into `[]` (`Array.isArray(rules) ? rules : []`) — appropriate
// for ITS contract (a caller who successfully queried zero rules), but
// wrong for Pulse if the rule query itself failed: that would silently
// read as "genuinely zero rules exist" (a real fact -> "No matching
// rule") instead of "couldn't verify" (the true state). This module never
// calls evaluateNextActionAuthority at all when `rules` isn't a real
// array — every invoice gets `null` in the map instead, and
// classifyPulseAuthority's own `!evaluation` branch (below) already
// reports that truthfully as unavailable. nextActionAuthority.js itself
// is untouched.
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
  const rulesAvailable = Array.isArray(rules)
  for (const invoice of invoices || []) {
    byInvoiceId.set(
      invoice.id,
      rulesAvailable
        ? evaluateNextActionAuthority({
            userId,
            invoice,
            rules,
            autopilotSettings,
            handledKeys,
            pendingInvoiceIds,
            now,
          })
        : null
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

// HIGH fix (adversarial review): a single, truthful classification of
// WHAT an authority evaluation actually says — never collapsed into "No
// matching rule" for every non-authorized case, which was false for
// ALREADY_HANDLED/PENDING_ACTION_EXISTS/EXECUTION_HISTORY_UNAVAILABLE/
// malformed states alike. This is presentation logic ONLY — it never
// re-derives authority itself (that's still 100% evaluateNextActionAuthority's
// job) and never invents a new blockedReason vocabulary; it just maps the
// REAL vocabulary AUTHORITY_BLOCK_REASONS already defines to a state a UI
// may safely render. Raw enum strings (e.g. 'already_handled' as literal
// developer text) are never the thing shown to a founder — see
// PULSE_STATE_COPY below for the actual copy.
//
// Second review-fix pass: three DISTINCT "couldn't verify" states, not
// one generic one — a founder should never be told "action history"
// couldn't be verified when the real cause was the rule query or the
// Autopilot settings query failing instead.
export const PULSE_STATE = Object.freeze({
  AUTHORIZED_AUTOMATIC: 'authorized_automatic',
  AUTHORIZED_APPROVAL_REQUIRED: 'authorized_approval_required',
  AWAITING_APPROVAL: 'awaiting_approval',
  ALREADY_HANDLED: 'already_handled',
  NEEDS_REVIEW_RULES_UNAVAILABLE: 'needs_review_rules_unavailable',
  NEEDS_REVIEW_SETTINGS_UNAVAILABLE: 'needs_review_settings_unavailable',
  NEEDS_REVIEW_HISTORY_UNAVAILABLE: 'needs_review_history_unavailable',
  NEEDS_REVIEW_MALFORMED: 'needs_review_malformed',
  NO_RULE: 'no_rule',
})

// The only founder-facing copy for each state. Deliberately plain,
// truthful sentences — never a raw AUTHORITY_BLOCK_REASONS string, never a
// softened/urgency-implying claim.
export const PULSE_STATE_COPY = Object.freeze({
  [PULSE_STATE.AWAITING_APPROVAL]: 'Awaiting your approval',
  [PULSE_STATE.ALREADY_HANDLED]: 'Already handled',
  [PULSE_STATE.NEEDS_REVIEW_RULES_UNAVAILABLE]: "Duewatch couldn't verify the current rule state.",
  [PULSE_STATE.NEEDS_REVIEW_SETTINGS_UNAVAILABLE]:
    "Duewatch couldn't verify the current Autopilot/permission state.",
  [PULSE_STATE.NEEDS_REVIEW_HISTORY_UNAVAILABLE]: "Duewatch couldn't verify the current action history.",
  [PULSE_STATE.NEEDS_REVIEW_MALFORMED]: "Duewatch couldn't verify the current rule state.",
  [PULSE_STATE.NO_RULE]: 'No matching rule',
})

// `evaluation` is exactly what evaluatePulseAuthority's Map holds for one
// invoice: the real evaluateNextActionAuthority() result, or `null` when
// the rule query itself was unavailable (see evaluatePulseAuthority's own
// doc comment) — `null` here is itself a truthful "couldn't verify"
// signal, not an absence of information to paper over.
//
// `settingsUnavailable` (HIGH fix, second review pass): the Autopilot
// settings query failing is a THIRD, independent unavailable condition —
// distinct from both the rule query and evaluateNextActionAuthority's own
// execution-history check. It is passed in separately (not folded into
// `evaluation`) because nextActionAuthority.js itself already handles a
// missing settings object safely and conservatively (no automatic
// permission, requiresApproval defaults true) — that internal behavior is
// correct and untouched. The bug this fixes is purely a DISPLAY one: an
// `evaluation` built from unavailable settings can still say
// "authorized, approval required," which is true only in the narrow sense
// that nextActionAuthority.js's safe default happens to read that way —
// it must never be presented as an observed, real founder policy. When
// settings are unavailable, this OVERRIDES any authorized/blocked reading
// from `evaluation` and reports the real unknown instead.
export function classifyPulseAuthority(evaluation, { settingsUnavailable = false } = {}) {
  if (!evaluation) {
    return {
      state: PULSE_STATE.NEEDS_REVIEW_RULES_UNAVAILABLE,
      label: PULSE_STATE_COPY[PULSE_STATE.NEEDS_REVIEW_RULES_UNAVAILABLE],
    }
  }

  if (settingsUnavailable) {
    return {
      state: PULSE_STATE.NEEDS_REVIEW_SETTINGS_UNAVAILABLE,
      label: PULSE_STATE_COPY[PULSE_STATE.NEEDS_REVIEW_SETTINGS_UNAVAILABLE],
    }
  }

  const { authority, permission } = evaluation
  if (authority?.authorized === true) {
    return permission?.canActAutomatically === true
      ? { state: PULSE_STATE.AUTHORIZED_AUTOMATIC, label: null }
      : { state: PULSE_STATE.AUTHORIZED_APPROVAL_REQUIRED, label: null }
  }

  switch (authority?.blockedReason) {
    case AUTHORITY_BLOCK_REASONS.PENDING_ACTION_EXISTS:
      return { state: PULSE_STATE.AWAITING_APPROVAL, label: PULSE_STATE_COPY[PULSE_STATE.AWAITING_APPROVAL] }
    case AUTHORITY_BLOCK_REASONS.ALREADY_HANDLED:
      return { state: PULSE_STATE.ALREADY_HANDLED, label: PULSE_STATE_COPY[PULSE_STATE.ALREADY_HANDLED] }
    case AUTHORITY_BLOCK_REASONS.EXECUTION_HISTORY_UNAVAILABLE:
      return {
        state: PULSE_STATE.NEEDS_REVIEW_HISTORY_UNAVAILABLE,
        label: PULSE_STATE_COPY[PULSE_STATE.NEEDS_REVIEW_HISTORY_UNAVAILABLE],
      }
    case AUTHORITY_BLOCK_REASONS.MALFORMED_RULE_STATE:
    case AUTHORITY_BLOCK_REASONS.AMBIGUOUS_RULE_PRECEDENCE:
    case AUTHORITY_BLOCK_REASONS.TENANT_MISMATCH:
      // TENANT_MISMATCH should never legitimately occur for an invoice
      // Pulse itself loaded for the signed-in founder — if it somehow
      // does, treat it the same as "couldn't verify," never as "no rule."
      return {
        state: PULSE_STATE.NEEDS_REVIEW_MALFORMED,
        label: PULSE_STATE_COPY[PULSE_STATE.NEEDS_REVIEW_MALFORMED],
      }
    case null:
    case undefined:
      // The one genuine case: authority ran, found no blocking condition,
      // and simply found no rule that currently matches.
      return { state: PULSE_STATE.NO_RULE, label: PULSE_STATE_COPY[PULSE_STATE.NO_RULE] }
    default:
      // An unrecognized/future blockedReason value fails closed to "needs
      // review" rather than silently defaulting to "No matching rule."
      return {
        state: PULSE_STATE.NEEDS_REVIEW_MALFORMED,
        label: PULSE_STATE_COPY[PULSE_STATE.NEEDS_REVIEW_MALFORMED],
      }
  }
}

// MEDIUM fix (adversarial review): ONE mutually-exclusive per-invoice
// workflow state, shared by the Action column's button/label AND the
// decision-count math below — so "how should this row's action cell
// render" and "does this invoice count as a founder decision" can never
// silently disagree with each other.
//
// Second review-fix pass, MEDIUM: AUTHORIZED_APPROVAL_REQUIRED is its own
// row state now — it used to fall through to MANUAL, which rendered the
// same "Choose action" affordance as a genuine no-rule invoice even
// though a real rule already granted authority here.
export const PULSE_ROW_STATE = Object.freeze({
  AWAITING_APPROVAL: 'awaiting_approval',
  AUTOMATED: 'automated',
  AUTHORIZED_APPROVAL_REQUIRED: 'authorized_approval_required',
  ALREADY_HANDLED: 'already_handled',
  NEEDS_REVIEW: 'needs_review',
  MANUAL: 'manual',
})

// Second review-fix pass, HIGH: derives ENTIRELY from
// classifyPulseAuthority's own state (single source of truth), rather
// than a separate isAuthorizedForAutomaticHandling check racing against
// it — so a real authority AWAITING_APPROVAL result is always honored
// even if the optimistic `awaitingInvoiceIds` list has already removed
// the card (e.g. mid-resolution, before DataContext's next background
// poll or local reconciliation catches up). `awaitingInvoiceIds` is kept
// only as a fast, currently-visible-card precedence check — it can never
// cause a real AWAITING_APPROVAL evaluation to be missed, only recognize
// it slightly earlier.
export function classifyPulseRowState(invoiceId, { awaitingInvoiceIds, evaluation, settingsUnavailable = false }) {
  if (awaitingInvoiceIds.has(invoiceId)) return PULSE_ROW_STATE.AWAITING_APPROVAL
  const classified = classifyPulseAuthority(evaluation, { settingsUnavailable })
  switch (classified.state) {
    case PULSE_STATE.AWAITING_APPROVAL:
      return PULSE_ROW_STATE.AWAITING_APPROVAL
    case PULSE_STATE.AUTHORIZED_AUTOMATIC:
      return PULSE_ROW_STATE.AUTOMATED
    case PULSE_STATE.AUTHORIZED_APPROVAL_REQUIRED:
      return PULSE_ROW_STATE.AUTHORIZED_APPROVAL_REQUIRED
    case PULSE_STATE.ALREADY_HANDLED:
      return PULSE_ROW_STATE.ALREADY_HANDLED
    case PULSE_STATE.NO_RULE:
      return PULSE_ROW_STATE.MANUAL
    default:
      // Every "couldn't verify" state (rules/settings/history/malformed).
      return PULSE_ROW_STATE.NEEDS_REVIEW
  }
}

// MEDIUM fix (adversarial review): mutually-exclusive decision counting,
// pulled out as its own pure, testable unit — Dashboard's headline/bell/
// subline math and the Action column's own per-row classification can
// never silently disagree, because both are now built from the SAME
// classifyPulseRowState() call. An invoice that is AWAITING_APPROVAL is
// counted once, by the caller, via its own awaitingSignature row count —
// never a second time here as "blocked." AUTOMATED and ALREADY_HANDLED
// invoices are genuinely not open founder decisions, and neither is
// AUTHORIZED_APPROVAL_REQUIRED on its own — that becomes a real decision
// only once a draft actually exists (AWAITING_APPROVAL). MANUAL and
// NEEDS_REVIEW both are open decisions right now.
export function countBlockedDecisions(invoices, { awaitingInvoiceIds, pulseAuthority, settingsUnavailable = false }) {
  return (invoices || []).filter((inv) => {
    const state = classifyPulseRowState(inv.id, {
      awaitingInvoiceIds,
      evaluation: pulseAuthority.get(inv.id),
      settingsUnavailable,
    })
    return state === PULSE_ROW_STATE.MANUAL || state === PULSE_ROW_STATE.NEEDS_REVIEW
  }).length
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
