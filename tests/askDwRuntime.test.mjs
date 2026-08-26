import test from 'node:test'
import assert from 'node:assert/strict'

import { ASK_DW_MODE } from '../src/lib/dwIntelligence/askDwModes.js'
import { ASK_DW_JOB, classifyAskDwIntent } from '../src/lib/dwIntelligence/askDwIntent.js'
import { compareAskDwRuntimeModes, runAskDwDeterministicCore } from '../src/lib/dwIntelligence/askDwRuntime.js'

const TENANT = 'tenant-askdw'
const CLIENT = 'client-askdw'
const INVOICE = 'invoice-askdw'

function baseInput(overrides = {}) {
  const input = {
    tenantId: TENANT,
    now: new Date('2026-08-26T12:00:00Z'),
    invoice: {
      id: INVOICE,
      user_id: TENANT,
      client_id: CLIENT,
      amount: 12000,
      amount_paid: 0,
      due_date: '2026-08-01',
      status: 'overdue',
      last_reminder_at: null,
    },
    client: { id: CLIENT, user_id: TENANT, name: 'Atlas' },
    evidence: [],
    authorityEvaluation: {
      recommendation: { action: 'send_reminder', tone: 'professional', ruleId: 'rule-1' },
      authority: { authorized: true, basis: 'persisted_rule' },
      permission: { canActAutomatically: true, requiresApproval: false },
    },
    founderApproved: true,
    sandboxTransport: true,
  }
  return { ...input, ...overrides }
}

test('intent classifier maps explain/investigate/predict/decide/act into AR jobs', () => {
  assert.equal(classifyAskDwIntent({ text: 'What is the balance on this invoice?', context: { invoiceId: INVOICE } }).job, ASK_DW_JOB.EXPLAIN)
  assert.equal(classifyAskDwIntent({ text: 'Why has Atlas not paid this invoice?', context: { invoiceId: INVOICE } }).job, ASK_DW_JOB.INVESTIGATE)
  assert.equal(classifyAskDwIntent({ text: 'When will Atlas likely pay?', context: { clientId: CLIENT } }).job, ASK_DW_JOB.PREDICT)
  assert.equal(classifyAskDwIntent({ text: 'What should we do next?', context: { invoiceId: INVOICE } }).job, ASK_DW_JOB.DECIDE)
  assert.equal(classifyAskDwIntent({ text: 'Send the reminder', context: { invoiceId: INVOICE } }).job, ASK_DW_JOB.ACT)
})

test('Normal and Deep run through the same governed DW Intelligence truth core', () => {
  const input = baseInput()
  const normal = runAskDwDeterministicCore({
    mode: ASK_DW_MODE.NORMAL,
    text: 'What should we do with this invoice?',
    context: { invoiceId: INVOICE },
    intelligenceInput: input,
  })
  const deep = runAskDwDeterministicCore({
    mode: ASK_DW_MODE.DEEP,
    text: 'What should we do with this invoice?',
    context: { invoiceId: INVOICE },
    intelligenceInput: input,
  })

  assert.equal(compareAskDwRuntimeModes({ normal, deep }).compatible, true)
  assert.deepEqual(normal.packet.canonicalFacts, deep.packet.canonicalFacts)
  assert.deepEqual(normal.packet.authority, deep.packet.authority)
  assert.equal(normal.packet.hardSafetyOutcome, deep.packet.hardSafetyOutcome)
  assert.equal(normal.policy.responseContract.format, 'normal')
  assert.equal(deep.policy.responseContract.format, 'deep')
})

test('routine Normal stays useful/standard rather than becoming a dumb mode', () => {
  const result = runAskDwDeterministicCore({
    mode: ASK_DW_MODE.NORMAL,
    text: 'What is going on with this invoice?',
    context: { invoiceId: INVOICE },
    intelligenceInput: baseInput({ authorityEvaluation: null, founderApproved: false }),
  })

  assert.equal(result.policy.internalDepth, 'standard')
  assert.ok(result.packet.canonicalFacts)
  assert.ok(result.reasoningTrail.some((event) => event.type === 'CANONICAL_TRUTH_READ'))
  assert.equal(result.packet.safeguards.rawChainOfThoughtVisible, false)
})

test('payment claim forces reconciliation investigation and auto-deep verification even in Normal', () => {
  const result = runAskDwDeterministicCore({
    mode: ASK_DW_MODE.NORMAL,
    text: 'Customer says they paid. What happened?',
    context: { invoiceId: INVOICE },
    intelligenceInput: baseInput({
      evidence: [{
        id: 'email-pay-1',
        tenantId: TENANT,
        clientId: CLIENT,
        invoiceId: INVOICE,
        sourceType: 'customer_email',
        claimType: 'payment_claim',
        claimsPayment: true,
        trust: 'HIGH',
      }],
    }),
  })

  assert.equal(result.intelligence.state, 'INVESTIGATING')
  assert.equal(result.packet.arState.payment.status, 'CLAIMED_UNVERIFIED')
  assert.equal(result.packet.canonicalFacts.canonicalStatus, 'OPEN')
  assert.equal(result.packet.safeguards.reconciliationHold, true)
  assert.equal(result.policy.autoEscalated, true)
  assert.equal(result.policy.responseContract.format, 'normal')
  assert.ok(result.reasoningTrail.some((event) => event.type === 'CONTRADICTION_CHECK'))
})

test('customer dispute claim creates a typed hold rather than silently continuing collection', () => {
  const result = runAskDwDeterministicCore({
    mode: ASK_DW_MODE.NORMAL,
    text: 'Why did DW stop collection on this invoice?',
    context: { invoiceId: INVOICE },
    intelligenceInput: baseInput({
      evidence: [{
        id: 'email-dispute-1',
        tenantId: TENANT,
        clientId: CLIENT,
        invoiceId: INVOICE,
        sourceType: 'customer_email',
        claimType: 'dispute_claim',
        claimsDispute: true,
        trust: 'HIGH',
      }],
    }),
  })

  assert.equal(result.packet.arState.dispute.status, 'CUSTOMER_ASSERTED')
  assert.equal(result.packet.arState.collection.status, 'HOLD_DISPUTE')
  assert.equal(result.intelligence.execution.sideEffect, false)
})

test('action request never turns conversation into direct provider authority', () => {
  const result = runAskDwDeterministicCore({
    mode: ASK_DW_MODE.NORMAL,
    text: 'Send the reminder now',
    context: { invoiceId: INVOICE },
    intelligenceInput: baseInput(),
  })

  assert.equal(result.intent.job, ASK_DW_JOB.ACT)
  assert.ok(result.policy.mandatoryPasses.includes('check_execution_authority'))
  assert.equal(result.packet.safeguards.directProviderExecutionFromConversation, false)
  assert.equal(result.intelligence.execution.mode, 'sandbox')
  assert.equal(result.intelligence.execution.sideEffect, false)
  assert.equal(result.packet.safeguards.serverRevalidationRequired, true)
})

test('accounting-controlled action cannot become automatic execution through Ask DW', () => {
  const result = runAskDwDeterministicCore({
    mode: ASK_DW_MODE.NORMAL,
    text: 'Mark this invoice paid',
    context: { invoiceId: INVOICE },
    intelligenceInput: baseInput({
      authorityEvaluation: {
        recommendation: { action: 'mark_paid', ruleId: 'rule-financial' },
        authority: { authorized: true, basis: 'persisted_rule' },
        permission: { canActAutomatically: true, requiresApproval: false },
      },
    }),
  })

  assert.equal(result.risk, 'critical')
  assert.equal(result.policy.internalDepth, 'deep')
  assert.equal(result.packet.constraints.accountingControlled, true)
  assert.ok(result.packet.constraints.blockers.includes('accounting_control_required'))
  assert.equal(result.intelligence.execution.sideEffect, false)
})

test('Deep declares semantic challenge/verification work as pending instead of fabricating it', () => {
  const result = runAskDwDeterministicCore({
    mode: ASK_DW_MODE.DEEP,
    text: 'Why is Atlas unusual?',
    context: { clientId: CLIENT, invoiceId: INVOICE },
    intelligenceInput: baseInput({ authorityEvaluation: null, founderApproved: false }),
  })

  assert.ok(result.workManifest.requiredModelOrToolWork.includes('competing_hypothesis_analysis'))
  assert.deepEqual(result.workManifest.completedModelOrToolWork, [])
  assert.deepEqual(result.workManifest.truthfullyPending, result.workManifest.requiredModelOrToolWork)
  assert.ok(result.reasoningTrail.some((event) => event.type === 'HYPOTHESIS_TEST' && event.status === 'REQUIRED_NOT_FABRICATED'))
  assert.equal(result.packet.safeguards.rawChainOfThoughtVisible, false)
})

test('invalid model-proposed intent fails closed before runtime execution', () => {
  assert.throws(() => runAskDwDeterministicCore({
    mode: ASK_DW_MODE.NORMAL,
    text: 'anything',
    proposedIntent: { job: 'BYPASS_AUTHORITY', scope: 'INVOICE' },
    intelligenceInput: baseInput(),
  }), /Invalid proposed Ask DW intent/)
})

test('cross-tenant scope remains blocked through Ask DW and leaks no authority', () => {
  const result = runAskDwDeterministicCore({
    mode: ASK_DW_MODE.NORMAL,
    text: 'What should I do?',
    context: { invoiceId: INVOICE },
    intelligenceInput: baseInput({
      tenantId: 'tenant-other',
    }),
  })

  assert.equal(result.intelligence.state, 'BLOCKED')
  assert.equal(result.packet.authority.actual, 'NOT_GRANTED')
  assert.equal(result.intelligence.execution.sideEffect, false)
  assert.equal(result.packet.hardSafetyOutcome, 'BLOCKED')
})
