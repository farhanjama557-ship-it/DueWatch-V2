import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildClientCollectionComparison,
  buildCollectedInvoiceSummary,
  buildMonthlyCollectionSeries,
  buildReportsReadModel,
  monthPeriod,
} from '../src/lib/reports/reportReadModel.js'

const AS_OF = new Date(2026, 8, 20)

function payment(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    total_amount: 100,
    currency: 'USD',
    origin: 'founder_manual',
    payment_date: '2026-09-10',
    recorded_at: '2026-09-10T12:00:00Z',
    source_event_id: null,
    reversed_at: null,
    ...overrides,
  }
}

function allocation(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    payment_id: 'p1',
    invoice_id: overrides.invoice_id || 'i1',
    amount: 100,
    invoices: {
      id: overrides.invoice_id || 'i1',
      client_id: overrides.client_id || 'c1',
      clients: { id: overrides.client_id || 'c1', name: overrides.client_name || 'Atlas Freight' },
    },
    ...overrides,
  }
}

function invoice(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    client_id: overrides.client_id || 'c1',
    clients: { name: overrides.client_name || 'Atlas Freight' },
    amount: 1000,
    amount_paid: 0,
    paid: false,
    due_date: '2026-09-10',
    currency: 'USD',
    ...overrides,
  }
}

test('monthPeriod uses local calendar month boundaries', () => {
  assert.deepEqual(monthPeriod(AS_OF), { startDate: '2026-09-01', endDate: '2026-10-01' })
  assert.deepEqual(monthPeriod(AS_OF, -1), { startDate: '2026-08-01', endDate: '2026-09-01' })
})

test('collected invoice count comes from allocations attached to reportable payments', () => {
  const rows = [
    payment({ id: 'p1' }),
    payment({ id: 'p2', total_amount: 50 }),
    payment({ id: 'rev', reversed_at: '2026-09-11T00:00:00Z' }),
  ]
  const allocations = [
    allocation({ payment_id: 'p1', invoice_id: 'i1', amount: 100 }),
    allocation({ payment_id: 'p2', invoice_id: 'i1', amount: 50 }),
    allocation({ payment_id: 'rev', invoice_id: 'i2', amount: 100 }),
  ]

  const result = buildCollectedInvoiceSummary(rows, allocations, {
    startDate: '2026-09-01',
    endDate: '2026-10-01',
  })

  assert.equal(result.collectedInvoiceCount, 1)
  assert.equal(result.byCurrency.USD.allocatedAmount, 150)
})

test('client collection comparison is based on payment allocations, not invoice guesses', () => {
  const payments = [
    payment({ id: 'current', payment_date: '2026-09-10', total_amount: 200 }),
    payment({ id: 'previous', payment_date: '2026-08-10', total_amount: 100 }),
  ]
  const allocations = [
    allocation({ payment_id: 'current', invoice_id: 'i1', client_id: 'atlas', amount: 200 }),
    allocation({ payment_id: 'previous', invoice_id: 'i2', client_id: 'atlas', amount: 100 }),
  ]

  const rows = buildClientCollectionComparison(payments, allocations, {
    startDate: '2026-09-01',
    endDate: '2026-10-01',
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].comparisonByCurrency.USD.currentAmount, 200)
  assert.equal(rows[0].comparisonByCurrency.USD.previousAmount, 100)
  assert.equal(rows[0].comparisonByCurrency.USD.relativeChange, 1)
})

test('monthly series returns separate currency buckets instead of cross-currency totals', () => {
  const rows = [
    payment({ id: 'usd', payment_date: '2026-09-10', total_amount: 100, currency: 'USD' }),
    payment({ id: 'eur', payment_date: '2026-09-12', total_amount: 50, currency: 'EUR' }),
  ]

  const series = buildMonthlyCollectionSeries(rows, { asOf: AS_OF, months: 1 })
  assert.equal(series.length, 1)
  assert.equal(series[0].byCurrency.USD.amount, 100)
  assert.equal(series[0].byCurrency.EUR.amount, 50)
})

test('R5 read model exposes unsupported mockup metrics as unavailable instead of fabricating them', () => {
  const result = buildReportsReadModel({
    invoices: [invoice()],
    payments: [payment({ id: 'p1' })],
    allocations: [allocation({ payment_id: 'p1' })],
    promisesAvailable: false,
    asOf: AS_OF,
  })

  assert.equal(result.schemaVersion, 'reports-r5-read-model-v1')
  assert.equal(result.availability.collections, true)
  assert.equal(result.availability.aging, true)
  assert.equal(result.availability.promiseCurrentState, false)
  assert.equal(result.availability.promiseFulfillment, false)
  assert.equal(result.availability.collectionTarget, false)
  assert.equal(result.availability.collectionRate, false)
  assert.equal(result.availability.collectorPerformance, false)
  assert.equal(result.availability.timeSaved, false)
  assert.equal(result.availability.recoveredCashAttribution, false)
})

test('R5 insights cite only proven source classes', () => {
  const result = buildReportsReadModel({
    invoices: [invoice()],
    payments: [
      payment({ id: 'cur', payment_date: '2026-09-10', total_amount: 200 }),
      payment({ id: 'prev', payment_date: '2026-08-10', total_amount: 100 }),
    ],
    allocations: [],
    promisesAvailable: false,
    asOf: AS_OF,
  })

  const evidenceTypes = new Set(result.insights.map((item) => item.evidence.type))
  for (const type of evidenceTypes) {
    assert.ok(['payment_ledger', 'invoice_ledger', 'autopilot_execution_claims'].includes(type))
  }
})
