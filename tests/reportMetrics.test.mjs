import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agingBucketForInvoice,
  buildAgingSummary,
  buildClientExposure,
  buildReceivablesReport,
  reportInvoiceBalance,
} from '../src/lib/reports/reportMetrics.js'

const AS_OF = new Date(2026, 8, 20)

function invoice(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    client_id: overrides.client_id || 'client-1',
    clients: { name: overrides.client_name || 'Atlas Freight' },
    amount: 1000,
    amount_paid: 0,
    paid: false,
    due_date: '2026-09-20',
    currency: 'USD',
    ...overrides,
  }
}

test('reportInvoiceBalance uses canonical amount minus amount_paid and excludes paid rows', () => {
  assert.equal(reportInvoiceBalance(invoice({ amount: 1250, amount_paid: 250 })), 1000)
  assert.equal(reportInvoiceBalance(invoice({ amount: 1250, amount_paid: 250, paid: true })), 0)
  assert.equal(reportInvoiceBalance(invoice({ amount: 100, amount_paid: 150 })), 0)
})

test('aging buckets are deterministic at an explicit as-of date', () => {
  assert.equal(agingBucketForInvoice(invoice({ due_date: '2026-09-20' }), AS_OF), 'current')
  assert.equal(agingBucketForInvoice(invoice({ due_date: '2026-09-19' }), AS_OF), '1_14')
  assert.equal(agingBucketForInvoice(invoice({ due_date: '2026-09-06' }), AS_OF), '1_14')
  assert.equal(agingBucketForInvoice(invoice({ due_date: '2026-09-05' }), AS_OF), '15_30')
  assert.equal(agingBucketForInvoice(invoice({ due_date: '2026-08-21' }), AS_OF), '15_30')
  assert.equal(agingBucketForInvoice(invoice({ due_date: '2026-08-20' }), AS_OF), '31_60')
  assert.equal(agingBucketForInvoice(invoice({ due_date: '2026-07-21' }), AS_OF), '61_plus')
})

test('aging summary never invents collected money and totals only outstanding invoice balance', () => {
  const result = buildAgingSummary([
    invoice({ id: 'a', amount: 1000, amount_paid: 250, due_date: '2026-09-10' }),
    invoice({ id: 'b', amount: 500, due_date: '2026-08-01' }),
    invoice({ id: 'c', amount: 300, paid: true, due_date: '2026-07-01' }),
    invoice({ id: 'd', amount: 400, due_date: null }),
  ], AS_OF)

  assert.equal(result.outstanding.invoiceCount, 3)
  assert.equal(result.outstanding.amount, 1650)
  assert.equal(result.outstanding.byCurrency.USD.amount, 1650)
  assert.equal(result.overdue.invoiceCount, 2)
  assert.equal(result.overdue.amount, 1250)
  assert.equal(result.overdue.byCurrency.USD.amount, 1250)
  assert.equal(result.dataQuality.missingDueDateCount, 1)
  assert.equal(result.buckets.current.amount, 400)
  assert.equal(result.buckets['1_14'].amount, 750)
  assert.equal(result.buckets['31_60'].amount, 500)
})

test('aging summary never adds unlike currencies together', () => {
  const result = buildAgingSummary([
    invoice({ id: 'usd', amount: 1000, currency: 'USD', due_date: '2026-09-10' }),
    invoice({ id: 'eur', amount: 500, currency: 'EUR', due_date: '2026-09-10' }),
  ], AS_OF)

  assert.equal(result.outstanding.amount, null)
  assert.equal(result.outstanding.byCurrency.USD.amount, 1000)
  assert.equal(result.outstanding.byCurrency.EUR.amount, 500)
  assert.equal(result.overdue.amount, null)
  assert.equal(result.overdue.shareOfOutstanding, null)
})

test('unsupported invoice currencies are counted but excluded from monetary totals', () => {
  const result = buildAgingSummary([
    invoice({ id: 'usd', amount: 1000, currency: 'USD' }),
    invoice({ id: 'missing', amount: 500, currency: null }),
  ], AS_OF)

  assert.equal(result.outstanding.invoiceCount, 2)
  assert.equal(result.outstanding.amount, 1000)
  assert.equal(result.dataQuality.unsupportedCurrencyCount, 1)
})

test('client exposure groups real outstanding balances and calculates concentration per currency', () => {
  const rows = buildClientExposure([
    invoice({ id: 'a', client_id: 'atlas', client_name: 'Atlas Freight', amount: 800 }),
    invoice({ id: 'b', client_id: 'atlas', client_name: 'Atlas Freight', amount: 200 }),
    invoice({ id: 'c', client_id: 'luma', client_name: 'Luma Studio', amount: 500 }),
  ], AS_OF)

  const atlas = rows.find((row) => row.clientName === 'Atlas Freight')
  const luma = rows.find((row) => row.clientName === 'Luma Studio')

  assert.equal(rows.length, 2)
  assert.equal(atlas.outstandingAmount, 1000)
  assert.equal(atlas.shareOfOutstanding, 2 / 3)
  assert.equal(atlas.shareOfOutstandingByCurrency.USD, 2 / 3)
  assert.equal(luma.shareOfOutstanding, 1 / 3)
})

test('client exposure keeps multi-currency clients separated', () => {
  const rows = buildClientExposure([
    invoice({ id: 'usd', client_id: 'atlas', client_name: 'Atlas Freight', amount: 800, currency: 'USD' }),
    invoice({ id: 'eur', client_id: 'atlas', client_name: 'Atlas Freight', amount: 200, currency: 'EUR' }),
  ], AS_OF)

  assert.equal(rows[0].outstandingAmount, null)
  assert.equal(rows[0].byCurrency.USD.amount, 800)
  assert.equal(rows[0].byCurrency.EUR.amount, 200)
  assert.equal(rows[0].shareOfOutstanding, null)
})

test('report envelope is versioned and uses the same as-of date across projections', () => {
  const result = buildReceivablesReport({
    invoices: [invoice({ id: 'a', amount: 1000, due_date: '2026-09-01' })],
    asOf: AS_OF,
  })

  assert.equal(result.schemaVersion, 'reports-r1-v2-currency-safe')
  assert.equal(result.asOf, '2026-09-20')
  assert.equal(result.aging.asOf, '2026-09-20')
  assert.ok(Object.isFrozen(result))
})
