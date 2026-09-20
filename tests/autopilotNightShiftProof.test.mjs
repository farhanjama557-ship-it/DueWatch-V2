import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NIGHT_SHIFT_DISPOSITION } from '../src/lib/autopilot/nightShiftPlanner.js'
import {
  SHIFT_RESULT,
  buildMorningHandoff,
  buildShiftLogEntry,
} from '../src/lib/autopilot/nightShiftProof.js'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const RUN = 'shift-1'

function plan(disposition = NIGHT_SHIFT_DISPOSITION.EXECUTE) {
  return { disposition }
}

function receipt() {
  return {
    provider: 'resend',
    provider_message_id: 'msg-1',
    execution_claim_id: 'claim-1',
  }
}

test('AP6: external completion requires both provider and idempotency proof', () => {
  assert.throws(
    () => buildShiftLogEntry({
      userId: USER,
      shiftRunId: RUN,
      evidenceRefs: ['invoice:1'],
      authorityProof: { authorized: true },
      plan: plan(),
      result: { status: SHIFT_RESULT.COMPLETED, external_action_performed: true },
    }),
    /requires provider and execution claim receipt/,
  )

  const entry = buildShiftLogEntry({
    userId: USER,
    shiftRunId: RUN,
    occurredAt: '2026-09-20T04:00:00.000Z',
    evidenceRefs: ['invoice:1', 'rule:1'],
    authorityProof: { authorized: true, rule_id: 'rule-1' },
    plan: plan(),
    result: { status: SHIFT_RESULT.COMPLETED, external_action_performed: true },
    providerReceipt: receipt(),
  })
  assert.equal(entry.result.status, SHIFT_RESULT.COMPLETED)
  assert.equal(entry.provider_receipt.execution_claim_id, 'claim-1')
})

test('AP6: an unauthorized external action cannot be represented as performed', () => {
  assert.throws(
    () => buildShiftLogEntry({
      userId: USER,
      shiftRunId: RUN,
      evidenceRefs: [],
      authorityProof: { authorized: false },
      plan: plan(),
      result: { status: SHIFT_RESULT.COMPLETED, external_action_performed: true },
      providerReceipt: receipt(),
    }),
    /unauthorized external action/,
  )
})

test('AP6: Morning Handoff counts collected money only from canonical settlement evidence', () => {
  const completed = buildShiftLogEntry({
    userId: USER,
    shiftRunId: RUN,
    occurredAt: '2026-09-20T04:00:00.000Z',
    evidenceRefs: ['invoice:1'],
    authorityProof: { authorized: true },
    plan: plan(),
    result: { status: SHIFT_RESULT.COMPLETED, external_action_performed: true },
    providerReceipt: receipt(),
  })
  const waiting = buildShiftLogEntry({
    userId: USER,
    shiftRunId: RUN,
    occurredAt: '2026-09-20T04:05:00.000Z',
    evidenceRefs: ['contact-window:1'],
    authorityProof: { authorized: true },
    plan: plan(NIGHT_SHIFT_DISPOSITION.SCHEDULE),
    result: { status: SHIFT_RESULT.SCHEDULED, external_action_performed: false },
    nextCheckAt: '2026-09-20T13:00:00.000Z',
  })

  const handoff = buildMorningHandoff({
    userId: USER,
    shiftRun: { id: RUN, user_id: USER, mode: 'NIGHT_SHIFT' },
    entries: [completed, waiting],
    canonicalMoneyEvents: [
      {
        user_id: USER,
        shift_run_id: RUN,
        kind: 'PAYMENT_SETTLED',
        canonical: true,
        amount: 4000,
        evidence_ref: 'stripe:charge:paid',
      },
      {
        user_id: USER,
        shift_run_id: RUN,
        kind: 'PTP_PROMISED',
        canonical: false,
        amount: 50000,
        evidence_ref: 'email:promise',
      },
      {
        user_id: USER,
        shift_run_id: RUN,
        kind: 'PAYMENT_SETTLED',
        canonical: false,
        amount: 99999,
        evidence_ref: 'unverified',
      },
    ],
    generatedAt: '2026-09-20T11:00:00.000Z',
  })

  assert.equal(handoff.money_collected, 4000)
  assert.equal(handoff.canonical_payment_events, 1)
  assert.equal(handoff.actions_handled, 1)
  assert.equal(handoff.actions_scheduled, 1)
  assert.equal(handoff.unauthorized_actions, 0)
})

test('AP6: cross-tenant proof cannot enter a Morning Handoff', () => {
  assert.throws(
    () => buildMorningHandoff({
      userId: USER,
      shiftRun: { id: RUN, user_id: USER },
      entries: [{
        user_id: OTHER,
        shift_run_id: RUN,
        disposition: NIGHT_SHIFT_DISPOSITION.BLOCKED,
        result: { status: SHIFT_RESULT.WITHHELD, external_action_performed: false },
      }],
      canonicalMoneyEvents: [],
    }),
    /shift entry tenant mismatch/,
  )
})
