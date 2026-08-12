// Phase 2A.1 — the deterministic authority contract every future Pulse
// recommendation depends on.
//
// FACTS MAY BE DERIVED. POLICY MUST BE GRANTED.
//
// A non-null recommendation must be backed by a real, persisted, currently
// enabled founder rule (`autopilot_rules`). If no enabled rule currently
// matches an invoice, the recommendation is null — not softened, not
// hedged, not an inferred escalation. Zero working rules = facts only.
//
// This module does not decide ranking/priority (`recommend.js`'s
// "High priority"/"Firm"/"Follow up" badges are exactly the invented-policy
// pattern this contract exists to replace, but rewriting that file is Pulse
// UI work and explicitly out of scope here) and never fabricates a "no
// response" fact from `last_reminder` alone — no evidence source in this
// app currently proves a client responded to anything.
//
// Reuses the app's one existing deterministic rule engine rather than
// building a second one: `ruleMatches`/`nextScheduledAction` from
// `./ruleSchedule` (same matching semantics as the live scheduler's Deno
// mirror, `supabase/functions/_shared/rules.js`). `nextScheduledAction`
// already encodes "the most-advanced matching enabled rule wins, never the
// first in array order" — this module reuses that exact selection, it does
// not re-decide it.

import { daysOverdue, daysUntil } from './format.js'
import { ruleMatches, nextScheduledAction } from './ruleSchedule.js'

// The only action an autopilot_rules row currently authorizes is sending a
// reminder at some tone/timing — there is no "escalate"/"call client"/etc.
// in the current rule model, so this is the one honest action identifier.
export const ACTION_SEND_REMINDER = 'send_reminder'

export const REVALIDATION_OUTCOMES = Object.freeze({
  VALID: 'valid',
  PRIOR_AUTHORITY_INVALID: 'prior_authority_invalid',
  RULE_NOT_FOUND: 'rule_not_found',
  MALFORMED_RULE_STATE: 'malformed_rule_state',
  RULE_DISABLED: 'rule_disabled',
  RULE_CHANGED: 'rule_changed',
  INVOICE_NO_LONGER_MATCHES: 'invoice_no_longer_matches',
})

// Canonical policy-relevant fields for the rule snapshot fingerprint.
// Deliberately excludes `name` (a label; renaming a rule doesn't change
// what it authorizes), `sort_order` (display ordering only, and this
// checkpoint does not implement prioritization policy), and `created_at`
// (unstable metadata, never policy-relevant) — matching the instruction to
// include only fields that materially change what action a rule
// authorizes.
export const RULE_SNAPSHOT_FIELDS = Object.freeze([
  'id',
  'trigger_type',
  'trigger_days',
  'tone',
  'enabled',
])

const VALID_TRIGGER_TYPES = new Set(['before_due', 'after_due'])

// A rule that fails this check cannot authorize anything — it is excluded
// from matching entirely (fail closed), the same as a rule that simply
// doesn't exist. This covers both structurally malformed rules (missing/
// wrong-typed fields) and rules carrying an unrecognized trigger_type.
export function isWellFormedRule(rule) {
  if (!rule || typeof rule !== 'object') return false
  if (rule.id === null || rule.id === undefined) return false
  if (!VALID_TRIGGER_TYPES.has(rule.trigger_type)) return false
  if (typeof rule.trigger_days !== 'number' || !Number.isFinite(rule.trigger_days) || rule.trigger_days < 0) {
    return false
  }
  if (typeof rule.tone !== 'string' || rule.tone.trim() === '') return false
  if (typeof rule.enabled !== 'boolean') return false
  return true
}

export function buildRuleSnapshot(rule) {
  return {
    id: rule.id,
    trigger_type: rule.trigger_type,
    trigger_days: rule.trigger_days,
    tone: rule.tone,
    enabled: rule.enabled === true,
  }
}

// Deterministic, sorted-key JSON so key insertion order can never change
// the fingerprint, and so stray extra fields on the input object (anything
// not in RULE_SNAPSHOT_FIELDS) never leak into it.
function canonicalizeSnapshot(snapshot) {
  const sorted = {}
  for (const key of RULE_SNAPSHOT_FIELDS) sorted[key] = snapshot[key]
  return JSON.stringify(sorted)
}

// 32-bit FNV-1a, run twice with different seeds for a 64-bit-wide hex
// fingerprint. Deliberately NOT the SHA-256 used by
// `importPersistence/materialPayload.js` — that hash has to survive
// network idempotency retries and needs real collision resistance, and is
// async (webcrypto). This hash is evidence of which policy state was
// evaluated, not a security boundary (see the doctrine at the top of this
// file: the hash matching or merely existing never implies authorization),
// so a small synchronous non-cryptographic fingerprint is the right tool —
// it also lets this whole module stay synchronous end to end.
function fnv1a32(str, seed) {
  let hash = seed >>> 0
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function hashRuleSnapshot(snapshot) {
  const canonical = canonicalizeSnapshot(snapshot)
  const lo = fnv1a32(canonical, 0x811c9dc5)
  const hi = fnv1a32(canonical, 0x9e3779b9)
  return lo.toString(16).padStart(8, '0') + hi.toString(16).padStart(8, '0')
}

// `events` (evaluate) / `currentEvents` (revalidate) are accepted for
// future evidence sources — e.g. an eventual explicit reply/response
// tracking feature — but are not consulted today. No such evidence source
// is currently defined anywhere in this app, and `last_reminder` alone
// must never be used to imply a response outcome (see REMINDER TRUTH in
// the checkpoint brief). Facts here are therefore limited to what the
// invoice row itself proves: elapsed time, not client behavior.
function deriveFacts(invoice, now) {
  if (!invoice || typeof invoice !== 'object') {
    return {
      amountOutstanding: null,
      dueDate: null,
      daysOverdue: null,
      daysUntilDue: null,
      paid: null,
      lastReminderAt: null,
      daysSinceLastReminder: null,
    }
  }
  const amount = Number(invoice.amount) || 0
  const amountPaid = Number(invoice.amount_paid) || 0
  const lastReminderAt = invoice.last_reminder ?? null
  const daysSinceLastReminder = lastReminderAt
    ? Math.floor((now.getTime() - new Date(lastReminderAt).getTime()) / 86400000)
    : null

  return {
    amountOutstanding: Math.max(0, amount - amountPaid),
    dueDate: invoice.due_date ?? null,
    daysOverdue: daysOverdue(invoice.due_date, now),
    daysUntilDue: daysUntil(invoice.due_date, now),
    paid: invoice.paid === true,
    lastReminderAt,
    daysSinceLastReminder,
  }
}

// Permission ("may Duewatch execute without approval?") is a separate
// question from policy ("what action applies?") and is always recomputed
// from CURRENT settings, never carried over from a prior evaluation.
// Missing/unset autopilotSettings default to the safest reading:
// autopilot not enabled, approval required.
function derivePermission({ autopilotSettings, invoice }) {
  const autopilotEnabled = autopilotSettings?.enabled === true
  const requiresApproval = autopilotSettings?.approval_required !== false
  const invoicePaused = invoice?.autopilot_paused === true
  return {
    requiresApproval,
    canActAutomatically: autopilotEnabled && !invoicePaused && !requiresApproval,
  }
}

const UNAUTHORIZED_PERMISSION = Object.freeze({ requiresApproval: null, canActAutomatically: false })

/**
 * evaluateNextActionAuthority({ invoice, rules, autopilotSettings, events, now })
 *
 * Pure, synchronous, deterministic. Returns:
 *   {
 *     facts:          real, derivable state — never policy language
 *     recommendation: null, or { action, tone, ruleId, ruleName }
 *     authority:      { authorized, basis, ruleSnapshotHash, evaluatedAt }
 *     permission:     { requiresApproval, canActAutomatically }
 *   }
 *
 * recommendation is non-null only when authority.authorized is true, which
 * requires a real persisted, currently enabled rule whose window currently
 * matches the invoice (via the app's existing ruleSchedule.js matcher).
 */
export function evaluateNextActionAuthority({ invoice, rules, autopilotSettings, events, now = new Date() } = {}) {
  const evaluatedAt = now.toISOString()
  const facts = deriveFacts(invoice, now)

  const unauthorized = () => ({
    facts,
    recommendation: null,
    authority: { authorized: false, basis: null, ruleSnapshotHash: null, evaluatedAt },
    permission: UNAUTHORIZED_PERMISSION,
  })

  if (!invoice || typeof invoice !== 'object') return unauthorized()

  const safeRules = Array.isArray(rules) ? rules.filter(isWellFormedRule) : []
  const match = nextScheduledAction(safeRules, invoice, now)
  if (!match || !match.eligible) return unauthorized()

  const rule = match.rule
  const ruleSnapshotHash = hashRuleSnapshot(buildRuleSnapshot(rule))

  return {
    facts,
    recommendation: {
      action: ACTION_SEND_REMINDER,
      tone: rule.tone,
      ruleId: rule.id,
      ruleName: rule.name ?? null,
    },
    authority: {
      authorized: true,
      basis: { ruleId: rule.id, ruleName: rule.name ?? null },
      ruleSnapshotHash,
      evaluatedAt,
    },
    permission: derivePermission({ autopilotSettings, invoice }),
  }
}

/**
 * revalidateAuthority({ priorAuthority, invoice, currentRules, currentAutopilotSettings, currentEvents, now })
 *
 * `priorAuthority` is the *authority* object returned by a prior
 * evaluateNextActionAuthority call (the { authorized, basis,
 * ruleSnapshotHash, evaluatedAt } shape) — the durable "receipt" a future
 * action boundary would hold, not the whole facts/recommendation bundle.
 *
 * Render-time authorization is never sufficient for execution. This is the
 * pure re-check every future Approve/Send/Schedule boundary must call
 * first. It never substitutes a different rule for the one that originally
 * authorized the recommendation — it re-checks that exact rule ID only.
 *
 * Returns { outcome, checkedRuleId, authority, permission }. `outcome` is
 * one of REVALIDATION_OUTCOMES; only 'valid' means the prior recommendation
 * may still be acted on. Every other outcome is fail-closed: do not
 * execute, do not silently pick another rule.
 */
export function revalidateAuthority({
  priorAuthority,
  invoice,
  currentRules,
  currentAutopilotSettings,
  currentEvents,
  now = new Date(),
} = {}) {
  const evaluatedAt = now.toISOString()

  const closed = (outcome, checkedRuleId = null) => ({
    outcome,
    checkedRuleId,
    authority: { authorized: false, basis: null, ruleSnapshotHash: null, evaluatedAt },
    permission: UNAUTHORIZED_PERMISSION,
  })

  if (
    !priorAuthority ||
    priorAuthority.authorized !== true ||
    !priorAuthority.basis ||
    priorAuthority.basis.ruleId === null ||
    priorAuthority.basis.ruleId === undefined ||
    !priorAuthority.ruleSnapshotHash
  ) {
    return closed(REVALIDATION_OUTCOMES.PRIOR_AUTHORITY_INVALID)
  }

  const ruleId = priorAuthority.basis.ruleId
  const rules = Array.isArray(currentRules) ? currentRules : []
  // Look up the exact rule that originally authorized this recommendation.
  // Never fall back to "whatever rule matches best now" — that would be
  // silently transferring authority to a different rule.
  const rule = rules.find((r) => r && r.id === ruleId)

  if (!rule) return closed(REVALIDATION_OUTCOMES.RULE_NOT_FOUND, ruleId)
  if (!isWellFormedRule(rule)) return closed(REVALIDATION_OUTCOMES.MALFORMED_RULE_STATE, ruleId)
  if (rule.enabled !== true) return closed(REVALIDATION_OUTCOMES.RULE_DISABLED, ruleId)

  const currentHash = hashRuleSnapshot(buildRuleSnapshot(rule))
  if (currentHash !== priorAuthority.ruleSnapshotHash) {
    return closed(REVALIDATION_OUTCOMES.RULE_CHANGED, ruleId)
  }

  if (!invoice || typeof invoice !== 'object' || !ruleMatches(rule, invoice, now)) {
    return closed(REVALIDATION_OUTCOMES.INVOICE_NO_LONGER_MATCHES, ruleId)
  }

  return {
    outcome: REVALIDATION_OUTCOMES.VALID,
    checkedRuleId: ruleId,
    authority: {
      authorized: true,
      basis: { ruleId: rule.id, ruleName: rule.name ?? null },
      ruleSnapshotHash: currentHash,
      evaluatedAt,
    },
    // Always current permission — an approval-setting change since the
    // prior evaluation must be reflected even when the rule itself is
    // still perfectly valid.
    permission: derivePermission({ autopilotSettings: currentAutopilotSettings, invoice }),
  }
}
