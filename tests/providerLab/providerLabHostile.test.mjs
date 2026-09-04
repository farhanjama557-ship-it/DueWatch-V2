/**
 * M2H-CP1 — hostile properties of the integration trust kernel.
 *
 * Each of these is a way a provider integration turns into a second truth,
 * authority or execution system. They are cross-layer on purpose: several
 * reach into the frozen G8 and Company Brain boundaries to prove M2H did not
 * quietly widen them.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PROVIDER_TRUTH_DIMENSION as T, TRUTH_DIMENSIONS, CLAIM_SOURCE_OWNER as OWNER,
  GENERALIZATION_LEVEL as G, CONTRADICTION_MARKER,
  ownerMaySpeakTo, promoteGeneralization, classifyDisagreement,
} from '../../src/lib/integrations/providerTruthModel.js'
import {
  EVIDENCE_CLASS, OBSERVATION_ENVIRONMENT, PRIMITIVE_EVIDENCE_CLASSES,
  recordEvidence, composeEvidence, evidenceGrantsAuthority,
} from '../../src/lib/integrations/providerEvidence.js'
import { interpretObservation, reinterpret } from '../../src/lib/integrations/providerObservation.js'
import {
  FRESHNESS_STATE, freshnessMayGovern, resolveFreshness, preferFresher,
} from '../../src/lib/integrations/providerFreshness.js'
import {
  CAPABILITY_VALUE, describeProviderCapability, describeProviderHealth,
  capabilityGrantsAuthority, scopeGrantsAuthority, PROVIDER_CONNECTION_STATE,
} from '../../src/lib/integrations/providerCapability.js'
import {
  PROVIDER_CLAIM_ADMISSION, admitProviderClaim, assertProviderCannotWriteCanonicalMoney,
} from '../../src/lib/integrations/providerContract.js'
import {
  COLLECTION_ELIGIBILITY, deriveCollectionEligibility,
} from '../../src/lib/integrations/collectionEligibility.js'

import { createClaim, assertCompanyBrainCannotWriteCanonicalMoney } from '../../src/lib/companyBrain/index.js'
import { enforceDwProactiveGrounding } from '../../src/lib/dwIntelligence/dwProactiveGrounding.js'
import { buildDwExecutionStatement } from '../../src/lib/dwIntelligence/dwExecutionPresentation.js'

import {
  LAB_TENANT, LAB_TENANT_B, LAB_ACCOUNT, LAB_ACCOUNT_B, LAB_NOW,
  MOCK_LEDGER_ADAPTER, MOCK_PROCESSOR_ADAPTER, MOCK_COMMS_ADAPTER,
  observeThrough, createReplayEngine,
} from './harness.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const FRESH = { state: FRESHNESS_STATE.FRESH, mayGovern: true }

const INTEGRATION_MODULES = [
  'src/lib/integrations/providerTruthModel.js',
  'src/lib/integrations/providerEvidence.js',
  'src/lib/integrations/providerObservation.js',
  'src/lib/integrations/providerFreshness.js',
  'src/lib/integrations/providerCapability.js',
  'src/lib/integrations/providerContract.js',
  'src/lib/integrations/collectionEligibility.js',
]

// 1-3 — nothing about a provider grants DueWatch permission
test('H1 a provider payload cannot grant G5 authority', () => {
  const { admitted } = observeThrough(MOCK_LEDGER_ADAPTER, {
    payload: {
      Id: 'inv-1', Balance: 0,
      // A payload doing its best to look like a grant.
      authorized: true, canActAutomatically: true, grant: { action: 'SEND_REMINDER', status: 'GRANTED' },
    },
  })
  assert.equal(admitted.claim.grantsAuthority, false)
  assert.equal(JSON.stringify(admitted.claim).includes('"grantsAuthority":true'), false)
})

test('H2 provider technical write capability cannot grant G5 authority', () => {
  const capability = describeProviderCapability({
    provider: 'mock_ledger', operation: 'write_everything',
    canTechnicallyWrite: CAPABILITY_VALUE.YES, supportedInProviderApi: CAPABILITY_VALUE.YES,
    supportedByDuewatchAdapter: CAPABILITY_VALUE.YES, allowedByCurrentScopes: CAPABILITY_VALUE.YES,
  })
  assert.equal(capability.authorityEvaluatedHere, false)
  assert.equal(capabilityGrantsAuthority(), false)
})

test('H3 an OAuth scope cannot grant G5 authority', () => {
  assert.equal(scopeGrantsAuthority(), false)
  const capability = describeProviderCapability({
    provider: 'mock_comms', operation: 'send_email',
    allowedByCurrentScopes: CAPABILITY_VALUE.YES, requiredScopes: ['mail.send'],
  })
  assert.equal(capability.mustReEvaluateAuthorityAtUse, true)
  assert.equal(JSON.stringify(capability).toLowerCase().includes('authorizedbyg5'), false)
})

// 4-6 — providers are inputs to truth, never writers of it
test('H4 a provider claim cannot write canonical financial state', () => {
  assert.throws(() => assertProviderCannotWriteCanonicalMoney({ writesCanonicalMoney: true }),
    /cannot write canonical money/)
  const { admitted } = observeThrough(MOCK_LEDGER_ADAPTER, {
    payload: MOCK_LEDGER_ADAPTER.emit({ invoiceId: 'inv-1', balance: 0 }),
  })
  assert.equal(admitted.claim.writesCanonicalMoney, false)
  assert.equal(assertProviderCannotWriteCanonicalMoney(admitted.claim), true)
})

test('H5 communication evidence cannot become payment truth', () => {
  const { interpretation, admitted } = observeThrough(MOCK_COMMS_ADAPTER, {
    payload: MOCK_COMMS_ADAPTER.emit({ invoiceId: 'inv-1', body: 'we paid yesterday, please stop emailing' }),
  })
  assert.equal(interpretation.truthDimension, null)
  assert.equal(admitted.claim.truthDimension, null)
  // And it cannot be promoted by relabelling the owner.
  const forged = interpretObservation({
    observation: { ...admitted, kind: 'M2H_PROVIDER_OBSERVATION_V0' },
    truthDimension: T.T3_PAYMENT_RECEIPT_STATE, sourceOwner: OWNER.COMMUNICATION_SOURCE,
  })
  assert.equal(ownerMaySpeakTo(forged.sourceOwner, forged.truthDimension), false)
})

test('H6 contract evidence cannot become a current ledger balance', () => {
  for (const dimension of TRUTH_DIMENSIONS) {
    assert.equal(ownerMaySpeakTo(OWNER.CONTRACT_SOURCE, dimension), false, dimension)
  }
})

// 7-9 — the dimensions do not imply one another
test('H7 a payment receipt does not imply invoice allocation', () => {
  const { interpretation } = observeThrough(MOCK_PROCESSOR_ADAPTER, {
    payload: MOCK_PROCESSOR_ADAPTER.emit({ invoiceId: 'inv-1', amountMinor: 100000 }),
  })
  assert.equal(interpretation.truthDimension, T.T3_PAYMENT_RECEIPT_STATE)
  assert.equal(ownerMaySpeakTo(OWNER.PAYMENT_PROCESSOR, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE), false)
})

test('H8 an accounting invoice status does not imply bank reconciliation', () => {
  assert.equal(ownerMaySpeakTo(OWNER.LEDGER_SOURCE, T.T6_BANK_LEDGER_RECONCILIATION_STATE), false)
})

test('H9 two observations in different dimensions are not automatically a conflict', () => {
  const pairs = [
    [T.T3_PAYMENT_RECEIPT_STATE, T.T1_INVOICE_AR_STATE],
    [T.T2_PAYMENT_ATTEMPT_STATE, T.T3_PAYMENT_RECEIPT_STATE],
    [T.T5_PROCESSOR_FUNDS_SETTLEMENT_STATE, T.T6_BANK_LEDGER_RECONCILIATION_STATE],
  ]
  for (const [a, b] of pairs) {
    const verdict = classifyDisagreement(
      { truthDimension: a, subject: 'inv-1', value: { x: 1 } },
      { truthDimension: b, subject: 'inv-1', value: { x: 2 } })
    assert.equal(verdict.marker, CONTRADICTION_MARKER.NO_CONTRADICTION, `${a} vs ${b}`)
  }
})

// 10-12 — freshness beats authority-of-source, and unknown is not empty
test('H10 a stale observation cannot beat a fresh one by looking authoritative', () => {
  const staleLedger = {
    observation: { observedAt: '2020-01-01T00:00:00Z' },
    freshness: { state: FRESHNESS_STATE.STALE, mayGovern: false },
    sourceOwner: OWNER.LEDGER_SOURCE,
  }
  const freshProcessor = {
    observation: { observedAt: LAB_NOW },
    freshness: FRESH, sourceOwner: OWNER.PAYMENT_PROCESSOR,
  }
  assert.equal(preferFresher(staleLedger, freshProcessor), freshProcessor)
})

test('H11 an invalidated observation cannot silently govern', () => {
  const resolved = resolveFreshness({
    observation: { observedAt: LAB_NOW }, now: LAB_NOW, maxAgeMs: 10_000_000,
    invalidatedAt: LAB_NOW,
  })
  assert.equal(resolved.state, FRESHNESS_STATE.INVALIDATED)
  assert.equal(resolved.mayGovern, false)
  assert.equal(freshnessMayGovern(resolved.state), false)
})

test('H12 SOURCE_UNAVAILABLE is not empty, zero or "no issue"', () => {
  const health = describeProviderHealth({ connectionState: PROVIDER_CONNECTION_STATE.ERROR })
  assert.equal(health.sourceAvailable, false)
  assert.equal(health.absenceOfDataMeansUnknown, true)
  const eligibility = deriveCollectionEligibility({ sourceAvailable: false })
  assert.equal(eligibility.outcome, COLLECTION_ELIGIBILITY.UNKNOWN)
  assert.notEqual(eligibility.outcome, COLLECTION_ELIGIBILITY.BLOCKED)
  assert.notEqual(eligibility.outcome, COLLECTION_ELIGIBILITY.ELIGIBLE)
})

// 13-15 — delivery is not truth
test('H13 duplicate events are idempotent', () => {
  const engine = createReplayEngine()
  const first = engine.deliver({ deliveryId: 'd1', eventId: 'e1', sequence: 1, mutationType: 'PAYMENT_CREATED' })
  const second = engine.deliver({ deliveryId: 'd1', eventId: 'e1', sequence: 1, mutationType: 'PAYMENT_CREATED' })
  assert.equal(first.outcome, 'ACCEPTED')
  assert.equal(second.outcome, 'DUPLICATE_DELIVERY')
  assert.deepEqual(first.refetch, second.refetch)
})

test('H14 out-of-order events converge and never write state from the event', () => {
  const engine = createReplayEngine()
  const late = engine.deliver({ deliveryId: 'd9', eventId: 'e9', sequence: 9, mutationType: 'INVOICE_UPDATED' })
  const older = engine.deliver({ deliveryId: 'd1', eventId: 'e1', sequence: 1, mutationType: 'INVOICE_UPDATED' })
  assert.equal(late.stateWrittenFromEvent, false)
  assert.equal(older.outcome, 'ACCEPTED_OUT_OF_ORDER')
  assert.equal(engine.settle().converged, true)
})

test('H15 a dropped event cannot create false certainty', () => {
  const engine = createReplayEngine()
  engine.deliver({ deliveryId: 'd1', eventId: 'e1', mutationType: 'A_MUTATION_WE_HAVE_NEVER_SEEN' })
  // Unknown scope ⇒ everything suspect ⇒ refetch obligation outstanding.
  assert.ok(engine.pendingRefetch.length > 0)
})

// 16-18 — identity fails closed
test('H16 a wrong-tenant provider object fails closed', () => {
  const { observation, interpretation } = observeThrough(MOCK_LEDGER_ADAPTER, {
    payload: MOCK_LEDGER_ADAPTER.emit({ invoiceId: 'inv-1', balance: 100 }), tenantId: LAB_TENANT_B,
  })
  assert.equal(admitProviderClaim({
    tenantId: LAB_TENANT, providerAccountId: LAB_ACCOUNT, observation, interpretation,
  }).admission, PROVIDER_CLAIM_ADMISSION.REJECTED_TENANT)
})

test('H17 a wrong provider-account identity fails closed', () => {
  // One tenant, two connected companies: an object from the other company is
  // as wrong as one from another tenant.
  const { observation, interpretation } = observeThrough(MOCK_LEDGER_ADAPTER, {
    payload: MOCK_LEDGER_ADAPTER.emit({ invoiceId: 'inv-1', balance: 100 }),
    providerAccountId: LAB_ACCOUNT_B,
  })
  assert.equal(admitProviderClaim({
    tenantId: LAB_TENANT, providerAccountId: LAB_ACCOUNT, observation, interpretation,
  }).admission, PROVIDER_CLAIM_ADMISSION.REJECTED_PROVIDER_ACCOUNT)
})

test('H18 a same-name client collision stays unresolved', () => {
  const result = deriveCollectionEligibility({
    ledger: { value: { balance: 1000 } }, ledgerFreshness: FRESH, attributionKnown: false,
  })
  assert.equal(result.outcome, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED)
  assert.ok(result.reasons.includes('ATTRIBUTION_UNKNOWN'))
})

// 19-20 — knowledge discipline
test('H19 the raw observation survives even when the interpretation changes', () => {
  const { observation, interpretation } = observeThrough(MOCK_LEDGER_ADAPTER, {
    payload: MOCK_LEDGER_ADAPTER.emit({ invoiceId: 'inv-1', balance: 100 }),
  })
  const changed = reinterpret(interpretation, { value: { balance: 999 } })
  assert.equal(observation.rawPayload.Balance, 100)
  assert.equal(changed.observationHash, observation.rawHash)
})

test('H20 a provider quirk cannot silently become a universal DueWatch rule', () => {
  assert.throws(() => promoteGeneralization(
    G.G0_PROVIDER_IMPLEMENTATION_DETAIL, G.G5_LOCKED_CANONICAL_RULE), /one level at a time/)
  assert.throws(() => promoteGeneralization(
    G.G1_PROVIDER_CAPABILITY, G.G4_CANDIDATE_CANONICAL_INVARIANT), /one level at a time/)
})

// 21-23 — evidence is not power
test('H21 a mock provider cannot claim E4/E5, and cannot claim E6 at all', () => {
  for (const cls of [EVIDENCE_CLASS.E4_SANDBOX_OBSERVED, EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED]) {
    assert.throws(() => recordEvidence({
      evidenceClass: cls, environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['x'],
    }), /mock cannot be the evidence/, cls)
  }
  // E6 is composite: it cannot be recorded directly from any environment.
  assert.throws(() => recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
    environment: OBSERVATION_ENVIRONMENT.PROVIDER_SANDBOX, refs: ['x'],
  }), /composite/i)
})

test('H22 an evidence class does not act as authority — primitive or composed', () => {
  assert.equal(evidenceGrantsAuthority(), false)
  for (const cls of PRIMITIVE_EVIDENCE_CLASSES) {
    const record = recordEvidence({
      evidenceClass: cls, provider: 'mock_ledger',
      environment: cls.startsWith('E4') || cls.startsWith('E5')
        ? OBSERVATION_ENVIRONMENT.PROVIDER_SANDBOX : OBSERVATION_ENVIRONMENT.MOCK,
      refs: ['ref'],
    })
    assert.equal(record.grantsAuthority, false, cls)
  }
  // A composed class carries more provenance and exactly as little power.
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [
      recordEvidence({ evidenceClass: EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED, provider: 'p', environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['s'] }),
      recordEvidence({ evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED, provider: 'p', environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['d'] }),
    ],
  })
  assert.equal(composed.grantsAuthority, false)
})

test('H23 model confidence does not change source ownership', () => {
  const { observation } = observeThrough(MOCK_COMMS_ADAPTER, {
    payload: MOCK_COMMS_ADAPTER.emit({ invoiceId: 'inv-1', body: 'we paid' }),
  })
  // Confidence is not a parameter of interpretation, and adding it changes
  // nothing about who owns the claim.
  const a = interpretObservation({ observation, sourceOwner: OWNER.COMMUNICATION_SOURCE, subject: 'inv-1' })
  const b = interpretObservation({
    observation, sourceOwner: OWNER.COMMUNICATION_SOURCE, subject: 'inv-1',
    confidence: 1, modelCertainty: 'ABSOLUTE',
  })
  assert.equal(a.sourceOwner, b.sourceOwner)
  assert.equal(JSON.stringify(b).includes('modelCertainty'), false)
})

// 24-25 — the frozen boundaries M2H must not widen
test('H24 the Company Brain cannot turn a provider observation into canonical money', () => {
  for (const dimension of TRUTH_DIMENSIONS) {
    assert.throws(() => createClaim({
      tenantId: LAB_TENANT, id: 'c1', claimClass: 'COMPANY_POLICY',
      claimType: dimension, provenanceRootIds: ['provider-source-1'],
    }), /cannot create canonical money truth/, dimension)
  }
  assert.throws(() => assertCompanyBrainCannotWriteCanonicalMoney({
    truthDimension: T.T1_INVOICE_AR_STATE, objectType: 'invoice',
  }), /./)
})

test('H25 the G8 execution receipt source contract is unchanged and untouched by M2H', () => {
  // A provider observation is not a receipt, and no amount of provider state
  // produces a presentable execution statement.
  const result = enforceDwProactiveGrounding({
    narrative: { headline: 'Here is what happened.' },
    truthLock: { canonicalFacts: { canonicalStatus: 'OPEN', balance: 1000, daysOverdue: 10, paid: false } },
    governance: null,
    providerObservation: observeThrough(MOCK_PROCESSOR_ADAPTER, {
      payload: MOCK_PROCESSOR_ADAPTER.emit({ invoiceId: 'inv-1', amountMinor: 100000 }),
    }).admitted,
  })
  assert.deepEqual(result.presentableExecution, [])
  assert.equal(result.boundaries.executionStatementOwner, 'RECEIPT')
  assert.equal(result.boundaries.narrativeMayStateExecution, false)
  // A provider claim shaped like a receipt still is not one.
  const fromProvider = buildDwExecutionStatement({
    receipt: { provider: 'mock_processor', status: 'succeeded' },
    claim: { tenantId: LAB_TENANT, invoiceId: 'inv-1', ruleId: 'r-1', action: 'send_reminder' },
  })
  assert.equal(fromProvider.issued, false)
  // The source-provenance contract text is still present in the frozen module.
  const owner = read('src/lib/dwIntelligence/dwExecutionPresentation.js')
  assert.ok(/MUST originate from[\s\S]{0,120}canonical execution-claim/.test(owner))
})

// Structural: the kernel opens no new surface
test('the integration kernel is pure — no persistence, network, schema or credentials', () => {
  for (const relative of INTEGRATION_MODULES) {
    const source = read(relative)
    const body = source.split('\n').filter((line) => !/^\s*(import|}\s*from)\b/.test(line)).join('\n')
    for (const forbidden of ['createClient', 'fetch(', '.from(', 'process.env', 'Deno.',
      'create table', 'alter table', 'access_token', 'refresh_token', 'client_secret']) {
      assert.equal(body.toLowerCase().includes(forbidden.toLowerCase()), false,
        `${relative} contains ${forbidden}`)
    }
  }
})

test('no live provider SDK, OAuth flow or webhook registration was introduced', () => {
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.git', 'dist', 'build'].includes(name)) continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full, out)
      else if (/\.(m?js|jsx)$/.test(name)) out.push(path.relative(root, full))
    }
    return out
  }
  // The production kernel and the harness: the only code here that could ever
  // reach a provider. Test files are excluded deliberately — a test asserting
  // "no QuickBooks call exists" has to contain the word, and scanning the
  // scanners only ever finds their own vocabulary.
  const files = walk(path.join(root, 'src/lib/integrations'))
    .concat(['tests/providerLab/harness.mjs'])
  for (const relative of files) {
    // CODE only. Naming QuickBooks in a comment to explain why its token is not
    // permission is exactly the documentation this checkpoint should carry; what
    // must not exist is a call to it.
    const code = read(relative)
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
      .toLowerCase()
    for (const live of ['quickbooks', 'intuit', 'xero.com', 'api.stripe.com', 'googleapis',
      // Not a blanket URL ban: a doc citation IS the evidence model working.
      // Actual network use is covered by the purity test above.
      'oauth2', 'client_id=', 'webhook_secret']) {
      assert.equal(code.includes(live), false, `${relative} references live provider surface ${live}`)
    }
  }
})
