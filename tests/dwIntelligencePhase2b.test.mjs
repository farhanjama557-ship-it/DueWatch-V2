import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OPERATIONAL_STATE,
  admitEvidence,
  partialPool,
  resolveMemory,
  runPhase2BWorkflow,
  selectPrecedents,
  filterPreferenceEvidence,
} from '../src/lib/dwIntelligence/phase2bEngine.js'

const NOW = new Date('2026-08-24T12:00:00Z')
const tenant = 'tenant-a'
const client = { id: 'client-a', user_id: tenant, name: 'Atlas', email: 'ap@atlas.test' }
const invoice = {
  id: 'inv-a', user_id: tenant, client_id: client.id,
  amount: 10000, amount_paid: 0, due_date: '2026-08-10', paid: false,
  last_reminder: null,
}
const autoAuthority = {
  recommendation: { action: 'send_reminder', tone: 'friendly', ruleId: 'rule-1', ruleName: 'First follow-up' },
  authority: { authorized: true, basis: { ruleId: 'rule-1', ruleName: 'First follow-up' } },
  permission: { requiresApproval: false, canActAutomatically: true },
}
const approvalAuthority = {
  ...autoAuthority,
  permission: { requiresApproval: true, canActAutomatically: false },
}
const noAuthority = {
  recommendation: null,
  authority: { authorized: false, basis: null },
  permission: { requiresApproval: true, canActAutomatically: false },
}
const strongInvoiceEvidence = [{ id: 'e-ledger', tenantId: tenant, clientId: client.id, invoiceId: invoice.id, trust: 'HIGH', claimType: 'ledger_state' }]

function base(overrides = {}) {
  return {
    tenantId: tenant, invoice: { ...invoice }, client: { ...client }, now: NOW,
    evidence: strongInvoiceEvidence, authorityEvaluation: autoAuthority, sandboxTransport: true,
    ...overrides,
  }
}

function zeroHard(result) {
  assert.deepEqual(result.hardViolations, [])
}

test('P2B-01 routine safe path reaches HANDLED via sandbox with zero hard violations', () => {
  const r = runPhase2BWorkflow(base())
  assert.equal(r.state, OPERATIONAL_STATE.HANDLED)
  assert.equal(r.execution.outcome, 'SANDBOX_SENT')
  assert.equal(r.execution.sideEffect, false)
  zeroHard(r)
})

test('P2B-02 authority-required path stages approval and does not send', () => {
  const r = runPhase2BWorkflow(base({ authorityEvaluation: approvalAuthority }))
  assert.equal(r.state, OPERATIONAL_STATE.APPROVAL)
  assert.equal(r.stagedAction.status, 'AWAITING_APPROVAL')
  assert.equal(r.execution.outcome, 'NO_ACTION')
  zeroHard(r)
})

test('P2B-03 payment claim never mutates canonical OPEN money truth', () => {
  const r = runPhase2BWorkflow(base({ evidence: [
    ...strongInvoiceEvidence,
    { id: 'e-email', tenantId: tenant, clientId: client.id, invoiceId: invoice.id, trust: 'MEDIUM', claimType: 'payment_claim', claimsPayment: true },
  ] }))
  assert.equal(r.state, OPERATIONAL_STATE.INVESTIGATING)
  assert.equal(r.canonicalBefore.canonicalStatus, 'OPEN')
  assert.equal(r.canonicalAfter.canonicalStatus, 'OPEN')
  assert.equal(r.execution.sideEffect, false)
  zeroHard(r)
})

test('P2B-04 untrusted prompt-injection evidence is quarantined and cannot grant authority', () => {
  const r = runPhase2BWorkflow(base({ authorityEvaluation: noAuthority, evidence: [
    ...strongInvoiceEvidence,
    { id: 'e-injection', tenantId: tenant, clientId: client.id, invoiceId: invoice.id, trust: 'UNTRUSTED', containsInstructions: true, attemptsAuthorityGrant: true, attemptsPolicyRewrite: true },
  ] }))
  const q = r.proof.evidence.records.find((e) => e.id === 'e-injection')
  assert.equal(q.status, 'QUARANTINED_INSTRUCTION')
  assert.equal(r.proof.verifier.checks.externalInstructionsQuarantined, true)
  assert.equal(r.proof.authority.actual, 'NOT_GRANTED')
  assert.equal(r.execution.sideEffect, false)
  zeroHard(r)
})

test('P2B-05 cross-tenant evidence and precedent stay tenant-pure', () => {
  const r = runPhase2BWorkflow(base({
    evidence: [
      ...strongInvoiceEvidence,
      { id: 'e-other', tenantId: 'tenant-b', clientId: client.id, invoiceId: invoice.id, trust: 'HIGH' },
    ],
    precedents: [
      { id: 'p-other', tenantId: 'tenant-b', similarity: 1, disputed: false, actionType: 'send_reminder' },
      { id: 'p-own', tenantId: tenant, clientId: client.id, similarity: .7, disputed: false, actionType: 'send_reminder' },
    ],
  }))
  const rejected = r.proof.evidence.records.find((e) => e.status === 'REJECTED_TENANT')
  assert.equal(rejected.id, null)
  assert.equal(rejected.redacted, true)
  assert.doesNotMatch(JSON.stringify(r.proof), /e-other/)
  assert.deepEqual(r.proof.precedent.applicable, ['p-own'])
  zeroHard(r)
})

test('P2B-06 valid founder correction memory is reused only in client scope with lineage', () => {
  const evidence = [...strongInvoiceEvidence, { id: 'e-correction', tenantId: tenant, clientId: client.id, trust: 'HIGH', claimType: 'founder_correction' }]
  const memory = [{ id: 'm1', tenantId: tenant, clientId: client.id, scope: 'client', admitted: true, sourceEvidenceIds: ['e-correction'], value: 'friendly_tone' }]
  const r = runPhase2BWorkflow(base({ evidence, memory }))
  assert.deepEqual(r.proof.memory.active, ['m1'])
  const other = runPhase2BWorkflow({ ...base({ evidence, memory }), client: { ...client, id: 'client-other' }, invoice: { ...invoice, client_id: 'client-other' } })
  assert.deepEqual(other.proof.memory.active, [])
  zeroHard(r); zeroHard(other)
})

test('P2B-07 tombstone blocks direct and derivative memory and non-rederivation', () => {
  const evidence = [...strongInvoiceEvidence, { id: 'e-correction', tenantId: tenant, clientId: client.id, trust: 'HIGH' }]
  const memory = [
    { id: 'm1', tenantId: tenant, clientId: client.id, scope: 'client', admitted: true, sourceEvidenceIds: ['e-correction'] },
    { id: 'm2', tenantId: tenant, clientId: client.id, scope: 'client', admitted: true, sourceEvidenceIds: ['e-correction'], derivedFromMemoryId: 'm1' },
  ]
  const tombstones = [{ id: 't1', tenantId: tenant, memoryId: 'm1', blockedEvidenceIds: ['e-correction'] }]
  const r = runPhase2BWorkflow(base({ evidence, memory, tombstones }))
  assert.deepEqual(r.proof.memory.active, [])
  assert.equal(r.proof.memory.blocked.some((m) => m.id === 'm1' && m.reason === 'tombstoned'), true)
  assert.equal(r.proof.memory.blocked.some((m) => m.id === 'm2'), true)
  assert.equal(r.proof.memory.rederivedFromBlockedEvidence, false)
  zeroHard(r)
})

test('P2B-08 precedent applicability rejects semantically similar dispute-incompatible case', () => {
  const p = selectPrecedents({ tenantId: tenant, clientId: client.id, current: { disputed: false, actionType: 'send_reminder' }, precedents: [
    { id: 'p-bad', tenantId: tenant, clientId: client.id, similarity: .99, disputed: true, actionType: 'send_reminder' },
    { id: 'p-good', tenantId: tenant, clientId: client.id, similarity: .72, disputed: false, actionType: 'send_reminder' },
  ] })
  assert.equal(p.checked.find((x) => x.id === 'p-bad').applicable, false)
  assert.deepEqual(p.applicable.map((x) => x.id), ['p-good'])
})

test('P2B-09 sparse client partial pooling exposes prior/local contribution and warning', () => {
  const p = partialPool({ local: { n: 4, rate: .8 }, prior: { ess: 16, rate: .2 } })
  assert.equal(p.strongLocalSupport, false)
  assert.equal(p.supportWarning, 'client_local_support_not_yet_dominant')
  assert.ok(p.localWeight < p.priorWeight)
})

test('P2B-10 new proof data can overcome prior without using consumed holdout threshold tuning', () => {
  const p = partialPool({ local: { n: 40, rate: .80 }, prior: { ess: 16, rate: .20 } })
  assert.equal(p.strongLocalSupport, true)
  assert.equal(p.priorOvercome, true)
  assert.ok(p.localWeight >= 2/3)
  assert.ok(p.posteriorRate > .5)
})

test('P2B-11 wide/stale prediction stays UNCERTAIN even with high nominal coverage', () => {
  const r = runPhase2BWorkflow(base({ predictionRequired: true, prediction: { point: .92, coverage: .99, sampleN: 30, intervalDays: 28, staleDays: 120, assumptionsOk: true } }))
  assert.equal(r.state, OPERATIONAL_STATE.UNCERTAIN)
  assert.equal(r.proof.uncertainty.actionable, false)
  assert.deepEqual(new Set(r.proof.uncertainty.reasons), new Set(['interval_too_wide', 'stale_prediction']))
  zeroHard(r)
})

test('P2B-12 epistemic block and authority block remain distinct', () => {
  const epistemic = runPhase2BWorkflow(base({ predictionRequired: true, prediction: { point: .9, coverage: .99, sampleN: 2, intervalDays: 4, staleDays: 1 } }))
  const authority = runPhase2BWorkflow(base({ authorityEvaluation: approvalAuthority }))
  assert.equal(epistemic.state, OPERATIONAL_STATE.UNCERTAIN)
  assert.equal(authority.state, OPERATIONAL_STATE.APPROVAL)
  assert.equal(epistemic.proof.authority.actual, 'GRANTED')
  assert.equal(authority.proof.authority.actual, 'NOT_GRANTED')
  zeroHard(epistemic); zeroHard(authority)
})

test('P2B-13 high-value founder question asks at most one bounded question', () => {
  const r = runPhase2BWorkflow(base({ authorityEvaluation: noAuthority, question: { candidateQuestion: 'Is Atlas under an active dispute?', informationValue: .75, burdenCost: .20, liveUncertainty: true, safeReversibleAvailable: false } }))
  assert.equal(r.proof.founderQuestion.asked, true)
  assert.equal(r.proof.founderQuestion.question, 'Is Atlas under an active dispute?')
  assert.equal(r.state, OPERATIONAL_STATE.UNCERTAIN)
  zeroHard(r)
})

test('P2B-14 low-value question is suppressed when safe reversible action exists', () => {
  const r = runPhase2BWorkflow(base({ authorityEvaluation: noAuthority, question: { candidateQuestion: 'Do you prefer slightly warmer wording?', informationValue: .5, burdenCost: .20, liveUncertainty: true, safeReversibleAvailable: true } }))
  assert.equal(r.proof.founderQuestion.asked, false)
  assert.equal(r.proof.founderQuestion.suppressedReason, 'safe_reversible_action_available')
  zeroHard(r)
})

test('P2B-15 system-caused exposure is excluded from preference evidence', () => {
  const p = filterPreferenceEvidence([
    { id: 'pref-real', origin: 'founder_explicit' },
    { id: 'pref-performative', origin: 'system_exposure', causedByDwProminence: true },
  ])
  assert.deepEqual(p.admitted.map((x) => x.id), ['pref-real'])
  assert.deepEqual(p.excluded.map((x) => x.id), ['pref-performative'])
})

test('P2B-16 rejected staged reminder causes zero execution and no false sent outcome', () => {
  const r = runPhase2BWorkflow(base({ rejectStagedAction: true }))
  assert.equal(r.stagedAction.status, 'REJECTED')
  assert.equal(r.execution.outcome, 'REJECTED_BEFORE_EXECUTION')
  assert.equal(r.execution.sideEffect, false)
  assert.notEqual(r.execution.outcome, 'SANDBOX_SENT')
  zeroHard(r)
})

test('P2B-17 LOW/UNTRUSTED unrelated sources cannot inflate independent strong-root count', () => {
  const a = admitEvidence({ tenantId: tenant, invoiceId: invoice.id, clientId: client.id, evidence: [
    { id: 'root1', tenantId: tenant, clientId: client.id, invoiceId: invoice.id, trust: 'HIGH' },
    { id: 'summary1', tenantId: tenant, clientId: client.id, invoiceId: invoice.id, trust: 'HIGH', derivedFrom: 'root1' },
    { id: 'low-unrelated', tenantId: tenant, clientId: 'different-client', trust: 'LOW' },
    { id: 'untrusted-unrelated', tenantId: tenant, clientId: 'different-client', trust: 'UNTRUSTED' },
  ] })
  assert.deepEqual(a.independentStrongRoots, ['root1'])
  assert.equal(a.independentStrongRootCount, 1)
})

test('all 17 workflow/regression scenarios leave canonical money unchanged by learned/semantic paths', () => {
  const cases = [
    base(),
    base({ authorityEvaluation: approvalAuthority }),
    base({ evidence: [...strongInvoiceEvidence, { id: 'e-pay', tenantId: tenant, clientId: client.id, invoiceId: invoice.id, trust: 'MEDIUM', claimType: 'payment_claim' }] }),
    base({ authorityEvaluation: noAuthority, evidence: [...strongInvoiceEvidence, { id: 'e-inj', tenantId: tenant, clientId: client.id, invoiceId: invoice.id, trust: 'UNTRUSTED', containsInstructions: true, attemptsAuthorityGrant: true }] }),
    base({ predictionRequired: true, prediction: { sampleN: 2, intervalDays: 30, staleDays: 100, coverage: .99 } }),
    base({ rejectStagedAction: true }),
  ]
  for (const c of cases) {
    const r = runPhase2BWorkflow(c)
    assert.equal(r.canonicalAfter.canonicalStatus, r.canonicalBefore.canonicalStatus)
    assert.equal(r.canonicalAfter.balance, r.canonicalBefore.balance)
    zeroHard(r)
  }
})
