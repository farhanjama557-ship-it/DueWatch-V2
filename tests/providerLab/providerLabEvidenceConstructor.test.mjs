/**
 * M2H-CP1 final closure — evidence constructor provenance and E8 identity.
 *
 * The last repair closed the domain artifact against forgery by requiring
 * membership of a module-private WeakSet, then left the evidence records
 * themselves trusting a public `kind` string — the very shape check it had
 * just replaced. A plain object literal could therefore pose as a schema
 * confirmation, and two of them could pose as multi-provider support.
 *
 * That is the same mistake twice, so this fixes it by applying the same
 * doctrine consistently rather than by inventing a third mechanism.
 *
 * Two smaller E8 defects come with it: an artifact-only E8 lost the very
 * proposition it proved (propositionKey null), and its identity ignored the
 * artifact entirely, so two different accounting sources collapsed to one
 * evidenceId.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EVIDENCE_CLASS, OBSERVATION_ENVIRONMENT, DOMAIN_SUPPORT_KIND,
  recordEvidence, composeEvidence, createDomainSupportArtifact,
} from '../../src/lib/integrations/providerEvidence.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BALANCE = 'invoice_balance_field_exists'
const RECEIPT = 'payment_receipt_is_not_allocation'

const schema = (provider, propositionKey = BALANCE) => recordEvidence({
  evidenceClass: EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED, provider, propositionKey,
  environment: OBSERVATION_ENVIRONMENT.MOCK, refs: [`schema://${provider}`],
})
const doc = (provider, propositionKey = BALANCE) => recordEvidence({
  evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED, provider, propositionKey,
  environment: OBSERVATION_ENVIRONMENT.MOCK, refs: [`docs://${provider}`],
})
const observed = (provider, captureId, propositionKey = BALANCE) => recordEvidence({
  evidenceClass: EVIDENCE_CLASS.E4_SANDBOX_OBSERVED, provider, propositionKey, captureId,
  environment: OBSERVATION_ENVIRONMENT.PROVIDER_SANDBOX, refs: [captureId],
})
const artifact = (artifactId, propositionKey = RECEIPT) => createDomainSupportArtifact({
  artifactId, propositionKey, domainCategory: 'ACCOUNTING_PRINCIPLE',
  citation: `standard://example/${artifactId}`, recordedAt: '2026-09-04T00:00:00Z',
})

/** A plain object wearing the public evidence shape. Anyone can type this. */
const forged = (evidenceClass, provider, propositionKey = BALANCE) => ({
  kind: 'M2H_EVIDENCE_V0',
  evidenceClass, provider, propositionKey,
  environment: OBSERVATION_ENVIRONMENT.MOCK,
  refs: [], captureId: null, evidenceId: 'deadbeef',
  grantsAuthority: false, isRanked: false,
})

// ── A — components must have passed the constructor ──────────────────────────

test('A1 a forged schema record cannot compose into E3', () => {
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [forged(EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED, 'qbo_like'), doc('qbo_like')],
  }), /constructor|recordEvidence/i)
})

test('A2 a forged documentation record cannot compose into E3', () => {
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('qbo_like'), forged(EVIDENCE_CLASS.E2_DOC_CONFIRMED, 'qbo_like')],
  }), /constructor|recordEvidence/i)
})

test('A3 two forged support records cannot earn E7', () => {
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED,
    components: [
      forged(EVIDENCE_CLASS.E2_DOC_CONFIRMED, 'provider_a'),
      forged(EVIDENCE_CLASS.E2_DOC_CONFIRMED, 'provider_b'),
    ],
  }), /constructor|recordEvidence/i)
})

test('A4 a spread copy of a genuine primitive record is rejected', () => {
  const genuineSchema = schema('qbo_like')
  const genuineDoc = doc('qbo_like')
  // The copy is field-for-field identical, including evidenceId.
  const copy = { ...genuineDoc }
  assert.deepEqual(copy, genuineDoc)
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC, components: [genuineSchema, copy],
  }), /constructor|recordEvidence/i)
})

test('A5 a spread copy of a genuine COMPOSITE record is rejected', () => {
  const qbo = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('qbo_like', RECEIPT), doc('qbo_like', RECEIPT)],
  })
  const xero = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('xero_like', RECEIPT), doc('xero_like', RECEIPT)],
  })
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED,
    components: [{ ...qbo }, xero],
  }), /constructor|recordEvidence/i)
})

test('A6 genuine primitive evidence still composes', () => {
  assert.equal(composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('qbo_like'), doc('qbo_like')],
  }).evidenceClass, EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC)
})

test('A7 genuine nested composites still compose — E3 into E7, E5 into E6', () => {
  const qbo = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('qbo_like', RECEIPT), doc('qbo_like', RECEIPT)],
  })
  const xero = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('xero_like', RECEIPT), doc('xero_like', RECEIPT)],
  })
  assert.deepEqual([...composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED, components: [qbo, xero],
  }).providers].sort(), ['qbo_like', 'xero_like'])

  const reproduced = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED,
    components: [observed('qbo_like', 'capture-1'), observed('qbo_like', 'capture-2')],
  })
  assert.equal(composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
    components: [doc('qbo_like'), reproduced],
  }).evidenceClass, EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX)
})

test('A8 the evidence registry is private and uses no copyable trust flag', () => {
  const source = readFileSync(
    path.join(repoRoot, 'src/lib/integrations/providerEvidence.js'), 'utf8')
  assert.equal(/export\s+(const|let|function)\s+\w*CONSTRUCTED/i.test(source), false,
    'the evidence registry must not be exported')
  const code = source.split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n')
  for (const copyable of ['valid: true', 'trusted: true', 'constructed: true']) {
    assert.equal(code.includes(copyable), false, copyable)
  }
  // Two registries, one doctrine — and it must say what it does NOT prove.
  assert.equal((source.match(/new WeakSet\(\)/g) ?? []).length, 2)
  assert.ok(/does NOT prove|not prove/i.test(source))
})

// ── B — E8 always states what it proves ──────────────────────────────────────

test('B1 an artifact-only E8 carries the artifact\'s proposition', () => {
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [], domainSupport: artifact('accounting-001', RECEIPT),
  })
  assert.equal(composed.propositionKey, RECEIPT)
})

test('B2 E8 never returns a null proposition', () => {
  for (const components of [[], [doc('provider_a', RECEIPT)]]) {
    const composed = composeEvidence({
      evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
      components, domainSupport: artifact('accounting-001', RECEIPT),
    })
    assert.equal(composed.propositionKey, RECEIPT)
    assert.notEqual(composed.propositionKey, null)
  }
})

test('B3 an artifact proving something else is still rejected', () => {
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [doc('provider_a', BALANCE)], domainSupport: artifact('accounting-001', RECEIPT),
  }), /same proposition/i)
})

// ── C — E8 identity includes the artifact that earned it ─────────────────────

test('C1 two different domain artifacts yield different E8 identities', () => {
  const a = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [], domainSupport: artifact('accounting-001', RECEIPT),
  })
  const b = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [], domainSupport: artifact('accounting-002', RECEIPT),
  })
  assert.notEqual(a.evidenceId, b.evidenceId,
    'the artifact is what earns E8, so it must be part of the identity')
})

test('C1b two artifacts differing ONLY in artifact id are still distinct', () => {
  // The isolating case: same citation, same category, same date, same
  // proposition. If the id were dropped from the identity, two genuinely
  // different artifact records would collapse into one E8.
  const shared = {
    propositionKey: RECEIPT, domainCategory: 'ACCOUNTING_PRINCIPLE',
    citation: 'standard://example/shared', recordedAt: '2026-09-04T00:00:00Z',
  }
  const ids = ['accounting-001', 'accounting-002'].map((artifactId) => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED, components: [],
    domainSupport: createDomainSupportArtifact({ ...shared, artifactId }),
  }).evidenceId)
  assert.notEqual(ids[0], ids[1])
})

test('C2 a different proposition yields a different E8 identity', () => {
  const a = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [], domainSupport: artifact('accounting-001', RECEIPT),
  })
  const b = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [], domainSupport: artifact('accounting-001', BALANCE),
  })
  assert.notEqual(a.evidenceId, b.evidenceId)
})

test('C3 the same artifact and the same inputs are deterministic', () => {
  const build = () => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [], domainSupport: artifact('accounting-001', RECEIPT),
  })
  // Fresh artifact objects with identical fields: identity is canonical, not
  // object reference, so it must be stable across constructions.
  assert.equal(build().evidenceId, build().evidenceId)
})

test('C4 a changed citation or category changes the E8 identity', () => {
  const base = createDomainSupportArtifact({
    artifactId: 'accounting-001', propositionKey: RECEIPT,
    domainCategory: 'ACCOUNTING_PRINCIPLE', citation: 'standard://a',
    recordedAt: '2026-09-04T00:00:00Z',
  })
  const differentCitation = createDomainSupportArtifact({
    artifactId: 'accounting-001', propositionKey: RECEIPT,
    domainCategory: 'ACCOUNTING_PRINCIPLE', citation: 'standard://b',
    recordedAt: '2026-09-04T00:00:00Z',
  })
  const ids = [base, differentCitation].map((domainSupport) => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [], domainSupport,
  }).evidenceId)
  assert.notEqual(ids[0], ids[1])
})

test('C5 non-E8 composites keep a stable identity that ignores absent artifacts', () => {
  const build = () => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('qbo_like'), doc('qbo_like')],
  })
  assert.equal(build().evidenceId, build().evidenceId)
})

// ── Provenance retention is not weakened ─────────────────────────────────────

test('component provenance is still fully retained', () => {
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
    components: [doc('qbo_like'), observed('qbo_like', 'capture-1')],
  })
  for (const component of composed.components) {
    for (const field of ['evidenceId', 'evidenceClass', 'propositionKey', 'providers',
      'captureIds', 'environment', 'refs']) {
      assert.ok(component[field] !== undefined, field)
    }
  }
  assert.deepEqual([...composed.captureIds], ['capture-1'])
})

test('the forged shape used by these tests is genuinely well-formed public data', () => {
  // If the forgery were malformed, these tests would prove nothing: they must
  // fail on PROVENANCE, not on shape.
  const fake = forged(EVIDENCE_CLASS.E2_DOC_CONFIRMED, 'qbo_like')
  const genuine = doc('qbo_like')
  for (const field of Object.keys(fake)) {
    assert.ok(field in genuine, `forgery carries a field the real record lacks: ${field}`)
  }
  assert.equal(fake.kind, genuine.kind)
  assert.equal(fake.evidenceClass, genuine.evidenceClass)
})
