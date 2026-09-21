import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  createProviderObservation,
  interpretObservation,
} from '../src/lib/integrations/providerObservation.js'
import {
  PROVIDER_TRUTH_DIMENSION as T,
} from '../src/lib/integrations/providerTruthModel.js'
import {
  stripeAdapter,
  STRIPE_ADAPTER_WRITE_SUPPORT,
  STRIPE_PROVIDER,
  stripeAdmissionIdentity,
} from '../src/lib/providerAdapters/payments/stripeAdapter.js'

const CONNECTION = Object.freeze({
  tenantId: 'tenant-a',
  provider: STRIPE_PROVIDER,
  providerAccountId: 'acct_123',
  livemode: false,
  eventScope: 'ACCOUNT',
})

function interpret(objectType, payload) {
  const input = stripeAdapter.createObservationInput({
    connection: CONNECTION,
    objectType,
    payload,
    observedAt: '2026-09-21T16:00:00.000Z',
  })
  const observation = createProviderObservation(input)
  const descriptor = stripeAdapter.interpretFor(observation)
  const interpretation = interpretObservation({ observation, ...descriptor })
  return { observation, interpretation }
}

test('Stripe research adapter is read-only evidence code, not a provider writer', async () => {
  assert.equal(STRIPE_ADAPTER_WRITE_SUPPORT, 'NO')
  assert.equal(stripeAdapter.supportedByDuewatchAdapter.write, 'NO')
  const source = await readFile(new URL('../src/lib/providerAdapters/payments/stripeAdapter.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\.rpc\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(|fetch\s*\(/)
})

test('Stripe connection identity binds account and test/live mode', () => {
  const testIdentity = stripeAdmissionIdentity(CONNECTION)
  const liveIdentity = stripeAdmissionIdentity({ ...CONNECTION, livemode: true })
  assert.equal(testIdentity.providerAccountId, 'acct_123:test')
  assert.equal(liveIdentity.providerAccountId, 'acct_123:live')
  assert.notEqual(testIdentity.providerAccountId, liveIdentity.providerAccountId)
})

test('Stripe object mode mismatch fails closed', () => {
  assert.throws(() => stripeAdapter.createObservationInput({
    connection: CONNECTION,
    objectType: 'Charge',
    payload: { id: 'ch_1', livemode: true },
    observedAt: '2026-09-21T16:00:00.000Z',
  }), /livemode does not match/i)
})

test('succeeded PaymentIntent is processor receipt evidence but never canonical money authority', () => {
  const { interpretation } = interpret('PaymentIntent', {
    id: 'pi_1',
    livemode: false,
    status: 'succeeded',
    amount: 10000,
    amount_received: 10000,
    amount_capturable: 0,
    currency: 'usd',
    latest_charge: 'ch_1',
    created: 1790000000,
  })
  assert.equal(interpretation.truthDimension, T.T3_PAYMENT_RECEIPT_STATE)
  assert.equal(interpretation.value.processorReceiptEstablished, true)
  assert.equal(interpretation.writesCanonicalMoney, false)
  assert.equal(interpretation.grantsAuthority, false)
})

test('captured Charge establishes native processor receipt evidence and shares PaymentIntent subject', () => {
  const pi = interpret('PaymentIntent', {
    id: 'pi_1', livemode: false, status: 'succeeded',
    amount: 10000, amount_received: 10000, currency: 'usd',
    latest_charge: 'ch_1', created: 1790000000,
  }).interpretation
  const charge = interpret('Charge', {
    id: 'ch_1', livemode: false, paid: true, captured: true,
    amount: 10000, amount_captured: 10000, amount_refunded: 0,
    refunded: false, disputed: false, currency: 'usd',
    payment_intent: 'pi_1', created: 1790000001,
  }).interpretation
  assert.equal(charge.truthDimension, T.T3_PAYMENT_RECEIPT_STATE)
  assert.equal(charge.value.processorReceiptEstablished, true)
  assert.equal(charge.subject, pi.subject)
  assert.equal(charge.value.receiptIdentity, 'payment_intent:pi_1')
})

test('InvoicePayment is allocation evidence and cannot substitute for processor receipt', () => {
  const { interpretation } = interpret('InvoicePayment', {
    id: 'ip_1',
    livemode: false,
    invoice: 'in_1',
    status: 'paid',
    amount_requested: 10000,
    amount_paid: 10000,
    currency: 'usd',
    payment: { type: 'payment_intent', payment_intent: 'pi_1' },
    status_transitions: { paid_at: 1790000002 },
    created: 1790000002,
  })
  assert.equal(interpretation.truthDimension, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE)
  assert.equal(interpretation.value.provesProcessorReceipt, false)
})

test('Refund and Dispute remain reversal/contest evidence and do not invent invoice reopening', () => {
  for (const [type, id, status] of [
    ['Refund', 're_1', 'succeeded'],
    ['Dispute', 'dp_1', 'lost'],
  ]) {
    const { interpretation } = interpret(type, {
      id,
      livemode: false,
      payment_intent: 'pi_1',
      charge: 'ch_1',
      amount: 10000,
      currency: 'usd',
      status,
      created: 1790000003,
    })
    assert.equal(interpretation.truthDimension, T.T3_PAYMENT_RECEIPT_STATE)
    assert.equal(interpretation.value.receiptReversalOrContest, true)
    assert.equal(interpretation.value.reopensInvoiceAr, false)
    assert.ok(interpretation.uncertainty.includes('AUTHORITATIVE_INVOICE_AND_PROCESSOR_REFETCH_REQUIRED'))
  }
})

test('BalanceTransaction stays processor settlement evidence rather than payment receipt truth', () => {
  const { interpretation } = interpret('BalanceTransaction', {
    id: 'txn_1',
    livemode: false,
    type: 'charge',
    amount: 10000,
    fee: 300,
    net: 9700,
    currency: 'usd',
    source: 'ch_1',
    status: 'available',
    created: 1790000004,
    available_on: 1790003600,
  })
  assert.equal(interpretation.truthDimension, T.T5_PROCESSOR_FUNDS_SETTLEMENT_STATE)
  assert.equal(interpretation.value.establishesBankLedgerReconciliation, false)
})

test('Stripe webhook parsing rejects wrong account or mode before creating a refetch obligation', () => {
  const wrongMode = stripeAdapter.parseChangeEvent({
    connection: CONNECTION,
    envelope: {
      id: 'evt_1',
      type: 'charge.succeeded',
      livemode: true,
      data: { object: { id: 'ch_1' } },
    },
  })
  assert.equal(wrongMode.accepted, false)
  assert.equal(wrongMode.stateWrittenFromEvent, false)

  const connected = { ...CONNECTION, eventScope: 'CONNECTED_ACCOUNT' }
  const wrongAccount = stripeAdapter.parseChangeEvent({
    connection: connected,
    envelope: {
      id: 'evt_2',
      type: 'charge.succeeded',
      livemode: false,
      account: 'acct_other',
      data: { object: { id: 'ch_1' } },
    },
  })
  assert.equal(wrongAccount.accepted, false)
  assert.equal(wrongAccount.stateWrittenFromEvent, false)
})
