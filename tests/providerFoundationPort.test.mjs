import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canonicalValueEquals,
  canonicalHash,
} from '../src/lib/integrations/canonicalValue.js'
import {
  EVIDENCE_CLASS,
  OBSERVATION_ENVIRONMENT,
  recordEvidence,
  composeEvidence,
  evidenceGrantsAuthority,
} from '../src/lib/integrations/providerEvidence.js'
import {
  createProviderObservation,
  interpretObservation,
  isConstructedProviderObservation,
  interpretationBelongsToObservation,
} from '../src/lib/integrations/providerObservation.js'
import {
  FRESHNESS_STATE,
  resolveFreshness,
  freshnessBelongsToObservation,
  freshnessMayGovern,
} from '../src/lib/integrations/providerFreshness.js'
import {
  CLAIM_SOURCE_OWNER,
  PROVIDER_TRUTH_DIMENSION,
  ownerMaySpeakTo,
} from '../src/lib/integrations/providerTruthModel.js'
import {
  CAPABILITY_VALUE,
  capabilityGrantsAuthority,
  describeProviderCapability,
  providerTechnicallyCapable,
  scopeGrantsAuthority,
} from '../src/lib/integrations/providerCapability.js'
import {
  PROVIDER_CLAIM_ADMISSION,
  admitProviderClaim,
  assertProviderCannotWriteCanonicalMoney,
  governingClaims,
} from '../src/lib/integrations/providerContract.js'
import {
  decimalStringToMinorUnits,
  minorUnitsToDecimalString,
  normalizeProviderMoney,
} from '../src/lib/integrations/providerMoney.js'
import {
  COLLECTION_ELIGIBILITY,
  COLLECTION_POLICY_DECISION,
  createCollectionDecisionContext,
  deriveCollectionEligibility,
} from '../src/lib/integrations/collectionEligibility.js'

function observation(overrides = {}) {
  return createProviderObservation({
    tenantId: 'tenant-a',
    provider: 'stripe',
    providerAccountId: 'acct-a',
    objectType: 'charge',
    externalObjectId: 'ch_1',
    eventId: 'evt_1',
    deliveryId: 'delivery_1',
    observedAt: '2026-09-21T15:00:00.000Z',
    environment: 'SANDBOX',
    rawPayload: { id: 'ch_1', amount: 10000, currency: 'usd' },
    ...overrides,
  })
}

test('provider foundation canonicalizes equivalent structured values', () => {
  assert.equal(canonicalValueEquals({ b: 2, a: 1 }, { a: 1, b: 2 }), true)
  assert.equal(canonicalHash({ b: 2, a: 1 }), canonicalHash({ a: 1, b: 2 }))
})

test('provider evidence cannot mint composite proof classes directly', () => {
  assert.throws(() => recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED,
    propositionKey: 'webhook_delivery_may_repeat',
  }), /composite class/i)
})

test('sandbox evidence cannot be manufactured from a mock environment', () => {
  assert.throws(() => recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E4_SANDBOX_OBSERVED,
    provider: 'stripe',
    propositionKey: 'webhook_delivery_may_repeat',
    captureId: 'capture-1',
    environment: OBSERVATION_ENVIRONMENT.MOCK,
  }), /real provider observation/i)
})

test('E3 evidence requires schema and docs for the same proposition', () => {
  const schema = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED,
    provider: 'stripe',
    propositionKey: 'charge_has_currency',
    refs: ['stripe-schema'],
  })
  const docs = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED,
    provider: 'stripe',
    propositionKey: 'charge_has_currency',
    refs: ['stripe-docs'],
  })
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema, docs],
  })
  assert.equal(composed.evidenceClass, EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC)
  assert.equal(evidenceGrantsAuthority(composed), false)
})

test('observation provenance is exact-object and interpretation-bound', () => {
  const obs = observation()
  const interpretation = interpretObservation({
    observation: obs,
    truthDimension: PROVIDER_TRUTH_DIMENSION.T3_PAYMENT_RECEIPT_STATE,
    sourceOwner: CLAIM_SOURCE_OWNER.PAYMENT_PROCESSOR,
    subject: 'invoice:inv-1',
    value: { amount: 100, currency: 'USD' },
  })
  assert.equal(isConstructedProviderObservation(obs), true)
  assert.equal(isConstructedProviderObservation({ ...obs }), false)
  assert.equal(interpretationBelongsToObservation(interpretation, obs), true)
  assert.equal(interpretationBelongsToObservation(interpretation, { ...obs }), false)
})

test('freshness is resolver-produced and bound to the exact observation', () => {
  const obs = observation()
  const fresh = resolveFreshness({
    observation: obs,
    now: '2026-09-21T15:01:00.000Z',
    maxAgeMs: 5 * 60 * 1000,
    sourceAvailable: true,
  })
  assert.equal(fresh.state, FRESHNESS_STATE.FRESH)
  assert.equal(freshnessMayGovern(fresh.state), true)
  assert.equal(freshnessBelongsToObservation(fresh, obs), true)
  assert.equal(freshnessBelongsToObservation({ ...fresh }, obs), false)
})

test('provider claim admission requires the full tenant/provider/account tuple', () => {
  const obs = observation()
  const interpretation = interpretObservation({
    observation: obs,
    truthDimension: PROVIDER_TRUTH_DIMENSION.T3_PAYMENT_RECEIPT_STATE,
    sourceOwner: CLAIM_SOURCE_OWNER.PAYMENT_PROCESSOR,
    subject: 'payment:ch_1',
    value: { received: true },
  })
  const fresh = resolveFreshness({
    observation: obs,
    now: '2026-09-21T15:01:00.000Z',
    maxAgeMs: 5 * 60 * 1000,
    sourceAvailable: true,
  })

  const wrongAccount = admitProviderClaim({
    tenantId: 'tenant-a',
    provider: 'stripe',
    providerAccountId: 'acct-b',
    observation: obs,
    interpretation,
    freshness: fresh,
  })
  assert.equal(wrongAccount.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_PROVIDER_ACCOUNT)

  const admitted = admitProviderClaim({
    tenantId: 'tenant-a',
    provider: 'stripe',
    providerAccountId: 'acct-a',
    observation: obs,
    interpretation,
    freshness: fresh,
  })
  assert.equal(admitted.admitted, true)
  assert.equal(admitted.claim.grantsAuthority, false)
  assert.equal(admitted.claim.writesCanonicalMoney, false)
})

test('communication evidence cannot speak as payment receipt truth', () => {
  const obs = observation({ objectType: 'email', externalObjectId: 'mail-1' })
  const interpretation = interpretObservation({
    observation: obs,
    truthDimension: PROVIDER_TRUTH_DIMENSION.T3_PAYMENT_RECEIPT_STATE,
    sourceOwner: CLAIM_SOURCE_OWNER.COMMUNICATION_SOURCE,
    subject: 'invoice:inv-1',
    value: { customerSaidPaid: true },
  })
  const result = admitProviderClaim({
    tenantId: 'tenant-a',
    provider: 'stripe',
    providerAccountId: 'acct-a',
    observation: obs,
    interpretation,
  })
  assert.equal(result.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_OWNER_CANNOT_SPEAK)
  assert.equal(ownerMaySpeakTo(
    CLAIM_SOURCE_OWNER.COMMUNICATION_SOURCE,
    PROVIDER_TRUTH_DIMENSION.T3_PAYMENT_RECEIPT_STATE,
  ), false)
})

test('provider capability and OAuth scope never become DueWatch action authority', () => {
  const capability = describeProviderCapability({
    provider: 'stripe',
    operation: 'refund',
    canRead: CAPABILITY_VALUE.YES,
    canTechnicallyWrite: CAPABILITY_VALUE.YES,
    supportedInProviderApi: CAPABILITY_VALUE.YES,
    supportedByDuewatchAdapter: CAPABILITY_VALUE.YES,
    allowedByCurrentScopes: CAPABILITY_VALUE.YES,
  })
  assert.equal(providerTechnicallyCapable(capability), true)
  assert.equal(capabilityGrantsAuthority(capability), false)
  assert.equal(scopeGrantsAuthority(capability), false)
  assert.throws(() => describeProviderCapability({
    provider: 'stripe',
    operation: 'refund',
    authorized: true,
  }), /cannot be recorded as a provider capability/i)
})

test('source unavailable never governs as if it were empty', () => {
  const obs = observation()
  const unavailable = resolveFreshness({
    observation: obs,
    now: '2026-09-21T15:01:00.000Z',
    maxAgeMs: 5 * 60 * 1000,
    sourceAvailable: false,
  })
  assert.equal(unavailable.state, FRESHNESS_STATE.SOURCE_UNAVAILABLE)
  assert.equal(unavailable.mayGovern, false)
})

test('governing claims report stale inputs instead of silently treating them as current', () => {
  const obs = observation()
  const interpretation = interpretObservation({
    observation: obs,
    truthDimension: PROVIDER_TRUTH_DIMENSION.T1_INVOICE_AR_STATE,
    sourceOwner: CLAIM_SOURCE_OWNER.INVOICE_ORIGIN_SOURCE,
    subject: 'invoice:inv-1',
    value: { balance: 100 },
  })
  const stale = resolveFreshness({
    observation: obs,
    now: '2026-09-21T16:00:00.000Z',
    maxAgeMs: 1000,
    sourceAvailable: true,
  })
  const claim = admitProviderClaim({
    tenantId: 'tenant-a',
    provider: 'stripe',
    providerAccountId: 'acct-a',
    observation: obs,
    interpretation,
    freshness: stale,
  })
  const selection = governingClaims([claim], PROVIDER_TRUTH_DIMENSION.T1_INVOICE_AR_STATE)
  assert.equal(selection.governing.length, 0)
  assert.equal(selection.withheld.length, 1)
  assert.equal(selection.complete, false)
})

test('collection eligibility requires fresh trusted T1 truth plus explicit safe context', () => {
  const obs = observation({ objectType: 'invoice', externalObjectId: 'in_1' })
  const interpretation = interpretObservation({
    observation: obs,
    truthDimension: PROVIDER_TRUTH_DIMENSION.T1_INVOICE_AR_STATE,
    sourceOwner: CLAIM_SOURCE_OWNER.INVOICE_ORIGIN_SOURCE,
    subject: 'invoice:inv-1',
    value: { balance: 100 },
  })
  const fresh = resolveFreshness({
    observation: obs,
    now: '2026-09-21T15:01:00.000Z',
    maxAgeMs: 5 * 60 * 1000,
    sourceAvailable: true,
  })
  const claim = admitProviderClaim({
    tenantId: 'tenant-a',
    provider: 'stripe',
    providerAccountId: 'acct-a',
    observation: obs,
    interpretation,
    freshness: fresh,
  })
  const selection = governingClaims([claim], PROVIDER_TRUTH_DIMENSION.T1_INVOICE_AR_STATE)
  const context = createCollectionDecisionContext({
    disputeActive: false,
    paymentInFlight: false,
    availableCredit: 0,
    unappliedValue: 0,
    sourceConflict: false,
    attributionKnown: true,
    policyDecision: COLLECTION_POLICY_DECISION.ALLOWED,
  })
  const decision = deriveCollectionEligibility({ governingLedger: selection, context })
  assert.equal(decision.outcome, COLLECTION_ELIGIBILITY.ELIGIBLE)
  assert.equal(decision.authorityEvaluated, false)
})

test('provider kernel structurally refuses direct canonical-money mutation claims', () => {
  assert.equal(assertProviderCannotWriteCanonicalMoney({ writesCanonicalMoney: false }), true)
  assert.throws(
    () => assertProviderCannotWriteCanonicalMoney({ writesCanonicalMoney: true }),
    /cannot write canonical money truth/i,
  )
})


test('provider money never assumes two decimal places', () => {
  assert.equal(minorUnitsToDecimalString({ amountMinor: '10000', exponent: 0 }), '10000')
  assert.equal(minorUnitsToDecimalString({ amountMinor: '10000', exponent: 2 }), '100.00')
  assert.equal(minorUnitsToDecimalString({ amountMinor: '1234', exponent: 3 }), '1.234')
  assert.equal(decimalStringToMinorUnits({ amount: '10000', exponent: 0 }), 10000n)
  assert.equal(decimalStringToMinorUnits({ amount: '100.00', exponent: 2 }), 10000n)
})

test('provider money fails closed when the currency exponent is unknown', () => {
  assert.throws(() => normalizeProviderMoney({
    currency: 'JPY',
    amountMinor: '10000',
    minorUnitExponent: null,
  }), /minor-unit exponent/i)
  assert.throws(() => decimalStringToMinorUnits({ amount: '1.23', exponent: 0 }), /more decimal places/i)
})
