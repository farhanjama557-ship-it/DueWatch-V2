/**
 * M2H-CP1 final closure — the local trust boundary, applied consistently.
 *
 * The evidence modules learned that a public field is not provenance. The rest
 * of the kernel had not: an observation was trusted for carrying the right
 * `kind`, an interpretation for carrying a matching id and hash, freshness for
 * saying `FRESH`, a claim for saying `admitted: true`, and the replay engine
 * defaulted a missing tenant or provider to whatever it was hoping for.
 *
 * Each of those let a caller skip the check that protects a founder's
 * customers. The freshness one is the sharpest: `{ state: 'FRESH' }` is eight
 * words, and it turned an unreachable ledger into a governing one.
 *
 * The rule, applied everywhere here:
 *
 *   THIS EXACT LOCAL OBJECT PASSED THE CONSTRUCTOR OR RESOLVER THAT OWNS IT.
 *
 * And its limit, stated rather than blurred: that is a fact about this
 * process, not about the world. External origin is CP2+/CP6.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createProviderObservation, interpretObservation, reinterpret,
  isConstructedProviderObservation, interpretationBelongsToObservation,
} from '../../src/lib/integrations/providerObservation.js'
import {
  FRESHNESS_STATE, resolveFreshness, isResolvedFreshness, freshnessBelongsToObservation,
} from '../../src/lib/integrations/providerFreshness.js'
import {
  PROVIDER_CLAIM_ADMISSION, admitProviderClaim, governingClaims,
} from '../../src/lib/integrations/providerContract.js'
import {
  PROVIDER_TRUTH_DIMENSION as T, CLAIM_SOURCE_OWNER as OWNER,
} from '../../src/lib/integrations/providerTruthModel.js'

import {
  LAB_TENANT, LAB_TENANT_B, LAB_ACCOUNT, LAB_ACCOUNT_B, LAB_NOW,
  MOCK_LEDGER_ADAPTER, MOCK_PROCESSOR_ADAPTER, createReplayEngine,
} from './harness.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PROVIDER = 'mock_ledger'

const observationInput = (overrides = {}) => ({
  tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
  objectType: 'Invoice', externalObjectId: 'inv-1', observedAt: LAB_NOW,
  rawPayload: { Id: 'inv-1', Balance: 1000 }, ...overrides,
})
const genuineObservation = (overrides = {}) => createProviderObservation(observationInput(overrides))
const genuineInterpretation = (observation) => interpretObservation({
  observation, truthDimension: T.T1_INVOICE_AR_STATE, sourceOwner: OWNER.LEDGER_SOURCE,
  subject: 'inv-1', value: { balance: 1000 },
})
const freshFor = (observation) => resolveFreshness({
  observation, now: LAB_NOW, maxAgeMs: 86_400_000,
})
/** A plain object wearing the full public observation shape. */
const forgedObservation = () => ({
  kind: 'M2H_PROVIDER_OBSERVATION_V0', ...observationInput(),
  eventId: null, deliveryId: null, providerTimestamp: null, apiVersion: null,
  environment: 'MOCK', rawHash: 'deadbeef', id: 'obs:mock_ledger:inv-1:deadbeef',
})

// ── 1-3 — observation constructor provenance ─────────────────────────────────

test('1 a forged observation shape cannot be interpreted', () => {
  assert.throws(() => interpretObservation({
    observation: forgedObservation(), truthDimension: T.T1_INVOICE_AR_STATE,
    sourceOwner: OWNER.LEDGER_SOURCE, subject: 'inv-1',
  }), /createProviderObservation/)
  assert.equal(isConstructedProviderObservation(forgedObservation()), false)
})

test('2 a spread copy of a genuine observation cannot be interpreted', () => {
  const genuine = genuineObservation()
  const copy = { ...genuine }
  assert.deepEqual(copy, genuine, 'the copy is field-identical')
  assert.throws(() => interpretObservation({
    observation: copy, truthDimension: T.T1_INVOICE_AR_STATE,
    sourceOwner: OWNER.LEDGER_SOURCE, subject: 'inv-1',
  }), /createProviderObservation/)
})

test('3 a genuine observation still interprets', () => {
  const observation = genuineObservation()
  assert.equal(isConstructedProviderObservation(observation), true)
  const interpretation = genuineInterpretation(observation)
  assert.equal(interpretationBelongsToObservation(interpretation, observation), true)
})

// ── 4-7 — interpretation provenance and exact binding ────────────────────────

test('4 a forged interpretation is refused at admission', () => {
  const observation = genuineObservation()
  const forged = {
    kind: 'M2H_PROVIDER_INTERPRETATION_V0',
    observationId: observation.id, observationHash: observation.rawHash,
    tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
    truthDimension: T.T1_INVOICE_AR_STATE, sourceOwner: OWNER.LEDGER_SOURCE,
    subject: 'inv-1', value: { balance: 0 },
  }
  const result = admitProviderClaim({
    tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
    observation, interpretation: forged, freshness: freshFor(observation),
  })
  assert.equal(result.admitted, false)
  assert.equal(result.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_UNCONSTRUCTED)
})

test('5 a spread copy of a genuine interpretation is refused', () => {
  const observation = genuineObservation()
  const interpretation = genuineInterpretation(observation)
  const result = admitProviderClaim({
    tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
    observation, interpretation: { ...interpretation }, freshness: freshFor(observation),
  })
  assert.equal(result.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_UNCONSTRUCTED)
})

test('6 an interpretation transplanted onto another observation is refused', () => {
  // Both genuine; the interpretation simply was not made from this one. Public
  // ids and hashes cannot express that, which is why the binding is by object.
  const first = genuineObservation()
  const second = genuineObservation({ externalObjectId: 'inv-2' })
  const interpretation = genuineInterpretation(first)
  assert.equal(interpretationBelongsToObservation(interpretation, second), false)
  const result = admitProviderClaim({
    tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
    observation: second, interpretation, freshness: freshFor(second),
  })
  assert.equal(result.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_UNCONSTRUCTED)
})

test('6b an identical TWIN observation does not inherit the binding', () => {
  // The case that distinguishes object binding from id comparison: two genuine
  // observations built from identical input share an id and a rawHash, because
  // both are derived from content. They are still two different observations,
  // and an interpretation belongs to exactly one of them.
  const first = genuineObservation()
  const twin = genuineObservation()
  assert.equal(twin.id, first.id, 'identical content yields an identical id')
  assert.equal(twin.rawHash, first.rawHash)
  assert.notEqual(twin, first)
  const interpretation = genuineInterpretation(first)
  assert.equal(interpretationBelongsToObservation(interpretation, twin), false,
    'a matching id is not a binding')
  assert.equal(admitProviderClaim({
    tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
    observation: twin, interpretation, freshness: freshFor(twin),
  }).admission, PROVIDER_CLAIM_ADMISSION.REJECTED_UNCONSTRUCTED)
})

test('4b a forged observation is named as the reason, before the interpretation', () => {
  // The diagnoses differ and both matter: "this observation is not ours" is a
  // different problem from "this interpretation is not of that observation".
  const result = admitProviderClaim({
    tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
    observation: forgedObservation(),
    interpretation: genuineInterpretation(genuineObservation()),
  })
  assert.equal(result.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_UNCONSTRUCTED)
  assert.match(result.reason, /observation was not produced/i)
})

test('12b a genuine REJECTED result is recognised, not counted as untrusted', () => {
  // Rejections are registered too. A caller passing its whole result list —
  // admitted and rejected alike — must not be told half of it was foreign.
  const observation = genuineObservation()
  const rejected = admitProviderClaim({
    tenantId: LAB_TENANT_B, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
    observation, interpretation: genuineInterpretation(observation),
    freshness: freshFor(observation),
  })
  assert.equal(rejected.admitted, false)
  const governed = governingClaims([rejected], T.T1_INVOICE_AR_STATE)
  assert.equal(governed.untrustedInputs, 0, 'a real rejection is a known result')
  assert.deepEqual(governed.governing, [])
  assert.equal(governed.complete, true)
})

test('7 reinterpret refuses an unconstructed interpretation, and keeps the binding', () => {
  const observation = genuineObservation()
  const interpretation = genuineInterpretation(observation)
  assert.throws(() => reinterpret({ ...interpretation }, { value: { balance: 0 } }),
    /interpretObservation/)
  const replacement = reinterpret(interpretation, { value: { balance: 400 } })
  assert.equal(interpretationBelongsToObservation(replacement, observation), true)
  assert.equal(admitProviderClaim({
    tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
    observation, interpretation: replacement, freshness: freshFor(observation),
  }).admitted, true)
})

// ── 8-11 — freshness must come from the resolver, for this observation ───────

test('8 a hand-written FRESH object is refused', () => {
  const observation = genuineObservation()
  const interpretation = genuineInterpretation(observation)
  for (const freshness of [
    { state: FRESHNESS_STATE.FRESH },
    { state: FRESHNESS_STATE.FRESH, mayGovern: true },
    // Even declaring it non-governing is still a caller-authored verdict.
    { state: FRESHNESS_STATE.FRESH, mayGovern: false },
  ]) {
    const result = admitProviderClaim({
      tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
      observation, interpretation, freshness,
    })
    assert.equal(result.admitted, false, JSON.stringify(freshness))
    assert.equal(result.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_FRESHNESS_NOT_RESOLVED)
  }
})

test('9 a genuine FRESH result for ANOTHER observation is refused', () => {
  const observation = genuineObservation()
  const other = genuineObservation({ externalObjectId: 'inv-2' })
  const interpretation = genuineInterpretation(observation)
  const freshness = freshFor(other)
  assert.equal(isResolvedFreshness(freshness), true, 'genuinely resolved')
  assert.equal(freshnessBelongsToObservation(freshness, observation), false)
  assert.equal(admitProviderClaim({
    tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
    observation, interpretation, freshness,
  }).admission, PROVIDER_CLAIM_ADMISSION.REJECTED_FRESHNESS_NOT_RESOLVED)
})

test('10 a genuinely resolved FRESH result is accepted and governs', () => {
  const observation = genuineObservation()
  const interpretation = genuineInterpretation(observation)
  const result = admitProviderClaim({
    tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
    observation, interpretation, freshness: freshFor(observation),
  })
  assert.equal(result.admitted, true, result.reason ?? '')
  assert.equal(governingClaims([result], T.T1_INVOICE_AR_STATE).governing.length, 1)
})

test('11 a genuinely resolved STALE result is admitted but never governs', () => {
  const observation = genuineObservation({ observedAt: '2020-01-01T00:00:00Z' })
  const interpretation = genuineInterpretation(observation)
  const freshness = resolveFreshness({ observation, now: LAB_NOW, maxAgeMs: 1000 })
  assert.equal(freshness.state, FRESHNESS_STATE.STALE)
  const result = admitProviderClaim({
    tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
    observation, interpretation, freshness,
  })
  assert.equal(result.admitted, true)
  const governed = governingClaims([result], T.T1_INVOICE_AR_STATE)
  assert.equal(governed.governing.length, 0)
  assert.equal(governed.withheld.length, 1)
})

// ── 12-14 — governing claims come only from real admissions ──────────────────

test('12 a forged admitted:true claim cannot govern, and is reported', () => {
  const forged = {
    kind: 'M2H_PROVIDER_CLAIM_V0', admitted: true,
    admission: PROVIDER_CLAIM_ADMISSION.ADMITTED, reason: null,
    claim: {
      tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
      truthDimension: T.T1_INVOICE_AR_STATE, sourceOwner: OWNER.LEDGER_SOURCE,
      subject: 'inv-1', value: { balance: 0 },
      freshness: { state: FRESHNESS_STATE.FRESH, mayGovern: true },
      writesCanonicalMoney: false, grantsAuthority: false,
    },
  }
  const governed = governingClaims([forged], T.T1_INVOICE_AR_STATE)
  assert.deepEqual(governed.governing, [])
  assert.equal(governed.untrustedInputs, 1)
  // Not silently dropped: the caller's list was not what it thought it was.
  assert.equal(governed.complete, false)
})

test('13 a spread copy of a genuine admitted result cannot govern', () => {
  const observation = genuineObservation()
  const result = admitProviderClaim({
    tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT,
    observation, interpretation: genuineInterpretation(observation),
    freshness: freshFor(observation),
  })
  assert.equal(result.admitted, true)
  const governed = governingClaims([{ ...result }], T.T1_INVOICE_AR_STATE)
  assert.deepEqual(governed.governing, [])
  assert.equal(governed.untrustedInputs, 1)
})

test('14 the full tuple plus resolved freshness is what actually governs', () => {
  const observation = genuineObservation()
  const interpretation = genuineInterpretation(observation)
  const base = { observation, interpretation, freshness: freshFor(observation) }
  // Every leg of the tuple still refuses on its own.
  assert.equal(admitProviderClaim({ ...base, tenantId: LAB_TENANT_B, provider: PROVIDER, providerAccountId: LAB_ACCOUNT }).admission,
    PROVIDER_CLAIM_ADMISSION.REJECTED_TENANT)
  assert.equal(admitProviderClaim({ ...base, tenantId: LAB_TENANT, provider: 'mock_processor', providerAccountId: LAB_ACCOUNT }).admission,
    PROVIDER_CLAIM_ADMISSION.REJECTED_PROVIDER)
  assert.equal(admitProviderClaim({ ...base, tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT_B }).admission,
    PROVIDER_CLAIM_ADMISSION.REJECTED_PROVIDER_ACCOUNT)
  assert.equal(admitProviderClaim({ ...base, tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT }).admitted, true)
})

// ── 15-19 — the replay engine is connection-scoped ───────────────────────────

const connection = { tenantId: LAB_TENANT, provider: PROVIDER, providerAccountId: LAB_ACCOUNT }
const identified = (extra = {}) => ({ ...connection, ...extra })

test('15-18 wrong or missing replay identity fails closed on every field', () => {
  const cases = [
    ['wrong tenant', identified({ tenantId: LAB_TENANT_B })],
    ['wrong provider', identified({ provider: 'mock_processor' })],
    ['wrong provider account', identified({ providerAccountId: LAB_ACCOUNT_B })],
    ['missing tenant', { provider: PROVIDER, providerAccountId: LAB_ACCOUNT }],
    ['missing provider', { tenantId: LAB_TENANT, providerAccountId: LAB_ACCOUNT }],
    ['missing provider account', { tenantId: LAB_TENANT, provider: PROVIDER }],
    ['empty provider', identified({ provider: '  ' })],
  ]
  for (const [label, identity] of cases) {
    const engine = createReplayEngine(connection)
    const result = engine.deliver({
      deliveryId: 'd1', eventId: 'e1', sequence: 1,
      mutationType: 'PAYMENT_DELETED', ...identity,
    })
    assert.equal(result.outcome, 'REJECTED_SCOPE', label)
    // Rejected before anything is accumulated.
    assert.deepEqual(engine.pendingRefetch, [], label)
  }
})

test('18b the same account id under another provider is not sufficient', () => {
  const engine = createReplayEngine(connection)
  assert.equal(engine.deliver({
    deliveryId: 'd1', eventId: 'e1', tenantId: LAB_TENANT,
    provider: MOCK_PROCESSOR_ADAPTER.provider, providerAccountId: LAB_ACCOUNT,
    mutationType: 'PAYMENT_DELETED',
  }).outcome, 'REJECTED_SCOPE')
})

test('19 duplicate tracking runs only after scope validation', () => {
  const engine = createReplayEngine(connection)
  // A foreign event carrying a delivery id we will legitimately use later.
  engine.deliver({ deliveryId: 'd1', eventId: 'e1', ...identified({ tenantId: LAB_TENANT_B }) })
  // The real event with the same ids must NOT be treated as a duplicate.
  const real = engine.deliver({
    deliveryId: 'd1', eventId: 'e1', ...connection, mutationType: 'INVOICE_UPDATED',
  })
  assert.equal(real.outcome, 'ACCEPTED')
})

// ── 20-23 — settlement requires an authoritative read ────────────────────────

test('20 calling settle with no successful refetch does not converge', () => {
  const engine = createReplayEngine(connection)
  engine.deliver({ deliveryId: 'd1', eventId: 'e1', ...connection, mutationType: 'PAYMENT_DELETED' })
  const settled = engine.settle()
  assert.equal(settled.converged, false)
  assert.equal(settled.pending.length, 4)
  assert.deepEqual(settled.refetched, [])
})

test('21 an unavailable source clears no obligation', () => {
  const engine = createReplayEngine(connection)
  engine.deliver({ deliveryId: 'd1', eventId: 'e1', ...connection, mutationType: 'PAYMENT_DELETED' })
  const settled = engine.settle({
    successfulRefetches: ['payment', 'invoice', 'allocations', 'customer_unapplied_value'],
    sourceAvailable: false,
  })
  assert.equal(settled.converged, false)
  assert.equal(settled.pending.length, 4)
})

test('22 a partial refetch leaves the remaining obligation', () => {
  const engine = createReplayEngine(connection)
  engine.deliver({ deliveryId: 'd1', eventId: 'e1', ...connection, mutationType: 'PAYMENT_DELETED' })
  const settled = engine.settle({ successfulRefetches: ['payment', 'invoice'] })
  assert.equal(settled.converged, false)
  assert.deepEqual([...settled.pending].sort(), ['allocations', 'customer_unapplied_value'])
  assert.deepEqual([...settled.refetched].sort(), ['invoice', 'payment'])
})

test('23 a complete successful refetch converges', () => {
  const engine = createReplayEngine(connection)
  engine.deliver({ deliveryId: 'd1', eventId: 'e1', ...connection, mutationType: 'PAYMENT_DELETED' })
  const settled = engine.settle({
    successfulRefetches: ['payment', 'invoice', 'allocations', 'customer_unapplied_value'],
  })
  assert.equal(settled.converged, true)
  assert.deepEqual(settled.pending, [])
})

// ── The limits of a local mechanism, stated ──────────────────────────────────

test('the registries are private and the process-bound limit is documented', () => {
  for (const relative of [
    'src/lib/integrations/providerObservation.js',
    'src/lib/integrations/providerFreshness.js',
    'src/lib/integrations/providerContract.js',
  ]) {
    const source = readFileSync(path.join(repoRoot, relative), 'utf8')
    assert.equal(/export\s+(const|let)\s+\w*(CONSTRUCTED|_TO_)/i.test(source), false,
      `${relative} exports a registry`)
    assert.ok(/WeakSet|WeakMap/.test(source), relative)
  }
  const observation = readFileSync(
    path.join(repoRoot, 'src/lib/integrations/providerObservation.js'), 'utf8')
  // The honest statement of what a local WeakSet cannot do.
  assert.ok(/NOT that the provider sent anything|does NOT prove/i.test(observation))
  assert.ok(/CP6/.test(observation), 'the rehydration boundary must be named as future work')
  assert.ok(/serialisation|serialization/i.test(observation),
    'membership not surviving serialisation must be recorded')
})

test('hashes are identifiers, never authentication', () => {
  // rawHash stays a deterministic checksum: useful as a durable reference,
  // powerless as provenance. Two observations of identical content share it.
  const a = genuineObservation()
  const b = genuineObservation()
  assert.equal(a.rawHash, b.rawHash)
  assert.notEqual(a, b)
  // And an object carrying that hash is still not an observation.
  assert.equal(isConstructedProviderObservation({ ...a }), false)
})
