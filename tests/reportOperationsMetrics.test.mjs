import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildActivityEvidenceSummary,
  buildApprovalSummary,
  buildExecutionSummary,
  buildOperationalReportingContract,
} from '../src/lib/reports/operationsMetrics.js'

function claim(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    status: 'sent',
    action_type: 'send_reminder',
    provider: 'resend',
    provider_message_id: 'msg-1',
    claimed_at: '2026-09-20T12:00:00Z',
    resolved_at: '2026-09-20T12:00:02Z',
    ...overrides,
  }
}

function approval(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    status: 'pending',
    created_at: '2026-09-20T11:00:00Z',
    ...overrides,
  }
}

function event(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    event_type: 'reminder_sent',
    created_at: '2026-09-20T12:00:03Z',
    ...overrides,
  }
}

const RANGE = {
  startAt: '2026-09-20T00:00:00.000Z',
  endAt: '2026-09-21T00:00:00.000Z',
}

test('execution summary preserves sent/failed/uncertain/in-flight truth separately', () => {
  const result = buildExecutionSummary([
    claim({ id: 'sent', status: 'sent' }),
    claim({ id: 'failed', status: 'send_failed' }),
    claim({ id: 'uncertain', status: 'uncertain' }),
    claim({ id: 'flight', status: 'in_flight' }),
  ], RANGE)

  assert.equal(result.claimCount, 4)
  assert.equal(result.byStatus.sent, 1)
  assert.equal(result.byStatus.send_failed, 1)
  assert.equal(result.byStatus.uncertain, 1)
  assert.equal(result.byStatus.in_flight, 1)
  assert.equal(result.providerAcceptedCount, 1)
})

test('provider acceptance is never labeled delivery or payment causation', () => {
  const result = buildExecutionSummary([claim()], RANGE)

  assert.equal(result.providerAcceptedCount, 1)
  assert.equal(result.semantics.providerAcceptedIsDelivery, false)
  assert.equal(result.semantics.providerAcceptedIsPaymentCausation, false)
})

test('execution claims are identity-deduped and malformed states fail closed', () => {
  const rows = [
    claim({ id: 'same' }),
    claim({ id: 'same' }),
    claim({ id: 'unknown-status', status: 'delivered' }),
    claim({ id: 'no-action', action_type: '' }),
  ]
  const result = buildExecutionSummary(rows, RANGE)

  assert.equal(result.claimCount, 1)
  assert.equal(result.dataQuality.duplicateIdentityCount, 1)
  assert.equal(result.dataQuality.unsupported_status, 1)
  assert.equal(result.dataQuality.missing_action_type, 1)
})

test('approval summary keeps current known statuses and does not reinterpret unknown states', () => {
  const result = buildApprovalSummary([
    approval({ id: 'p', status: 'pending' }),
    approval({ id: 'a', status: 'approved' }),
    approval({ id: 's', status: 'skipped' }),
    approval({ id: 'x', status: 'rejected' }),
  ], RANGE)

  assert.equal(result.requestCount, 4)
  assert.deepEqual(result.byStatus, {
    pending: 1,
    approved: 1,
    skipped: 1,
    other: 1,
  })
})

test('activity events remain evidence, not execution authority', () => {
  const result = buildActivityEvidenceSummary([
    event({ id: 'e1', event_type: 'reminder_sent' }),
    event({ id: 'e2', event_type: 'payment_recorded' }),
  ], RANGE)

  assert.equal(result.eventCount, 2)
  assert.equal(result.byType.reminder_sent, 1)
  assert.equal(result.byType.payment_recorded, 1)
  assert.equal(result.semantics.eventsAreExecutionAuthority, false)
})

test('R4 contract explicitly disables unproven ROI-style metrics', () => {
  const result = buildOperationalReportingContract({
    executionClaims: [claim()],
    approvals: [approval()],
    events: [event()],
    ...RANGE,
  })

  assert.equal(result.schemaVersion, 'reports-r4-v1')
  assert.equal(result.capabilities.timeSaved, false)
  assert.equal(result.capabilities.recoveredCashAttribution, false)
  assert.equal(result.capabilities.autopilotROI, false)
  assert.equal(result.capabilities.deliveryProof, false)
  assert.ok(Object.isFrozen(result))
})
