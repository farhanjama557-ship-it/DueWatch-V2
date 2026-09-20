import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROMISE_REPORT_STATE,
  buildPromiseReportingContract,
  buildPromiseSummary,
  promiseReportState,
} from '../src/lib/reports/promiseMetrics.js'

const AS_OF = new Date(2026, 8, 20)

function promise(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    status: 'confirmed',
    promised_amount: 1000,
    promised_date: '2026-09-25',
    currency: 'USD',
    ...overrides,
  }
}

test('proposed promises are needs-confirmation, never treated as governing cash', () => {
  assert.equal(
    promiseReportState(promise({ status: 'proposed' }), AS_OF),
    PROMISE_REPORT_STATE.NEEDS_CONFIRMATION
  )
})

test('confirmed promise timing is deterministic without inventing terminal states', () => {
  assert.equal(promiseReportState(promise({ promised_date: '2026-10-15' }), AS_OF), PROMISE_REPORT_STATE.FUTURE)
  assert.equal(promiseReportState(promise({ promised_date: '2026-09-25' }), AS_OF), PROMISE_REPORT_STATE.DUE_SOON)
  assert.equal(promiseReportState(promise({ promised_date: '2026-09-20' }), AS_OF), PROMISE_REPORT_STATE.DUE_TODAY)
  assert.equal(
    promiseReportState(promise({ promised_date: '2026-09-19' }), AS_OF),
    PROMISE_REPORT_STATE.PAST_DUE_UNRESOLVED
  )
})

test('summary keeps currencies separate and dedupes promise identity', () => {
  const rows = [
    promise({ id: 'p1', promised_amount: 1000, currency: 'USD', promised_date: '2026-09-20' }),
    promise({ id: 'p2', promised_amount: 500, currency: 'EUR', promised_date: '2026-09-20' }),
    promise({ id: 'p1', promised_amount: 1000, currency: 'USD', promised_date: '2026-09-20' }),
  ]

  const result = buildPromiseSummary(rows, { asOf: AS_OF })

  assert.equal(result.reportablePromiseCount, 2)
  assert.equal(result.states.due_today.byCurrency.USD.amount, 1000)
  assert.equal(result.states.due_today.byCurrency.EUR.amount, 500)
  assert.equal(result.dataQuality.duplicateIdentityCount, 1)
})

test('unknown future lifecycle states fail closed instead of being mislabeled broken or fulfilled', () => {
  const result = buildPromiseSummary([
    promise({ id: 'future-status', status: 'fulfilled' }),
  ], { asOf: AS_OF })

  assert.equal(result.states.unknown.promiseCount, 1)
  assert.equal(result.dataQuality.unsupportedStatusCount, 1)
})

test('R3 explicitly exposes unsupported performance capabilities', () => {
  const result = buildPromiseReportingContract([promise()], { asOf: AS_OF })

  assert.equal(result.schemaVersion, 'reports-r3-v1')
  assert.equal(result.summary.capabilities.fulfilledState, false)
  assert.equal(result.summary.capabilities.brokenState, false)
  assert.equal(result.summary.capabilities.keptPromiseRate, false)
  assert.equal(result.summary.capabilities.paymentToPromiseAttribution, false)
  assert.ok(Object.isFrozen(result))
})
