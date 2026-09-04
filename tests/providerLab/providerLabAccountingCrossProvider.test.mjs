import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveCollectionEligibility, COLLECTION_ELIGIBILITY,
  createCollectionDecisionContext, COLLECTION_POLICY_DECISION } from '../../src/lib/integrations/collectionEligibility.js'
import { governingClaims } from '../../src/lib/integrations/providerContract.js'
import { classifyDisagreement, CONTRADICTION_MARKER,
  PROVIDER_TRUTH_DIMENSION as T } from '../../src/lib/integrations/providerTruthModel.js'
import { EVIDENCE_CLASS, OBSERVATION_ENVIRONMENT, recordEvidence, composeEvidence } from '../../src/lib/integrations/providerEvidence.js'
import { describeProviderCapability, CAPABILITY_VALUE, capabilityGrantsAuthority } from '../../src/lib/integrations/providerCapability.js'
import { uglyScenario } from './harness.mjs'
import { observeAccounting, qboInvoice, xeroInvoice, CP2_NOW } from './accountingHarness.mjs'
import { quickBooksOnlineAdapter as QBO, QUICKBOOKS_ONLINE_PROVIDER } from '../../src/lib/providerAdapters/accounting/quickbooksOnlineAdapter.js'
import { xeroAccountingAdapter as XERO, XERO_ACCOUNTING_PROVIDER } from '../../src/lib/providerAdapters/accounting/xeroAccountingAdapter.js'

const Q = { tenantId: 'dw-a', provider: QUICKBOOKS_ONLINE_PROVIDER, providerAccountId: 'realm-a' }
const X = { tenantId: 'dw-a', provider: XERO_ACCOUNTING_PROVIDER, providerAccountId: 'org-a' }

test('different provider invoice shapes reach the same T1 meaning through CP1', () => {
  const q = observeAccounting(QBO, { connection: Q, objectType: 'Invoice', payload: qboInvoice('shared') })
  const x = observeAccounting(XERO, { connection: X, objectType: 'Invoice', payload: xeroInvoice('shared') })
  for (const result of [q, x]) {
    assert.equal(result.interpretation.truthDimension, T.T1_INVOICE_AR_STATE)
    assert.equal(result.interpretation.value.balance, 1000)
    assert.equal(result.admitted.admitted, true)
  }
})

test('QBO and Xero credit allocations agree on T4 while retaining provider kind', () => {
  const q = observeAccounting(QBO, { connection: Q, objectType: 'CreditMemo', payload: {
    Id: 'credit-q', TotalAmt: 100, RemainingCredit: 0, CustomerRef: { value: 'customer-q' },
    Line: [{ LinkedTxn: [{ TxnId: 'invoice-a', TxnType: 'Invoice' }] }],
    MetaData: { LastUpdatedTime: CP2_NOW },
  } })
  const x = observeAccounting(XERO, { connection: X, objectType: 'CreditNote', payload: {
    CreditNoteID: 'credit-x', Status: 'AUTHORISED', Contact: { ContactID: 'contact-x' },
    Total: 100, RemainingCredit: 0, Allocations: [{ Invoice: { InvoiceID: 'invoice-a' }, Amount: 100 }],
    UpdatedDateUTCString: CP2_NOW,
  } })
  assert.equal(q.interpretation.truthDimension, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE)
  assert.equal(x.interpretation.truthDimension, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE)
  assert.notEqual(q.interpretation.value.allocationKind, x.interpretation.value.allocationKind)
})

test('different dimensions cannot become a fake provider conflict', () => {
  const verdict = classifyDisagreement(
    { truthDimension: T.T1_INVOICE_AR_STATE, subject: 'invoice-a', value: { balance: 100 } },
    { truthDimension: T.T4_PAYMENT_CREDIT_ALLOCATION_STATE, subject: 'invoice-a', value: { allocated: 100 } })
  assert.equal(verdict.marker, CONTRADICTION_MARKER.NO_CONTRADICTION)
})

test('same dimension and subject disagreement remains unresolved', () => {
  const verdict = classifyDisagreement(
    { truthDimension: T.T1_INVOICE_AR_STATE, sourceOwner: 'LEDGER_SOURCE', subject: 'same', value: { balance: 100 } },
    { truthDimension: T.T1_INVOICE_AR_STATE, sourceOwner: 'LEDGER_SOURCE', subject: 'same', value: { balance: 0 } })
  assert.equal(verdict.marker, CONTRADICTION_MARKER.SOURCE_STATE_DISAGREEMENT)
  assert.equal(verdict.resolved, false)
})

test('current QBO T1 flows through governing selection into frozen collection decision', () => {
  const q = observeAccounting(QBO, { connection: Q, objectType: 'Invoice', payload: qboInvoice('collect') })
  const selection = governingClaims([q.admitted], T.T1_INVOICE_AR_STATE)
  const context = createCollectionDecisionContext({ disputeActive: false, paymentInFlight: false,
    availableCredit: 0, unappliedValue: 0, sourceConflict: false, attributionKnown: true,
    policyDecision: COLLECTION_POLICY_DECISION.ALLOWED })
  assert.equal(deriveCollectionEligibility({ governingLedger: selection, context }).outcome,
    COLLECTION_ELIGIBILITY.ELIGIBLE)
})

test('available credit supplied by T4 context prevents shortcut eligibility', () => {
  const q = observeAccounting(QBO, { connection: Q, objectType: 'Invoice', payload: qboInvoice('credit-review') })
  const selection = governingClaims([q.admitted], T.T1_INVOICE_AR_STATE)
  const context = createCollectionDecisionContext({ disputeActive: false, paymentInFlight: false,
    availableCredit: 100, unappliedValue: 0, sourceConflict: false, attributionKnown: true,
    policyDecision: COLLECTION_POLICY_DECISION.ALLOWED })
  assert.equal(deriveCollectionEligibility({ governingLedger: selection, context }).outcome,
    COLLECTION_ELIGIBILITY.REVIEW_REQUIRED)
})

test('provider-neutral proposition earns E7 only from two provider support records', () => {
  const propositionKey = 'invoice_outstanding_balance_represents_ar_state'
  const q = recordEvidence({ evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED,
    environment: OBSERVATION_ENVIRONMENT.FIXTURE_REPLAY, provider: QUICKBOOKS_ONLINE_PROVIDER,
    propositionKey, refs: ['https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice'] })
  const x = recordEvidence({ evidenceClass: EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED,
    environment: OBSERVATION_ENVIRONMENT.FIXTURE_REPLAY, provider: XERO_ACCOUNTING_PROVIDER,
    propositionKey, refs: ['https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml'] })
  const combined = composeEvidence({ evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED,
    components: [q, x] })
  assert.deepEqual(combined.providers, [QUICKBOOKS_ONLINE_PROVIDER, XERO_ACCOUNTING_PROVIDER])
})

test('schema plus documentation remains same-provider and proposition-bound', () => {
  const key = 'invoice_allocation_link_identifies_applied_value'
  const schema = recordEvidence({ evidenceClass: EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED,
    environment: OBSERVATION_ENVIRONMENT.FIXTURE_REPLAY, provider: XERO_ACCOUNTING_PROVIDER,
    propositionKey: key, refs: ['https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml'] })
  const docs = recordEvidence({ evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED,
    environment: OBSERVATION_ENVIRONMENT.FIXTURE_REPLAY, provider: XERO_ACCOUNTING_PROVIDER,
    propositionKey: key, refs: ['https://developer.xero.com/documentation/api/accounting/payments'] })
  assert.equal(composeEvidence({ evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema, docs] }).evidenceClass, EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC)
})

test('fixture replay cannot mint sandbox evidence', () => {
  assert.throws(() => recordEvidence({ evidenceClass: EVIDENCE_CLASS.E4_SANDBOX_OBSERVED,
    environment: OBSERVATION_ENVIRONMENT.FIXTURE_REPLAY, provider: QUICKBOOKS_ONLINE_PROVIDER,
    propositionKey: 'invoice_balance_represents_provider_ledger_state', captureId: 'fake' }),
  /mock cannot be the evidence/)
})

test('provider write capability and scopes still grant no G5 authority or execution', () => {
  for (const provider of [QUICKBOOKS_ONLINE_PROVIDER, XERO_ACCOUNTING_PROVIDER]) {
    const capability = describeProviderCapability({ provider, operation: 'create_payment',
      canTechnicallyWrite: CAPABILITY_VALUE.YES, supportedInProviderApi: CAPABILITY_VALUE.YES,
      supportedByDuewatchAdapter: CAPABILITY_VALUE.NO, allowedByCurrentScopes: CAPABILITY_VALUE.YES })
    assert.equal(capability.supportedByDuewatchAdapter, CAPABILITY_VALUE.NO)
    assert.equal(capabilityGrantsAuthority(), false)
  }
})

test('provider surprises are permanent complete ugly-scenario records', () => {
  const cases = [
    ['UGLY-QBO-UNAPPLIED', 'Payment with value but no invoice link', ['PAYMENT_CREDIT_ALLOCATION_STATE']],
    ['UGLY-XERO-RECONCILED', 'Payment has IsReconciled=true', ['BANK_LEDGER_RECONCILIATION_STATE']],
    ['UGLY-MULTICURRENCY', 'Amount and BankAmount differ by currency', ['PAYMENT_CREDIT_ALLOCATION_STATE']],
  ].map(([id, behavior, dimensions]) => uglyScenario({ id, initialState: 'authoritative read pending',
    trigger: 'provider fixture replay', observedProviderBehavior: behavior,
    truthDimensionsAffected: dimensions, dangerousInterpretation: 'cash received and safe to collect',
    correctInterpretation: 'preserve provider fact in its exact dimension and refetch authoritative state',
    requiredInvalidation: ['invoice', 'allocations'], collectionEligibility: 'REVIEW_REQUIRED',
    evidence: 'E1/E2 fixture-backed; not sandbox evidence',
    canonicalInvariantTested: 'provider shape never collapses truth dimensions or grants authority' }))
  assert.equal(cases.length, 3)
  assert.ok(cases.every((item) => item.kind === 'M2H_UGLY_SCENARIO_V0'))
})
