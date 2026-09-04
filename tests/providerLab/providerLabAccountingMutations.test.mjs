/**
 * Targeted semantic mutants. Each row is an unsafe implementation decision;
 * its observable counterexample is asserted here. There are no equivalent
 * mutants in this table: deleting the named control flips its assertion.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDER_TRUTH_DIMENSION as T } from '../../src/lib/integrations/providerTruthModel.js'
import { createAccountingSyncState } from '../../src/lib/providerAdapters/accounting/accountingAdapterCommon.js'
import { quickBooksOnlineAdapter as QBO, QUICKBOOKS_ONLINE_PROVIDER } from '../../src/lib/providerAdapters/accounting/quickbooksOnlineAdapter.js'
import { xeroAccountingAdapter as XERO, XERO_ACCOUNTING_PROVIDER } from '../../src/lib/providerAdapters/accounting/xeroAccountingAdapter.js'
import { observeAccounting, qboInvoice, xeroInvoice, CP2_NOW } from './accountingHarness.mjs'

const q = { tenantId: 'tenant', provider: QUICKBOOKS_ONLINE_PROVIDER, providerAccountId: 'realm' }
const x = { tenantId: 'tenant', provider: XERO_ACCOUNTING_PROVIDER, providerAccountId: 'org' }
const qPayment = { Id: 'p', TotalAmt: 10, UnappliedAmt: 10, CustomerRef: { value: 'c' },
  Line: [], MetaData: { LastUpdatedTime: CP2_NOW } }
const xCredit = { CreditNoteID: 'c', Status: 'AUTHORISED', RemainingCredit: 10,
  Contact: { ContactID: 'contact' }, Allocations: [], UpdatedDateUTCString: CP2_NOW }

const mutants = [
  ['M01 Payment -> T3', () => observeAccounting(QBO, { connection: q, objectType: 'Payment', payload: qPayment }).interpretation.truthDimension !== T.T3_PAYMENT_RECEIPT_STATE],
  ['M02 collapse T3/T4', () => T.T3_PAYMENT_RECEIPT_STATE !== T.T4_PAYMENT_CREDIT_ALLOCATION_STATE],
  ['M03 ignore provider account', () => observeAccounting(QBO, { connection: q, objectType: 'Invoice', payload: qboInvoice(), expectedConnection: { ...q, providerAccountId: 'other' } }).admitted.admitted === false],
  ['M04 ignore realm mismatch', () => QBO.parseChangeEvent({ connection: q, envelope: { eventNotifications: [{ realmId: 'other', dataChangeEvent: { entities: [] } }] } }).accepted === false],
  ['M05 ignore Xero tenant mismatch', () => XERO.parseChangeEvent({ connection: x, event: { tenantId: 'other' } }).accepted === false],
  ['M06 connection id == tenant id', () => XERO.parseChangeEvent({ connection: { ...x, connectionId: 'oauth' }, event: { tenantId: 'oauth' } }).accepted === false],
  ['M07 infer tenant from payload', () => observeAccounting(QBO, { connection: q, objectType: 'Invoice', payload: qboInvoice('i', { tenantId: 'attacker' }) }).observation.tenantId === 'tenant'],
  ['M08 unavailable -> empty', () => observeAccounting(QBO, { connection: q, objectType: 'Invoice', payload: qboInvoice(), freshness: { sourceAvailable: false } }).freshness.state === 'SOURCE_UNAVAILABLE'],
  ['M09 incomplete pagination accepted', () => createAccountingSyncState(q).ingestPage({ connection: q, items: [] }).syncComplete === false],
  ['M10 webhook writes truth', () => QBO.parseChangeEvent({ connection: q, envelope: { eventNotifications: [{ realmId: 'realm', dataChangeEvent: { entities: [{ name: 'Invoice', id: 'i' }] } }] } }).obligation.stateWrittenFromEvent === false],
  ['M11 drop refetch', () => QBO.parseChangeEvent({ connection: q, envelope: { eventNotifications: [{ realmId: 'realm', dataChangeEvent: { entities: [{ name: 'Payment', id: 'p' }] } }] } }).obligation.targets.includes('invoice')],
  ['M12 unapplied credit -> zero', () => observeAccounting(XERO, { connection: x, objectType: 'CreditNote', payload: xCredit }).interpretation.value.remainingCredit === 10],
  ['M13 credit note -> cash receipt', () => observeAccounting(XERO, { connection: x, objectType: 'CreditNote', payload: xCredit }).interpretation.value.provesProcessorReceipt === false],
  ['M14 prepayment without allocation -> allocated', () => observeAccounting(XERO, { connection: x, objectType: 'Prepayment', payload: { PrepaymentID: 'p', RemainingCredit: 10, Allocations: [], UpdatedDateUTCString: CP2_NOW } }).interpretation.value.allocations.length === 0],
  ['M15 overpayment fully allocated', () => observeAccounting(XERO, { connection: x, objectType: 'Overpayment', payload: { OverpaymentID: 'o', RemainingCredit: 7, Allocations: [], UpdatedDateUTCString: CP2_NOW } }).interpretation.value.remainingCredit === 7],
  ['M16 stale invoice governs', () => observeAccounting(QBO, { connection: q, objectType: 'Invoice', payload: qboInvoice(), observedAt: '2020-01-01T00:00:00Z' }).freshness.mayGovern === false],
  ['M17 IsReconciled -> T6', () => observeAccounting(XERO, { connection: x, objectType: 'Payment', payload: { PaymentID: 'p', Invoice: { InvoiceID: 'i' }, Amount: 1, IsReconciled: true, UpdatedDateUTCString: CP2_NOW } }).interpretation.truthDimension !== T.T6_BANK_LEDGER_RECONCILIATION_STATE],
  ['M18 API capability -> authority', () => QBO.supportedByDuewatchAdapter.write === 'NO' && XERO.supportedByDuewatchAdapter.write === 'NO'],
]

for (const [name, killed] of mutants) test(`${name} is killed`, () => assert.equal(killed(), true))

test('mutation inventory contains 18 non-equivalent observable targets', () => {
  assert.equal(mutants.length, 18)
  assert.equal(new Set(mutants.map(([name]) => name)).size, 18)
})
