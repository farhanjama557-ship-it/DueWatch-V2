import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCollectionsComparison,
  buildCollectionsSummary,
  buildPaymentReportingContract,
  classifyPaymentForReporting,
  effectivePaymentDate,
  previousEquivalentPeriod,
} from '../src/lib/reports/paymentMetrics.js'

function payment(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    total_amount: 100,
    currency: 'USD',
    origin: 'founder_manual',
    payment_date: '2026-09-10',
    recorded_at: '2026-09-10T15:00:00Z',
    source_event_id: null,
    reversed_at: null,
    ...overrides,
  }
}

test('effectivePaymentDate prefers canonical payment_date and only falls back for supported legacy evidence', () => {
  assert.equal(effectivePaymentDate(payment()), '2026-09-10')
  assert.equal(
    effectivePaymentDate(payment({
      origin: 'legacy_carry_forward',
      payment_date: null,
      source_event_id: 'evt-1',
      recorded_at: '2026-08-22T18:30:00Z',
    })),
    '2026-08-22'
  )
  assert.equal(
    effectivePaymentDate(payment({
      origin: 'legacy_carry_forward',
      payment_date: null,
      source_event_id: null,
    })),
    null
  )
})

test('reversed and unsupported rows never count as collected cash', () => {
  assert.equal(classifyPaymentForReporting(payment({ reversed_at: '2026-09-15T00:00:00Z' })).reason, 'reversed')
  assert.equal(classifyPaymentForReporting(payment({ currency: null })).reason, 'unsupported_currency')
  assert.equal(classifyPaymentForReporting(payment({ total_amount: 0 })).reason, 'invalid_amount')
  assert.equal(classifyPaymentForReporting(payment({ origin: 'mystery' })).reason, 'unsupported_origin')
})

test('collections are currency-separated, identity-deduped, and date bounded', () => {
  const rows = [
    payment({ id: 'usd-1', total_amount: 100, currency: 'USD', payment_date: '2026-09-01' }),
    payment({ id: 'usd-2', total_amount: 50, currency: 'USD', payment_date: '2026-09-19' }),
    payment({ id: 'eur-1', total_amount: 80, currency: 'EUR', payment_date: '2026-09-05' }),
    payment({ id: 'usd-2', total_amount: 50, currency: 'USD', payment_date: '2026-09-19' }),
    payment({ id: 'outside', total_amount: 999, currency: 'USD', payment_date: '2026-08-31' }),
    payment({ id: 'reversed', total_amount: 500, reversed_at: '2026-09-18T00:00:00Z' }),
  ]

  const result = buildCollectionsSummary(rows, {
    startDate: '2026-09-01',
    endDate: '2026-09-20',
  })

  assert.equal(result.includedPaymentCount, 3)
  assert.equal(result.byCurrency.USD.amount, 150)
  assert.equal(result.byCurrency.USD.paymentCount, 2)
  assert.equal(result.byCurrency.EUR.amount, 80)
  assert.equal(result.dataQuality.duplicateIdentityCount, 1)
  assert.equal(result.dataQuality.excluded.reversed, 1)
})

test('legacy source-event fallback is counted exactly once even when payment_date exists', () => {
  const row = payment({
    id: 'legacy-1',
    origin: 'legacy_carry_forward',
    payment_date: '2026-09-07',
    source_event_id: 'evt-1',
    recorded_at: '2026-09-08T12:00:00Z',
    total_amount: 220,
  })

  const result = buildCollectionsSummary([row], {
    startDate: '2026-09-01',
    endDate: '2026-10-01',
  })

  assert.equal(result.includedPaymentCount, 1)
  assert.equal(result.byCurrency.USD.amount, 220)
  assert.equal(Object.keys(result.byDay).length, 1)
  assert.ok(result.byDay['2026-09-07'])
})

test('previousEquivalentPeriod produces a same-length adjacent period', () => {
  assert.deepEqual(
    previousEquivalentPeriod('2026-09-01', '2026-10-01'),
    { startDate: '2026-08-02', endDate: '2026-09-01' }
  )
})

test('comparison never divides by zero to fabricate a percentage', () => {
  const result = buildCollectionsComparison(
    [payment({ payment_date: '2026-09-10', total_amount: 100 })],
    { startDate: '2026-09-01', endDate: '2026-10-01' }
  )

  assert.equal(result.comparisonByCurrency.USD.currentAmount, 100)
  assert.equal(result.comparisonByCurrency.USD.previousAmount, 0)
  assert.equal(result.comparisonByCurrency.USD.relativeChange, null)
})

test('R2 contract is versioned and exposes current, previous, and comparison projections', () => {
  const result = buildPaymentReportingContract(
    [payment({ payment_date: '2026-09-10', total_amount: 100 })],
    { startDate: '2026-09-01', endDate: '2026-10-01' }
  )

  assert.equal(result.schemaVersion, 'reports-r2-v1')
  assert.equal(result.current.byCurrency.USD.amount, 100)
  assert.ok(result.previous)
  assert.ok(result.comparisonByCurrency)
  assert.ok(Object.isFrozen(result))
})
