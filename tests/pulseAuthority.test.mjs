import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  evaluatePulseAuthority,
  isAuthorizedForAutomaticHandling,
  toPendingInvoiceIds,
  toHandledKeys,
  classifyPulseAuthority,
  classifyPulseRowState,
  countBlockedDecisions,
  PULSE_STATE,
  PULSE_ROW_STATE,
} from '../src/lib/pulseAuthority.js'
import { AUTHORITY_BLOCK_REASONS } from '../src/lib/nextActionAuthority.js'

// Phase 2A.2 — "Pulse Consumes Authority." These tests exercise
// evaluatePulseAuthority() (the real per-invoice orchestration Dashboard.jsx
// now uses) rather than re-deriving expectations independently, so a
// regression here is a regression Dashboard would actually hit.

const NOW = new Date(2026, 5, 15)
const USER_A = 'user-a-11111111-1111-4111-8111-111111111111'
const USER_B = 'user-b-22222222-2222-4222-8222-222222222222'

function isoDateDaysFromNow(now, offsetDays) {
  const d = new Date(now.getTime())
  d.setDate(d.getDate() + offsetDays)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function baseInvoice(overrides = {}) {
  return {
    id: 'inv-1',
    user_id: USER_A,
    due_date: isoDateDaysFromNow(NOW, -20),
    amount: 1000,
    amount_paid: 0,
    paid: false,
    last_reminder: null,
    autopilot_paused: false,
    ...overrides,
  }
}

function baseRule(overrides = {}) {
  return {
    id: 'rule-1',
    user_id: USER_A,
    name: 'Firm reminder',
    trigger_type: 'after_due',
    trigger_days: 15,
    tone: 'firm',
    enabled: true,
    sort_order: 2,
    ...overrides,
  }
}

function autopilotSettings(overrides = {}) {
  return { id: 'settings-1', user_id: USER_A, enabled: true, approval_required: false, ...overrides }
}

const EMPTY = { handledKeys: new Set(), pendingInvoiceIds: new Set() }

test('1: zero rules -> no recommendation, not authorized', () => {
  const invoice = baseInvoice()
  const result = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoice],
    rules: [],
    autopilotSettings: autopilotSettings(),
    ...EMPTY,
    now: NOW,
  })
  const evaluation = result.get(invoice.id)
  assert.equal(evaluation.recommendation, null)
  assert.equal(evaluation.authority.authorized, false)
  assert.equal(isAuthorizedForAutomaticHandling(evaluation), false)
})

test('2: a matching persisted founder rule -> authorized recommendation', () => {
  const invoice = baseInvoice()
  const rule = baseRule()
  const result = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoice],
    rules: [rule],
    autopilotSettings: autopilotSettings(),
    ...EMPTY,
    now: NOW,
  })
  const evaluation = result.get(invoice.id)
  assert.equal(evaluation.authority.authorized, true)
  assert.equal(evaluation.authority.basis.ruleId, rule.id)
  assert.equal(evaluation.recommendation.ruleId, rule.id)
  assert.equal(isAuthorizedForAutomaticHandling(evaluation), true)
})

test('3a: a rule owned by a different tenant -> no recommendation', () => {
  const invoice = baseInvoice()
  const wrongTenantRule = baseRule({ user_id: USER_B })
  const result = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoice],
    rules: [wrongTenantRule],
    autopilotSettings: autopilotSettings(),
    ...EMPTY,
    now: NOW,
  })
  const evaluation = result.get(invoice.id)
  assert.equal(evaluation.authority.authorized, false)
  assert.equal(isAuthorizedForAutomaticHandling(evaluation), false)
})

test('3b: autopilot_settings owned by a different tenant -> authorized but no automatic permission', () => {
  const invoice = baseInvoice()
  const rule = baseRule()
  const result = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoice],
    rules: [rule],
    autopilotSettings: autopilotSettings({ user_id: USER_B }),
    ...EMPTY,
    now: NOW,
  })
  const evaluation = result.get(invoice.id)
  // The rule itself is still authored/owned by USER_A and matches, so
  // authority can still be granted -- but permission ("may this be acted on
  // WITHOUT approval?") must never be true from settings that aren't
  // provably this tenant's own.
  assert.equal(evaluation.authority.authorized, true)
  assert.equal(evaluation.permission.canActAutomatically, false)
  assert.equal(isAuthorizedForAutomaticHandling(evaluation), false)
})

test('4: execution-history query unavailable (null, not a Set) -> fails closed', () => {
  const invoice = baseInvoice()
  const rule = baseRule()
  const result = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoice],
    rules: [rule],
    autopilotSettings: autopilotSettings(),
    handledKeys: null, // the DataContext shape for "query failed"
    pendingInvoiceIds: null,
    now: NOW,
  })
  const evaluation = result.get(invoice.id)
  assert.equal(evaluation.authority.authorized, false)
  assert.equal(evaluation.authority.blockedReason, AUTHORITY_BLOCK_REASONS.EXECUTION_HISTORY_UNAVAILABLE)
  assert.equal(isAuthorizedForAutomaticHandling(evaluation), false)
})

test('5: an existing durable claim for this exact invoice+rule -> no new recommendation', () => {
  const invoice = baseInvoice()
  const rule = baseRule()
  const result = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoice],
    rules: [rule],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set([`${invoice.id}:${rule.id}`]),
    pendingInvoiceIds: new Set(),
    now: NOW,
  })
  const evaluation = result.get(invoice.id)
  assert.equal(evaluation.authority.authorized, false)
  assert.equal(evaluation.authority.blockedReason, AUTHORITY_BLOCK_REASONS.ALREADY_HANDLED)
})

test('6: a pending awaiting_signature row for this invoice -> no duplicate recommendation', () => {
  const invoice = baseInvoice()
  const rule = baseRule()
  const result = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoice],
    rules: [rule],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set([invoice.id]),
    now: NOW,
  })
  const evaluation = result.get(invoice.id)
  assert.equal(evaluation.authority.authorized, false)
  assert.equal(evaluation.authority.blockedReason, AUTHORITY_BLOCK_REASONS.PENDING_ACTION_EXISTS)
})

test('evaluatePulseAuthority computes one evaluation per invoice, reused (Map keyed by invoice id)', () => {
  const invoiceA = baseInvoice({ id: 'inv-a' })
  const invoiceB = baseInvoice({ id: 'inv-b' })
  const rule = baseRule()
  const result = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoiceA, invoiceB],
    rules: [rule],
    autopilotSettings: autopilotSettings(),
    ...EMPTY,
    now: NOW,
  })
  assert.equal(result.size, 2)
  assert.ok(result.has('inv-a'))
  assert.ok(result.has('inv-b'))
})

// ---------------------------------------------------------------------
// toPendingInvoiceIds / toHandledKeys: the load-bearing success/failure
// distinction DataContext.jsx relies on, and (adversarial-review HIGH fix)
// toHandledKeys's union with awaiting_signature history — parity with the
// real Deno fetchHandledState() (supabase/functions/_shared/
// autopilotAuthorityInputs.js), which folds EVERY awaiting_signature row
// carrying ai_context.rule_id (any status) into handledKeys, not just
// execution claims. This is the exact gap the adversarial review found:
// a founder-skipped/approved draft that never created an execution claim
// (e.g. an approval-mode rule) must still durably block that invoice+rule
// from being recommended again.

test('toPendingInvoiceIds: null rows (query failed) stays null, never an empty Set', () => {
  assert.equal(toPendingInvoiceIds(null), null)
})

test('toPendingInvoiceIds: a real empty array (query succeeded, zero rows) becomes a real empty Set', () => {
  const result = toPendingInvoiceIds([])
  assert.ok(result instanceof Set)
  assert.equal(result.size, 0)
})

test('toPendingInvoiceIds: filters to status === "pending" only, from the full all-status history', () => {
  const result = toPendingInvoiceIds([
    { invoice_id: 'inv-1', status: 'pending' },
    { invoice_id: 'inv-2', status: 'approved' },
    { invoice_id: 'inv-3', status: 'rejected' },
  ])
  assert.ok(result instanceof Set)
  assert.deepEqual([...result], ['inv-1'])
})

test('toHandledKeys: both sources null/unavailable (query failed) -> null, never an empty Set', () => {
  assert.equal(toHandledKeys(null, null), null)
  assert.equal(toHandledKeys(null, []), null)
  assert.equal(toHandledKeys([], null), null)
})

test('toHandledKeys: execution claims alone become a Set of "invoiceId:ruleId"', () => {
  const result = toHandledKeys([{ invoice_id: 'inv-1', rule_id: 'rule-1' }], [])
  assert.ok(result instanceof Set)
  assert.ok(result.has('inv-1:rule-1'))
})

// HIGH fix, test 1: a skipped/resolved awaiting row with ai_context.rule_id
// blocks the same invoice+rule even with ZERO execution claims.
test('toHandledKeys: a skipped awaiting_signature row (no execution claim at all) still blocks its invoice+rule', () => {
  const result = toHandledKeys(
    [], // zero execution claims -- approval-mode rules never create one
    [{ invoice_id: 'inv-1', status: 'skipped', ai_context: { rule_id: 'rule-1' } }]
  )
  assert.ok(result.has('inv-1:rule-1'))
})

// HIGH fix, test 2: an approved/historical awaiting row similarly remains
// handled.
test('toHandledKeys: an approved (historical) awaiting_signature row still blocks its invoice+rule', () => {
  const result = toHandledKeys(
    [],
    [{ invoice_id: 'inv-1', status: 'approved', ai_context: { rule_id: 'rule-1' } }]
  )
  assert.ok(result.has('inv-1:rule-1'))
})

// HIGH fix, test 3: a pending row produces PENDING_ACTION_EXISTS via
// toPendingInvoiceIds -> evaluateNextActionAuthority, not via handledKeys.
test('toHandledKeys/toPendingInvoiceIds: a pending row contributes to pendingInvoiceIds (PENDING_ACTION_EXISTS), and ALSO to handledKeys when it carries a rule id', () => {
  const rows = [{ invoice_id: 'inv-1', status: 'pending', ai_context: { rule_id: 'rule-1' } }]
  const pending = toPendingInvoiceIds(rows)
  const handled = toHandledKeys([], rows)
  assert.ok(pending.has('inv-1'))
  assert.ok(handled.has('inv-1:rule-1'))
})

test('evaluatePulseAuthority: a pending awaiting_signature row for the invoice -> PENDING_ACTION_EXISTS', () => {
  const invoice = baseInvoice()
  const rule = baseRule()
  const rows = [{ invoice_id: invoice.id, status: 'pending', ai_context: { rule_id: rule.id } }]
  const result = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoice],
    rules: [rule],
    autopilotSettings: autopilotSettings(),
    handledKeys: toHandledKeys([], rows),
    pendingInvoiceIds: toPendingInvoiceIds(rows),
    now: NOW,
  })
  const evaluation = result.get(invoice.id)
  assert.equal(evaluation.authority.authorized, false)
  assert.equal(evaluation.authority.blockedReason, AUTHORITY_BLOCK_REASONS.PENDING_ACTION_EXISTS)
})

// HIGH fix, test 4: an awaiting row without a rule ID never invents a
// handled key.
test('toHandledKeys: an awaiting_signature row without ai_context.rule_id contributes nothing', () => {
  const result = toHandledKeys(
    [],
    [
      { invoice_id: 'inv-1', status: 'pending', ai_context: null },
      { invoice_id: 'inv-2', status: 'approved', ai_context: {} },
      { invoice_id: 'inv-3', status: 'skipped' }, // no ai_context at all
    ]
  )
  assert.equal(result.size, 0)
})

// HIGH fix, test 5: the union of signature history + execution claims is
// correct (neither source alone would prove both keys).
test('toHandledKeys: union of execution claims and signature history is correct', () => {
  const result = toHandledKeys(
    [{ invoice_id: 'inv-1', rule_id: 'rule-1' }],
    [{ invoice_id: 'inv-2', status: 'approved', ai_context: { rule_id: 'rule-2' } }]
  )
  assert.equal(result.size, 2)
  assert.ok(result.has('inv-1:rule-1'))
  assert.ok(result.has('inv-2:rule-2'))
})

// HIGH fix, test 6: failure of EITHER history source returns
// unavailable/null, never a partial Set built from just the source that
// happened to succeed.
test('toHandledKeys: execution-claims query failed (null), signature history succeeded -> still null, not a partial Set from signature history alone', () => {
  const result = toHandledKeys(null, [{ invoice_id: 'inv-1', status: 'approved', ai_context: { rule_id: 'rule-1' } }])
  assert.equal(result, null)
})

test('toHandledKeys: signature-history query failed (null), execution claims succeeded -> still null, not a partial Set from execution claims alone', () => {
  const result = toHandledKeys([{ invoice_id: 'inv-1', rule_id: 'rule-1' }], null)
  assert.equal(result, null)
})

// HIGH fix, test 7: end-to-end proof that the gap the review found is
// closed -- an authorized-looking invoice with zero execution claims but a
// resolved awaiting_signature row for the same rule is NOT recommended.
test('evaluatePulseAuthority: a resolved (skipped) awaiting_signature row with zero execution claims still suppresses the recommendation', () => {
  const invoice = baseInvoice()
  const rule = baseRule()
  const historyRows = [{ invoice_id: invoice.id, status: 'skipped', ai_context: { rule_id: rule.id } }]
  const result = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoice],
    rules: [rule],
    autopilotSettings: autopilotSettings(),
    handledKeys: toHandledKeys([], historyRows), // zero execution claims
    pendingInvoiceIds: toPendingInvoiceIds(historyRows),
    now: NOW,
  })
  const evaluation = result.get(invoice.id)
  assert.equal(evaluation.authority.authorized, false)
  assert.equal(evaluation.authority.blockedReason, AUTHORITY_BLOCK_REASONS.ALREADY_HANDLED)
  assert.equal(evaluation.recommendation, null)
})

// Documents the intentional equivalence claim the adversarial review asked
// for: Pulse's toHandledKeys and the Deno fetchHandledState() must compute
// the same union for the same inputs (minus fetchHandledState's
// excludeAwaitingSignatureId, which only the approval Edge Function needs —
// see toHandledKeys's own doc comment for why Pulse never uses it).
test('toHandledKeys is intentionally semantically equivalent to the Deno fetchHandledState() union (execution claims UNION any-status signature rows with a rule id)', () => {
  const executionClaimRows = [{ invoice_id: 'inv-1', rule_id: 'rule-1' }]
  const awaitingRows = [
    { invoice_id: 'inv-2', status: 'approved', ai_context: { rule_id: 'rule-2' } },
    { invoice_id: 'inv-3', status: 'pending', ai_context: { rule_id: 'rule-3' } },
    { invoice_id: 'inv-4', status: 'rejected', ai_context: { rule_id: 'rule-4' } },
  ]
  // Independently reconstruct the Deno-side union algorithm (see
  // supabase/functions/_shared/autopilotAuthorityInputs.js's
  // fetchHandledState) to prove the two never diverge for the same inputs.
  const denoEquivalentHandledKeys = new Set([
    ...awaitingRows.filter((r) => r.ai_context?.rule_id).map((r) => `${r.invoice_id}:${r.ai_context.rule_id}`),
    ...executionClaimRows.map((c) => `${c.invoice_id}:${c.rule_id}`),
  ])
  const pulseHandledKeys = toHandledKeys(executionClaimRows, awaitingRows)
  assert.deepEqual([...pulseHandledKeys].sort(), [...denoEquivalentHandledKeys].sort())
})

// ---------------------------------------------------------------------
// Second adversarial review pass, HIGH 1: classifyPulseAuthority() must
// give a truthful, DISTINCT display state for every authority outcome —
// never collapsed into "No matching rule" for anything that isn't
// genuinely "authority ran and found no rule."

test('HIGH1: classifyPulseAuthority gives DISTINCT states for no-rule vs already-handled vs pending vs unavailable', () => {
  const noRule = classifyPulseAuthority({
    recommendation: null,
    authority: { authorized: false, blockedReason: null },
    permission: { canActAutomatically: false },
  })
  const alreadyHandled = classifyPulseAuthority({
    recommendation: null,
    authority: { authorized: false, blockedReason: AUTHORITY_BLOCK_REASONS.ALREADY_HANDLED },
    permission: { canActAutomatically: false },
  })
  const pending = classifyPulseAuthority({
    recommendation: null,
    authority: { authorized: false, blockedReason: AUTHORITY_BLOCK_REASONS.PENDING_ACTION_EXISTS },
    permission: { canActAutomatically: false },
  })
  const unavailable = classifyPulseAuthority(null)

  const states = [noRule.state, alreadyHandled.state, pending.state, unavailable.state]
  assert.deepEqual(states, [
    PULSE_STATE.NO_RULE,
    PULSE_STATE.ALREADY_HANDLED,
    PULSE_STATE.AWAITING_APPROVAL,
    PULSE_STATE.NEEDS_REVIEW_UNAVAILABLE,
  ])
  // Every one of the four must be a DIFFERENT value -- the whole point of
  // this fix.
  assert.equal(new Set(states).size, 4, 'all four states must be pairwise distinct')

  // And none of the labels is a raw developer enum string.
  for (const result of [noRule, alreadyHandled, pending, unavailable]) {
    assert.doesNotMatch(result.label, /^[a-z_]+$/, 'label must be human copy, never a raw enum string')
  }
})

test('HIGH1: authorized + canActAutomatically -> AUTHORIZED_AUTOMATIC; authorized + approval required -> AUTHORIZED_APPROVAL_REQUIRED (also distinct)', () => {
  const automatic = classifyPulseAuthority({
    authority: { authorized: true, blockedReason: null },
    permission: { canActAutomatically: true },
  })
  const approvalRequired = classifyPulseAuthority({
    authority: { authorized: true, blockedReason: null },
    permission: { canActAutomatically: false },
  })
  assert.equal(automatic.state, PULSE_STATE.AUTHORIZED_AUTOMATIC)
  assert.equal(approvalRequired.state, PULSE_STATE.AUTHORIZED_APPROVAL_REQUIRED)
  assert.notEqual(automatic.state, approvalRequired.state)
})

test('HIGH1: malformed/ambiguous authority state -> a "needs review / couldn\'t verify" state, never "No matching rule"', () => {
  const malformed = classifyPulseAuthority({
    authority: { authorized: false, blockedReason: AUTHORITY_BLOCK_REASONS.MALFORMED_RULE_STATE },
    permission: { canActAutomatically: false },
  })
  const ambiguous = classifyPulseAuthority({
    authority: { authorized: false, blockedReason: AUTHORITY_BLOCK_REASONS.AMBIGUOUS_RULE_PRECEDENCE },
    permission: { canActAutomatically: false },
  })
  assert.equal(malformed.state, PULSE_STATE.NEEDS_REVIEW_MALFORMED)
  assert.equal(ambiguous.state, PULSE_STATE.NEEDS_REVIEW_MALFORMED)
  assert.notEqual(malformed.state, PULSE_STATE.NO_RULE)
  assert.match(malformed.label, /couldn't verify/i)
})

test('HIGH1: an unrecognized/future blockedReason value fails closed to "needs review," never defaults to "No matching rule"', () => {
  const unknown = classifyPulseAuthority({
    authority: { authorized: false, blockedReason: 'some_future_reason_this_module_has_never_seen' },
    permission: { canActAutomatically: false },
  })
  assert.equal(unknown.state, PULSE_STATE.NEEDS_REVIEW_MALFORMED)
})

test('HIGH1: classifyPulseRowState gives distinct row states for awaiting vs automated vs already-handled vs needs-review vs manual', () => {
  const awaitingIds = new Set(['inv-awaiting'])
  const empty = new Set()

  const awaiting = classifyPulseRowState('inv-awaiting', { awaitingInvoiceIds: awaitingIds, evaluation: null })
  const automated = classifyPulseRowState('inv-2', {
    awaitingInvoiceIds: empty,
    evaluation: { authority: { authorized: true }, permission: { canActAutomatically: true } },
  })
  const alreadyHandled = classifyPulseRowState('inv-3', {
    awaitingInvoiceIds: empty,
    evaluation: { authority: { authorized: false, blockedReason: AUTHORITY_BLOCK_REASONS.ALREADY_HANDLED } },
  })
  const needsReview = classifyPulseRowState('inv-4', { awaitingInvoiceIds: empty, evaluation: null })
  const manual = classifyPulseRowState('inv-5', {
    awaitingInvoiceIds: empty,
    evaluation: { authority: { authorized: false, blockedReason: null } },
  })

  assert.deepEqual(
    [awaiting, automated, alreadyHandled, needsReview, manual],
    [
      PULSE_ROW_STATE.AWAITING_APPROVAL,
      PULSE_ROW_STATE.AUTOMATED,
      PULSE_ROW_STATE.ALREADY_HANDLED,
      PULSE_ROW_STATE.NEEDS_REVIEW,
      PULSE_ROW_STATE.MANUAL,
    ]
  )
})

// ---------------------------------------------------------------------
// Second adversarial review pass, HIGH 2: a rule-query FAILURE must not
// become "genuinely zero rules" -- evaluatePulseAuthority must never call
// evaluateNextActionAuthority with an unavailable rule list (which would
// silently coerce to [] and misreport "no rule matches" as fact).

test('HIGH2: rules === null (query failed) -> every invoice evaluates to null (unavailable), never treated as zero rules', () => {
  const invoice = baseInvoice()
  const result = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoice],
    rules: null, // the DataContext shape for "the rule query failed"
    autopilotSettings: autopilotSettings(),
    ...EMPTY,
    now: NOW,
  })
  const evaluation = result.get(invoice.id)
  assert.equal(evaluation, null)
  // Downstream classification must say "couldn't verify," never "No
  // matching rule" (which would be a false claim of a checked, real fact).
  const classified = classifyPulseAuthority(evaluation)
  assert.equal(classified.state, PULSE_STATE.NEEDS_REVIEW_UNAVAILABLE)
  assert.notEqual(classified.state, PULSE_STATE.NO_RULE)
})

test('HIGH2: rules === [] (query succeeded, zero rows) -> a REAL evaluation runs and genuinely reports no matching rule', () => {
  const invoice = baseInvoice()
  const result = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoice],
    rules: [], // a real, successful, empty result -- distinct from null
    autopilotSettings: autopilotSettings(),
    ...EMPTY,
    now: NOW,
  })
  const evaluation = result.get(invoice.id)
  assert.notEqual(evaluation, null, 'a real empty rule list must still produce a real evaluation, not the unavailable sentinel')
  assert.equal(evaluation.authority.authorized, false)
  const classified = classifyPulseAuthority(evaluation)
  assert.equal(classified.state, PULSE_STATE.NO_RULE)
})

test('HIGH2: isAuthorizedForAutomaticHandling is safely false when rules were unavailable (no automatic-handling claim)', () => {
  const invoice = baseInvoice()
  const result = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoice],
    rules: null,
    autopilotSettings: autopilotSettings(),
    ...EMPTY,
    now: NOW,
  })
  assert.equal(isAuthorizedForAutomaticHandling(result.get(invoice.id)), false)
})

// ---------------------------------------------------------------------
// Second adversarial review pass, MEDIUM 1: decision counts must be
// mutually exclusive -- one overdue invoice with one pending approval
// counts as exactly one founder decision, never two.

test('MEDIUM1: an overdue invoice with a pending approval is NOT double-counted by countBlockedDecisions', () => {
  const invoice = baseInvoice() // overdue (baseInvoice's due_date is -20 days)
  const rule = baseRule()
  const awaitingInvoiceIds = new Set([invoice.id]) // this invoice has a pending draft
  const pulseAuthority = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [invoice],
    rules: [rule],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set([invoice.id]),
    now: NOW,
  })
  const blockedCount = countBlockedDecisions([invoice], { awaitingInvoiceIds, pulseAuthority })
  // The founder-facing total is awaitingCount (1, from the real
  // awaiting_signature row count) + blockedCount -- blockedCount must be
  // 0 here, or this single invoice would count as two decisions.
  assert.equal(blockedCount, 0)
  const decisionsNeeded = 1 /* awaitingCount */ + blockedCount
  assert.equal(decisionsNeeded, 1, 'exactly one founder decision, not two')
})

test('MEDIUM1: a DIFFERENT overdue invoice with no pending approval and no working automation IS counted as blocked', () => {
  const pendingInvoice = baseInvoice({ id: 'inv-pending' })
  const blockedInvoice = baseInvoice({ id: 'inv-blocked' })
  const rule = baseRule()
  const awaitingInvoiceIds = new Set([pendingInvoice.id])
  const pulseAuthority = evaluatePulseAuthority({
    userId: USER_A,
    invoices: [pendingInvoice, blockedInvoice],
    rules: [], // no rule -> MANUAL for whichever invoice isn't awaiting
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set([pendingInvoice.id]),
    now: NOW,
  })
  const blockedCount = countBlockedDecisions([pendingInvoice, blockedInvoice], { awaitingInvoiceIds, pulseAuthority })
  assert.equal(blockedCount, 1)
})

// ---------------------------------------------------------------------
// Static checks on Dashboard.jsx — mirrors the existing convention (see
// tests/dataContextEventsProjection.test.mjs) for properties that require
// a full React/Supabase render harness to prove at runtime, and are
// instead proven here as source-level invariants.

function readDashboardSource() {
  const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'Dashboard.jsx')
  return readFileSync(filePath, 'utf8')
}

test('7: Dashboard.jsx never turns last_reminder into a "no response" claim', () => {
  const content = readDashboardSource()
  assert.doesNotMatch(content, /no response/i)
})

test('8: no recommendFor() heuristic path remains in Pulse (Dashboard.jsx)', () => {
  const content = readDashboardSource()
  assert.doesNotMatch(content, /recommendFor/)
  assert.doesNotMatch(content, /from ['"]\.\.\/lib\/recommend['"]/)
  assert.doesNotMatch(content, /nextScheduledAction/)
})

test('9: Dashboard.jsx contains none of the forbidden zero-authority policy phrases', () => {
  const content = readDashboardSource()
  const forbidden = [
    /send final notice/i,
    /a firmer tone is recommended/i,
    /gentle nudge/i,
    /high priority/i,
    /next check: tomorrow morning/i,
  ]
  for (const pattern of forbidden) {
    assert.doesNotMatch(content, pattern, `found forbidden phrase matching ${pattern}`)
  }
  // "Send a reminder" / "Follow up" as their own imperative recommendation
  // strings (recommend.js's old badges) must be gone; "Choose action" /
  // neutral copy replaces them.
  assert.doesNotMatch(content, /send a (friendly|firm|follow-up) reminder/i)
})

test('10: Dashboard.jsx computes authority once via evaluatePulseAuthority and reuses it (no second engine)', () => {
  const content = readDashboardSource()
  assert.match(content, /evaluatePulseAuthority/)
  assert.match(content, /isAuthorizedForAutomaticHandling/)
})

// ---------------------------------------------------------------------
// Second adversarial review pass, MEDIUM 2: remove remaining unsupported
// Pulse copy -- an unconditional "reminder scheduled" claim, last_reminder
// (a past timestamp only) turned into a future-scheduling claim, and an
// events-window-derived "Everything is handled" overclaim.

test('MEDIUM2: Dashboard.jsx never claims an unconditional/unproven "reminder scheduled"', () => {
  const content = readDashboardSource()
  assert.doesNotMatch(content, /reminder scheduled/i)
})

test('MEDIUM2: Dashboard.jsx never claims "Everything is handled" from the recent-events window alone', () => {
  const content = readDashboardSource()
  assert.doesNotMatch(content, /everything is handled/i)
})

test('MEDIUM2: the old "Duewatch Will Do Next" heading (implying a persisted schedule) is gone', () => {
  const content = readDashboardSource()
  assert.doesNotMatch(content, /duewatch will do next/i)
})
