// Phase 2A.1 — the deterministic authority contract every future Pulse
// recommendation depends on.
//
// FACTS MAY BE DERIVED. POLICY MUST BE GRANTED.
//
// A non-null recommendation must be backed by a real, persisted, currently
// enabled founder rule (`autopilot_rules`), owned by the same tenant as the
// invoice, that currently matches, has not already been handled for this
// exact invoice, and is not blocked by an already-pending action on that
// invoice. If none of that holds, the recommendation is null — not
// softened, not hedged, not an inferred escalation. Zero working rules =
// facts only.
//
// This module does not decide ranking/priority (`recommend.js`'s
// "High priority"/"Firm"/"Follow up" badges are exactly the invented-policy
// pattern this contract exists to replace, but rewriting that file is Pulse
// UI work and explicitly out of scope here) and never fabricates a "no
// response" fact from `last_reminder` alone — no evidence source in this
// app currently proves a client responded to anything.
//
// --- Review-fix pass (2026-08-12) ---
// An independent adversarial review of the first candidate
// (cf2fe94ede1010742344cebe8c86c6c15f4a53ea) found this module's selection
// logic did not agree with the real scheduler's execution semantics. Fixed
// here; see the inline notes at selectAuthorizingRule, isValidDueDate, the
// userId parameter, and RULE_SNAPSHOT_FIELDS for exactly what changed and
// why. `ruleSchedule.js`'s `nextScheduledAction()` is no longer used by
// this module for authorization — see selectAuthorizingRule for why.
//
// --- Second review-fix pass (2026-08-12) ---
// A further independent adversarial review of f82936c found four more
// issues: (1) handledKeys/pendingInvoiceIds silently defaulted to empty
// Sets when omitted, recreating the original permissive failure mode --
// they are now required, explicit Sets (see the isValidExecutionHistory
// check in both entry points); (2) revalidateAuthority checked the prior
// rule in isolation but never confirmed CURRENT policy, taken as a whole,
// still selects that same rule -- see the "current policy reselection"
// step near the end of revalidateAuthority; (3) permission derivation
// trusted autopilotSettings without proving it belonged to the caller's
// own tenant -- see derivePermission's settingsOwnedByTenant check;
// (4) equal-sort_order ties were broken by rule id, a secondary ordering
// never proven to match the real scheduler -- selectAuthorizingRule now
// fails closed (AMBIGUOUS_RULE_PRECEDENCE) on a genuine tie instead.

import { daysOverdue, daysUntil } from './format.js'
import { ruleMatches } from './ruleSchedule.js'

// The only action an autopilot_rules row currently authorizes is sending a
// reminder at some tone/timing — there is no "escalate"/"call client"/etc.
// in the current rule model, so this is the one honest action identifier.
export const ACTION_SEND_REMINDER = 'send_reminder'

// Shared block-reason vocabulary. `evaluateNextActionAuthority` uses these
// as `authority.blockedReason` (alongside `authorized: false`);
// `revalidateAuthority` uses the matching REVALIDATION_OUTCOMES entries as
// its top-level `outcome`, so the same concept has the same string value on
// both sides of the contract.
export const AUTHORITY_BLOCK_REASONS = Object.freeze({
  TENANT_MISMATCH: 'tenant_mismatch',
  // Distinct from "checked and found none" (an explicit, valid, empty
  // Set). This means the caller did not establish the state at all --
  // omitted or malformed input -- which must never be silently treated as
  // "there is none." See selectAuthorizingRule / isValidExecutionHistory.
  EXECUTION_HISTORY_UNAVAILABLE: 'execution_history_unavailable',
  PENDING_ACTION_EXISTS: 'pending_action_exists',
  ALREADY_HANDLED: 'already_handled',
  // Two or more currently-open candidate rules share the same winning
  // sort_order. The real scheduler's ORDER BY sort_order ascending has no
  // proven secondary ordering for exact ties, so which one it would
  // actually pick is unknown -- this fails closed rather than guessing.
  AMBIGUOUS_RULE_PRECEDENCE: 'ambiguous_rule_precedence',
})

export const REVALIDATION_OUTCOMES = Object.freeze({
  VALID: 'valid',
  PRIOR_AUTHORITY_INVALID: 'prior_authority_invalid',
  TENANT_MISMATCH: AUTHORITY_BLOCK_REASONS.TENANT_MISMATCH,
  EXECUTION_HISTORY_UNAVAILABLE: AUTHORITY_BLOCK_REASONS.EXECUTION_HISTORY_UNAVAILABLE,
  RULE_NOT_FOUND: 'rule_not_found',
  MALFORMED_RULE_STATE: 'malformed_rule_state',
  RULE_DISABLED: 'rule_disabled',
  RULE_CHANGED: 'rule_changed',
  INVOICE_NO_LONGER_MATCHES: 'invoice_no_longer_matches',
  PENDING_ACTION_EXISTS: AUTHORITY_BLOCK_REASONS.PENDING_ACTION_EXISTS,
  ALREADY_HANDLED: AUTHORITY_BLOCK_REASONS.ALREADY_HANDLED,
  AMBIGUOUS_RULE_PRECEDENCE: AUTHORITY_BLOCK_REASONS.AMBIGUOUS_RULE_PRECEDENCE,
  // The prior rule itself is still individually valid -- exists, enabled,
  // unchanged hash, still matches, not handled/pending -- but current
  // founder policy AS A WHOLE, re-evaluated fresh, now selects a
  // different rule (e.g. a newly-enabled or newly-matching rule with
  // earlier/higher precedence). Never silently transferred; the old
  // recommendation is simply stale.
  POLICY_SELECTION_CHANGED: 'policy_selection_changed',
})

// Canonical policy-relevant fields for the rule snapshot fingerprint.
// Deliberately excludes `name` (a label; renaming a rule doesn't change
// what it authorizes), `user_id` (an identity/access-control fact enforced
// separately and structurally by the explicit tenant checks below, not
// policy content whose *change* should be reported as "the rule changed"),
// and `created_at` (unstable metadata, never policy-relevant).
//
// `sort_order` WAS excluded in the first candidate, reasoned as "display
// ordering only." The review found that reasoning wrong: the real
// scheduler (supabase/functions/autopilot-scheduler/index.ts) fetches
// rules `.order('sort_order', { ascending: true })` and
// supabase/functions/_shared/rules.js's planRun() picks the *first*
// matching rule in that array via `rules.find(...)` — not the most
// advanced one. sort_order therefore genuinely determines which rule wins
// when more than one currently matches, which makes it policy-relevant,
// so it is included here. A rule whose own sort_order changes is treated
// as stale on revalidation even in cases where the change wouldn't have
// altered the outcome — that's the conservative, always-safe direction to
// round to; proving the negative ("this specific sort_order change could
// never have altered selection") would require re-running full selection
// anyway, at which point the caller should just re-evaluate.
export const RULE_SNAPSHOT_FIELDS = Object.freeze([
  'id',
  'trigger_type',
  'trigger_days',
  'tone',
  'enabled',
  'sort_order',
])

const VALID_TRIGGER_TYPES = new Set(['before_due', 'after_due'])

// Mirrors src/lib/reminders.js's `TONES` exactly. Duplicated rather than
// imported: that module pulls in a live Supabase client (`./supabase`) and
// this module must stay pure, dependency-free, and runnable under
// `node --test` with no network/browser globals. This is a finite,
// code-confirmed vocabulary (also matched by
// supabase/functions/_shared/draftTemplate.js's tone branches), not an
// invented restriction.
const VALID_TONES = new Set(['friendly', 'professional', 'firm'])

// A rule that fails this check cannot authorize anything — it is excluded
// from matching entirely (fail closed), the same as a rule that simply
// doesn't exist. Tightened by the review-fix pass: trigger_days must now be
// a whole number (every existing rule in the app — DEFAULT_RULES, and the
// shared daysOverdue()/daysUntil() helpers, which always return
// Math.round()-ed whole-day counts — assumes integer day semantics; no UI
// anywhere in this app produces a fractional trigger_days), and tone must
// be one of the app's actual finite vocabulary rather than any non-empty
// string.
export function isWellFormedRule(rule) {
  if (!rule || typeof rule !== 'object') return false
  if (rule.id === null || rule.id === undefined) return false
  if (typeof rule.user_id !== 'string' || rule.user_id === '') return false
  if (!VALID_TRIGGER_TYPES.has(rule.trigger_type)) return false
  if (
    typeof rule.trigger_days !== 'number' ||
    !Number.isInteger(rule.trigger_days) ||
    rule.trigger_days < 0
  ) {
    return false
  }
  if (!VALID_TONES.has(rule.tone)) return false
  if (typeof rule.enabled !== 'boolean') return false
  if (typeof rule.sort_order !== 'number' || !Number.isFinite(rule.sort_order)) return false
  return true
}

export function buildRuleSnapshot(rule) {
  return {
    id: rule.id,
    trigger_type: rule.trigger_type,
    trigger_days: rule.trigger_days,
    tone: rule.tone,
    enabled: rule.enabled === true,
    sort_order: rule.sort_order,
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
// evaluated, not a security or trust boundary (the hash matching or merely
// existing never implies authorization anywhere in this module — see the
// doctrine at the top of this file), so a small synchronous
// non-cryptographic fingerprint is the right tool here and lets this whole
// module stay synchronous end to end. If this fingerprint is ever persisted
// as action-receipt material in a later checkpoint, that checkpoint should
// reassess whether SHA-256 or another collision-resistant hash is needed —
// this one is a local change detector only.
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

const DUE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

// A minimal validity guard the shared date helpers do not themselves
// provide symmetrically: daysOverdue() silently collapses an unparseable
// due_date to 0 (so an after_due rule with trigger_days: 0 would otherwise
// "match" a missing or garbled date — the review's HIGH 2 finding),
// while daysUntil() correctly returns null for the same input, which
// ruleMatches()'s before_due branch already checks explicitly. This closes
// that asymmetry at the authority boundary only. It does not modify
// daysOverdue, daysUntil, ruleMatches, parseDate, or any shared production
// helper in src/lib/ruleSchedule.js, src/lib/format.js, or
// supabase/functions/_shared/rules.js — those stay exactly as they were,
// per the review's explicit caution about touching production scheduler
// code. A due_date that doesn't pass this check can never be treated as
// proof that an after_due or before_due window has opened, regardless of
// what daysOverdue/daysUntil compute for it. Also rejects invalid calendar
// dates (e.g. "2026-02-30") that the Date constructor would otherwise
// silently roll into the following month.
function isValidDueDate(value) {
  if (typeof value !== 'string') return false
  const match = DUE_DATE_PATTERN.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

// A Set the caller explicitly constructed (even if empty) is evidence they
// checked; anything else (undefined, an array, null, ...) means the
// caller never established the state at all. Those are NOT equivalent --
// see the doctrine note on AUTHORITY_BLOCK_REASONS.EXECUTION_HISTORY_UNAVAILABLE.
function isValidExecutionHistory(value) {
  return value instanceof Set
}

// Selects which rule, if any, currently authorizes an action for this
// invoice — and distinguishes *why* nothing was selected when nothing was.
//
// This mirrors supabase/functions/_shared/rules.js's planRun() selection:
// the first enabled, not-yet-handled-for-this-invoice rule (in persisted
// sort_order-ascending precedence) whose window currently matches, on an
// invoice that doesn't already have a pending action. It deliberately does
// NOT use src/lib/ruleSchedule.js's nextScheduledAction(), which picks the
// *most advanced* matching rule (largest trigger_days) — that function's
// own comment already discloses it is "the closest honest approximation"
// for a browser display line with no access to execution history, not a
// claim of parity with what the scheduler will actually do. This authority
// boundary is load-bearing, so it has to agree with the real scheduler's
// actual decision — see HIGH 1 in the first Phase 2A.1 adversarial review.
//
// handledKeys/pendingInvoiceIds must already be real Sets by the time this
// runs — evaluateNextActionAuthority/revalidateAuthority validate that via
// isValidExecutionHistory() before ever calling this function (second
// review pass, HIGH 1); this function trusts them.
//
// Precedence ties: the real scheduler's `.order('sort_order', { ascending:
// true })` has no proven secondary ordering for two rules sharing the same
// sort_order, so if the currently-open candidate set has more than one
// rule at the winning (lowest) sort_order, this fails closed as
// AMBIGUOUS_RULE_PRECEDENCE rather than guessing via rule id or array
// position (second review pass, MEDIUM 2). A duplicate sort_order on a
// rule that isn't itself an open candidate (disabled, non-matching, or
// already handled) never participates and cannot create a false
// ambiguity.
function selectAuthorizingRule({ invoice, rules, handledKeys, pendingInvoiceIds, now }) {
  if (!invoice || invoice.paid) return { rule: null, blockedReason: null }

  if (pendingInvoiceIds.has(invoice.id)) {
    return { rule: null, blockedReason: AUTHORITY_BLOCK_REASONS.PENDING_ACTION_EXISTS }
  }

  let sawHandledMatch = false
  const openCandidates = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (!ruleMatches(rule, invoice, now)) continue
    if (handledKeys.has(`${invoice.id}:${rule.id}`)) {
      sawHandledMatch = true
      continue
    }
    openCandidates.push(rule)
  }

  if (openCandidates.length === 0) {
    return { rule: null, blockedReason: sawHandledMatch ? AUTHORITY_BLOCK_REASONS.ALREADY_HANDLED : null }
  }

  const minSortOrder = Math.min(...openCandidates.map((r) => r.sort_order))
  const winners = openCandidates.filter((r) => r.sort_order === minSortOrder)

  if (winners.length > 1) {
    return { rule: null, blockedReason: AUTHORITY_BLOCK_REASONS.AMBIGUOUS_RULE_PRECEDENCE }
  }

  return { rule: winners[0], blockedReason: null }
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
    // daysOverdue/daysUntilDue below reuse the same shared helpers the rest
    // of this app uses for display (unchanged by this module). For a
    // malformed due_date these can read 0/null the same way they would
    // anywhere else in the app — that is a display fact, not a policy
    // decision. isValidDueDate() (see evaluateNextActionAuthority /
    // revalidateAuthority) is what stops that from ever being converted
    // into an authorized after_due/before_due match.
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
//
// canActAutomatically additionally requires autopilotSettings.user_id to
// match the caller's own userId (second review pass, MEDIUM 1) — a
// load-bearing autonomy decision must not be granted from a settings
// object a future caller might accidentally supply for a different
// tenant. requiresApproval itself is left unaffected by that check: it
// describes what the (unproven-ownership) settings object says, which is
// inert on its own — the dangerous step is specifically permitting
// automatic execution, not reporting a fact about a settings row.
function derivePermission({ autopilotSettings, invoice, userId }) {
  const settingsOwnedByCaller = Boolean(userId) && autopilotSettings?.user_id === userId
  const autopilotEnabled = autopilotSettings?.enabled === true
  const requiresApproval = autopilotSettings?.approval_required !== false
  const invoicePaused = invoice?.autopilot_paused === true
  return {
    requiresApproval,
    canActAutomatically: settingsOwnedByCaller && autopilotEnabled && !invoicePaused && !requiresApproval,
  }
}

const UNAUTHORIZED_PERMISSION = Object.freeze({ requiresApproval: null, canActAutomatically: false })

/**
 * evaluateNextActionAuthority({ userId, invoice, rules, autopilotSettings,
 *   events, handledKeys, pendingInvoiceIds, now })
 *
 * Pure, synchronous, deterministic. Returns:
 *   {
 *     facts:          real, derivable state — never policy language
 *     recommendation: null, or { action, tone, ruleId, ruleName }
 *     authority:      { authorized, basis, ruleSnapshotHash, evaluatedAt, blockedReason }
 *     permission:     { requiresApproval, canActAutomatically }
 *   }
 *
 * recommendation is non-null only when authority.authorized is true, which
 * requires: userId provided and matching invoice.user_id; a real persisted
 * rule, also owned by userId, that is well-formed, currently enabled, and
 * currently matches (via ruleMatches — never nextScheduledAction, see
 * selectAuthorizingRule); the invoice's due_date provably valid; the
 * invoice not already holding a pending action; this exact rule/invoice
 * pair not already in handledKeys; and, when multiple rules currently
 * qualify, an unambiguous (non-tied) winning sort_order.
 *
 * userId is required. Without it, or when the invoice doesn't belong to
 * it, this returns closed with no derived facts at all — see MEDIUM 1 in
 * the first Phase 2A.1 adversarial review: returning facts about an
 * invoice that doesn't provably belong to the caller's tenant would itself
 * be a cross-tenant leak, a different and more severe class of problem
 * than an over-eager recommendation.
 *
 * handledKeys and pendingInvoiceIds are also required — they must be real
 * `Set` instances, even if empty (second review pass, HIGH 1). An empty
 * `Set` means "the caller checked and found none"; omitting them, or
 * passing something that isn't a `Set`, means the caller never
 * established that state at all, and this returns closed with
 * blockedReason: 'execution_history_unavailable' (facts still included —
 * this is a "not enough evidence to grant policy" case, not a tenant
 * boundary). Never inferred from `events` — no event schema in this app
 * currently proves that exact relationship.
 */
export function evaluateNextActionAuthority({
  userId,
  invoice,
  rules,
  autopilotSettings,
  events,
  handledKeys,
  pendingInvoiceIds,
  now = new Date(),
} = {}) {
  const evaluatedAt = now.toISOString()

  const closed = (facts, blockedReason = null) => ({
    facts,
    recommendation: null,
    authority: { authorized: false, basis: null, ruleSnapshotHash: null, evaluatedAt, blockedReason },
    permission: UNAUTHORIZED_PERMISSION,
  })

  if (typeof userId !== 'string' || userId === '') {
    return closed(deriveFacts(null, now), AUTHORITY_BLOCK_REASONS.TENANT_MISMATCH)
  }
  if (!invoice || typeof invoice !== 'object' || invoice.user_id !== userId) {
    return closed(deriveFacts(null, now), AUTHORITY_BLOCK_REASONS.TENANT_MISMATCH)
  }

  const facts = deriveFacts(invoice, now)

  if (!isValidDueDate(invoice.due_date)) {
    return closed(facts)
  }

  if (!isValidExecutionHistory(handledKeys) || !isValidExecutionHistory(pendingInvoiceIds)) {
    return closed(facts, AUTHORITY_BLOCK_REASONS.EXECUTION_HISTORY_UNAVAILABLE)
  }

  const safeRules = (Array.isArray(rules) ? rules : [])
    .filter(isWellFormedRule)
    .filter((r) => r.user_id === userId)

  const { rule, blockedReason } = selectAuthorizingRule({
    invoice,
    rules: safeRules,
    handledKeys,
    pendingInvoiceIds,
    now,
  })

  if (!rule) return closed(facts, blockedReason)

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
      blockedReason: null,
    },
    permission: derivePermission({ autopilotSettings, invoice, userId }),
  }
}

/**
 * revalidateAuthority({ userId, priorAuthority, invoice, currentRules,
 *   currentAutopilotSettings, currentEvents, currentHandledKeys,
 *   currentPendingInvoiceIds, now })
 *
 * `priorAuthority` is the *authority* object returned by a prior
 * evaluateNextActionAuthority call (the { authorized, basis,
 * ruleSnapshotHash, evaluatedAt, blockedReason } shape) — the durable
 * "receipt" a future action boundary would hold, not the whole
 * facts/recommendation bundle. userId is supplied fresh on every call, the
 * same as invoice/currentRules — it is not expected to be embedded in the
 * receipt itself.
 *
 * Render-time authorization is never sufficient for execution. This is the
 * pure re-check every future Approve/Send/Schedule boundary must call
 * first. It re-checks that exact prior rule ID first (existence, tenant,
 * well-formedness, enabled, unchanged snapshot hash, still matching, not
 * handled/pending) — never substituting a different rule at that stage —
 * and then, only once that rule individually still holds, re-runs full
 * current-policy selection (the same selectAuthorizingRule() primitive
 * evaluateNextActionAuthority uses) to confirm CURRENT policy as a whole
 * still picks this same rule (second review pass, HIGH 2). A rule that
 * still technically matches but has been superseded by a newly-enabled or
 * newly-matching earlier-precedence rule is stale
 * ('policy_selection_changed'), never silently transferred to the new
 * winner and never kept alive on the old one.
 *
 * currentHandledKeys/currentPendingInvoiceIds are required real `Set`
 * instances, exactly like evaluateNextActionAuthority's handledKeys/
 * pendingInvoiceIds — omitted or malformed input returns closed with
 * outcome 'execution_history_unavailable' rather than assuming empty
 * (second review pass, HIGH 1).
 *
 * Returns { outcome, checkedRuleId, authority, permission }. `outcome` is
 * one of REVALIDATION_OUTCOMES; only 'valid' means the prior recommendation
 * may still be acted on. Every other outcome is fail-closed: do not
 * execute, do not silently pick another rule.
 */
export function revalidateAuthority({
  userId,
  priorAuthority,
  invoice,
  currentRules,
  currentAutopilotSettings,
  currentEvents,
  currentHandledKeys,
  currentPendingInvoiceIds,
  now = new Date(),
} = {}) {
  const evaluatedAt = now.toISOString()

  const closed = (outcome, checkedRuleId = null) => ({
    outcome,
    checkedRuleId,
    authority: { authorized: false, basis: null, ruleSnapshotHash: null, evaluatedAt, blockedReason: outcome },
    permission: UNAUTHORIZED_PERMISSION,
  })

  if (typeof userId !== 'string' || userId === '') {
    return closed(REVALIDATION_OUTCOMES.TENANT_MISMATCH)
  }

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

  if (!invoice || typeof invoice !== 'object' || invoice.user_id !== userId) {
    return closed(REVALIDATION_OUTCOMES.TENANT_MISMATCH)
  }

  if (!isValidExecutionHistory(currentHandledKeys) || !isValidExecutionHistory(currentPendingInvoiceIds)) {
    return closed(REVALIDATION_OUTCOMES.EXECUTION_HISTORY_UNAVAILABLE, priorAuthority.basis.ruleId)
  }

  const ruleId = priorAuthority.basis.ruleId
  const rules = Array.isArray(currentRules) ? currentRules : []
  // Look up the exact rule that originally authorized this recommendation.
  // Never fall back to "whatever rule matches best now" — that would be
  // silently transferring authority to a different rule.
  const rule = rules.find((r) => r && r.id === ruleId)

  if (!rule) return closed(REVALIDATION_OUTCOMES.RULE_NOT_FOUND, ruleId)
  if (rule.user_id !== userId) return closed(REVALIDATION_OUTCOMES.TENANT_MISMATCH, ruleId)
  if (!isWellFormedRule(rule)) return closed(REVALIDATION_OUTCOMES.MALFORMED_RULE_STATE, ruleId)
  if (rule.enabled !== true) return closed(REVALIDATION_OUTCOMES.RULE_DISABLED, ruleId)

  const currentHash = hashRuleSnapshot(buildRuleSnapshot(rule))
  if (currentHash !== priorAuthority.ruleSnapshotHash) {
    return closed(REVALIDATION_OUTCOMES.RULE_CHANGED, ruleId)
  }

  if (!isValidDueDate(invoice.due_date) || !ruleMatches(rule, invoice, now)) {
    return closed(REVALIDATION_OUTCOMES.INVOICE_NO_LONGER_MATCHES, ruleId)
  }

  if (currentPendingInvoiceIds.has(invoice.id)) {
    return closed(REVALIDATION_OUTCOMES.PENDING_ACTION_EXISTS, ruleId)
  }
  if (currentHandledKeys.has(`${invoice.id}:${rule.id}`)) {
    return closed(REVALIDATION_OUTCOMES.ALREADY_HANDLED, ruleId)
  }

  // The prior rule individually still holds -- but that alone is not
  // enough (second review pass, HIGH 2). Re-run the exact same
  // deterministic selection primitive evaluateNextActionAuthority uses,
  // against current rules/invoice/execution history, and require it to
  // still pick this exact rule. If current policy as a whole would now
  // select a different (e.g. newly-enabled, earlier-precedence) rule
  // instead, the old recommendation is stale -- never silently
  // transferred to whatever current policy would pick, and never kept
  // alive just because this one rule, considered in isolation, still
  // technically matches.
  const safeCurrentRules = rules.filter(isWellFormedRule).filter((r) => r.user_id === userId)
  const currentSelection = selectAuthorizingRule({
    invoice,
    rules: safeCurrentRules,
    handledKeys: currentHandledKeys,
    pendingInvoiceIds: currentPendingInvoiceIds,
    now,
  })

  if (!currentSelection.rule || currentSelection.rule.id !== ruleId) {
    return closed(currentSelection.blockedReason || REVALIDATION_OUTCOMES.POLICY_SELECTION_CHANGED, ruleId)
  }

  return {
    outcome: REVALIDATION_OUTCOMES.VALID,
    checkedRuleId: ruleId,
    authority: {
      authorized: true,
      basis: { ruleId: rule.id, ruleName: rule.name ?? null },
      ruleSnapshotHash: currentHash,
      evaluatedAt,
      blockedReason: null,
    },
    // Always current permission — an approval-setting change since the
    // prior evaluation must be reflected even when the rule itself is
    // still perfectly valid.
    permission: derivePermission({ autopilotSettings: currentAutopilotSettings, invoice, userId }),
  }
}
