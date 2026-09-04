import test from 'node:test'
import assert from 'node:assert/strict'
import { createProviderObservation, interpretObservation } from '../../src/lib/integrations/providerObservation.js'
import { admitProviderClaim, governingClaims, PROVIDER_CLAIM_ADMISSION } from '../../src/lib/integrations/providerContract.js'
import { resolveFreshness, FRESHNESS_STATE } from '../../src/lib/integrations/providerFreshness.js'
import { PROVIDER_TRUTH_DIMENSION as T } from '../../src/lib/integrations/providerTruthModel.js'
import { createAccountingSyncState } from '../../src/lib/providerAdapters/accounting/accountingAdapterCommon.js'
import { quickBooksOnlineAdapter as QBO, QUICKBOOKS_ONLINE_PROVIDER } from '../../src/lib/providerAdapters/accounting/quickbooksOnlineAdapter.js'
import { observeAccounting, qboInvoice, CP2_NOW } from './accountingHarness.mjs'

const CONNECTION = Object.freeze({ tenantId: 'dw-tenant-a', provider: QUICKBOOKS_ONLINE_PROVIDER,
  providerAccountId: 'qbo-realm-a' })
const OTHER_REALM = Object.freeze({ ...CONNECTION, providerAccountId: 'qbo-realm-b' })

const linked = (id, type = 'Invoice', amount = null) => [{ Amount: amount,
  LinkedTxn: [{ TxnId: id, TxnType: type }] }]

test('Q1 open invoice produces T1 current AR state through CP1', () => {
  const result = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Invoice', payload: qboInvoice() })
  assert.equal(result.interpretation.truthDimension, T.T1_INVOICE_AR_STATE)
  assert.equal(result.interpretation.value.balance, 1000)
  assert.equal(result.admitted.admitted, true)
})

test('Q2 fully paid zero-balance invoice is T1, not receipt truth', () => {
  const { interpretation } = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Invoice',
    payload: qboInvoice('q-paid', { Balance: 0, TxnStatus: 'Paid' }) })
  assert.equal(interpretation.truthDimension, T.T1_INVOICE_AR_STATE)
  assert.equal(interpretation.value.balance, 0)
})

test('Q3 partial payment is represented by authoritative invoice balance', () => {
  const { interpretation } = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Invoice',
    payload: qboInvoice('q-partial', { Balance: 400, TotalAmt: 1000 }) })
  assert.deepEqual([interpretation.value.total, interpretation.value.balance], [1000, 400])
})

test('Q4 linked Payment produces T4 and never T3', () => {
  const { interpretation } = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Payment', payload: {
    Id: 'q-pay-1', TotalAmt: 600, UnappliedAmt: 0, CustomerRef: { value: 'q-customer-1' },
    CurrencyRef: { value: 'USD' }, Line: linked('q-inv-1', 'Invoice', 600),
    MetaData: { LastUpdatedTime: CP2_NOW },
  } })
  assert.equal(interpretation.truthDimension, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE)
  assert.equal(interpretation.value.invoiceLinks[0].allocationAmount, 600)
  assert.equal(interpretation.value.provesProcessorReceipt, false)
})

test('Q5 Payment linked across invoices preserves every allocation relationship', () => {
  const { interpretation } = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Payment', payload: {
    Id: 'q-pay-many', TotalAmt: 800, CustomerRef: { value: 'q-customer-1' },
    Line: [...linked('q-inv-1', 'Invoice', 500), ...linked('q-inv-2', 'Invoice', 300)],
    MetaData: { LastUpdatedTime: CP2_NOW },
  } })
  assert.deepEqual(interpretation.value.invoiceLinks.map((x) => x.txnId), ['q-inv-1', 'q-inv-2'])
  assert.deepEqual(interpretation.value.invoiceLinks.map((x) => x.allocationAmount), [500, 300])
})

test('Q6 unapplied Payment remains customer value with no invented invoice allocation', () => {
  const { interpretation } = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Payment', payload: {
    Id: 'q-unapplied', TotalAmt: 250, UnappliedAmt: 250, CustomerRef: { value: 'q-customer-1' },
    Line: [], MetaData: { LastUpdatedTime: CP2_NOW },
  } })
  assert.equal(interpretation.subject, 'customer:q-customer-1')
  assert.equal(interpretation.value.unapplied, 250)
  assert.deepEqual(interpretation.uncertainty, ['NO_INVOICE_ALLOCATION_LINK'])
})

test('Q7 applied CreditMemo produces T4 credit allocation', () => {
  const { interpretation } = observeAccounting(QBO, { connection: CONNECTION, objectType: 'CreditMemo', payload: {
    Id: 'q-credit-1', TotalAmt: 100, RemainingCredit: 0, CustomerRef: { value: 'q-customer-1' },
    Line: linked('q-inv-1'), CurrencyRef: { value: 'USD' }, MetaData: { LastUpdatedTime: CP2_NOW },
  } })
  assert.equal(interpretation.value.allocationKind, 'CREDIT_MEMO')
  assert.equal(interpretation.value.provesProcessorReceipt, false)
})

test('Q8 unallocated CreditMemo preserves available credit', () => {
  const { interpretation } = observeAccounting(QBO, { connection: CONNECTION, objectType: 'CreditMemo', payload: {
    Id: 'q-credit-open', TotalAmt: 120, RemainingCredit: 120, CustomerRef: { value: 'q-customer-1' },
    Line: [], MetaData: { LastUpdatedTime: CP2_NOW },
  } })
  assert.equal(interpretation.value.unapplied, 120)
})

test('Q9 voided invoice is recorded as provider state and does not override Balance', () => {
  const { interpretation } = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Invoice',
    payload: qboInvoice('q-void', { TxnStatus: 'Voided', Balance: 91 }) })
  assert.equal(interpretation.value.voided, true)
  assert.equal(interpretation.value.balance, 91)
})

test('Q10 deleted Payment remains invalid allocation evidence, not receipt truth', () => {
  const { interpretation } = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Payment', payload: {
    Id: 'q-pay-deleted', TotalAmt: 50, deleted: true, Line: linked('q-inv-1'),
    MetaData: { LastUpdatedTime: CP2_NOW },
  } })
  assert.equal(interpretation.value.deleted, true)
  assert.equal(interpretation.truthDimension, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE)
})

test('Q11 stale invoice is admitted but withheld from governing selection', () => {
  const result = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Invoice',
    payload: qboInvoice(), observedAt: '2020-01-01T00:00:00Z' })
  assert.equal(result.freshness.state, FRESHNESS_STATE.STALE)
  assert.equal(governingClaims([result.admitted], T.T1_INVOICE_AR_STATE).governing.length, 0)
})

test('Q12 unavailable source never becomes an empty fresh source', () => {
  const result = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Invoice', payload: qboInvoice(),
    freshness: { sourceAvailable: false } })
  assert.equal(result.freshness.state, FRESHNESS_STATE.SOURCE_UNAVAILABLE)
})

test('Q13 duplicate provider event is idempotent at refetch target level', () => {
  const envelope = { eventNotifications: [{ realmId: 'qbo-realm-a', dataChangeEvent: { entities: [
    { name: 'Invoice', id: 'q-inv-1', operation: 'Update', lastUpdated: CP2_NOW },
    { name: 'Invoice', id: 'q-inv-1', operation: 'Update', lastUpdated: CP2_NOW },
  ] } }] }
  const result = QBO.parseChangeEvent({ connection: CONNECTION, envelope })
  assert.equal(result.eventFormat, 'LEGACY_REPLAY_ONLY')
  assert.equal(result.obligation.tenantId, 'dw-tenant-a')
  assert.deepEqual(result.obligation.targets, ['allocations', 'invoice'])
})

test('Q14 out-of-order page cannot overwrite newer authoritative object', () => {
  const sync = createAccountingSyncState(CONNECTION)
  sync.ingestPage({ connection: CONNECTION, items: [{ objectType: 'Invoice', externalObjectId: 'same',
    versionAt: '2026-09-04T11:00:00Z', payload: { Balance: 20 } }] })
  sync.ingestPage({ connection: CONNECTION, items: [{ objectType: 'Invoice', externalObjectId: 'same',
    versionAt: '2026-09-03T11:00:00Z', payload: { Balance: 99 } }], pageComplete: true })
  assert.equal(sync.snapshot.items[0].payload.Balance, 20)
})

test('Q15 current webhook is invalidation only and requires authoritative reread', () => {
  const result = QBO.parseChangeEvent({ connection: CONNECTION, envelope: [{
    specversion: '1.0', id: 'cloud-event-1', source: 'quickbooks-online',
    type: 'qbo.payment.created.v1', time: CP2_NOW,
    intuitentityid: 'q-pay-1', intuitaccountid: 'qbo-realm-a', data: {},
  }] })
  assert.equal(result.eventFormat, 'CLOUDEVENTS_1_0')
  assert.deepEqual([result.eventEntities[0].entity, result.eventEntities[0].operation,
    result.eventEntities[0].version], ['payment', 'created', 'v1'])
  assert.equal(result.obligation.stateWrittenFromEvent, false)
  assert.equal(result.obligation.tenantId, 'dw-tenant-a')
  assert.ok(result.obligation.targets.includes('invoice'))
})

test('Q15 current CloudEvents validate every account before invalidation', () => {
  const result = QBO.parseChangeEvent({ connection: CONNECTION, envelope: [
    { specversion: '1.0', id: 'one', type: 'qbo.invoice.updated.v1',
      time: CP2_NOW, intuitentityid: 'safe', intuitaccountid: 'qbo-realm-a' },
    { specversion: '1.0', id: 'two', type: 'qbo.invoice.updated.v1',
      time: CP2_NOW, intuitentityid: 'foreign', intuitaccountid: 'qbo-realm-b' },
  ] })
  assert.deepEqual(result, { accepted: false, reason: 'REJECTED_REALM', stateWrittenFromEvent: false })
})

test('CP2-R21 QBO versioned type separates operation from version', () => {
  const cases = [
    ['qbo.invoice.created.v1', 'invoice', 'created', 'v1'],
    ['qbo.invoice.updated.v1', 'invoice', 'updated', 'v1'],
    ['qbo.payment.created.v1', 'payment', 'created', 'v1'],
    ['qbo.creditmemo.updated.v1', 'creditmemo', 'updated', 'v1'],
  ]
  for (const [type, entity, operation, version] of cases) {
    const result = QBO.parseChangeEvent({ connection: CONNECTION, envelope: [{
      specversion: '1.0', id: type, type, time: CP2_NOW,
      intuitentityid: `${entity}-1`, intuitaccountid: 'qbo-realm-a', data: {},
    }] })
    assert.equal(result.accepted, true)
    assert.deepEqual([result.eventEntities[0].entity, result.eventEntities[0].operation,
      result.eventEntities[0].version, result.eventEntities[0].classification],
    [entity, operation, version, 'SUPPORTED_V1'])
    assert.notEqual(result.eventEntities[0].operation, version)
  }
})

test('QBO malformed, unknown-entity and future-version types refetch broadly without inventing truth', () => {
  const cases = [
    ['not-a-current-type', 'MALFORMED_TYPE', null, null],
    ['qbo.customer.created.v1', 'UNKNOWN_ENTITY', 'created', 'v1'],
    ['qbo.invoice.merged.v1', 'UNKNOWN_OPERATION', 'merged', 'v1'],
    ['qbo.invoice.updated.v2', 'UNSUPPORTED_VERSION', 'updated', 'v2'],
  ]
  for (const [type, classification, operation, version] of cases) {
    const result = QBO.parseChangeEvent({ connection: CONNECTION, envelope: [{
      specversion: '1.0', id: type, type, time: CP2_NOW,
      intuitentityid: 'object-1', intuitaccountid: 'qbo-realm-a', data: {},
    }] })
    assert.equal(result.eventEntities[0].classification, classification)
    assert.equal(result.eventEntities[0].operation, operation)
    assert.equal(result.eventEntities[0].version, version)
    assert.ok(result.obligation.targets.includes('customer_unapplied_value'))
    assert.equal(result.obligation.stateWrittenFromEvent, false)
  }
})

test('QBO contradictory data.operation is marked and cannot narrow canonical refetch', () => {
  const result = QBO.parseChangeEvent({ connection: CONNECTION, envelope: [{
    specversion: '1.0', id: 'conflict', type: 'qbo.invoice.updated.v1', time: CP2_NOW,
    intuitentityid: 'invoice-1', intuitaccountid: 'qbo-realm-a',
    data: { operation: 'deleted' },
  }] })
  assert.equal(result.eventEntities[0].operation, 'updated')
  assert.equal(result.eventEntities[0].metadataOperation, 'deleted')
  assert.equal(result.eventEntities[0].metadataConflict, true)
  assert.equal(result.eventEntities[0].classification, 'CONTRADICTORY_METADATA')
  assert.ok(result.obligation.targets.includes('customer_unapplied_value'))
})

test('CP2-R19 refetch obligations preserve trusted tenant scope and ignore payload tenant', () => {
  const event = { specversion: '1.0', id: 'same-event', type: 'qbo.invoice.updated.v1',
    time: CP2_NOW, intuitentityid: 'invoice-1', intuitaccountid: 'qbo-realm-a',
    data: { tenantId: 'payload-attacker' } }
  const a = QBO.parseChangeEvent({ connection: CONNECTION, envelope: [event] })
  const b = QBO.parseChangeEvent({ connection: { ...CONNECTION, tenantId: 'dw-tenant-b' }, envelope: [event] })
  assert.equal(a.obligation.tenantId, 'dw-tenant-a')
  assert.equal(b.obligation.tenantId, 'dw-tenant-b')
  assert.equal(a.obligation.eventId, b.obligation.eventId)
  assert.notDeepEqual(a.obligation, b.obligation)
})

test('QBO rejected connection identity creates no obligation', () => {
  const result = QBO.parseChangeEvent({ connection: { ...CONNECTION, provider: 'xero_accounting' },
    envelope: [{ intuitaccountid: 'qbo-realm-a', type: 'qbo.invoice.updated.v1' }] })
  assert.equal(result.accepted, false)
  assert.equal(Object.hasOwn(result, 'obligation'), false)
})

test('Q16 wrong DueWatch tenant fails CP1 admission', () => {
  const result = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Invoice', payload: qboInvoice(),
    expectedConnection: { ...CONNECTION, tenantId: 'dw-tenant-b' } })
  assert.equal(result.admitted.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_TENANT)
})

test('Q17 wrong realm event is rejected before invalidation', () => {
  const result = QBO.parseChangeEvent({ connection: CONNECTION, envelope: { eventNotifications: [{
    realmId: 'qbo-realm-b', dataChangeEvent: { entities: [{ name: 'Invoice', id: 'q-inv-1' }] },
  }] } })
  assert.deepEqual(result, { accepted: false, reason: 'REJECTED_REALM', stateWrittenFromEvent: false })
})

test('Q17 every notification realm is checked before any event is accepted', () => {
  const result = QBO.parseChangeEvent({ connection: CONNECTION, envelope: { eventNotifications: [
    { realmId: 'qbo-realm-a', dataChangeEvent: { entities: [{ name: 'Invoice', id: 'safe' }] } },
    { realmId: 'qbo-realm-b', dataChangeEvent: { entities: [{ name: 'Invoice', id: 'foreign' }] } },
  ] } })
  assert.deepEqual(result, { accepted: false, reason: 'REJECTED_REALM', stateWrittenFromEvent: false })
})

test('Q18 same external object id under two realms has different CP1 observation identity', () => {
  const a = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Invoice', payload: qboInvoice('same') })
  const b = observeAccounting(QBO, { connection: OTHER_REALM, objectType: 'Invoice', payload: qboInvoice('same') })
  assert.notEqual(a.observation.id, b.observation.id)
})

test('Q19 incomplete and failed pages never report complete synchronization', () => {
  const sync = createAccountingSyncState(CONNECTION)
  assert.equal(sync.ingestPage({ connection: CONNECTION, items: [] }).syncComplete, false)
  assert.equal(sync.ingestPage({ connection: CONNECTION, failed: true }).syncComplete, false)
  assert.equal(sync.ingestPage({ connection: CONNECTION, pageComplete: true }).syncComplete, false)
})

test('Q19 every page must match the expected realm before it affects sync state', () => {
  const sync = createAccountingSyncState(CONNECTION)
  const result = sync.ingestPage({ connection: OTHER_REALM, pageComplete: true,
    items: [{ objectType: 'Invoice', externalObjectId: 'foreign', versionAt: CP2_NOW }] })
  assert.equal(result.accepted, false)
  assert.equal(sync.snapshot.items.length, 0)
  assert.equal(sync.snapshot.syncComplete, false)
})

test('Q20 multicurrency preserves native currency and rate without conversion truth', () => {
  const { interpretation } = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Invoice',
    payload: qboInvoice('q-eur', { CurrencyRef: { value: 'EUR' }, ExchangeRate: 1.09, Balance: 100 }) })
  assert.equal(interpretation.value.currency, 'EUR')
  assert.equal(interpretation.value.exchangeRate, 1.09)
  assert.equal(Object.hasOwn(interpretation.value, 'convertedBalance'), false)
})

test('QBO expected provider cannot be inferred from payload', () => {
  const result = observeAccounting(QBO, { connection: CONNECTION, objectType: 'Invoice', payload: qboInvoice(),
    expectedConnection: { ...CONNECTION, provider: 'xero_accounting' } })
  assert.equal(result.admitted.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_PROVIDER)
})

test('QBO handwritten freshness and forged interpretation remain rejected', () => {
  const input = QBO.createObservationInput({ connection: CONNECTION, objectType: 'Invoice', payload: qboInvoice(), observedAt: CP2_NOW })
  const observation = createProviderObservation({ ...input, environment: 'FIXTURE_REPLAY' })
  const interpretation = interpretObservation({ observation, ...QBO.interpretFor(observation) })
  assert.equal(admitProviderClaim({ ...CONNECTION, observation, interpretation,
    freshness: { state: 'FRESH', mayGovern: true } }).admission,
  PROVIDER_CLAIM_ADMISSION.REJECTED_FRESHNESS_NOT_RESOLVED)
  assert.throws(() => interpretObservation({ observation: { ...observation }, ...QBO.interpretFor(observation) }),
    /createProviderObservation/)
})
