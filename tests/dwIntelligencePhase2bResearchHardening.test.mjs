import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLAIM_ROLE,
  PAYMENT_STATE,
  DISPUTE_STATE,
  ACTION_RISK,
  assessPrecedentStructure,
  buildArAnalysisPlan,
  buildConstraintPlan,
  buildExecutionIntent,
  projectArControlState,
  projectAttributedClaims,
} from '../src/lib/dwIntelligence/phase2bArControl.js'

import {
  OPERATIONAL_STATE,
  admitEvidence,
  assessPrediction,
  partialPool,
  runPhase2BWorkflow,
  selectPrecedents,
} from '../src/lib/dwIntelligence/phase2bEngine.js'

const NOW = new Date('2026-08-25T12:00:00Z')
const tenantId = 'tenant-a'
const client = { id: 'client-a', user_id: tenantId, name: 'Atlas' }
const invoice = {
  id: 'inv-a',
  user_id: tenantId,
  client_id: client.id,
  amount: 18400,
  amount_paid: 0,
  due_date: '2026-08-01',
  paid: false,
  last_reminder: null,
}

function authority(action = 'send_reminder', { automatic = true } = {}) {
  return {
    recommendation: { action, tone: 'friendly', ruleId: 'rule-a' },
    authority: { authorized: true, basis: { ruleId: 'rule-a' } },
    permission: { canActAutomatically: automatic, requiresApproval: !automatic },
  }
}

function evidence(extra = []) {
  return [
    {
      id: 'ledger',
      tenantId,
      clientId: client.id,
      invoiceId: invoice.id,
      trust: 'HIGH',
      sourceType: 'invoice_system',
      claimType: 'invoice_state',
    },
    ...extra,
  ]
}

test('RH-01 attributed claims preserve role/provenance and never directly mutate canonical state', () => {
  const admission = admitEvidence({
    tenantId,
    clientId: client.id,
    invoiceId: invoice.id,
    evidence: evidence([{
      id: 'customer-paid',
      tenantId,
      clientId: client.id,
      invoiceId: invoice.id,
      trust: 'MEDIUM',
      sourceType: 'email',
      claimType: 'payment_claim',
      claimsPayment: true,
    }]),
  })
  const claims = projectAttributedClaims({ admission, observedAt: NOW.toISOString() })
  assert.equal(claims.find((c) => c.sourceEvidenceId === 'ledger').role, CLAIM_ROLE.CANONICAL_RECORD)
  assert.equal(claims.find((c) => c.sourceEvidenceId === 'customer-paid').role, CLAIM_ROLE.ATTRIBUTED_ASSERTION)
  assert.equal(claims.every((c) => c.canonicalEffect === 'NONE'), true)
})

test('RH-02 payment claim becomes reconciliation state, not SETTLED truth', () => {
  const admission = admitEvidence({
    tenantId,
    clientId: client.id,
    invoiceId: invoice.id,
    evidence: evidence([{
      id: 'customer-paid',
      tenantId,
      clientId: client.id,
      invoiceId: invoice.id,
      trust: 'MEDIUM',
      claimType: 'payment_claim',
      claimsPayment: true,
    }]),
  })
  const canonical = { canonicalStatus: 'OPEN', settled: false, balance: 18400, daysOverdue: 24 }
  const state = projectArControlState({ canonical, admission })
  assert.equal(state.payment.status, PAYMENT_STATE.CLAIMED_UNVERIFIED)
  assert.equal(state.reconciliation.requiresPaymentReconciliation, true)
  assert.equal(state.reconciliation.canonicalMutationAllowed, false)
  assert.equal(state.collection.status, 'HOLD_RECONCILIATION')
})

test('RH-03 customer dispute assertion is a typed operational hold and workflow investigates', () => {
  const result = runPhase2BWorkflow({
    tenantId,
    invoice,
    client,
    now: NOW,
    evidence: evidence([{
      id: 'dispute-email',
      tenantId,
      clientId: client.id,
      invoiceId: invoice.id,
      trust: 'MEDIUM',
      sourceType: 'email',
      claimType: 'dispute_claim',
      claimsDispute: true,
    }]),
    authorityEvaluation: authority(),
    sandboxTransport: true,
  })
  assert.equal(result.proof.arState.dispute.status, DISPUTE_STATE.CUSTOMER_ASSERTED)
  assert.equal(result.proof.reconciliation.requiresDisputeResolution, true)
  assert.equal(result.state, OPERATIONAL_STATE.INVESTIGATING)
  assert.equal(result.execution.sideEffect, false)
  assert.deepEqual(result.hardViolations, [])
})

test('RH-04 structural precedent applicability rejects payment-state mismatch and bad outcome quality', () => {
  const current = {
    disputed: false,
    actionType: 'send_reminder',
    promiseStatus: 'NONE',
    paymentState: 'OPEN',
    collectionStage: 'ACTIVE_OVERDUE',
  }
  const p = selectPrecedents({
    tenantId,
    clientId: client.id,
    current,
    precedents: [
      { id: 'semantic-only', tenantId, similarity: .99, disputed: false, actionType: 'send_reminder', paymentState: 'CLAIMED_UNVERIFIED' },
      { id: 'bad-outcome', tenantId, similarity: .95, disputed: false, actionType: 'send_reminder', paymentState: 'OPEN', outcomeQuality: 'LOW' },
      { id: 'fit', tenantId, similarity: .80, disputed: false, actionType: 'send_reminder', paymentState: 'OPEN', collectionStage: 'ACTIVE_OVERDUE' },
    ],
  })
  assert.deepEqual(p.applicable.map((x) => x.id), ['fit'])
  assert.equal(p.checked.find((x) => x.id === 'semantic-only').reasons.paymentCompatible, false)
  assert.equal(p.checked.find((x) => x.id === 'bad-outcome').reasons.outcomeQualityOk, false)
})

test('RH-05 empirical partial pooling stays transparent instead of pretending to be a full Bayesian model', () => {
  const p = partialPool({ local: { n: 2, rate: .9 }, prior: { ess: 12, rate: .5 } })
  assert.equal(p.method, 'EMPIRICAL_PARTIAL_POOL')
  assert.equal(p.effectiveSampleSize, 14)
  assert.ok(p.priorWeight > p.localWeight)
})

test('RH-06 drift-aware prediction refuses false precision', () => {
  const p = assessPrediction({
    point: 7,
    sampleN: 30,
    intervalDays: 8,
    staleDays: 2,
    assumptionsOk: true,
    driftScore: .72,
  })
  assert.equal(p.actionable, false)
  assert.equal(p.reasons.includes('distribution_drift'), true)
})

test('RH-07 routine cases use minimum-sufficient analysis plan', () => {
  const plan = buildArAnalysisPlan({
    evidence: evidence(),
    authorityEvaluation: authority(),
  })
  assert.equal(plan.tier, 'STANDARD')
  assert.equal(plan.run.precedent, false)
  assert.equal(plan.run.pooling, false)
  assert.equal(plan.run.uncertainty, false)
  assert.equal(plan.run.memory, false)
  assert.equal(plan.reason, 'minimum_sufficient_analysis')
})

test('RH-08 conflicting evidence automatically promotes core analysis to GUARDED', () => {
  const plan = buildArAnalysisPlan({
    evidence: evidence([{
      id: 'pay',
      tenantId,
      clientId: client.id,
      invoiceId: invoice.id,
      trust: 'MEDIUM',
      claimType: 'payment_claim',
    }]),
    authorityEvaluation: authority(),
  })
  assert.equal(plan.tier, 'GUARDED')
})

test('RH-09 execution intent carries deterministic idempotency and server-revalidation contract', () => {
  const intent = buildExecutionIntent({
    tenantId,
    invoiceId: invoice.id,
    canonical: { canonicalStatus: 'OPEN', balance: 18400, lastReminderAt: null },
    recommendation: { action: 'send_reminder', ruleId: 'r1' },
  })
  assert.equal(intent.riskClass, ACTION_RISK.REVERSIBLE_CUSTOMER_CONTACT)
  assert.equal(intent.requiresServerRevalidation, true)
  assert.match(intent.idempotencyKey, /^dw:tenant-a:inv-a:send_reminder:r1:/)
})

test('RH-10 accounting-controlled mutation cannot be auto-executed by Phase 2B even if a policy says automatic', () => {
  const result = runPhase2BWorkflow({
    tenantId,
    invoice,
    client,
    now: NOW,
    evidence: evidence(),
    authorityEvaluation: authority('write_off', { automatic: true }),
    sandboxTransport: true,
  })
  assert.equal(result.proof.constraints.accountingControlled, true)
  assert.equal(result.proof.constraints.blockers.includes('accounting_control_required'), true)
  assert.equal(result.state, OPERATIONAL_STATE.APPROVAL)
  assert.equal(result.execution.sideEffect, false)
})

test('RH-11 routine reminder remains HANDLED while gaining control metadata', () => {
  const result = runPhase2BWorkflow({
    tenantId,
    invoice,
    client,
    now: NOW,
    evidence: evidence(),
    authorityEvaluation: authority(),
    sandboxTransport: true,
  })
  assert.equal(result.state, OPERATIONAL_STATE.HANDLED)
  assert.equal(result.proof.analysisPlan.tier, 'STANDARD')
  assert.equal(result.proof.constraints.preconditionsSatisfied, true)
  assert.equal(result.stagedAction.requiresServerRevalidation, true)
  assert.ok(result.stagedAction.idempotencyKey)
  assert.deepEqual(result.hardViolations, [])
})

test('RH-12 research hardening still preserves canonical money immutability', () => {
  const result = runPhase2BWorkflow({
    tenantId,
    invoice,
    client,
    now: NOW,
    evidence: evidence([{
      id: 'settlement-looking-doc',
      tenantId,
      clientId: client.id,
      invoiceId: invoice.id,
      trust: 'HIGH',
      sourceType: 'remittance_pdf',
      claimType: 'payment_settlement',
      settlementConfirmed: true,
    }]),
    authorityEvaluation: authority(),
    sandboxTransport: true,
  })
  assert.equal(result.proof.arState.payment.status, PAYMENT_STATE.SETTLEMENT_EVIDENCE_CONFLICT)
  assert.equal(result.canonicalAfter.balance, result.canonicalBefore.balance)
  assert.equal(result.canonicalAfter.canonicalStatus, result.canonicalBefore.canonicalStatus)
  assert.equal(result.execution.sideEffect, false)
  assert.deepEqual(result.hardViolations, [])
})
