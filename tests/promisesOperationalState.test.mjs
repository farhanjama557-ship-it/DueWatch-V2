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
    recorded_at: '2026-09-19T12:00:00Z',
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
  assert.equal(result.state, 'past_due_unresolved')
  assert.equal(result.fulfilledAmount, 0)
})

test('reversed founder payment never fulfills a promise', () => {
  const result = derivePromiseOperationalState(PROMISE, {
    payments: [payment({ reversed_at: '2026-09-20T12:00:00Z' })],
    allocations: [allocation()],
    asOf: new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(result.state, 'past_due_unresolved')
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

test('multiple partial allocations sum exactly to fulfillment', () => {
  const result = derivePromiseOperationalState(
    { ...PROMISE, promised_amount: '0.30' },
    {
      payments: [
        payment({ id: 'pay-a', payment_date: '2026-09-16', recorded_at: '2026-09-16T12:00:00Z', total_amount: '0.10' }),
        payment({ id: 'pay-b', payment_date: '2026-09-17', recorded_at: '2026-09-17T12:00:00Z', total_amount: '0.20' }),
      ],
      allocations: [
        allocation({ id: 'alloc-a', payment_id: 'pay-a', amount: '0.10' }),
        allocation({ id: 'alloc-b', payment_id: 'pay-b', amount: '0.20' }),
      ],
      asOf: new Date('2026-09-21T12:00:00Z'),
    }
  )
  assert.equal(result.state, 'fulfilled')
  assert.equal(result.fulfilledAmount, 0.3)
})

test('duplicate allocation identity is counted once', () => {
  const result = derivePromiseOperationalState(PROMISE, {
    payments: [payment({ total_amount: '60.00' })],
    allocations: [
      allocation({ id: 'alloc-dup', amount: '60.00' }),
      allocation({ id: 'alloc-dup', amount: '60.00' }),
    ],
    asOf: new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(result.state, 'past_due_unresolved')
  assert.equal(result.fulfilledAmount, 60)
})

test('partial matching payment does not fulfill and past due remains unresolved', () => {
  const result = derivePromiseOperationalState(PROMISE, {
    payments: [payment({ total_amount: '40.00' })],
    allocations: [allocation({ amount: '40.00' })],
    asOf: new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(result.state, 'past_due_unresolved')
  assert.equal(result.fulfilledAmount, 40)
})

test('same-day payment recorded before confirmation cannot fulfill a later promise', () => {
  const result = derivePromiseOperationalState(PROMISE, {
    payments: [payment({
      payment_date: '2026-09-15',
      recorded_at: '2026-09-15T10:00:00Z',
    })],
    allocations: [allocation()],
    asOf: new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(result.state, 'past_due_unresolved')
  assert.equal(result.fulfilledAmount, 0)
})

test('same-day payment recorded after confirmation can fulfill', () => {
  const result = derivePromiseOperationalState(PROMISE, {
    payments: [payment({
      payment_date: '2026-09-15',
      recorded_at: '2026-09-15T13:00:00Z',
    })],
    allocations: [allocation()],
    asOf: new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(result.state, 'fulfilled')
})

test('back-dated payment does not fulfill even if entered after confirmation', () => {
  const result = derivePromiseOperationalState(PROMISE, {
    payments: [payment({
      payment_date: '2026-09-14',
      recorded_at: '2026-09-16T13:00:00Z',
    })],
    allocations: [allocation()],
    asOf: new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(result.state, 'past_due_unresolved')
  assert.equal(result.fulfilledAmount, 0)
})

test('currency-mismatched payment evidence never fulfills', () => {
  const result = derivePromiseOperationalState(PROMISE, {
    payments: [payment({ currency: 'EUR' })],
    allocations: [allocation()],
    asOf: new Date('2026-09-21T12:00:00Z'),
  })
  assert.equal(result.state, 'past_due_unresolved')
  assert.equal(result.fulfilledAmount, 0)
})

test('confirmed promise derives due-today and 48-hour due-soon states', () => {
  assert.equal(
    derivePromiseOperationalState(
      { ...PROMISE, promised_date: '2026-09-21' },
      { asOf: new Date('2026-09-21T12:00:00Z') }
    ).state,
    'due_today'
  )
  assert.equal(
    derivePromiseOperationalState(
      { ...PROMISE, promised_date: '2026-09-23' },
      { asOf: new Date('2026-09-21T12:00:00Z') }
    ).state,
    'due_soon'
  )
  assert.equal(
    derivePromiseOperationalState(
      { ...PROMISE, promised_date: '2026-09-24' },
      { asOf: new Date('2026-09-21T12:00:00Z') }
    ).state,
    'confirmed'
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
