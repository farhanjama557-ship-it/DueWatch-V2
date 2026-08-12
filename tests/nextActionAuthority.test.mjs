import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateNextActionAuthority,
  revalidateAuthority,
  buildRuleSnapshot,
  hashRuleSnapshot,
  isWellFormedRule,
  REVALIDATION_OUTCOMES,
  AUTHORITY_BLOCK_REASONS,
  ACTION_SEND_REMINDER,
} from '../src/lib/nextActionAuthority.js'
import * as authorityModule from '../src/lib/nextActionAuthority.js'

// Local midnight, matching how due_date strings are parsed (src/lib/format.js
// parseDate) so day-math in these tests is exact, never rounding-ambiguous.
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
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const FORBIDDEN_SUBSTRINGS = [
  'final notice',
  'firm reminder', // as a *narrative recommendation phrase*, not a rule's own name field
  'escalat',
  'follow up',
  'follow-up',
  'you might',
  'firmer',
  'recommended action',
  'consider',
  'perhaps',
  'no response',
  'no_response',
  'responded',
]

// The rule's own `name` field ("Firm reminder") legitimately appears inside
// authority.basis/recommendation when a real rule authorizes something --
// that is founder-authored evidence, not invented policy language. These
// checks only run against results where NO rule authorized anything, so
// there is no rule `name` in the payload to produce a false positive.
function assertNoInventedPolicyLanguage(result) {
  const serialized = JSON.stringify(result).toLowerCase()
  for (const phrase of FORBIDDEN_SUBSTRINGS) {
    assert.equal(serialized.includes(phrase), false, `result must not contain "${phrase}": ${serialized}`)
  }
}

// =======================================================================
// PART 1 -- original Phase 2A.1 checkpoint scenarios (1-18), updated to
// pass the now-required userId parameter and sort_order-bearing fixtures.
// =======================================================================

test('1. zero rules + 120 days overdue -> no recommendation, facts only, no invented policy language', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -120), amount: 50000, amount_paid: 0 })
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })

  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
  assert.equal(result.authority.basis, null)
  assert.equal(result.authority.ruleSnapshotHash, null)
  assert.equal(result.facts.daysOverdue, 120)
  assert.equal(result.facts.amountOutstanding, 50000)
  assert.equal(result.facts.paid, false)
  assertNoInventedPolicyLanguage(result)
})

test('2. 30+ days overdue with only a non-matching rule -> no "final notice" recommendation', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -35) })
  const rules = [
    baseRule({ id: 'r-before', trigger_type: 'before_due', trigger_days: 3, name: 'Friendly reminder' }),
  ]
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules,
    autopilotSettings: null,
    events: [],
    now: NOW,
  })

  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
  assertNoInventedPolicyLanguage(result)
})

test('3. 15+ days overdue with only a non-matching rule -> no "firm reminder" recommendation', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -18) })
  const rules = [
    baseRule({ id: 'r-before', trigger_type: 'before_due', trigger_days: 3, name: 'Friendly reminder' }),
  ]
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules,
    autopilotSettings: null,
    events: [],
    now: NOW,
  })

  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
  assertNoInventedPolicyLanguage(result)
})

test('4. a matching enabled rule authorizes a recommendation carrying the exact persisted rule ID and name', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rules = [baseRule({ id: 'rule-firm-42', name: 'Firm reminder', trigger_type: 'after_due', trigger_days: 15 })]
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules,
    autopilotSettings: null,
    events: [],
    now: NOW,
  })

  assert.equal(result.authority.authorized, true)
  assert.equal(result.authority.basis.ruleId, 'rule-firm-42')
  assert.equal(result.authority.basis.ruleName, 'Firm reminder')
  assert.ok(result.authority.ruleSnapshotHash)
  assert.equal(result.authority.evaluatedAt, NOW.toISOString())
  assert.equal(result.recommendation.ruleId, 'rule-firm-42')
  assert.equal(result.recommendation.ruleName, 'Firm reminder')
  assert.equal(result.recommendation.action, ACTION_SEND_REMINDER)
  assert.equal(result.recommendation.tone, 'firm')
})

test('5. a disabled rule does not authorize a recommendation', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rules = [baseRule({ id: 'rule-1', trigger_days: 15, enabled: false })]
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules,
    autopilotSettings: null,
    events: [],
    now: NOW,
  })

  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
})

test('6a. the same policy state always produces the same snapshot hash', () => {
  const rule = baseRule({ id: 'r1', trigger_days: 15, tone: 'firm', enabled: true, sort_order: 2 })
  const h1 = hashRuleSnapshot(buildRuleSnapshot(rule))
  const h2 = hashRuleSnapshot(buildRuleSnapshot({ ...rule }))
  assert.equal(h1, h2)
})

test('6b. irrelevant metadata (name, created_at) does not change the hash', () => {
  const rule = baseRule({ id: 'r1', trigger_days: 15, tone: 'firm', enabled: true, sort_order: 2 })
  const h1 = hashRuleSnapshot(buildRuleSnapshot(rule))
  const h2 = hashRuleSnapshot(
    buildRuleSnapshot({ ...rule, name: 'Totally different label', created_at: '2099-01-01T00:00:00Z' })
  )
  assert.equal(h1, h2)
})

test('6c. a policy-relevant change (trigger_days) does change the hash', () => {
  const rule = baseRule({ id: 'r1', trigger_days: 15, tone: 'firm', enabled: true, sort_order: 2 })
  const h1 = hashRuleSnapshot(buildRuleSnapshot(rule))
  const h2 = hashRuleSnapshot(buildRuleSnapshot({ ...rule, trigger_days: 45 }))
  assert.notEqual(h1, h2)
})

test('6d. a policy-relevant change (tone) does change the hash', () => {
  const rule = baseRule({ id: 'r1', trigger_days: 15, tone: 'friendly', enabled: true, sort_order: 2 })
  const h1 = hashRuleSnapshot(buildRuleSnapshot(rule))
  const h2 = hashRuleSnapshot(buildRuleSnapshot({ ...rule, tone: 'firm' }))
  assert.notEqual(h1, h2)
})

test('7. revalidation rejects the prior authority as stale once trigger_days changes', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const originalRule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [originalRule],
    autopilotSettings: { enabled: true, approval_required: false },
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const changedRule = { ...originalRule, trigger_days: 45 }
  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice,
    currentRules: [changedRule],
    currentAutopilotSettings: { enabled: true, approval_required: false },
    currentEvents: [],
    now: NOW,
  })

  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.RULE_CHANGED)
  assert.equal(revalidated.authority.authorized, false)
})

test('8. revalidation rejects the prior authority once the same rule is disabled', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const originalRule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [originalRule],
    autopilotSettings: { enabled: true, approval_required: false },
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const disabledRule = { ...originalRule, enabled: false }
  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice,
    currentRules: [disabledRule],
    currentAutopilotSettings: { enabled: true, approval_required: false },
    currentEvents: [],
    now: NOW,
  })

  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.RULE_DISABLED)
  assert.equal(revalidated.authority.authorized, false)
})

test('9. revalidation does not pass merely because the rule ID still exists -- tone change is caught', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const originalRule = baseRule({ id: 'rule-1', trigger_days: 15, tone: 'friendly' })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [originalRule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const retonedRule = { ...originalRule, tone: 'firm' }
  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice,
    currentRules: [retonedRule],
    currentAutopilotSettings: null,
    currentEvents: [],
    now: NOW,
  })

  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.RULE_CHANGED)
  assert.equal(revalidated.authority.authorized, false)
})

test('10. trigger changed from 30 to 45 days invalidates the old authorization', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -32) })
  const originalRule = baseRule({ id: 'rule-final', trigger_days: 30, name: 'Final notice' })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [originalRule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const movedRule = { ...originalRule, trigger_days: 45 }
  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice,
    currentRules: [movedRule],
    currentAutopilotSettings: null,
    currentEvents: [],
    now: NOW,
  })

  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.RULE_CHANGED)
  assert.equal(revalidated.authority.authorized, false)
})

test('11. invoice facts changing so the rule no longer matches invalidates the prior authorization', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const paidInvoice = { ...invoice, paid: true }
  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice: paidInvoice,
    currentRules: [rule],
    currentAutopilotSettings: null,
    currentEvents: [],
    now: NOW,
  })

  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.INVOICE_NO_LONGER_MATCHES)
  assert.equal(revalidated.authority.authorized, false)
})

test('12. a different, more-advanced rule newly matching does not silently transfer authority', () => {
  const invoiceAt20 = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const firmRule = baseRule({ id: 'rule-firm', trigger_days: 15, name: 'Firm reminder', sort_order: 2 })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice: invoiceAt20,
    rules: [firmRule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)
  assert.equal(evaluated.authority.basis.ruleId, 'rule-firm')

  // Time passes: the invoice is now 35 days overdue, and a second, more
  // advanced rule ("Final notice", 30 days, later in sort_order) also
  // matches now. The original 15-day rule is untouched and, on its own
  // terms, still matches too.
  const invoiceAt35 = { ...invoiceAt20, due_date: isoDateDaysFromNow(NOW, -35) }
  const finalNoticeRule = baseRule({ id: 'rule-final', trigger_days: 30, name: 'Final notice', sort_order: 3 })

  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice: invoiceAt35,
    currentRules: [firmRule, finalNoticeRule],
    currentAutopilotSettings: null,
    currentEvents: [],
    now: NOW,
  })

  // The ORIGINAL rule's own authorization remains valid on its own terms --
  // it is not invalidated just because a different rule also now matches --
  // but identity must never move to the new rule.
  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.VALID)
  assert.equal(revalidated.authority.basis.ruleId, 'rule-firm')
  assert.notEqual(revalidated.authority.basis.ruleId, 'rule-final')
})

test('13. revalidation uses current permission state, not the permission state at evaluation time', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: { enabled: true, approval_required: true },
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.permission.requiresApproval, true)
  assert.equal(evaluated.permission.canActAutomatically, false)

  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice,
    currentRules: [rule],
    currentAutopilotSettings: { enabled: true, approval_required: false },
    currentEvents: [],
    now: NOW,
  })

  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.VALID)
  assert.equal(revalidated.permission.requiresApproval, false)
  assert.equal(revalidated.permission.canActAutomatically, true)
})

test('14. last_reminder produces only elapsed-time evidence, never a "no response" fact', () => {
  const lastReminderAt = new Date(NOW.getTime() - 6 * 86400000).toISOString()
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20), last_reminder: lastReminderAt })
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })

  assert.equal(result.facts.lastReminderAt, lastReminderAt)
  assert.equal(result.facts.daysSinceLastReminder, 6)
  assert.equal('responded' in result.facts, false)
  assert.equal('noResponse' in result.facts, false)
  assert.equal('hasResponded' in result.facts, false)
  const serialized = JSON.stringify(result).toLowerCase()
  assert.equal(serialized.includes('respond'), false)
})

test('15a. a structurally malformed rule cannot authorize anything at evaluation time', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const malformedRule = { id: 'bad-rule', user_id: USER_A, trigger_type: 'after_due' } // missing trigger_days/tone/enabled/sort_order
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [malformedRule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(isWellFormedRule(malformedRule), false)
  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
})

test('15b. a malformed rule at revalidation time fails closed', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const corrupted = { id: 'rule-1', user_id: USER_A, trigger_type: 'after_due' } // now missing required fields
  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice,
    currentRules: [corrupted],
    currentAutopilotSettings: null,
    currentEvents: [],
    now: NOW,
  })

  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.MALFORMED_RULE_STATE)
  assert.equal(revalidated.authority.authorized, false)
})

test('16. an unrecognized trigger_type cannot authorize anything', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const unknownTypeRule = baseRule({ id: 'rule-1', trigger_type: 'quarterly_review', trigger_days: 15 })
  assert.equal(isWellFormedRule(unknownTypeRule), false)

  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [unknownTypeRule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
})

test('17a. an unauthorized evaluation never carries a stray ruleSnapshotHash', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -5) })
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(result.authority.authorized, false)
  assert.equal(result.authority.ruleSnapshotHash, null)
})

test('17b. revalidation rejects a prior authority object that carries a hash but authorized: false', () => {
  const fakePriorAuthority = {
    authorized: false, // was never actually granted
    basis: { ruleId: 'rule-1', ruleName: 'Firm reminder' },
    ruleSnapshotHash: hashRuleSnapshot(buildRuleSnapshot(baseRule({ id: 'rule-1' }))),
    evaluatedAt: NOW.toISOString(),
  }
  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: fakePriorAuthority,
    invoice: baseInvoice(),
    currentRules: [baseRule({ id: 'rule-1' })],
    currentAutopilotSettings: null,
    currentEvents: [],
    now: NOW,
  })
  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.PRIOR_AUTHORITY_INVALID)
  assert.equal(revalidated.authority.authorized, false)
})

test('18a. the module exports no ranking/priority/sort-as-a-feature function', () => {
  const exportNames = Object.keys(authorityModule)
  for (const name of exportNames) {
    const lower = name.toLowerCase()
    assert.equal(lower.includes('rank'), false, `unexpected ranking export: ${name}`)
    assert.equal(lower.includes('priorit'), false, `unexpected priority export: ${name}`)
  }
})

test('18b. results contain no rank/priority field, and selection order matches persisted sort_order deterministically (not accidental array order) -- see review-fix section for the dedicated array-order-independence proof', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15, sort_order: 1 })
  const otherRule = baseRule({
    id: 'rule-0',
    trigger_type: 'before_due',
    trigger_days: 3,
    name: 'Friendly reminder',
    sort_order: 0,
  })

  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule, otherRule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })

  assert.equal('rank' in result, false)
  assert.equal('priority' in result, false)
  assert.equal('rank' in result.recommendation, false)
  assert.equal('priority' in result.recommendation, false)
})

test('bonus: differing events arrays never change the result (no undefined evidence source is consulted)', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rules = [baseRule({ id: 'rule-1', trigger_days: 15 })]
  const resultNoEvents = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules,
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  const resultWithEvents = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules,
    autopilotSettings: null,
    events: [{ event_type: 'reminder_sent', invoice_id: 'inv-1', created_at: NOW.toISOString() }],
    now: NOW,
  })
  assert.deepEqual(resultNoEvents, resultWithEvents)
})

test('bonus: a matching rule can authorize a recommendation while an individually-paused invoice still blocks automatic action', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20), autopilot_paused: true })
  const rules = [baseRule({ id: 'rule-1', trigger_days: 15 })]
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules,
    autopilotSettings: { enabled: true, approval_required: false },
    events: [],
    now: NOW,
  })

  assert.equal(result.authority.authorized, true)
  assert.equal(result.permission.canActAutomatically, false)
})

test('bonus: zero rules leaves permission with no meaningful requiresApproval value (no policy to speak of)', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -5) })
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [],
    autopilotSettings: { enabled: true, approval_required: false },
    events: [],
    now: NOW,
  })
  assert.equal(result.authority.authorized, false)
  assert.equal(result.permission.requiresApproval, null)
  assert.equal(result.permission.canActAutomatically, false)
})

// =======================================================================
// PART 2 -- review-fix regression tests (independent adversarial review of
// candidate cf2fe94ede1010742344cebe8c86c6c15f4a53ea: 0 blocker, 2 high,
// 2 medium).
// =======================================================================

// --- HIGH 1: scheduler execution-state parity (handledKeys / pendingInvoiceIds) ---

test('review-fix HIGH1-1: an already-handled exact rule/invoice pair cannot produce a fresh actionable authority', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const handledKeys = new Set([`${invoice.id}:${rule.id}`])

  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    handledKeys,
    pendingInvoiceIds: new Set(),
    now: NOW,
  })

  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
  assert.equal(result.authority.blockedReason, AUTHORITY_BLOCK_REASONS.ALREADY_HANDLED)
})

test('review-fix HIGH1-2: a pending action on the invoice blocks fresh actionable authority even when a rule matches', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const pendingInvoiceIds = new Set([invoice.id])

  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    handledKeys: new Set(),
    pendingInvoiceIds,
    now: NOW,
  })

  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
  assert.equal(result.authority.blockedReason, AUTHORITY_BLOCK_REASONS.PENDING_ACTION_EXISTS)
})

test('review-fix HIGH1-3: being handled for one rule does not incorrectly consume a different, also-matching rule', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  // Both match (15 and 5 day after_due thresholds against a 20-day-overdue
  // invoice). rule-a is earlier in sort_order and already handled; rule-b
  // is later in sort_order and still open -- selection must still find it,
  // not treat the whole invoice as exhausted just because ONE candidate
  // rule was already handled.
  const ruleA = baseRule({ id: 'rule-a', trigger_days: 15, sort_order: 1 })
  const ruleB = baseRule({ id: 'rule-b', trigger_days: 5, sort_order: 2, name: 'First follow-up' })
  const handledKeys = new Set([`${invoice.id}:${ruleA.id}`])

  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [ruleA, ruleB],
    autopilotSettings: null,
    events: [],
    handledKeys,
    pendingInvoiceIds: new Set(),
    now: NOW,
  })

  assert.equal(result.authority.authorized, true)
  assert.equal(result.authority.basis.ruleId, 'rule-b')
})

test('review-fix HIGH1-4: revalidation also rejects a recommendation whose rule/invoice pair became handled after evaluation', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice,
    currentRules: [rule],
    currentAutopilotSettings: null,
    currentEvents: [],
    currentHandledKeys: new Set([`${invoice.id}:${rule.id}`]),
    currentPendingInvoiceIds: new Set(),
    now: NOW,
  })

  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.ALREADY_HANDLED)
  assert.equal(revalidated.authority.authorized, false)
})

test('review-fix HIGH1-5: revalidation also rejects a recommendation once the invoice gains a pending action', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice,
    currentRules: [rule],
    currentAutopilotSettings: null,
    currentEvents: [],
    currentHandledKeys: new Set(),
    currentPendingInvoiceIds: new Set([invoice.id]),
    now: NOW,
  })

  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.PENDING_ACTION_EXISTS)
  assert.equal(revalidated.authority.authorized, false)
})

test('review-fix HIGH1-6: selection agrees with the real scheduler, not nextScheduledAction\'s "most advanced" display heuristic', () => {
  // A 32-day-overdue invoice with First follow-up (5d), Firm reminder (15d),
  // and Final notice (30d) all matching, none yet handled. The real
  // scheduler's planRun() (supabase/functions/_shared/rules.js) picks the
  // FIRST match in persisted sort_order-ascending order -- First follow-up
  // -- not the most advanced. This module must agree.
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -32) })
  const rules = [
    baseRule({ id: 'r-first', name: 'First follow-up', trigger_days: 5, sort_order: 1 }),
    baseRule({ id: 'r-firm', name: 'Firm reminder', trigger_days: 15, sort_order: 2 }),
    baseRule({ id: 'r-final', name: 'Final notice', trigger_days: 30, sort_order: 3 }),
  ]

  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules,
    autopilotSettings: null,
    events: [],
    now: NOW,
  })

  assert.equal(result.authority.authorized, true)
  assert.equal(result.authority.basis.ruleId, 'r-first')
})

// --- HIGH 2: due-date evidence must be valid before it can become policy ---

test('review-fix HIGH2-1: after_due, trigger_days 0, due_date null -> unauthorized', () => {
  const invoice = baseInvoice({ due_date: null })
  const rule = baseRule({ id: 'rule-zero', trigger_type: 'after_due', trigger_days: 0 })
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
})

test('review-fix HIGH2-2: after_due, trigger_days 0, due_date malformed -> unauthorized', () => {
  const invoice = baseInvoice({ due_date: 'not-a-real-date' })
  const rule = baseRule({ id: 'rule-zero', trigger_type: 'after_due', trigger_days: 0 })
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
})

test('review-fix HIGH2-3: recommendation valid at evaluation, due_date disappears before revalidation -> fails closed', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice: { ...invoice, due_date: null },
    currentRules: [rule],
    currentAutopilotSettings: null,
    currentEvents: [],
    now: NOW,
  })

  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.INVOICE_NO_LONGER_MATCHES)
  assert.equal(revalidated.authority.authorized, false)
})

test('review-fix HIGH2-4: recommendation valid at evaluation, due_date becomes malformed before revalidation -> fails closed', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice: { ...invoice, due_date: 'garbage-2099' },
    currentRules: [rule],
    currentAutopilotSettings: null,
    currentEvents: [],
    now: NOW,
  })

  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.INVOICE_NO_LONGER_MATCHES)
  assert.equal(revalidated.authority.authorized, false)
})

test('review-fix HIGH2-5: before_due with malformed or missing due_date -> unauthorized', () => {
  const ruleBeforeDue = baseRule({ id: 'rule-before', trigger_type: 'before_due', trigger_days: 3 })

  const withNullDueDate = evaluateNextActionAuthority({
    userId: USER_A,
    invoice: baseInvoice({ due_date: null }),
    rules: [ruleBeforeDue],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(withNullDueDate.authority.authorized, false)

  const withMalformedDueDate = evaluateNextActionAuthority({
    userId: USER_A,
    invoice: baseInvoice({ due_date: '2026-99-99' }),
    rules: [ruleBeforeDue],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(withMalformedDueDate.authority.authorized, false)
})

test('review-fix HIGH2-6: an invalid calendar date (2026-02-30) is rejected even though it superficially matches the YYYY-MM-DD shape', () => {
  const invoice = baseInvoice({ due_date: '2026-02-30' })
  const rule = baseRule({ id: 'rule-zero', trigger_type: 'after_due', trigger_days: 0 })
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(result.authority.authorized, false)
})

// --- MEDIUM 1: tenant identity is bound structurally ---

test('review-fix MEDIUM1-1: a tenant A invoice cannot be authorized by a tenant B rule, even with matching fields', () => {
  const invoice = baseInvoice({ user_id: USER_A, due_date: isoDateDaysFromNow(NOW, -20) })
  const crossTenantRule = baseRule({ id: 'rule-1', user_id: USER_B, trigger_days: 15 })

  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [crossTenantRule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })

  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
})

test('review-fix MEDIUM1-2: revalidation fails closed when the same rule ID now belongs to a different tenant', () => {
  const invoice = baseInvoice({ user_id: USER_A, due_date: isoDateDaysFromNow(NOW, -20) })
  const ownRule = baseRule({ id: 'rule-1', user_id: USER_A, trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [ownRule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const reassignedRule = { ...ownRule, user_id: USER_B }
  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice,
    currentRules: [reassignedRule],
    currentAutopilotSettings: null,
    currentEvents: [],
    now: NOW,
  })

  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.TENANT_MISMATCH)
  assert.equal(revalidated.authority.authorized, false)
})

test('review-fix MEDIUM1-3: a missing userId fails closed on both evaluate and revalidate, with no facts leaked', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15 })

  const evaluated = evaluateNextActionAuthority({
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, false)
  assert.equal(evaluated.facts.amountOutstanding, null)
  assert.equal(evaluated.facts.daysOverdue, null)

  const validEvaluation = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  const revalidatedWithoutUserId = revalidateAuthority({
    priorAuthority: validEvaluation.authority,
    invoice,
    currentRules: [rule],
    currentAutopilotSettings: null,
    currentEvents: [],
    now: NOW,
  })
  assert.equal(revalidatedWithoutUserId.outcome, REVALIDATION_OUTCOMES.TENANT_MISMATCH)
  assert.equal(revalidatedWithoutUserId.authority.authorized, false)
})

test('review-fix MEDIUM1-4: an invoice belonging to a different tenant than userId fails closed with no facts leaked', () => {
  const invoice = baseInvoice({ user_id: USER_B, due_date: isoDateDaysFromNow(NOW, -20) })
  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [baseRule({ user_id: USER_B, trigger_days: 15 })],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(result.authority.authorized, false)
  assert.equal(result.facts.amountOutstanding, null)
})

// --- MEDIUM 2: equal-threshold / sort_order precedence ---

test('review-fix MEDIUM2-1: with equal trigger_days, persisted sort_order (not array position) decides which rule is authorized', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const ruleFriendlyFirst = baseRule({
    id: 'rule-friendly',
    trigger_days: 15,
    tone: 'friendly',
    sort_order: 1,
    name: 'A',
  })
  const ruleFirmSecond = baseRule({ id: 'rule-firm', trigger_days: 15, tone: 'firm', sort_order: 2, name: 'B' })

  const resultInOrder = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [ruleFriendlyFirst, ruleFirmSecond],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(resultInOrder.authority.basis.ruleId, 'rule-friendly')

  const resultReversed = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [ruleFirmSecond, ruleFriendlyFirst],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  // Same persisted sort_order precedence, not accidental raw array order.
  assert.equal(resultReversed.authority.basis.ruleId, 'rule-friendly')
})

test('review-fix MEDIUM2-2: reversing the raw rule array order never changes which rule is authorized', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -32) })
  const rules = [
    baseRule({ id: 'r-first', trigger_days: 5, sort_order: 1 }),
    baseRule({ id: 'r-firm', trigger_days: 15, sort_order: 2 }),
    baseRule({ id: 'r-final', trigger_days: 30, sort_order: 3 }),
  ]

  const forward = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules,
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  const reversed = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [...rules].reverse(),
    autopilotSettings: null,
    events: [],
    now: NOW,
  })

  assert.equal(forward.authority.basis.ruleId, reversed.authority.basis.ruleId)
  assert.equal(forward.authority.basis.ruleId, 'r-first')
})

test('review-fix MEDIUM2-3: sort_order is policy-relevant -- changing it alone changes the snapshot hash', () => {
  const rule = baseRule({ id: 'r1', trigger_days: 15, tone: 'firm', enabled: true, sort_order: 1 })
  const h1 = hashRuleSnapshot(buildRuleSnapshot(rule))
  const h2 = hashRuleSnapshot(buildRuleSnapshot({ ...rule, sort_order: 5 }))
  assert.notEqual(h1, h2)
})

test('review-fix MEDIUM2-4: a policy-relevant sort_order change on the authorizing rule stales the prior authorization on revalidation', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15, sort_order: 1 })
  const evaluated = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const reorderedRule = { ...rule, sort_order: 9 }
  const revalidated = revalidateAuthority({
    userId: USER_A,
    priorAuthority: evaluated.authority,
    invoice,
    currentRules: [reorderedRule],
    currentAutopilotSettings: null,
    currentEvents: [],
    now: NOW,
  })

  assert.equal(revalidated.outcome, REVALIDATION_OUTCOMES.RULE_CHANGED)
  assert.equal(revalidated.authority.authorized, false)
})

// --- Additional review items: tone vocabulary, integer trigger_days ---

test('review-fix ADD-1: an unknown tone cannot authorize anything (finite vocabulary confirmed by src/lib/reminders.js TONES)', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15, tone: 'aggressive' })
  assert.equal(isWellFormedRule(rule), false)

  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
})

test('review-fix ADD-2: a fractional trigger_days cannot authorize anything (integer day semantics confirmed app-wide)', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15.5 })
  assert.equal(isWellFormedRule(rule), false)

  const result = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
})

test('review-fix ADD-3: professional and friendly (the other two real tones) still authorize normally', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  for (const tone of ['friendly', 'professional', 'firm']) {
    const rule = baseRule({ id: `rule-${tone}`, trigger_days: 15, tone })
    const result = evaluateNextActionAuthority({
      userId: USER_A,
      invoice,
      rules: [rule],
      autopilotSettings: null,
      events: [],
      now: NOW,
    })
    assert.equal(result.authority.authorized, true, `tone "${tone}" should authorize`)
    assert.equal(result.recommendation.tone, tone)
  }
})
