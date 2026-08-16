import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizePaymentAmount,
  formatPaymentAmount,
  summarizeCollectedPaymentRows,
  buildInvoicePaymentRequest,
  recordInvoicePayment,
  reversePayment,
} from '../src/lib/payments.js'

test('payment amounts normalize to exact two-decimal strings', () => {
  assert.equal(normalizePaymentAmount('10'), '10.00')
  assert.equal(normalizePaymentAmount('10.5'), '10.50')
  assert.equal(normalizePaymentAmount('0.01'), '0.01')
  assert.equal(formatPaymentAmount('10.5', 'CAD'), 'CAD 10.50')
})

test('payment amount validation rejects zero, negative, exponent, and excess precision', () => {
  for (const value of ['0', '-1', '1e2', '1.001', '', 'not-money']) {
    assert.throws(() => normalizePaymentAmount(value))
  }
})

test('single-invoice UI request explicitly allocates the complete payment', () => {
  assert.deepEqual(buildInvoicePaymentRequest({
    invoiceId: '11111111-1111-4111-8111-111111111111',
    amount: '42.5',
    currency: 'USD',
    paymentDate: '2026-08-16',
  }), {
    p_payment_date: '2026-08-16',
    p_total_amount: '42.50',
    p_currency: 'USD',
    p_allocations: [{
      invoice_id: '11111111-1111-4111-8111-111111111111',
      amount: '42.50',
    }],
    p_method: null,
    p_note: null,
  })
})

test('normal payment requests require an explicit normalized currency and date', () => {
  const base = { invoiceId: 'invoice', amount: '1.00', paymentDate: '2026-08-16' }
  assert.throws(() => buildInvoicePaymentRequest({ ...base, currency: null }), /explicit currency/)
  assert.throws(() => buildInvoicePaymentRequest({ ...base, currency: 'usd' }), /explicit currency/)
  assert.throws(() => buildInvoicePaymentRequest({ ...base, currency: 'USD', paymentDate: '' }), /date is required/)
})

test('recordInvoicePayment calls only the hardened RPC and returns stable IDs', async () => {
  const calls = []
  const expected = {
    payment_id: '22222222-2222-4222-8222-222222222222',
    allocations: [{ allocation_id: '33333333-3333-4333-8333-333333333333' }],
  }
  const database = {
    async rpc(name, args) {
      calls.push({ name, args })
      return { data: expected, error: null }
    },
  }
  const actual = await recordInvoicePayment({
    database,
    invoiceId: '11111111-1111-4111-8111-111111111111',
    amount: '25.00',
    currency: 'EUR',
    paymentDate: '2026-08-15',
  })
  assert.equal(actual, expected)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'record_payment')
  assert.deepEqual(calls[0].args.p_allocations, [{
    invoice_id: '11111111-1111-4111-8111-111111111111', amount: '25.00',
  }])
})

test('recordInvoicePayment surfaces RPC failure without a fallback write', async () => {
  const database = { rpc: async () => ({ data: null, error: { message: 'tenant rejected' } }) }
  await assert.rejects(() => recordInvoicePayment({
    database,
    invoiceId: '11111111-1111-4111-8111-111111111111',
    amount: '25.00',
    currency: 'USD',
    paymentDate: '2026-08-15',
  }), /tenant rejected/)
})

test('reversePayment requires a reason and calls the reversal RPC', async () => {
  const calls = []
  const database = { rpc: async (name, args) => (calls.push({ name, args }), { data: { payment_id: args.p_payment_id }, error: null }) }
  await assert.rejects(() => reversePayment({ database, paymentId: 'p', reason: ' ' }), /reason/)
  await reversePayment({ database, paymentId: 'payment-id', reason: 'Duplicate bank entry' })
  assert.deepEqual(calls, [{
    name: 'reverse_payment',
    args: { p_payment_id: 'payment-id', p_reversal_reason: 'Duplicate bank entry' },
  }])
})

test('InvoiceDetailPanel uses payment RPC, requires payment date, and has no direct aggregate write', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = readFileSync(path.join(root, 'src', 'components', 'InvoiceDetailPanel.jsx'), 'utf8')
  assert.match(source, /recordInvoicePayment\(/)
  assert.match(source, /id="paymentDate"/)
  assert.doesNotMatch(source, /\.from\('invoices'\)\s*\.update\(\{\s*(?:paid|amount_paid)/s)
  assert.match(source, /setPayAmount\(Number\(balance\)\.toFixed\(2\)\)/)
})

test('fixture collected total remains compatible without counting unsupported residual carry-forward', () => {
  const previousEventTotal = ['40.00', '40.00', '40.00']
    .reduce((sum, amount) => sum + Number(amount), 0)
  const supportedDatedLegacyRows = [{ total_amount: '80.00' }]
  const reconstructedEventRows = [{ total_amount: '40.00' }]
  // The undated 60/50/25/50 residual rows are intentionally absent: none can
  // be truthfully assigned to a month. The two ambiguous 40 events are not
  // ledger facts because together they exceed that invoice's aggregate.
  const ledgerSummary = summarizeCollectedPaymentRows(
    supportedDatedLegacyRows,
    reconstructedEventRows,
  )
  assert.equal(previousEventTotal, 120)
  assert.equal(ledgerSummary.sum, previousEventTotal)
  assert.equal(ledgerSummary.count, 2)
})

test('DataContext collected KPI preserves event-backed legacy value but excludes unsupported residuals', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = readFileSync(path.join(root, 'src', 'context', 'DataContext.jsx'), 'utf8')
  assert.match(source, /\.from\('payments'\)[\s\S]*?\.in\('origin', \['founder_manual', 'legacy_carry_forward'\]\)[\s\S]*?\.not\('payment_date', 'is', null\)[\s\S]*?\.is\('reversed_at', null\)/)
  assert.match(source, /\.eq\('origin', 'legacy_carry_forward'\)[\s\S]*?\.not\('source_event_id', 'is', null\)[\s\S]*?\.gte\('recorded_at'/)
  assert.doesNotMatch(source, /\.in\('event_type', \['payment_recorded', 'invoice_marked_paid'\]\)/)
})

test('new invoices require and persist an explicit supported currency', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = readFileSync(path.join(root, 'src', 'components', 'AddInvoiceModal.jsx'), 'utf8')
  assert.match(source, /id="currency"/)
  assert.match(source, /SUPPORTED_CURRENCIES\.includes\(currency\)/)
  assert.match(source, /amount: amt,\s*currency,/)
})
