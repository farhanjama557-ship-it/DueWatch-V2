import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateNextActionAuthority,
  revalidateAuthority,
  buildRuleSnapshot,
  hashRuleSnapshot,
  isWellFormedRule,
  REVALIDATION_OUTCOMES,
  ACTION_SEND_REMINDER,
} from '../src/lib/nextActionAuthority.js'
import * as authorityModule from '../src/lib/nextActionAuthority.js'

// Local midnight, matching how due_date strings are parsed (src/lib/format.js
// parseDate) so day-math in these tests is exact, never rounding-ambiguous.
const NOW = new Date(2026, 5, 15)

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
    user_id: 'user-1',
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
    user_id: 'user-1',
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
// authority.basis/recommendation when a real rule authorizes something —
// that is founder-authored evidence, not invented policy language. These
// checks only run against results where NO rule authorized anything, so
// there is no rule `name` in the payload to produce a false positive.
function assertNoInventedPolicyLanguage(result) {
  const serialized = JSON.stringify(result).toLowerCase()
  for (const phrase of FORBIDDEN_SUBSTRINGS) {
    assert.equal(serialized.includes(phrase), false, `result must not contain "${phrase}": ${serialized}`)
  }
}

// ---------------------------------------------------------------------
// 1. ZERO RULES + 120 DAYS OVERDUE
// ---------------------------------------------------------------------
test('1. zero rules + 120 days overdue -> no recommendation, facts only, no invented policy language', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -120), amount: 50000, amount_paid: 0 })
  const result = evaluateNextActionAuthority({ invoice, rules: [], autopilotSettings: null, events: [], now: NOW })

  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
  assert.equal(result.authority.basis, null)
  assert.equal(result.authority.ruleSnapshotHash, null)
  assert.equal(result.facts.daysOverdue, 120)
  assert.equal(result.facts.amountOutstanding, 50000)
  assert.equal(result.facts.paid, false)
  assertNoInventedPolicyLanguage(result)
})

// ---------------------------------------------------------------------
// 2. 30+ DAYS OVERDUE, NO MATCHING RULE
// ---------------------------------------------------------------------
test('2. 30+ days overdue with only a non-matching rule -> no "final notice" recommendation', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -35) })
  const rules = [baseRule({ id: 'r-before', trigger_type: 'before_due', trigger_days: 3, name: 'Friendly reminder' })]
  const result = evaluateNextActionAuthority({ invoice, rules, autopilotSettings: null, events: [], now: NOW })

  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
  assertNoInventedPolicyLanguage(result)
})

// ---------------------------------------------------------------------
// 3. 15+ DAYS OVERDUE, NO MATCHING RULE
// ---------------------------------------------------------------------
test('3. 15+ days overdue with only a non-matching rule -> no "firm reminder" recommendation', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -18) })
  const rules = [baseRule({ id: 'r-before', trigger_type: 'before_due', trigger_days: 3, name: 'Friendly reminder' })]
  const result = evaluateNextActionAuthority({ invoice, rules, autopilotSettings: null, events: [], now: NOW })

  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
  assertNoInventedPolicyLanguage(result)
})

// ---------------------------------------------------------------------
// 4. MATCHING ENABLED RULE
// ---------------------------------------------------------------------
test('4. a matching enabled rule authorizes a recommendation carrying the exact persisted rule ID and name', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rules = [baseRule({ id: 'rule-firm-42', name: 'Firm reminder', trigger_type: 'after_due', trigger_days: 15 })]
  const result = evaluateNextActionAuthority({ invoice, rules, autopilotSettings: null, events: [], now: NOW })

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

// ---------------------------------------------------------------------
// 5. DISABLED RULE
// ---------------------------------------------------------------------
test('5. a disabled rule does not authorize a recommendation', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rules = [baseRule({ id: 'rule-1', trigger_days: 15, enabled: false })]
  const result = evaluateNextActionAuthority({ invoice, rules, autopilotSettings: null, events: [], now: NOW })

  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
})

// ---------------------------------------------------------------------
// 6. SNAPSHOT DETERMINISM
// ---------------------------------------------------------------------
test('6a. the same policy state always produces the same snapshot hash', () => {
  const rule = baseRule({ id: 'r1', trigger_days: 15, tone: 'firm', enabled: true })
  const h1 = hashRuleSnapshot(buildRuleSnapshot(rule))
  const h2 = hashRuleSnapshot(buildRuleSnapshot({ ...rule }))
  assert.equal(h1, h2)
})

test('6b. irrelevant metadata (name, sort_order, created_at) does not change the hash', () => {
  const rule = baseRule({ id: 'r1', trigger_days: 15, tone: 'firm', enabled: true })
  const h1 = hashRuleSnapshot(buildRuleSnapshot(rule))
  const h2 = hashRuleSnapshot(
    buildRuleSnapshot({ ...rule, name: 'Totally different label', sort_order: 99, created_at: '2099-01-01T00:00:00Z' })
  )
  assert.equal(h1, h2)
})

test('6c. a policy-relevant change (trigger_days) does change the hash', () => {
  const rule = baseRule({ id: 'r1', trigger_days: 15, tone: 'firm', enabled: true })
  const h1 = hashRuleSnapshot(buildRuleSnapshot(rule))
  const h2 = hashRuleSnapshot(buildRuleSnapshot({ ...rule, trigger_days: 45 }))
  assert.notEqual(h1, h2)
})

test('6d. a policy-relevant change (tone) does change the hash', () => {
  const rule = baseRule({ id: 'r1', trigger_days: 15, tone: 'friendly', enabled: true })
  const h1 = hashRuleSnapshot(buildRuleSnapshot(rule))
  const h2 = hashRuleSnapshot(buildRuleSnapshot({ ...rule, tone: 'firm' }))
  assert.notEqual(h1, h2)
})

// ---------------------------------------------------------------------
// 7. RULE CHANGED AFTER EVALUATION
// ---------------------------------------------------------------------
test('7. revalidation rejects the prior authority as stale once trigger_days changes', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const originalRule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    invoice,
    rules: [originalRule],
    autopilotSettings: { enabled: true, approval_required: false },
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const changedRule = { ...originalRule, trigger_days: 45 }
  const revalidated = revalidateAuthority({
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

// ---------------------------------------------------------------------
// 8. RULE DISABLED AFTER EVALUATION
// ---------------------------------------------------------------------
test('8. revalidation rejects the prior authority once the same rule is disabled', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const originalRule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    invoice,
    rules: [originalRule],
    autopilotSettings: { enabled: true, approval_required: false },
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const disabledRule = { ...originalRule, enabled: false }
  const revalidated = revalidateAuthority({
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

// ---------------------------------------------------------------------
// 9. RULE ID STILL EXISTS BUT TONE CHANGED
// ---------------------------------------------------------------------
test('9. revalidation does not pass merely because the rule ID still exists -- tone change is caught', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const originalRule = baseRule({ id: 'rule-1', trigger_days: 15, tone: 'friendly' })
  const evaluated = evaluateNextActionAuthority({
    invoice,
    rules: [originalRule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const retonedRule = { ...originalRule, tone: 'firm' }
  const revalidated = revalidateAuthority({
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

// ---------------------------------------------------------------------
// 10. TRIGGER CHANGED (30 -> 45 days)
// ---------------------------------------------------------------------
test('10. trigger changed from 30 to 45 days invalidates the old authorization', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -32) })
  const originalRule = baseRule({ id: 'rule-final', trigger_days: 30, name: 'Final notice' })
  const evaluated = evaluateNextActionAuthority({
    invoice,
    rules: [originalRule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const movedRule = { ...originalRule, trigger_days: 45 }
  const revalidated = revalidateAuthority({
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

// ---------------------------------------------------------------------
// 11. INVOICE FACTS CHANGE
// ---------------------------------------------------------------------
test('11. invoice facts changing so the rule no longer matches invalidates the prior authorization', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const paidInvoice = { ...invoice, paid: true }
  const revalidated = revalidateAuthority({
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

// ---------------------------------------------------------------------
// 12. DIFFERENT RULE NOW MATCHES -- must not silently transfer authority
// ---------------------------------------------------------------------
test('12. a different, more-advanced rule newly matching does not silently transfer authority', () => {
  const invoiceAt20 = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const firmRule = baseRule({ id: 'rule-firm', trigger_days: 15, name: 'Firm reminder' })
  const evaluated = evaluateNextActionAuthority({
    invoice: invoiceAt20,
    rules: [firmRule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)
  assert.equal(evaluated.authority.basis.ruleId, 'rule-firm')

  // Time passes: the invoice is now 35 days overdue, and a second, more
  // advanced rule ("Final notice", 30 days) also matches now. The original
  // 15-day rule is untouched and, on its own terms, still matches too.
  const invoiceAt35 = { ...invoiceAt20, due_date: isoDateDaysFromNow(NOW, -35) }
  const finalNoticeRule = baseRule({ id: 'rule-final', trigger_days: 30, name: 'Final notice' })

  const revalidated = revalidateAuthority({
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

// ---------------------------------------------------------------------
// 13. APPROVAL SETTING CHANGES
// ---------------------------------------------------------------------
test('13. revalidation uses current permission state, not the permission state at evaluation time', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const evaluated = evaluateNextActionAuthority({
    invoice,
    rules: [rule],
    autopilotSettings: { enabled: true, approval_required: true },
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.permission.requiresApproval, true)
  assert.equal(evaluated.permission.canActAutomatically, false)

  const revalidated = revalidateAuthority({
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

// ---------------------------------------------------------------------
// 14. LAST REMINDER -- elapsed time only, never a response fact
// ---------------------------------------------------------------------
test('14. last_reminder produces only elapsed-time evidence, never a "no response" fact', () => {
  const lastReminderAt = new Date(NOW.getTime() - 6 * 86400000).toISOString()
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20), last_reminder: lastReminderAt })
  const result = evaluateNextActionAuthority({ invoice, rules: [], autopilotSettings: null, events: [], now: NOW })

  assert.equal(result.facts.lastReminderAt, lastReminderAt)
  assert.equal(result.facts.daysSinceLastReminder, 6)
  assert.equal('responded' in result.facts, false)
  assert.equal('noResponse' in result.facts, false)
  assert.equal('hasResponded' in result.facts, false)
  const serialized = JSON.stringify(result).toLowerCase()
  assert.equal(serialized.includes('respond'), false)
})

// ---------------------------------------------------------------------
// 15. MALFORMED RULE STATE -- fail closed
// ---------------------------------------------------------------------
test('15a. a structurally malformed rule cannot authorize anything at evaluation time', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const malformedRule = { id: 'bad-rule', trigger_type: 'after_due' } // missing trigger_days/tone/enabled
  const result = evaluateNextActionAuthority({
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
    invoice,
    rules: [rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(evaluated.authority.authorized, true)

  const corrupted = { id: 'rule-1', trigger_type: 'after_due' } // now missing required fields
  const revalidated = revalidateAuthority({
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

// ---------------------------------------------------------------------
// 16. UNKNOWN RULE STATE -- unrecognized trigger_type fails closed
// ---------------------------------------------------------------------
test('16. an unrecognized trigger_type cannot authorize anything', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const unknownTypeRule = baseRule({ id: 'rule-1', trigger_type: 'quarterly_review', trigger_days: 15 })
  assert.equal(isWellFormedRule(unknownTypeRule), false)

  const result = evaluateNextActionAuthority({
    invoice,
    rules: [unknownTypeRule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  assert.equal(result.recommendation, null)
  assert.equal(result.authority.authorized, false)
})

// ---------------------------------------------------------------------
// 17. HASH PRESENCE ALONE CANNOT AUTHORIZE ANYTHING
// ---------------------------------------------------------------------
test('17a. an unauthorized evaluation never carries a stray ruleSnapshotHash', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -5) })
  const result = evaluateNextActionAuthority({ invoice, rules: [], autopilotSettings: null, events: [], now: NOW })
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

// ---------------------------------------------------------------------
// 18. RANKING -- this module must not invent priority/ranking
// ---------------------------------------------------------------------
test('18a. the module exports no ranking/priority/sort function', () => {
  const exportNames = Object.keys(authorityModule)
  for (const name of exportNames) {
    const lower = name.toLowerCase()
    assert.equal(lower.includes('rank'), false, `unexpected ranking export: ${name}`)
    assert.equal(lower.includes('priorit'), false, `unexpected priority export: ${name}`)
    assert.equal(lower.includes('sort'), false, `unexpected sort export: ${name}`)
  }
})

test('18b. results contain no rank/priority field and are independent of rule array order', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rule = baseRule({ id: 'rule-1', trigger_days: 15 })
  const otherRule = baseRule({ id: 'rule-0', trigger_type: 'before_due', trigger_days: 3, name: 'Friendly reminder' })

  const resultA = evaluateNextActionAuthority({
    invoice,
    rules: [rule, otherRule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })
  const resultB = evaluateNextActionAuthority({
    invoice,
    rules: [otherRule, rule],
    autopilotSettings: null,
    events: [],
    now: NOW,
  })

  assert.deepEqual(resultA.authority.basis, resultB.authority.basis)
  assert.equal('rank' in resultA, false)
  assert.equal('priority' in resultA, false)
  assert.equal('rank' in resultA.recommendation, false)
  assert.equal('priority' in resultA.recommendation, false)
})

// ---------------------------------------------------------------------
// Bonus: events is accepted for shape/future-parity but is inert today.
// ---------------------------------------------------------------------
test('bonus: differing events arrays never change the result (no undefined evidence source is consulted)', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20) })
  const rules = [baseRule({ id: 'rule-1', trigger_days: 15 })]
  const resultNoEvents = evaluateNextActionAuthority({ invoice, rules, autopilotSettings: null, events: [], now: NOW })
  const resultWithEvents = evaluateNextActionAuthority({
    invoice,
    rules,
    autopilotSettings: null,
    events: [{ event_type: 'reminder_sent', invoice_id: 'inv-1', created_at: NOW.toISOString() }],
    now: NOW,
  })
  assert.deepEqual(resultNoEvents, resultWithEvents)
})

// ---------------------------------------------------------------------
// Bonus: permission separates policy from execution authority.
// ---------------------------------------------------------------------
test('bonus: a matching rule can authorize a recommendation while an individually-paused invoice still blocks automatic action', () => {
  const invoice = baseInvoice({ due_date: isoDateDaysFromNow(NOW, -20), autopilot_paused: true })
  const rules = [baseRule({ id: 'rule-1', trigger_days: 15 })]
  const result = evaluateNextActionAuthority({
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
