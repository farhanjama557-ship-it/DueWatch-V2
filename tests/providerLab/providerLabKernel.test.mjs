/**
 * M2H-CP1 — the trust kernel itself.
 *
 * These test the contracts every later connector inherits: truth dimensions,
 * claim-level ownership, evidence classes, observation/interpretation
 * separation, freshness and invalidation, capability, and the derived
 * eligibility model.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROVIDER_TRUTH_DIMENSION as T, TRUTH_DIMENSIONS, CLAIM_SOURCE_OWNER as OWNER,
  GENERALIZATION_LEVEL as G, DECISION_STATUS, CONTRADICTION_MARKER,
  ownerMaySpeakTo, promoteGeneralization, classifyDisagreement,
} from '../../src/lib/integrations/providerTruthModel.js'
import {
  EVIDENCE_CLASS, OBSERVATION_ENVIRONMENT, EVIDENCE_CLASS_IS_RANKED,
  recordEvidence, evidenceGrantsAuthority,
} from '../../src/lib/integrations/providerEvidence.js'
import {
  createProviderObservation, interpretObservation, reinterpret,
} from '../../src/lib/integrations/providerObservation.js'
import {
  FRESHNESS_STATE, freshnessMayGovern, invalidationScope, resolveFreshness, preferFresher,
} from '../../src/lib/integrations/providerFreshness.js'
import {
  CAPABILITY_VALUE, PROVIDER_CONNECTION_STATE, describeProviderCapability,
  describeProviderHealth, providerTechnicallyCapable, capabilityGrantsAuthority, scopeGrantsAuthority,
} from '../../src/lib/integrations/providerCapability.js'
import {
  PROVIDER_CLAIM_ADMISSION, admitProviderClaim, governingClaims,
} from '../../src/lib/integrations/providerContract.js'
import {
  COLLECTION_ELIGIBILITY, ELIGIBILITY_REASON, deriveCollectionEligibility,
} from '../../src/lib/integrations/collectionEligibility.js'
import { createClaim } from '../../src/lib/companyBrain/index.js'

import { LAB_TENANT, LAB_ACCOUNT, LAB_NOW, MOCK_LEDGER_ADAPTER, observeThrough } from './harness.mjs'

// ── Truth dimensions: reused, not redeclared ─────────────────────────────────

test('the six dimensions are the Company Brain money-truth classes, proven behaviourally', () => {
  // Not a text comparison: the Company Brain REFUSES to create a claim in any
  // canonical money class. If our list drifted from its list, one of these
  // would stop throwing.
  assert.equal(TRUTH_DIMENSIONS.length, 6)
  for (const dimension of TRUTH_DIMENSIONS) {
    assert.throws(() => createClaim({
      tenantId: LAB_TENANT, id: 'c1', claimClass: 'COMPANY_POLICY',
      claimType: dimension, provenanceRootIds: ['s1'],
    }), /cannot create canonical money truth/, dimension)
  }
})

test('the dimensions stay distinct — attempt, receipt, allocation, settlement, reconciliation', () => {
  const distinct = new Set(TRUTH_DIMENSIONS)
  assert.equal(distinct.size, 6)
  for (const [a, b] of [
    [T.T2_PAYMENT_ATTEMPT_STATE, T.T3_PAYMENT_RECEIPT_STATE],
    [T.T3_PAYMENT_RECEIPT_STATE, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE],
    [T.T4_PAYMENT_CREDIT_ALLOCATION_STATE, T.T5_PROCESSOR_FUNDS_SETTLEMENT_STATE],
    [T.T5_PROCESSOR_FUNDS_SETTLEMENT_STATE, T.T6_BANK_LEDGER_RECONCILIATION_STATE],
  ]) assert.notEqual(a, b)
})

// ── Claim-level ownership ────────────────────────────────────────────────────

test('ownership is claim-level: a communication source owns no money dimension', () => {
  for (const dimension of TRUTH_DIMENSIONS) {
    assert.equal(ownerMaySpeakTo(OWNER.COMMUNICATION_SOURCE, dimension), false, dimension)
    assert.equal(ownerMaySpeakTo(OWNER.CONTRACT_SOURCE, dimension), false, dimension)
    assert.equal(ownerMaySpeakTo(OWNER.CRM_SOURCE, dimension), false, dimension)
    assert.equal(ownerMaySpeakTo(OWNER.DUEWATCH_DERIVED, dimension), false, dimension)
  }
})

test('a ledger owns AR and allocation; a processor owns attempt, receipt and settlement', () => {
  assert.ok(ownerMaySpeakTo(OWNER.LEDGER_SOURCE, T.T1_INVOICE_AR_STATE))
  assert.ok(ownerMaySpeakTo(OWNER.LEDGER_SOURCE, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE))
  // A ledger does not speak for the processor's funds, and vice versa.
  assert.equal(ownerMaySpeakTo(OWNER.LEDGER_SOURCE, T.T5_PROCESSOR_FUNDS_SETTLEMENT_STATE), false)
  assert.ok(ownerMaySpeakTo(OWNER.PAYMENT_PROCESSOR, T.T3_PAYMENT_RECEIPT_STATE))
  assert.equal(ownerMaySpeakTo(OWNER.PAYMENT_PROCESSOR, T.T1_INVOICE_AR_STATE), false)
  assert.ok(ownerMaySpeakTo(OWNER.BANK_RECONCILIATION_SOURCE, T.T6_BANK_LEDGER_RECONCILIATION_STATE))
})

// ── Disagreement classification ──────────────────────────────────────────────

test('different dimensions are NOT a contradiction', () => {
  const verdict = classifyDisagreement(
    { truthDimension: T.T3_PAYMENT_RECEIPT_STATE, subject: 'inv-1', value: { received: 1000 }, sourceOwner: OWNER.PAYMENT_PROCESSOR },
    { truthDimension: T.T1_INVOICE_AR_STATE, subject: 'inv-1', value: { balance: 1000 }, sourceOwner: OWNER.LEDGER_SOURCE })
  assert.equal(verdict.marker, CONTRADICTION_MARKER.NO_CONTRADICTION)
})

test('same dimension, same subject, different values IS a disagreement — and is not resolved here', () => {
  const verdict = classifyDisagreement(
    { truthDimension: T.T1_INVOICE_AR_STATE, subject: 'inv-1', value: { balance: 0 }, sourceOwner: OWNER.LEDGER_SOURCE },
    { truthDimension: T.T1_INVOICE_AR_STATE, subject: 'inv-1', value: { balance: 1000 }, sourceOwner: OWNER.INVOICE_ORIGIN_SOURCE })
  assert.equal(verdict.marker, CONTRADICTION_MARKER.PROVIDER_VS_PROVIDER_DIFFERENCE)
  assert.equal(verdict.resolved, false)
})

// ── Generalization ───────────────────────────────────────────────────────────

test('one provider observation cannot jump to a locked canonical rule', () => {
  assert.throws(
    () => promoteGeneralization(G.G0_PROVIDER_IMPLEMENTATION_DETAIL, G.G5_LOCKED_CANONICAL_RULE),
    /one level at a time/)
  assert.equal(
    promoteGeneralization(G.G0_PROVIDER_IMPLEMENTATION_DETAIL, G.G1_PROVIDER_CAPABILITY),
    G.G1_PROVIDER_CAPABILITY)
  assert.ok(DECISION_STATUS.LOCK_CANDIDATE)
})

// ── Evidence ─────────────────────────────────────────────────────────────────

test('a mock environment cannot claim a live-observation evidence class', () => {
  // E6 is no longer listed here because it is no longer directly recordable at
  // all: it is composite, and providerLabEvidenceClosure proves it must be
  // composed from a doc component plus a real sandbox component.
  for (const cls of [EVIDENCE_CLASS.E4_SANDBOX_OBSERVED, EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED]) {
    assert.throws(() => recordEvidence({ evidenceClass: cls, environment: OBSERVATION_ENVIRONMENT.MOCK }),
      /mock cannot be the evidence/, cls)
    assert.throws(() => recordEvidence({ evidenceClass: cls, environment: OBSERVATION_ENVIRONMENT.FIXTURE_REPLAY }),
      /mock cannot be the evidence/, cls)
  }
})

test('documentation classes require a citation', () => {
  assert.throws(() => recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED, environment: OBSERVATION_ENVIRONMENT.MOCK,
  }), /requires a citation/)
  const cited = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED,
    environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['https://provider.example/docs/x'],
  })
  assert.equal(cited.evidenceClass, EVIDENCE_CLASS.E2_DOC_CONFIRMED)
})

test('evidence classes are not a ranking and never grant authority', () => {
  assert.equal(EVIDENCE_CLASS_IS_RANKED, false)
  assert.equal(evidenceGrantsAuthority(), false)
  // A primitive class, since E8 can no longer be conjured by naming it.
  const record = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E0_HYPOTHESIS, environment: OBSERVATION_ENVIRONMENT.MOCK,
  })
  assert.equal(record.grantsAuthority, false)
  assert.equal(record.isRanked, false)
})

// ── Observation vs interpretation ────────────────────────────────────────────

test('the raw observation survives a changed interpretation', () => {
  // The QuickBooks zero-amount payment: read as cash it marks an invoice paid
  // that nobody paid; read as a credit allocation it is right. The bytes must
  // outlive our understanding of them.
  const observation = createProviderObservation({
    tenantId: LAB_TENANT, provider: 'mock_ledger', providerAccountId: LAB_ACCOUNT,
    objectType: 'Payment', externalObjectId: 'pay-1', observedAt: LAB_NOW,
    rawPayload: { TotalAmt: 0, LinkedTxn: [{ TxnType: 'CreditMemo' }, { TxnType: 'Invoice' }] },
  })
  const wrong = interpretObservation({
    observation, truthDimension: T.T3_PAYMENT_RECEIPT_STATE,
    sourceOwner: OWNER.PAYMENT_PROCESSOR, subject: 'inv-1', value: { cashReceived: 0 },
  })
  const right = reinterpret(wrong, {
    truthDimension: T.T4_PAYMENT_CREDIT_ALLOCATION_STATE,
    sourceOwner: OWNER.LEDGER_SOURCE, value: { creditAllocation: true, cashReceived: false },
  })
  assert.equal(right.observationId, observation.id)
  assert.equal(right.observationHash, observation.rawHash)
  assert.equal(right.supersedesVersion, 'v1')
  assert.equal(right.interpretationVersion, 'v2')
  // Raw bytes untouched and unreachable for edit.
  assert.deepEqual(observation.rawPayload, { TotalAmt: 0, LinkedTxn: [{ TxnType: 'CreditMemo' }, { TxnType: 'Invoice' }] })
  assert.ok(Object.isFrozen(observation.rawPayload))
})

test('an interpretation cannot be re-pointed at a different observation', () => {
  const { interpretation } = observeThrough(MOCK_LEDGER_ADAPTER, {
    payload: MOCK_LEDGER_ADAPTER.emit({ invoiceId: 'inv-1', balance: 100 }),
  })
  const forged = reinterpret(interpretation, { observationId: 'obs:other', tenantId: 'tenant-x' })
  assert.equal(forged.observationId, interpretation.observationId)
  assert.equal(forged.tenantId, LAB_TENANT)
})

// ── Freshness and invalidation ───────────────────────────────────────────────

test('only FRESH may govern', () => {
  assert.equal(freshnessMayGovern(FRESHNESS_STATE.FRESH), true)
  for (const state of [FRESHNESS_STATE.STALE, FRESHNESS_STATE.INVALIDATED,
    FRESHNESS_STATE.REFETCH_REQUIRED, FRESHNESS_STATE.SOURCE_UNAVAILABLE, FRESHNESS_STATE.UNKNOWN]) {
    assert.equal(freshnessMayGovern(state), false, state)
  }
})

test('an observation older than its window is STALE, and a recent one is FRESH', () => {
  // The age path itself, which the override tests below never reach: without
  // this, a freshness window could stop being applied and nothing would notice.
  const hour = 3_600_000
  const old = { observedAt: '2026-09-01T00:00:00Z' }
  const recent = { observedAt: '2026-09-01T11:30:00Z' }
  assert.equal(resolveFreshness({ observation: old, now: LAB_NOW, maxAgeMs: hour }).state,
    FRESHNESS_STATE.STALE)
  assert.equal(resolveFreshness({ observation: old, now: LAB_NOW, maxAgeMs: hour }).mayGovern, false)
  assert.equal(resolveFreshness({ observation: recent, now: LAB_NOW, maxAgeMs: hour }).state,
    FRESHNESS_STATE.FRESH)
  assert.equal(resolveFreshness({ observation: recent, now: LAB_NOW, maxAgeMs: hour }).mayGovern, true)
  // No window and no comparable timestamps means UNKNOWN, never FRESH.
  assert.equal(resolveFreshness({ observation: recent, now: LAB_NOW }).state, FRESHNESS_STATE.UNKNOWN)
})

test('source unavailable outranks age, and invalidation outranks both', () => {
  const observation = { observedAt: LAB_NOW }
  assert.equal(resolveFreshness({ observation, now: LAB_NOW, maxAgeMs: 1000, sourceAvailable: false }).state,
    FRESHNESS_STATE.SOURCE_UNAVAILABLE)
  assert.equal(resolveFreshness({ observation, now: LAB_NOW, maxAgeMs: 1000, invalidatedAt: LAB_NOW }).state,
    FRESHNESS_STATE.INVALIDATED)
  assert.equal(resolveFreshness({ observation, now: LAB_NOW, maxAgeMs: 1000, refetchRequired: true }).state,
    FRESHNESS_STATE.REFETCH_REQUIRED)
})

test('a deleted payment invalidates five things, not one', () => {
  const scope = invalidationScope('PAYMENT_DELETED')
  assert.equal(scope.known, true)
  assert.deepEqual([...scope.refetch].sort(),
    ['allocations', 'customer_unapplied_value', 'invoice', 'payment'])
  assert.ok(scope.dimensions.includes('INVOICE_AR_STATE'))
})

test('an unrecognised mutation is treated as maximally invalidating, not harmless', () => {
  const scope = invalidationScope('SOMETHING_NEW_THE_PROVIDER_ADDED')
  assert.equal(scope.known, false)
  assert.equal(scope.dimensions.length, 6)
})

test('a stale observation never beats a fresh one, however authoritative its source', () => {
  const stale = { observation: { observedAt: '2020-01-01T00:00:00Z' },
    freshness: { state: FRESHNESS_STATE.STALE, mayGovern: false } }
  const fresh = { observation: { observedAt: LAB_NOW },
    freshness: { state: FRESHNESS_STATE.FRESH, mayGovern: true } }
  assert.equal(preferFresher(stale, fresh), fresh)
  assert.equal(preferFresher(fresh, stale), fresh)
  assert.equal(preferFresher(stale, stale), null)
})

// ── Capability ───────────────────────────────────────────────────────────────

test('capability records six separate axes and refuses to hold authority', () => {
  const capability = describeProviderCapability({
    provider: 'mock_ledger', operation: 'update_invoice',
    canRead: CAPABILITY_VALUE.YES, canTechnicallyWrite: CAPABILITY_VALUE.YES,
    supportedInProviderApi: CAPABILITY_VALUE.YES,
    supportedByDuewatchAdapter: CAPABILITY_VALUE.NO,
    allowedByCurrentScopes: CAPABILITY_VALUE.YES,
    requiredScopes: ['accounting.write'],
  })
  assert.equal(capability.authorityOwner, 'G5')
  assert.equal(capability.authorityEvaluatedHere, false)
  assert.equal(capability.mustReEvaluateAuthorityAtUse, true)
  // Technically capable is false here only because OUR adapter lacks it —
  // which is still not a statement about permission.
  assert.equal(providerTechnicallyCapable(capability), false)
  assert.equal(capabilityGrantsAuthority(), false)
  assert.equal(scopeGrantsAuthority(), false)
})

test('a capability record refuses any authority-shaped field', () => {
  for (const field of ['authorizedByG5', 'authorized', 'canDoIt', 'canExecute', 'standingAuthority']) {
    assert.throws(() => describeProviderCapability({
      provider: 'p', operation: 'o', [field]: true,
    }), /G5 owns DueWatch authority/, field)
  }
})

test('capability values are tri-state, never a bare boolean', () => {
  assert.throws(() => describeProviderCapability({
    provider: 'p', operation: 'o', canRead: true,
  }), /never a bare boolean/)
  const unresearched = describeProviderCapability({ provider: 'p', operation: 'o' })
  assert.equal(unresearched.canRead, CAPABILITY_VALUE.UNKNOWN)
})

test('a revoked connection reports unknown, not clean', () => {
  const health = describeProviderHealth({
    provider: 'mock_ledger', connectionState: PROVIDER_CONNECTION_STATE.REVOKED,
  })
  assert.equal(health.sourceAvailable, false)
  assert.equal(health.absenceOfDataMeansUnknown, true)
})

// ── Claim admission ──────────────────────────────────────────────────────────

test('a claim from another tenant or another provider account is refused', () => {
  const { observation, interpretation } = observeThrough(MOCK_LEDGER_ADAPTER, {
    payload: MOCK_LEDGER_ADAPTER.emit({ invoiceId: 'inv-1', balance: 100 }),
  })
  assert.equal(admitProviderClaim({
    tenantId: 'tenant-other', providerAccountId: LAB_ACCOUNT, observation, interpretation,
  }).admission, PROVIDER_CLAIM_ADMISSION.REJECTED_TENANT)
  assert.equal(admitProviderClaim({
    tenantId: LAB_TENANT, providerAccountId: 'acct-other', observation, interpretation,
  }).admission, PROVIDER_CLAIM_ADMISSION.REJECTED_PROVIDER_ACCOUNT)
})

test('a source that does not own a dimension cannot claim it', () => {
  const { observation } = observeThrough(MOCK_LEDGER_ADAPTER, {
    payload: MOCK_LEDGER_ADAPTER.emit({ invoiceId: 'inv-1', balance: 100 }),
  })
  const overreach = interpretObservation({
    observation, truthDimension: T.T1_INVOICE_AR_STATE,
    sourceOwner: OWNER.COMMUNICATION_SOURCE, subject: 'inv-1', value: { balance: 0 },
  })
  const result = admitProviderClaim({
    tenantId: LAB_TENANT, providerAccountId: LAB_ACCOUNT, observation, interpretation: overreach,
  })
  assert.equal(result.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_OWNER_CANNOT_SPEAK)
})

test('governing claims exclude and REPORT everything non-fresh', () => {
  const fresh = observeThrough(MOCK_LEDGER_ADAPTER, {
    payload: MOCK_LEDGER_ADAPTER.emit({ invoiceId: 'inv-1', balance: 100 }), externalObjectId: 'a',
  }).admitted
  const stale = observeThrough(MOCK_LEDGER_ADAPTER, {
    payload: MOCK_LEDGER_ADAPTER.emit({ invoiceId: 'inv-2', balance: 200 }), externalObjectId: 'b',
    freshness: { state: FRESHNESS_STATE.STALE, mayGovern: false },
  }).admitted
  const result = governingClaims([fresh, stale], T.T1_INVOICE_AR_STATE)
  assert.equal(result.governing.length, 1)
  assert.equal(result.withheld.length, 1)
  assert.equal(result.complete, false)
})

// ── Collection eligibility ───────────────────────────────────────────────────

test('eligibility is never derived from balance alone', () => {
  const ledger = { value: { balance: 1000 } }
  const fresh = { state: FRESHNESS_STATE.FRESH, mayGovern: true }
  const base = { ledger, ledgerFreshness: fresh }
  assert.equal(deriveCollectionEligibility(base).outcome, COLLECTION_ELIGIBILITY.ELIGIBLE)
  assert.equal(deriveCollectionEligibility({ ...base, disputeActive: true }).outcome, COLLECTION_ELIGIBILITY.BLOCKED)
  assert.equal(deriveCollectionEligibility({ ...base, paymentInFlight: true }).outcome, COLLECTION_ELIGIBILITY.HOLD)
  assert.equal(deriveCollectionEligibility({ ...base, availableCredit: 50 }).outcome, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED)
  assert.equal(deriveCollectionEligibility({ ...base, sourceConflict: true }).outcome, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED)
  assert.equal(deriveCollectionEligibility({ ...base, attributionKnown: false }).outcome, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED)
  assert.equal(deriveCollectionEligibility({ ...base, sourceAvailable: false }).outcome, COLLECTION_ELIGIBILITY.UNKNOWN)
  assert.equal(deriveCollectionEligibility({ ledger, ledgerFreshness: { state: FRESHNESS_STATE.STALE } }).outcome,
    COLLECTION_ELIGIBILITY.HOLD)
})

test('eligibility never evaluates authority and says so', () => {
  const result = deriveCollectionEligibility({
    ledger: { value: { balance: 1000 } }, ledgerFreshness: { state: FRESHNESS_STATE.FRESH, mayGovern: true },
  })
  assert.equal(result.authorityEvaluated, false)
  assert.equal(result.authorityOwner, 'G5')
  assert.equal(result.requiresFreshAuthorityAtUse, true)
  assert.equal(result.derivedFromBalanceAlone, false)
})

test('an unreadable ledger yields UNKNOWN, never "nothing outstanding"', () => {
  const result = deriveCollectionEligibility({ sourceAvailable: false })
  assert.equal(result.outcome, COLLECTION_ELIGIBILITY.UNKNOWN)
  assert.ok(result.reasons.includes(ELIGIBILITY_REASON.LEDGER_UNAVAILABLE))
  assert.equal(result.reasons.includes(ELIGIBILITY_REASON.NOTHING_OUTSTANDING), false)
})
