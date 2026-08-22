import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProposePromiseRequest,
  buildConfirmPromiseRequest,
  proposePromise,
  confirmPromise,
} from '../src/lib/promiseToPay.js'

test('propose request normalizes amount and validates source/date', () => {
  assert.deepEqual(buildProposePromiseRequest({
    invoiceId: '11111111-1111-4111-8111-111111111111',
    amount: '42.5',
    date: '2026-09-01',
    source: 'phone',
    note: '  called about it  ',
  }), {
    p_invoice_id: '11111111-1111-4111-8111-111111111111',
    p_promised_amount: '42.50',
    p_promised_date: '2026-09-01',
    p_source: 'phone',
    p_note: 'called about it',
  })
})

test('propose request requires an invoice, a valid date, and a recognized source', () => {
  const base = { invoiceId: '11111111-1111-4111-8111-111111111111', amount: '10.00', date: '2026-09-01', source: 'email' }
  assert.throws(() => buildProposePromiseRequest({ ...base, invoiceId: null }), /invoice is required/)
  assert.throws(() => buildProposePromiseRequest({ ...base, date: '' }), /date is required/)
  assert.throws(() => buildProposePromiseRequest({ ...base, date: 'not-a-date' }), /date is required/)
  assert.throws(() => buildProposePromiseRequest({ ...base, source: 'carrier_pigeon' }), /evidence source/)
  assert.throws(() => buildProposePromiseRequest({ ...base, source: '' }), /evidence source/)
})

test('propose request rejects invalid amounts the same way payments does', () => {
  const base = { invoiceId: '11111111-1111-4111-8111-111111111111', date: '2026-09-01', source: 'email' }
  for (const amount of ['0', '-1', '1e2', '1.001', '', 'not-money']) {
    assert.throws(() => buildProposePromiseRequest({ ...base, amount }))
  }
})

test('confirm request normalizes amount and validates date', () => {
  assert.deepEqual(buildConfirmPromiseRequest({
    promiseId: '22222222-2222-4222-8222-222222222222',
    amount: '250',
    date: '2026-09-05',
  }), {
    p_promise_id: '22222222-2222-4222-8222-222222222222',
    p_promised_amount: '250.00',
    p_promised_date: '2026-09-05',
  })
  assert.throws(() => buildConfirmPromiseRequest({ promiseId: null, amount: '1', date: '2026-09-05' }), /promise is required/)
  assert.throws(() => buildConfirmPromiseRequest({ promiseId: 'p', amount: '1', date: '' }), /date is required/)
})

test('proposePromise calls only propose_promise and returns the RPC result', async () => {
  const calls = []
  const expected = { promise_id: '33333333-3333-4333-8333-333333333333', status: 'proposed' }
  const database = {
    async rpc(name, args) {
      calls.push({ name, args })
      return { data: expected, error: null }
    },
  }
  const actual = await proposePromise({
    database,
    invoiceId: '11111111-1111-4111-8111-111111111111',
    amount: '100',
    date: '2026-09-01',
    source: 'text',
  })
  assert.deepEqual(actual, expected)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'propose_promise')
  assert.deepEqual(calls[0].args, {
    p_invoice_id: '11111111-1111-4111-8111-111111111111',
    p_promised_amount: '100.00',
    p_promised_date: '2026-09-01',
    p_source: 'text',
    p_note: null,
  })
})

test('proposePromise surfaces RPC failure without a fallback write', async () => {
  const database = {
    async rpc() {
      return { data: null, error: { message: 'This invoice needs an explicit currency before a promise can be proposed' } }
    },
  }
  await assert.rejects(
    proposePromise({ database, invoiceId: 'i', amount: '10', date: '2026-09-01', source: 'email' }),
    /explicit currency/
  )
})

test('confirmPromise calls only confirm_promise and returns the RPC result', async () => {
  const calls = []
  const expected = { promise_id: '33333333-3333-4333-8333-333333333333', status: 'confirmed' }
  const database = {
    async rpc(name, args) {
      calls.push({ name, args })
      return { data: expected, error: null }
    },
  }
  const actual = await confirmPromise({
    database,
    promiseId: '33333333-3333-4333-8333-333333333333',
    amount: '100',
    date: '2026-09-01',
  })
  assert.deepEqual(actual, expected)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'confirm_promise')
  assert.deepEqual(calls[0].args, {
    p_promise_id: '33333333-3333-4333-8333-333333333333',
    p_promised_amount: '100.00',
    p_promised_date: '2026-09-01',
  })
})

test('confirmPromise surfaces the governance-invariant RPC failure without a fallback write', async () => {
  const database = {
    async rpc() {
      return { data: null, error: { message: 'Another promise already governs this invoice' } }
    },
  }
  await assert.rejects(
    confirmPromise({ database, promiseId: 'p', amount: '10', date: '2026-09-01' }),
    /already governs this invoice/
  )
})
