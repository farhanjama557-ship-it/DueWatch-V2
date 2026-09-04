/**
 * M2H-CP1 Provider Lab harness.
 *
 * Not a test file: the name avoids *.test.mjs so the runner does not execute
 * it. It is the shared machinery every later connector checkpoint reuses, so
 * CP2/CP3/CP4 become "an adapter plus fixtures" rather than a new integration
 * each time.
 *
 * Everything is deterministic and local. No credentials, no network, no
 * provider SDK. The mock adapters exist to prove the HARNESS works; they are
 * explicitly not QuickBooks, Xero or Stripe mappings, and the evidence module
 * refuses to let anything observed here claim a live-observation class.
 */

import {
  PROVIDER_TRUTH_DIMENSION as T, CLAIM_SOURCE_OWNER as OWNER,
} from '../../src/lib/integrations/providerTruthModel.js'
import {
  createProviderObservation, interpretObservation,
} from '../../src/lib/integrations/providerObservation.js'
import {
  EVIDENCE_CLASS, OBSERVATION_ENVIRONMENT, recordEvidence,
} from '../../src/lib/integrations/providerEvidence.js'
import {
  FRESHNESS_STATE, invalidationScope, resolveFreshness,
} from '../../src/lib/integrations/providerFreshness.js'
import {
  admitProviderClaim, governingClaims,
} from '../../src/lib/integrations/providerContract.js'
import {
  COLLECTION_POLICY_DECISION, createCollectionDecisionContext,
} from '../../src/lib/integrations/collectionEligibility.js'

/** The documented CP1 seed, carried forward from prior adversarial work. */
export const PROVIDER_LAB_SEED = 829144

export const LAB_TENANT = 'tenant-lab-a'
export const LAB_TENANT_B = 'tenant-lab-b'
export const LAB_ACCOUNT = 'acct-lab-1'
export const LAB_ACCOUNT_B = 'acct-lab-2'
export const LAB_NOW = '2026-09-01T12:00:00Z'

export function seededRandom(seed = PROVIDER_LAB_SEED) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const pick = (random, values) => values[Math.floor(random() * values.length) % values.length]

// ── Mock adapters ────────────────────────────────────────────────────────────

/**
 * Two deliberately DISSIMILAR mock providers.
 *
 * They disagree about field names, casing, money units and status vocabulary,
 * exactly as real providers do. The differential harness must not require them
 * to look alike — only that DueWatch's interpretation lands in the same truth
 * dimension with the same meaning.
 */
export const MOCK_LEDGER_ADAPTER = Object.freeze({
  provider: 'mock_ledger',
  role: OWNER.LEDGER_SOURCE,
  /** Ledger-shaped payload: dollars as a number, "Balance" capitalised. */
  emit({ invoiceId, balance, status = 'OPEN' }) {
    return { Id: invoiceId, Balance: balance, DocStatus: status }
  },
  interpretFor(observation) {
    return {
      truthDimension: T.T1_INVOICE_AR_STATE,
      sourceOwner: OWNER.LEDGER_SOURCE,
      subject: observation.rawPayload.Id,
      value: { balance: observation.rawPayload.Balance, status: observation.rawPayload.DocStatus },
    }
  },
})

export const MOCK_PROCESSOR_ADAPTER = Object.freeze({
  provider: 'mock_processor',
  role: OWNER.PAYMENT_PROCESSOR,
  /** Processor-shaped payload: minor units, snake_case, different vocabulary. */
  emit({ invoiceId, amountMinor, state = 'succeeded' }) {
    return { id: `pi_${invoiceId}`, metadata: { invoice_ref: invoiceId }, amount_received: amountMinor, status: state }
  },
  interpretFor(observation) {
    const succeeded = observation.rawPayload.status === 'succeeded'
    return {
      // The distinction the whole model rests on: a successful attempt is a
      // RECEIPT, and a receipt is not an allocation against an invoice.
      truthDimension: succeeded ? T.T3_PAYMENT_RECEIPT_STATE : T.T2_PAYMENT_ATTEMPT_STATE,
      sourceOwner: OWNER.PAYMENT_PROCESSOR,
      subject: observation.rawPayload.metadata.invoice_ref,
      value: { received: observation.rawPayload.amount_received / 100, status: observation.rawPayload.status },
    }
  },
})

export const MOCK_COMMS_ADAPTER = Object.freeze({
  provider: 'mock_comms',
  role: OWNER.COMMUNICATION_SOURCE,
  emit({ invoiceId, body }) {
    return { message_id: `msg_${invoiceId}`, subject_ref: invoiceId, body }
  },
  interpretFor(observation) {
    return {
      // Deliberately NO truth dimension. A customer saying they paid is
      // evidence about the world, not a fact about the ledger.
      truthDimension: null,
      sourceOwner: OWNER.COMMUNICATION_SOURCE,
      subject: observation.rawPayload.subject_ref,
      value: { asserted: observation.rawPayload.body },
    }
  },
})

export const MOCK_ADAPTERS = Object.freeze([
  MOCK_LEDGER_ADAPTER, MOCK_PROCESSOR_ADAPTER, MOCK_COMMS_ADAPTER,
])

/** Observation + interpretation + admission, in the shape every adapter produces. */
export function observeThrough(adapter, {
  payload, tenantId = LAB_TENANT, providerAccountId = LAB_ACCOUNT,
  observedAt = LAB_NOW, eventId = null, deliveryId = null,
  objectType = 'object', externalObjectId = 'obj-1',
  // Freshness INPUTS, not a freshness result. A test-only way to hand in a
  // pre-made { state: 'FRESH' } would be a backdoor production code could
  // imitate, which is the defect this closes.
  freshnessContext = null, evidenceClass = EVIDENCE_CLASS.E0_HYPOTHESIS,
  // What this observation is offered as evidence FOR. Provider-neutral by
  // construction: the lab's adapters are mocks, so the default names the
  // scenario role rather than any provider.
  propositionKey = 'lab_observation_under_test',
} = {}) {
  const observation = createProviderObservation({
    tenantId, provider: adapter.provider, providerAccountId,
    objectType, externalObjectId, rawPayload: payload,
    observedAt, eventId, deliveryId,
    environment: OBSERVATION_ENVIRONMENT.MOCK,
  })
  const evidence = recordEvidence({
    evidenceClass, environment: OBSERVATION_ENVIRONMENT.MOCK,
    provider: adapter.provider, propositionKey,
    refs: [], note: 'Provider Lab mock adapter',
  })
  const interpretation = interpretObservation({
    observation, evidence, ...adapter.interpretFor(observation),
  })
  return {
    observation,
    interpretation,
    admitted: admitProviderClaim({
      // The expected provider comes from the adapter whose connection this is,
      // never from the observation being checked.
      tenantId, provider: adapter.provider, providerAccountId,
      observation, interpretation, evidence,
      freshness: resolveFreshness({
        observation, now: observedAt, maxAgeMs: 86_400_000,
        sourceAvailable: true, ...(freshnessContext ?? {}),
      }),
    }),
  }
}

/** Genuine T1 selection through the full local provider trust chain. */
export function governingLedgerSelection({
  balance = 1000, subject = 'inv-1', observedAt = LAB_NOW,
  freshnessContext = null, providerAccountId = LAB_ACCOUNT,
} = {}) {
  const { admitted } = observeThrough(MOCK_LEDGER_ADAPTER, {
    payload: MOCK_LEDGER_ADAPTER.emit({ invoiceId: subject, balance }),
    providerAccountId, observedAt, externalObjectId: subject,
    freshnessContext,
  })
  return governingClaims([admitted], T.T1_INVOICE_AR_STATE)
}

/** Every decision-sensitive context fact is explicitly known and favourable. */
export function knownSafeCollectionContext(overrides = {}) {
  return createCollectionDecisionContext({
    disputeActive: false,
    paymentInFlight: false,
    availableCredit: 0,
    unappliedValue: 0,
    sourceConflict: false,
    attributionKnown: true,
    policyDecision: COLLECTION_POLICY_DECISION.ALLOWED,
    ...overrides,
  })
}

// ── Canonical scenario corpus (provider-neutral) ─────────────────────────────

/**
 * Scenarios are described in DueWatch terms, never in provider field names.
 * That is what lets CP2 attach QuickBooks fixtures and CP3 attach Stripe
 * fixtures to the SAME scenario and compare interpretations.
 */
export const SCENARIOS = Object.freeze([
  { id: 'S001', name: 'simple open invoice',
    dimensions: [T.T1_INVOICE_AR_STATE], expectEligibility: 'ELIGIBLE', expectAuthorityEffect: 'NONE' },
  { id: 'S002', name: 'full payment',
    dimensions: [T.T1_INVOICE_AR_STATE, T.T3_PAYMENT_RECEIPT_STATE], expectEligibility: 'BLOCKED', expectAuthorityEffect: 'NONE' },
  { id: 'S003', name: 'partial payment',
    dimensions: [T.T1_INVOICE_AR_STATE, T.T3_PAYMENT_RECEIPT_STATE], expectEligibility: 'ELIGIBLE', expectAuthorityEffect: 'NONE' },
  { id: 'S004', name: 'payment attempt but no proven receipt',
    dimensions: [T.T2_PAYMENT_ATTEMPT_STATE], expectEligibility: 'HOLD', expectAuthorityEffect: 'NONE' },
  { id: 'S005', name: 'receipt present, allocation not yet reflected',
    dimensions: [T.T3_PAYMENT_RECEIPT_STATE, T.T4_PAYMENT_CREDIT_ALLOCATION_STATE], expectEligibility: 'REVIEW_REQUIRED', expectAuthorityEffect: 'NONE' },
  { id: 'S006', name: 'credit plus payment',
    dimensions: [T.T4_PAYMENT_CREDIT_ALLOCATION_STATE], expectEligibility: 'REVIEW_REQUIRED', expectAuthorityEffect: 'NONE' },
  { id: 'S007', name: 'available unapplied credit',
    dimensions: [T.T4_PAYMENT_CREDIT_ALLOCATION_STATE], expectEligibility: 'REVIEW_REQUIRED', expectAuthorityEffect: 'NONE' },
  { id: 'S008', name: 'provider disagreement across different dimensions',
    dimensions: [T.T1_INVOICE_AR_STATE, T.T3_PAYMENT_RECEIPT_STATE], expectContradiction: 'NO_CONTRADICTION', expectAuthorityEffect: 'NONE' },
  { id: 'S009', name: 'accounting source stale',
    dimensions: [T.T1_INVOICE_AR_STATE], expectFreshness: FRESHNESS_STATE.STALE, expectEligibility: 'HOLD', expectAuthorityEffect: 'NONE' },
  { id: 'S010', name: 'source unavailable',
    dimensions: [T.T1_INVOICE_AR_STATE], expectFreshness: FRESHNESS_STATE.SOURCE_UNAVAILABLE, expectEligibility: 'UNKNOWN', expectAuthorityEffect: 'NONE' },
  { id: 'S011', name: 'connection revoked',
    dimensions: [T.T1_INVOICE_AR_STATE], expectFreshness: FRESHNESS_STATE.SOURCE_UNAVAILABLE, expectEligibility: 'UNKNOWN', expectAuthorityEffect: 'NONE' },
  { id: 'S012', name: 'duplicate event', replay: 'duplicate', expectAuthorityEffect: 'NONE' },
  { id: 'S013', name: 'out-of-order event', replay: 'out_of_order', expectAuthorityEffect: 'NONE' },
  { id: 'S014', name: 'event retry after process failure', replay: 'retry', expectAuthorityEffect: 'NONE' },
  { id: 'S015', name: 'payment deleted / reversed',
    mutation: 'PAYMENT_DELETED', expectRefetch: ['payment', 'invoice', 'allocations', 'customer_unapplied_value'], expectAuthorityEffect: 'NONE' },
  { id: 'S016', name: 'refund without automatic AR reopen assumption',
    mutation: 'REFUND_ISSUED', expectRefetch: ['payment', 'invoice', 'allocations'], expectAuthorityEffect: 'NONE' },
  { id: 'S017', name: 'customer email claims payment but ledger remains open',
    dimensions: [T.T1_INVOICE_AR_STATE], expectEligibility: 'ELIGIBLE', expectAuthorityEffect: 'NONE' },
  { id: 'S018', name: 'dispute active',
    dimensions: [T.T3_PAYMENT_RECEIPT_STATE], expectEligibility: 'BLOCKED', expectAuthorityEffect: 'NONE' },
  { id: 'S019', name: 'wrong-tenant object collision',
    expectAdmission: 'REJECTED_TENANT', expectAuthorityEffect: 'NONE' },
  { id: 'S020', name: 'same-name client collision',
    expectAttributionKnown: false, expectEligibility: 'REVIEW_REQUIRED', expectAuthorityEffect: 'NONE' },
])

// ── Webhook replay engine ────────────────────────────────────────────────────

/**
 * A deterministic local replay harness.
 *
 * The property under test is NOT "every event is processed as truth". It is
 * that DueWatch converges: an event marks what it invalidated, and the
 * authoritative source is re-read. Arrival order is a delivery artefact, and a
 * system that lets it decide state will believe a retried old event over the
 * newer one it already had.
 */
export function createReplayEngine({
  tenantId = LAB_TENANT, provider = MOCK_LEDGER_ADAPTER.provider,
  providerAccountId = LAB_ACCOUNT,
} = {}) {
  // The EXPECTED connection context, fixed when the engine is created. Events
  // are checked against it; they never supply it.
  const expected = { tenantId, provider, providerAccountId }
  const seenDeliveries = new Set()
  const seenEvents = new Map()
  const log = []
  const refetchSet = new Set()
  let sequenceHighWater = -1

  return {
    /**
     * @param {object} event.deliveryId unique per delivery attempt
     * @param {object} event.eventId    stable per semantic event
     * @param {number} event.sequence   provider ordering, when it exposes one
     *
     * Every event must carry its full identity explicitly. There is no
     * fallback to the expected values: defaulting a missing tenant or provider
     * to "whatever we were hoping for" is the opposite of failing closed.
     */
    deliver(event = {}) {
      const { deliveryId, eventId, sequence = null, mutationType = null } = event

      // Scope is validated FIRST — before duplicate tracking, invalidation,
      // refetch accumulation or sequence movement — so a foreign event cannot
      // leave a mark on this connection's state.
      for (const field of ['tenantId', 'provider', 'providerAccountId']) {
        const supplied = event[field]
        if (typeof supplied !== 'string' || !supplied.trim() || supplied !== expected[field]) {
          log.push({ eventId, outcome: 'REJECTED_SCOPE', field })
          return { outcome: 'REJECTED_SCOPE', field, refetch: [...refetchSet] }
        }
      }

      // Same delivery twice is a transport retry: idempotent by delivery id.
      if (deliveryId && seenDeliveries.has(deliveryId)) {
        log.push({ eventId, outcome: 'DUPLICATE_DELIVERY' })
        return { outcome: 'DUPLICATE_DELIVERY', refetch: [...refetchSet] }
      }
      if (deliveryId) seenDeliveries.add(deliveryId)
      // Same semantic event under a NEW delivery id is still the same event.
      if (eventId && seenEvents.has(eventId)) {
        log.push({ eventId, outcome: 'DUPLICATE_EVENT' })
        return { outcome: 'DUPLICATE_EVENT', refetch: [...refetchSet] }
      }
      if (eventId) seenEvents.set(eventId, true)

      const scope = mutationType ? invalidationScope(mutationType) : null
      for (const target of scope?.refetch ?? []) refetchSet.add(target)

      // An out-of-order arrival still invalidates; it just does not get to
      // write state, because the refetch is what establishes truth.
      const stale = sequence != null && sequence < sequenceHighWater
      if (sequence != null) sequenceHighWater = Math.max(sequenceHighWater, sequence)

      const outcome = stale ? 'ACCEPTED_OUT_OF_ORDER' : 'ACCEPTED'
      log.push({ eventId, outcome, invalidated: scope?.dimensions ?? [] })
      return {
        outcome,
        invalidated: scope?.dimensions ?? [],
        refetch: [...refetchSet],
        // Nothing is believed until the authoritative read happens.
        stateWrittenFromEvent: false,
      }
    },

    /**
     * Applies the result of an authoritative read.
     *
     * An obligation clears only when a target was actually re-read
     * SUCCESSFULLY. The previous version cleared everything and returned
     * converged: true simply because it had been called, which modelled "we
     * intended to refetch" as "we now know the truth" — the exact confusion
     * the freshness model exists to prevent.
     */
    applyAuthoritativeRefetch({ targets = [], sourceAvailable = true } = {}) {
      // An unreachable source refreshes nothing, however many targets were
      // named for it.
      const refreshed = sourceAvailable
        ? targets.filter((target) => refetchSet.has(target))
        : []
      for (const target of refreshed) refetchSet.delete(target)
      return {
        refreshed: [...refreshed],
        sourceAvailable,
        pending: [...refetchSet],
        converged: refetchSet.size === 0,
      }
    },

    /** Where the connection stands. Calling it proves nothing on its own. */
    settle({ successfulRefetches = [], sourceAvailable = true } = {}) {
      const applied = this.applyAuthoritativeRefetch({
        targets: successfulRefetches, sourceAvailable,
      })
      return {
        refetched: applied.refreshed,
        pending: applied.pending,
        converged: applied.converged,
      }
    },
    get log() { return [...log] },
    get pendingRefetch() { return [...refetchSet] },
  }
}

// ── Adversarial company generator ────────────────────────────────────────────

/**
 * Deterministic generated companies. A failure is reproducible from its seed
 * alone, which is the only reason generated tests are worth having.
 */
export function generateAdversarialCompany(seed = PROVIDER_LAB_SEED) {
  const random = seededRandom(seed)
  const clientCount = 2 + Math.floor(random() * 3)
  const clients = Array.from({ length: clientCount }, (_, index) => ({
    id: `client-${index}`,
    // Same-name collisions are generated on purpose: they are the realistic
    // way attribution becomes unknown.
    name: pick(random, ['Atlas Ltd', 'Atlas Limited', 'Northwind', 'Northwind Inc']),
  }))
  const invoices = clients.flatMap((client, index) => {
    const count = 1 + Math.floor(random() * 2)
    return Array.from({ length: count }, (_, n) => ({
      id: `inv-${index}-${n}`,
      clientId: client.id,
      balance: Math.round(random() * 500000) / 100,
      disputeActive: random() > 0.85,
      paymentInFlight: random() > 0.7,
      availableCredit: random() > 0.8 ? Math.round(random() * 20000) / 100 : 0,
      ledgerStale: random() > 0.75,
      sourceAvailable: random() > 0.1,
    }))
  })
  const events = invoices.map((invoice, index) => ({
    deliveryId: `d-${index}`,
    eventId: `e-${index}`,
    sequence: index,
    mutationType: pick(random, ['PAYMENT_CREATED', 'INVOICE_UPDATED', 'PAYMENT_DELETED', 'UNRECOGNISED_THING']),
    invoiceId: invoice.id,
  }))
  return { seed, clients, invoices, events }
}

// ── Differential harness ─────────────────────────────────────────────────────

/**
 * Runs one provider-neutral scenario through several adapters and compares
 * DueWatch's INTERPRETATION, not the provider payloads.
 *
 * Providers are allowed to look nothing alike. What must agree is which truth
 * dimension the observation lands in, who owns the claim, and what it means.
 */
export function runDifferential({ adapters, buildPayload, expect }) {
  const results = adapters.map((adapter) => {
    const { interpretation } = observeThrough(adapter, {
      payload: buildPayload(adapter),
      externalObjectId: `diff-${adapter.provider}`,
    })
    return {
      provider: adapter.provider,
      truthDimension: interpretation.truthDimension,
      sourceOwner: interpretation.sourceOwner,
      subject: interpretation.subject,
      value: interpretation.value,
    }
  })
  const mismatches = results.filter((result) =>
    result.truthDimension !== expect.truthDimension ||
    result.subject !== expect.subject)
  return { results, agreed: mismatches.length === 0, mismatches }
}

// ── Ugly-scenario regression format ──────────────────────────────────────────

/**
 * The permanent home for a provider surprise. Every future "wait, QuickBooks
 * does WHAT?" becomes one of these, so nobody rediscovers it.
 */
export function uglyScenario(input = {}) {
  const need = (key) => {
    if (input[key] == null) throw new Error(`ugly scenario requires ${key}`)
    return input[key]
  }
  return Object.freeze({
    kind: 'M2H_UGLY_SCENARIO_V0',
    id: need('id'),
    initialState: need('initialState'),
    trigger: need('trigger'),
    observedProviderBehavior: need('observedProviderBehavior'),
    truthDimensionsAffected: Object.freeze([...need('truthDimensionsAffected')]),
    dangerousInterpretation: need('dangerousInterpretation'),
    correctInterpretation: need('correctInterpretation'),
    requiredInvalidation: Object.freeze([...need('requiredInvalidation')]),
    collectionEligibility: need('collectionEligibility'),
    evidence: need('evidence'),
    canonicalInvariantTested: need('canonicalInvariantTested'),
  })
}

/** Raw fixture envelope. Sanitisation is a required field, not a convention. */
export function providerFixture(input = {}) {
  const need = (key) => {
    if (input[key] == null) throw new Error(`provider fixture requires ${key}`)
    return input[key]
  }
  const payload = JSON.stringify(input.payload ?? {})
  for (const secret of ['access_token', 'refresh_token', 'client_secret', 'signing_secret', 'authorization']) {
    if (payload.toLowerCase().includes(secret)) {
      throw new Error(`fixture appears to contain ${secret}: refusing to store provider credentials`)
    }
  }
  return Object.freeze({
    kind: 'M2H_PROVIDER_FIXTURE_V0',
    provider: need('provider'),
    objectOrEventType: need('objectOrEventType'),
    accountAnonymization: need('accountAnonymization'),
    capturedAt: need('capturedAt'),
    apiVersion: input.apiVersion ?? null,
    fixtureVersion: need('fixtureVersion'),
    evidenceClass: need('evidenceClass'),
    sanitizationStatement: need('sanitizationStatement'),
    expectedInterpretation: need('expectedInterpretation'),
    payload: input.payload ?? {},
  })
}
