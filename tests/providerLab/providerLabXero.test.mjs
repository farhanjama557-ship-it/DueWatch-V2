import test from 'node:test'
import assert from 'node:assert/strict'
import { governingClaims, PROVIDER_CLAIM_ADMISSION } from '../../src/lib/integrations/providerContract.js'
import { FRESHNESS_STATE } from '../../src/lib/integrations/providerFreshness.js'
import { PROVIDER_TRUTH_DIMENSION as T } from '../../src/lib/integrations/providerTruthModel.js'
import { createAccountingSyncState } from '../../src/lib/providerAdapters/accounting/accountingAdapterCommon.js'
import { xeroAccountingAdapter as XERO, XERO_ACCOUNTING_PROVIDER } from '../../src/lib/providerAdapters/accounting/xeroAccountingAdapter.js'
import { observeAccounting, xeroInvoice, CP2_NOW } from './accountingHarness.mjs'

const CONNECTION = Object.freeze({ tenantId: 'dw-tenant-a', provider: XERO_ACCOUNTING_PROVIDER,
  providerAccountId: 'xero-org-a' })
const OTHER_ORG = Object.freeze({ ...CONNECTION, providerAccountId: 'xero-org-b' })

function allocationPayload(kind, overrides = {}) {
  const idField = { Payment: 'PaymentID', CreditNote: 'CreditNoteID', Prepayment: 'PrepaymentID',
    Overpayment: 'OverpaymentID' }[kind]
  return { [idField]: `x-${kind.toLowerCase()}-1`, Status: 'AUTHORISED',
    Contact: { ContactID: 'x-contact-1' }, CurrencyCode: 'USD', Amount: 100, Total: 100,
    RemainingCredit: 0, UpdatedDateUTCString: CP2_NOW,
    Allocations: kind === 'Payment' ? []
      : [{ Invoice: { InvoiceID: 'x-inv-1' }, Amount: 100, Date: '2026-09-04' }],
    ...(kind === 'Payment' ? { Invoice: { InvoiceID: 'x-inv-1' }, Date: '2026-09-04',
      Account: { AccountID: 'bank-1' } } : {}),
    ...overrides }
}

test('X1 ACCREC open invoice produces T1 AR state', () => {
  const r = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Invoice', payload: xeroInvoice() })
  assert.equal(r.interpretation.truthDimension, T.T1_INVOICE_AR_STATE)
  assert.equal(r.interpretation.value.balance, 1000)
})

test('X2 paid zero AmountDue remains T1 and not T3', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Invoice',
    payload: xeroInvoice('x-paid', { Status: 'PAID', AmountDue: 0, AmountPaid: 1000 }) })
  assert.equal(interpretation.truthDimension, T.T1_INVOICE_AR_STATE)
  assert.equal(interpretation.value.balance, 0)
})

test('X3 partial payment uses invoice AmountDue', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Invoice',
    payload: xeroInvoice('x-partial', { AmountDue: 350, AmountPaid: 650 }) })
  assert.deepEqual([interpretation.value.amountPaid, interpretation.value.balance], [650, 350])
})

test('X4 AUTHORISED Payment allocated to invoice produces T4 only', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Payment',
    payload: allocationPayload('Payment') })
  assert.equal(interpretation.truthDimension, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE)
  assert.equal(interpretation.subject, 'x-inv-1')
  assert.equal(interpretation.value.allocations[0].amount, 100)
  assert.equal(interpretation.value.provesProcessorReceipt, false)
})

test('X5 DELETED payment is retained as reversed allocation state', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Payment',
    payload: allocationPayload('Payment', { Status: 'DELETED' }) })
  assert.equal(interpretation.value.deleted, true)
})

test('X6 CreditNote allocation is T4 and not cash receipt', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'CreditNote',
    payload: allocationPayload('CreditNote') })
  assert.equal(interpretation.value.allocationKind, 'CREDIT_NOTE')
  assert.equal(interpretation.value.provesProcessorReceipt, false)
})

test('X7 CreditNote remaining credit is explicit', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'CreditNote',
    payload: allocationPayload('CreditNote', { Allocations: [], RemainingCredit: 80 }) })
  assert.equal(interpretation.value.remainingCredit, 80)
  assert.deepEqual(interpretation.uncertainty, ['NO_INVOICE_ALLOCATION_EVIDENCE'])
})

test('X8 Prepayment allocation remains distinct T4 kind', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Prepayment',
    payload: allocationPayload('Prepayment') })
  assert.equal(interpretation.value.allocationKind, 'PREPAYMENT')
})

test('X9 remaining Prepayment credit is not silently allocated', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Prepayment',
    payload: allocationPayload('Prepayment', { Allocations: [], RemainingCredit: 70 }) })
  assert.equal(interpretation.value.remainingCredit, 70)
  assert.equal(interpretation.value.allocations.length, 0)
})

test('X10 Overpayment allocation remains distinct T4 kind', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Overpayment',
    payload: allocationPayload('Overpayment') })
  assert.equal(interpretation.value.allocationKind, 'OVERPAYMENT')
})

test('X11 remaining Overpayment credit is not treated fully allocated', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Overpayment',
    payload: allocationPayload('Overpayment', { Allocations: [], RemainingCredit: 90 }) })
  assert.equal(interpretation.value.remainingCredit, 90)
})

test('X12 voided invoice preserves provider status and AmountDue', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Invoice',
    payload: xeroInvoice('x-void', { Status: 'VOIDED', AmountDue: 12 }) })
  assert.equal(interpretation.value.voided, true)
  assert.equal(interpretation.value.balance, 12)
})

test('X13 stale observation cannot govern', () => {
  const r = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Invoice', payload: xeroInvoice(),
    observedAt: '2020-01-01T00:00:00Z' })
  assert.equal(r.freshness.state, FRESHNESS_STATE.STALE)
  assert.equal(governingClaims([r.admitted], T.T1_INVOICE_AR_STATE).governing.length, 0)
})

test('X14 unavailable source is unknown, not an empty list', () => {
  const r = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Invoice', payload: xeroInvoice(),
    freshness: { sourceAvailable: false } })
  assert.equal(r.freshness.state, FRESHNESS_STATE.SOURCE_UNAVAILABLE)
})

test('X15 duplicate event targets collapse idempotently', () => {
  const result = XERO.parseChangeEvent({ connection: CONNECTION, event: {
    tenantId: 'xero-org-a', eventId: 'e-1', eventCategory: 'INVOICE', resourceId: 'x-inv-1' } })
  assert.deepEqual(result.obligation.targets, ['allocations', 'invoice'])
})

test('X16 out-of-order modified object cannot overwrite newer provider version', () => {
  const sync = createAccountingSyncState(CONNECTION)
  sync.ingestPage({ connection: CONNECTION, items: [{ objectType: 'Invoice', externalObjectId: 'same',
    versionAt: '2026-09-04T12:00:00Z', payload: { AmountDue: 10 } }] })
  sync.ingestPage({ connection: CONNECTION, items: [{ objectType: 'Invoice', externalObjectId: 'same',
    versionAt: '2026-09-03T12:00:00Z', payload: { AmountDue: 900 } }], pageComplete: true })
  assert.equal(sync.snapshot.items[0].payload.AmountDue, 10)
})

test('X17 webhook requires authoritative resource reread and writes no truth', () => {
  const result = XERO.parseChangeEvent({ connection: CONNECTION, event: { tenantId: 'xero-org-a',
    eventId: 'e-payment', eventCategory: 'PAYMENT', resourceId: 'x-pay-1',
    resourceUrl: 'https://api.xero.com/api.xro/2.0/Payments/x-pay-1' } })
  assert.equal(result.obligation.stateWrittenFromEvent, false)
  assert.ok(result.obligation.targets.includes('payment'))
})

test('X18 wrong DueWatch tenant is rejected by CP1 admission', () => {
  const r = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Invoice', payload: xeroInvoice(),
    expectedConnection: { ...CONNECTION, tenantId: 'dw-tenant-b' } })
  assert.equal(r.admitted.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_TENANT)
})

test('X19 wrong Xero organisation event is rejected before invalidation', () => {
  assert.deepEqual(XERO.parseChangeEvent({ connection: CONNECTION, event: {
    tenantId: 'xero-org-b', eventId: 'e-foreign', eventCategory: 'INVOICE' } }),
  { accepted: false, reason: 'REJECTED_XERO_TENANT', stateWrittenFromEvent: false })
})

test('X20 OAuth connection id cannot masquerade as Xero tenant id', () => {
  const connectionWithOrgBoundary = { ...CONNECTION, connectionId: 'oauth-connection-17' }
  const result = XERO.parseChangeEvent({ connection: connectionWithOrgBoundary, event: {
    tenantId: 'oauth-connection-17', eventId: 'attack', eventCategory: 'INVOICE' } })
  assert.equal(result.accepted, false)
  assert.equal(XERO.connectionIdLifecycleOwner, 'M2H_CP6')
})

test('X20 connection context rejects a providerAccountId copied from connectionId', () => {
  assert.throws(() => observeAccounting(XERO, { connection: { ...CONNECTION,
    providerAccountId: 'oauth-connection-17', connectionId: 'oauth-connection-17' },
  objectType: 'Invoice', payload: xeroInvoice() }), /connectionId cannot be used/)
})

test('X21 same object ID under two organisations cannot collide', () => {
  const a = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Invoice', payload: xeroInvoice('same') })
  const b = observeAccounting(XERO, { connection: OTHER_ORG, objectType: 'Invoice', payload: xeroInvoice('same') })
  assert.notEqual(a.observation.id, b.observation.id)
})

test('X22 incomplete or failed paging/modified-after retrieval is never complete', () => {
  const sync = createAccountingSyncState(CONNECTION)
  assert.equal(sync.ingestPage({ connection: CONNECTION, items: [] }).syncComplete, false)
  assert.equal(sync.ingestPage({ connection: CONNECTION, failed: true }).syncComplete, false)
  assert.equal(sync.snapshot.syncComplete, false)
})

test('X22 every page must match expected organisation identity', () => {
  const sync = createAccountingSyncState(CONNECTION)
  const result = sync.ingestPage({ connection: OTHER_ORG, pageComplete: true,
    items: [{ objectType: 'Invoice', externalObjectId: 'foreign', versionAt: CP2_NOW }] })
  assert.equal(result.accepted, false)
  assert.equal(sync.snapshot.items.length, 0)
})

test('X23 multicurrency keeps transaction Amount apart from BankAmount and CurrencyRate', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Payment',
    payload: allocationPayload('Payment', { CurrencyCode: 'EUR', Amount: 100, BankAmount: 109,
      CurrencyRate: 1.09 }) })
  assert.deepEqual([interpretation.value.amount, interpretation.value.bankAmount,
    interpretation.value.currencyRate], [100, 109, 1.09])
  assert.equal(Object.hasOwn(interpretation.value, 'convertedAmount'), false)
})

test('X24 IsReconciled remains provider context and cannot establish T6', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Payment',
    payload: allocationPayload('Payment', { IsReconciled: true }) })
  assert.equal(interpretation.value.providerReconciledField, true)
  assert.equal(interpretation.value.duewatchT6Established, false)
  assert.notEqual(interpretation.truthDimension, T.T6_BANK_LEDGER_RECONCILIATION_STATE)
})

test('Xero invoice list summary missing AmountDue fails closed with explicit refetch uncertainty', () => {
  const { interpretation } = observeAccounting(XERO, { connection: CONNECTION, objectType: 'Invoice',
    payload: xeroInvoice('x-summary', { AmountDue: undefined }) })
  assert.equal(interpretation.value.balance, null)
  assert.ok(interpretation.uncertainty.includes('AMOUNT_DUE_MISSING_AUTHORITATIVE_DETAIL_REFETCH_REQUIRED'))
})

test('Xero non-ACCREC invoice cannot establish DueWatch AR state', () => {
  assert.throws(() => observeAccounting(XERO, { connection: CONNECTION, objectType: 'Invoice',
    payload: xeroInvoice('x-bill', { Type: 'ACCPAY' }) }), /only Xero ACCREC/)
})
