import test from 'node:test'
import assert from 'node:assert/strict'

import { derivePromiseOperationalState } from '../src/lib/promises.js'

const PROMISE = {
  id: 'promise-1',
  invoice_id: 'invoice-1',
  status: 'confirmed',
  promised_amount: '100.00',
  promised_date: '2026-09-20',
  currency: 'USD',
  confirmed_at: '2026-09-15T12:00:00Z',
  created_at: '2026-09-14T12:00:00Z',
}

function payment(overrides = {}) {
  return {
    id: 'payment-1',
    payment_date: '2026-09-19',
    total_amount: '100.00',
    currency: 'USD',
    origin: 'founder_manual',
    reversed_at: null,
    ...overrides,
  }
}

function allocation(overrides = {}) {
  return {
    id: 'allocation-1',
    payment_id: 'payment-1',
    invoice_id: 'invoice-1',
    amount: '100.00',
    ...overrides,
  }
}

test('legacy carry-forward payment never fulfills a promise', () => {
  const result = derivePromiseOperationalState(PROMISE, {
    payments: [payment({ origin: 'legacy_carry_forward' })],
    allocations: [allocation()],
    asOf: new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(result.state, 'broken')
  assert.equal(result.fulfilledAmount, 0)
})

test('reversed founder payment never fulfills a promise', () => {
  const result = derivePromiseOperationalState(PROMISE, {
    payments: [payment({ reversed_at: '2026-09-20T12:00:00Z' })],
    allocations: [allocation()],
    asOf: new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(result.state, 'broken')
  assert.equal(result.fulfilledAmount, 0)
})

test('matching founder payment allocation fulfills the promise', () => {
  const result = derivePromiseOperationalState(PROMISE, {
    payments: [payment()],
    allocations: [allocation()],
    asOf: new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(result.state, 'fulfilled')
  assert.equal(result.fulfilledAmount, 100)
})

test('partial matching payment does not fulfill and past due becomes broken', () => {
  const result = derivePromiseOperationalState(PROMISE, {
    payments: [payment({ total_amount: '40.00' })],
    allocations: [allocation({ amount: '40.00' })],
    asOf: new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(result.state, 'broken')
  assert.equal(result.fulfilledAmount, 40)
})

test('confirmed promise derives due-today and due-soon states', () => {
  assert.equal(
    derivePromiseOperationalState(
      { ...PROMISE, promised_date: '2026-09-21' },
      { asOf: new Date('2026-09-21T12:00:00Z') }
    ).state,
    'due_today'
  )
  assert.equal(
    derivePromiseOperationalState(
      { ...PROMISE, promised_date: '2026-09-25' },
      { asOf: new Date('2026-09-21T12:00:00Z') }
    ).state,
    'due_soon'
  )
})

test('proposed promise cannot be inferred fulfilled from payment evidence', () => {
  const result = derivePromiseOperationalState(
    { ...PROMISE, status: 'proposed', confirmed_at: null },
    { payments: [payment()], allocations: [allocation()] }
  )
  assert.equal(result.state, 'proposed')
  assert.equal(result.fulfilledAmount, 0)
})
