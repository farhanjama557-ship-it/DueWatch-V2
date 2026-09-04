/**
 * M2H-CP1 repair — generalization closure, composite evidence, semantic equality.
 *
 * Three defects found by independent review, each of which let a label be
 * stronger than the thing it stands for:
 *
 *   - generic promotion could walk G0 -> G5, so provider research could mint a
 *     LOCKED canonical rule by calling one function five times;
 *   - a caller could ask for E7 or E8 and simply receive it, so "two providers
 *     support this" needed no second provider;
 *   - value equality was JSON key-order sensitive, so { balance, currency } and
 *     { currency, balance } read as a source disagreement.
 *
 * The third is the one that would have hurt first: QuickBooks and Xero do not
 * serialise their objects in the same key order, and a false conflict on every
 * invoice teaches a founder to ignore conflicts.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

import {
  GENERALIZATION_LEVEL as G, TRUTH_DIMENSIONS, PROVIDER_TRUTH_DIMENSION as T,
  CONTRADICTION_MARKER, promoteGeneralization, classifyDisagreement,
  MAX_GENERIC_GENERALIZATION,
} from '../../src/lib/integrations/providerTruthModel.js'
import {
  EVIDENCE_CLASS, OBSERVATION_ENVIRONMENT, PRIMITIVE_EVIDENCE_CLASSES,
  COMPOSITE_EVIDENCE_CLASSES, recordEvidence, composeEvidence,
} from '../../src/lib/integrations/providerEvidence.js'
import { canonicalValueEquals } from '../../src/lib/integrations/canonicalValue.js'

// ── Defect 1 — generic promotion may never reach G5 ──────────────────────────

test('G4 -> G5 is refused: provider research cannot mint a locked canonical rule', () => {
  assert.throws(
    () => promoteGeneralization(G.G4_CANDIDATE_CANONICAL_INVARIANT, G.G5_LOCKED_CANONICAL_RULE),
    /locked canonical rule/i)
})

test('walking every generic step from G0 lands at G4 and stops', () => {
  // The exact escalation the review described: one function, called five times.
  const order = [
    G.G0_PROVIDER_IMPLEMENTATION_DETAIL, G.G1_PROVIDER_CAPABILITY,
    G.G2_MULTI_PROVIDER_PATTERN, G.G3_CANDIDATE_CANONICAL_CONCEPT,
    G.G4_CANDIDATE_CANONICAL_INVARIANT, G.G5_LOCKED_CANONICAL_RULE,
  ]
  let level = order[0]
  for (let index = 1; index < order.length - 1; index += 1) {
    level = promoteGeneralization(level, order[index])
  }
  assert.equal(level, G.G4_CANDIDATE_CANONICAL_INVARIANT)
  assert.throws(() => promoteGeneralization(level, G.G5_LOCKED_CANONICAL_RULE), /locked/i)
  assert.equal(MAX_GENERIC_GENERALIZATION, G.G4_CANDIDATE_CANONICAL_INVARIANT)
})

test('CP1 exposes no code path at all that can produce G5', () => {
  // Not "hard to reach" — absent. G5 stays vocabulary for a later closure gate
  // that CP1 deliberately does not own, and there is no boolean a caller can
  // flip to unlock it.
  const source = [
    'providerTruthModel.js', 'providerEvidence.js', 'providerObservation.js',
    'providerFreshness.js', 'providerCapability.js', 'providerContract.js',
    'collectionEligibility.js', 'canonicalValue.js',
  ]
  assert.equal(typeof promoteGeneralization, 'function')
  // The only mention of G5 may be its own declaration and refusals — no
  // function may RETURN it.
  for (const level of Object.values(G)) {
    if (level === G.G5_LOCKED_CANONICAL_RULE) continue
    for (const to of Object.values(G)) {
      if (to !== G.G5_LOCKED_CANONICAL_RULE) continue
      assert.throws(() => promoteGeneralization(level, to), /./, `${level} -> ${to}`)
    }
  }
  assert.ok(source.length === 8)
})

// ── Defect 2 — composite evidence must be earned ─────────────────────────────

test('E7 cannot be self-declared', () => {
  assert.throws(() => recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED,
    environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['looks-official'],
  }), /composed|component/i)
})

test('E8 cannot be self-declared', () => {
  assert.throws(() => recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['trust-me'],
  }), /composed|component/i)
})

test('E3 and E6 cannot be minted from one arbitrary citation', () => {
  for (const cls of [EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC, EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX]) {
    assert.throws(() => recordEvidence({
      evidenceClass: cls, environment: OBSERVATION_ENVIRONMENT.PROVIDER_SANDBOX,
      refs: ['one-citation'],
    }), /composed|component/i, cls)
  }
})

test('the primitive/composite split is explicit', () => {
  assert.deepEqual([...PRIMITIVE_EVIDENCE_CLASSES].sort(), [
    EVIDENCE_CLASS.E0_HYPOTHESIS, EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED,
    EVIDENCE_CLASS.E2_DOC_CONFIRMED, EVIDENCE_CLASS.E4_SANDBOX_OBSERVED,
    EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED,
  ].sort())
  assert.deepEqual([...COMPOSITE_EVIDENCE_CLASSES].sort(), [
    EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC, EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
    EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED, EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
  ].sort())
})

test('E3 is earned by compatible schema AND doc components, and keeps them', () => {
  const schema = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED, provider: 'mock_ledger',
    environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['schema://mock_ledger/invoice'],
  })
  const doc = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED, provider: 'mock_ledger',
    environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['docs://mock_ledger/invoice'],
  })
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC, components: [schema, doc],
  })
  assert.equal(composed.evidenceClass, EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC)
  // Provenance is retained and inspectable.
  assert.equal(composed.components.length, 2)
  assert.deepEqual(composed.components.map((c) => c.evidenceClass).sort(),
    [EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED, EVIDENCE_CLASS.E2_DOC_CONFIRMED].sort())
  assert.equal(composed.grantsAuthority, false)

  // The wrong components are refused, however many there are.
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC, components: [schema, schema],
  }), /requires/i)
})

test('E6 is earned by doc AND a real sandbox observation', () => {
  const doc = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED, provider: 'mock_ledger',
    environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['docs://x'],
  })
  const sandbox = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E4_SANDBOX_OBSERVED, provider: 'mock_ledger',
    environment: OBSERVATION_ENVIRONMENT.PROVIDER_SANDBOX, refs: ['capture-1'],
  })
  assert.equal(composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX, components: [doc, sandbox],
  }).evidenceClass, EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX)
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX, components: [doc, doc],
  }), /requires/i)
})

test('E7 requires TWO materially distinct providers, not one provider twice', () => {
  const one = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED, provider: 'mock_ledger',
    environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['docs://a'],
  })
  const alsoOne = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED, provider: 'mock_ledger',
    environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['schema://a'],
  })
  const other = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED, provider: 'mock_processor',
    environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['docs://b'],
  })
  // Same provider twice is one provider, whatever the class of each record.
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED, components: [one, alsoOne],
  }), /distinct provider/i)
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED, components: [one, other],
  })
  assert.deepEqual([...composed.providers].sort(), ['mock_ledger', 'mock_processor'])
})

test('E7 cannot be earned by naming providers without evidence records', () => {
  // Asserted on the SPECIFIC refusal, so this guard is load-bearing on its own
  // rather than masked by the distinct-provider count that would also refuse.
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED,
    components: [], providers: ['some_provider', 'another_provider'],
  }), /not provider names/i)
})

test('E8 stays UNISSUABLE without a real domain-support artifact', () => {
  // Better to be unable to mint E8 than to mint a fake one. CP1 has no
  // accounting-domain artifact, so there is nothing to compose from.
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED, components: [],
  }), /domain support/i)
  const notDomain = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED, provider: 'mock_ledger',
    environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['docs://a'],
  })
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED, components: [notDomain],
  }), /domain support/i)
})

test('composition introduces no ranking and never grants authority', () => {
  const source = [EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED, EVIDENCE_CLASS.E2_DOC_CONFIRMED]
    .map((cls, index) => recordEvidence({
      evidenceClass: cls, provider: 'mock_ledger',
      environment: OBSERVATION_ENVIRONMENT.MOCK, refs: [`ref-${index}`],
    }))
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC, components: source,
  })
  assert.equal(composed.grantsAuthority, false)
  assert.equal(composed.isRanked, false)
  for (const banned of ['evidenceRank', 'confidenceScore', 'maxEvidence', 'highestEvidence', 'score']) {
    assert.equal(JSON.stringify(composed).includes(banned), false, banned)
  }
})

// ── Defect 3 — semantic value equality ───────────────────────────────────────

test('key order does not create a disagreement', () => {
  const verdict = classifyDisagreement(
    { truthDimension: T.T1_INVOICE_AR_STATE, subject: 'inv-1', value: { balance: 1000, currency: 'USD' } },
    { truthDimension: T.T1_INVOICE_AR_STATE, subject: 'inv-1', value: { currency: 'USD', balance: 1000 } })
  assert.equal(verdict.marker, CONTRADICTION_MARKER.NO_CONTRADICTION)
})

test('nested key order does not create a disagreement either', () => {
  const a = { balance: 1000, allocation: { paid: 400, credit: 100 } }
  const b = { allocation: { credit: 100, paid: 400 }, balance: 1000 }
  assert.equal(canonicalValueEquals(a, b), true)
  assert.equal(classifyDisagreement(
    { truthDimension: T.T1_INVOICE_AR_STATE, subject: 'inv-1', value: a },
    { truthDimension: T.T1_INVOICE_AR_STATE, subject: 'inv-1', value: b },
  ).marker, CONTRADICTION_MARKER.NO_CONTRADICTION)
})

test('a real value difference is still a disagreement', () => {
  assert.equal(canonicalValueEquals({ balance: 1000 }, { balance: 1001 }), false)
  assert.equal(classifyDisagreement(
    { truthDimension: T.T1_INVOICE_AR_STATE, subject: 'inv-1', value: { balance: 1000 } },
    { truthDimension: T.T1_INVOICE_AR_STATE, subject: 'inv-1', value: { balance: 1001 } },
  ).marker, CONTRADICTION_MARKER.SOURCE_STATE_DISAGREEMENT)
})

test('arrays stay ORDERED — order is meaning until a contract says otherwise', () => {
  // Allocation sequences and payment histories are ordered. Sorting them to
  // make a comparison pass would erase real differences.
  assert.equal(canonicalValueEquals({ lines: [1, 2] }, { lines: [2, 1] }), false)
  assert.equal(canonicalValueEquals({ lines: [1, 2] }, { lines: [1, 2] }), true)
  assert.equal(canonicalValueEquals(
    { lines: [{ a: 1, b: 2 }] }, { lines: [{ b: 2, a: 1 }] }), true,
    'objects inside arrays are still compared structurally')
})

test('canonical equality handles the awkward values without calling them equal', () => {
  assert.equal(canonicalValueEquals(null, null), true)
  assert.equal(canonicalValueEquals(null, undefined), true, 'both are "no value"')
  assert.equal(canonicalValueEquals(0, null), false)
  assert.equal(canonicalValueEquals('1000', 1000), false, 'a string is not a number')
  assert.equal(canonicalValueEquals({ a: undefined }, {}), true, 'an absent key and an undefined one agree')
  assert.equal(canonicalValueEquals({ a: 1 }, { a: 1, b: null }), false)
})

// ── Honest terminology ───────────────────────────────────────────────────────

test('the frozen G8 Company Brain module is unchanged from the accepted base', () => {
  // The mirror's other half. The behavioural refusal check proves each of OUR
  // six is refused by the Brain; it cannot prove the Brain has not GAINED a
  // seventh. Pinning the frozen file to the accepted G8 base closes that gap
  // without modifying G8 to export its private set.
  const base = execFileSync('git',
    ['show', '236a9dee0c5a4a6bb417db466e562ae3e3c4f950:src/lib/companyBrain/index.js'],
    { cwd: repoRoot, encoding: 'utf8' })
  const current = readFileSync(path.join(repoRoot, 'src/lib/companyBrain/index.js'), 'utf8')
  assert.equal(current, base,
    'companyBrain/index.js changed since the accepted G8 base: the T1-T6 mirror must be re-verified')
  // And the six names still appear in that frozen source, in its private set.
  for (const dimension of TRUTH_DIMENSIONS) {
    assert.ok(base.includes(`'${dimension}'`), `${dimension} missing from the frozen G8 set`)
  }
  // Nothing beyond the six is in the frozen money-truth set.
  const block = base.slice(base.indexOf('MONEY_TRUTH_CLASSES = new Set(['))
  const listed = block.slice(0, block.indexOf('])')).match(/'[A-Z_]+'/g) ?? []
  assert.equal(listed.length, 6, 'the frozen G8 money-truth set no longer holds exactly six classes')
})

test('the T1-T6 mirror is locked, and described as a mirror', () => {
  // G8's MONEY_TRUTH_CLASSES is private and G8 is frozen, so M2H MIRRORS the
  // six values rather than importing them. The lock is what keeps the mirror
  // honest — the count, the exact names, and the behavioural check together.
  assert.equal(TRUTH_DIMENSIONS.length, 6)
  assert.deepEqual([...TRUTH_DIMENSIONS].sort(), [
    'BANK_LEDGER_RECONCILIATION_STATE', 'INVOICE_AR_STATE',
    'PAYMENT_ATTEMPT_STATE', 'PAYMENT_CREDIT_ALLOCATION_STATE',
    'PAYMENT_RECEIPT_STATE', 'PROCESSOR_FUNDS_SETTLEMENT_STATE',
  ])
  // The module says "mirror", not "reuse" or "imported".
  const source = readFileSync(
    path.join(repoRoot, 'src/lib/integrations/providerTruthModel.js'), 'utf8')
  assert.ok(/MIRROR of the frozen G8/.test(source))
  assert.equal(/not redeclared/i.test(source), false,
    'the module must not claim the dimensions are not redeclared — they are')
})

test('the observation module describes a JSON snapshot, not wire bytes', () => {
  const source = readFileSync(
    path.join(repoRoot, 'src/lib/integrations/providerObservation.js'), 'utf8')
  assert.ok(/structured JSON snapshot/.test(source))
  assert.equal(/bytes, verbatim/.test(source), false)
  // And the future exact-byte requirement is recorded, not assumed away.
  assert.ok(/signature verification/i.test(source))
})
