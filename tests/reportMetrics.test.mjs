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
  assert.equal(result.overdue.invoiceCount, 2)
  assert.equal(result.overdue.amount, 1250)
  assert.equal(result.dataQuality.missingDueDateCount, 1)
  assert.equal(result.buckets.current.amount, 400)
  assert.equal(result.buckets['1_14'].amount, 750)
  assert.equal(result.buckets['31_60'].amount, 500)
})

test('client exposure groups real outstanding balances and calculates concentration', () => {
  const rows = buildClientExposure([
    invoice({ id: 'a', client_id: 'atlas', client_name: 'Atlas Freight', amount: 800 }),
    invoice({ id: 'b', client_id: 'atlas', client_name: 'Atlas Freight', amount: 200 }),
    invoice({ id: 'c', client_id: 'luma', client_name: 'Luma Studio', amount: 500 }),
  ], AS_OF)

  assert.equal(rows.length, 2)
  assert.equal(rows[0].clientName, 'Atlas Freight')
  assert.equal(rows[0].outstandingAmount, 1000)
  assert.equal(rows[0].shareOfOutstanding, 2 / 3)
  assert.equal(rows[1].shareOfOutstanding, 1 / 3)
})

test('report envelope is versioned and uses the same as-of date across projections', () => {
  const result = buildReceivablesReport({
    invoices: [invoice({ id: 'a', amount: 1000, due_date: '2026-09-01' })],
    asOf: AS_OF,
  })

  assert.equal(result.schemaVersion, 'reports-r1-v1')
  assert.equal(result.asOf, '2026-09-20')
  assert.equal(result.aging.asOf, '2026-09-20')
  assert.ok(Object.isFrozen(result))
})
