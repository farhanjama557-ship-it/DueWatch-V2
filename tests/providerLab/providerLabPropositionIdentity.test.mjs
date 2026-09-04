/**
 * M2H-CP1 repair — proposition identity, reproduction provenance, domain artifact.
 *
 * Independent review of the pushed source found three ways evidence could
 * still be stronger than what backed it:
 *
 *   E5 ("independently reproduced") was primitive, so selecting the label was
 *   the whole proof.
 *
 *   Composition checked class, environment and provider count but never what
 *   the components were ABOUT, so a schema fact about invoice balances and a
 *   doc fact about webhook retries composed happily into E3.
 *
 *   E8 accepted any truthy `domainSupport`, so `'trust me'` minted it. My
 *   previous report called E8 unissuable. That was wrong.
 *
 * The fix is one idea: every evidence record states WHAT IT PROVES, as an
 * explicit typed key, and composition requires the components to agree on it.
 * Exact identity only — no similarity, no fuzzy matching, no model judgement.
 * "proposition" is the repository's existing word for a typed claim evaluated
 * in isolation (G7 authority propositions); this is the same idea applied to
 * provider research, and the two never mix.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EVIDENCE_CLASS, OBSERVATION_ENVIRONMENT, PRIMITIVE_EVIDENCE_CLASSES,
  COMPOSITE_EVIDENCE_CLASSES, recordEvidence, composeEvidence,
  createDomainSupportArtifact, DOMAIN_SUPPORT_KIND,
} from '../../src/lib/integrations/providerEvidence.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const RECEIPT_NOT_ALLOCATION = 'payment_receipt_is_not_allocation'
const BALANCE_FIELD = 'invoice_balance_field_exists'
const WEBHOOK_RETRY = 'webhook_delivery_may_repeat'
const REFUND_REOPENS = 'refund_reopens_ar'

const doc = (provider, propositionKey, ref = `docs://${propositionKey}`) => recordEvidence({
  evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED, provider, propositionKey,
  environment: OBSERVATION_ENVIRONMENT.MOCK, refs: [ref],
})
const schema = (provider, propositionKey) => recordEvidence({
  evidenceClass: EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED, provider, propositionKey,
  environment: OBSERVATION_ENVIRONMENT.MOCK, refs: [`schema://${propositionKey}`],
})
const sandbox = (provider, propositionKey, captureId) => recordEvidence({
  evidenceClass: EVIDENCE_CLASS.E4_SANDBOX_OBSERVED, provider, propositionKey,
  environment: OBSERVATION_ENVIRONMENT.PROVIDER_SANDBOX, captureId, refs: [captureId],
})

// ── Blocker A — E5 must be earned by an actual reproduction ──────────────────

test('A E5 can no longer be self-declared', () => {
  assert.throws(() => recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED,
    environment: OBSERVATION_ENVIRONMENT.PROVIDER_SANDBOX,
    provider: 'mock_ledger', propositionKey: RECEIPT_NOT_ALLOCATION, refs: ['capture-2'],
  }), /composite|composed/i)
  assert.ok(COMPOSITE_EVIDENCE_CLASSES.includes(EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED))
  assert.equal(PRIMITIVE_EVIDENCE_CLASSES.includes(EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED), false)
})

test('A E5 is earned by two independent sandbox observations of one proposition', () => {
  const first = sandbox('mock_ledger', RECEIPT_NOT_ALLOCATION, 'capture-1')
  const second = sandbox('mock_ledger', RECEIPT_NOT_ALLOCATION, 'capture-2')
  const reproduced = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED, components: [first, second],
  })
  assert.equal(reproduced.evidenceClass, EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED)
  assert.equal(reproduced.propositionKey, RECEIPT_NOT_ALLOCATION)
  assert.deepEqual([...reproduced.captureIds].sort(), ['capture-1', 'capture-2'])
})

test('A the same observation twice is not a reproduction', () => {
  const once = sandbox('mock_ledger', RECEIPT_NOT_ALLOCATION, 'capture-1')
  // The same object twice.
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED, components: [once, once],
  }), /independent|distinct/i)
  // A copy pretending to be independent — same capture, same everything.
  const copy = sandbox('mock_ledger', RECEIPT_NOT_ALLOCATION, 'capture-1')
  assert.equal(copy.evidenceId, once.evidenceId, 'identical evidence has identical identity')
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED, components: [once, copy],
  }), /independent|distinct/i)
})

test('A two records dressed up from ONE capture are still one observation', () => {
  // The subtler forgery: different refs, so different record identity, but the
  // same underlying capture. Capture identity is what independence rests on.
  const first = sandbox('mock_ledger', RECEIPT_NOT_ALLOCATION, 'capture-1')
  const dressedUp = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E4_SANDBOX_OBSERVED, provider: 'mock_ledger',
    propositionKey: RECEIPT_NOT_ALLOCATION, captureId: 'capture-1',
    environment: OBSERVATION_ENVIRONMENT.PROVIDER_SANDBOX, refs: ['capture-1', 'extra-note'],
  })
  assert.notEqual(dressedUp.evidenceId, first.evidenceId, 'the records do differ')
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED, components: [first, dressedUp],
  }), /distinct capture identity/i)
})

test('A a reproduction must be of the SAME proposition and the SAME provider', () => {
  const first = sandbox('mock_ledger', RECEIPT_NOT_ALLOCATION, 'capture-1')
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED,
    components: [first, sandbox('mock_ledger', REFUND_REOPENS, 'capture-2')],
  }), /proposition/i)
  // Reproduction is provider-specific: another provider doing something
  // similar is E7 territory, not a reproduction.
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED,
    components: [first, sandbox('mock_processor', RECEIPT_NOT_ALLOCATION, 'capture-2')],
  }), /same provider/i)
})

test('A E4 itself requires a capture identity, or nothing can be independent', () => {
  assert.throws(() => recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E4_SANDBOX_OBSERVED, provider: 'mock_ledger',
    propositionKey: RECEIPT_NOT_ALLOCATION,
    environment: OBSERVATION_ENVIRONMENT.PROVIDER_SANDBOX, refs: ['x'],
  }), /capture/i)
})

// ── Blocker B — composition requires the same proposition ────────────────────

test('B every evidence record must state what it proves', () => {
  assert.throws(() => recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED, provider: 'p',
    environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['docs://x'],
  }), /proposition/i)
})

test('B a proposition key is provider-neutral', () => {
  // "What is being proved" must not be "where it was seen". A key naming its
  // own provider is a provider fact wearing a universal label.
  assert.throws(() => recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED, provider: 'mock_ledger',
    propositionKey: 'mock_ledger_balance_field', environment: OBSERVATION_ENVIRONMENT.MOCK,
    refs: ['docs://x'],
  }), /provider-neutral/i)
  assert.throws(() => recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E2_DOC_CONFIRMED, provider: 'p',
    propositionKey: 'Not A Valid Key!', environment: OBSERVATION_ENVIRONMENT.MOCK, refs: ['d'],
  }), /proposition key/i)
})

test('B-A E3 refuses a schema fact and a doc fact about different things', () => {
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('qbo_like', BALANCE_FIELD), doc('stripe_like', WEBHOOK_RETRY)],
  }), /same proposition/i)
})

test('B-B E6 refuses documentation and sandbox evidence about different things', () => {
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
    components: [
      doc('qbo_like', 'invoice_balance_semantics'),
      sandbox('xero_like', 'credit_note_allocation_semantics', 'capture-9'),
    ],
  }), /same proposition/i)
})

test('B-C E7 refuses two providers supporting different propositions', () => {
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED,
    components: [doc('provider_a', RECEIPT_NOT_ALLOCATION), doc('provider_b', REFUND_REOPENS)],
  }), /same proposition/i)
})

test('B-D E7 succeeds when two distinct providers support the SAME proposition', () => {
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED,
    components: [
      doc('provider_a', RECEIPT_NOT_ALLOCATION),
      doc('provider_b', RECEIPT_NOT_ALLOCATION),
    ],
  })
  assert.equal(composed.evidenceClass, EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED)
  assert.equal(composed.propositionKey, RECEIPT_NOT_ALLOCATION)
  assert.deepEqual([...composed.providers].sort(), ['provider_a', 'provider_b'])
})

test('B a composed record carries the proposition it proves', () => {
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('qbo_like', BALANCE_FIELD), doc('qbo_like', BALANCE_FIELD)],
  })
  assert.equal(composed.propositionKey, BALANCE_FIELD)
  assert.equal(composed.components.length, 2)
})

// ── Blocker C — E8 needs a typed domain artifact ─────────────────────────────

test('C E8 refuses an arbitrary truthy domainSupport', () => {
  for (const domainSupport of ['trust me', 'GAAP', true, 1, { note: 'accounting says so' }]) {
    assert.throws(() => composeEvidence({
      evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
      components: [], domainSupport,
    }), /domain support artifact/i, JSON.stringify(domainSupport))
  }
})

test('C a domain artifact must be constructed with its provenance', () => {
  const complete = {
    artifactId: 'gaap-ar-001', propositionKey: RECEIPT_NOT_ALLOCATION,
    domainCategory: 'ACCOUNTING_PRINCIPLE', citation: 'standard://example/ar-recognition',
    recordedAt: '2026-09-04T00:00:00Z',
  }
  assert.equal(createDomainSupportArtifact(complete).kind, DOMAIN_SUPPORT_KIND)
  for (const missing of Object.keys(complete)) {
    const partial = { ...complete }
    delete partial[missing]
    assert.throws(() => createDomainSupportArtifact(partial), /require/i, missing)
  }
})

test('C E8 is issuable ONLY from a real artifact for the same proposition', () => {
  const artifact = createDomainSupportArtifact({
    artifactId: 'gaap-ar-001', propositionKey: RECEIPT_NOT_ALLOCATION,
    domainCategory: 'ACCOUNTING_PRINCIPLE', citation: 'standard://example/ar-recognition',
    recordedAt: '2026-09-04T00:00:00Z',
  })
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [doc('provider_a', RECEIPT_NOT_ALLOCATION)],
    domainSupport: artifact,
  })
  assert.equal(composed.evidenceClass, EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED)
  assert.equal(composed.domainSupport.artifactId, 'gaap-ar-001')

  // An artifact about something else does not support this proposition.
  const other = createDomainSupportArtifact({
    artifactId: 'gaap-ar-002', propositionKey: REFUND_REOPENS,
    domainCategory: 'ACCOUNTING_PRINCIPLE', citation: 'standard://example/refunds',
    recordedAt: '2026-09-04T00:00:00Z',
  })
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [doc('provider_a', RECEIPT_NOT_ALLOCATION)], domainSupport: other,
  }), /same proposition/i)
})

test('C CP1 ships no accounting-domain artifact, so no real E8 exists here', () => {
  // The contract exists; no instance does. Stated as a test so the claim is
  // checked rather than asserted in prose — the mistake last time.
  const walk = (dir) => readFileSync(dir, 'utf8')
  for (const relative of [
    'src/lib/integrations/providerEvidence.js',
    'tests/providerLab/harness.mjs',
  ]) {
    const source = walk(path.join(repoRoot, relative))
    assert.equal(/createDomainSupportArtifact\s*\(\s*\{/.test(source), false,
      `${relative} constructs a domain artifact; CP1 has no researched accounting source`)
  }
})

// ── Evidence identity and honesty ────────────────────────────────────────────

test('evidence identity is deterministic and distinguishes real differences', () => {
  const a = doc('provider_a', RECEIPT_NOT_ALLOCATION)
  const b = doc('provider_a', RECEIPT_NOT_ALLOCATION)
  const c = doc('provider_b', RECEIPT_NOT_ALLOCATION)
  const d = doc('provider_a', REFUND_REOPENS)
  assert.equal(a.evidenceId, b.evidenceId)
  assert.notEqual(a.evidenceId, c.evidenceId)
  assert.notEqual(a.evidenceId, d.evidenceId)
  assert.match(a.evidenceId, /^[0-9a-f]{8}$/)
})

test('composition still introduces no ranking and grants no authority', () => {
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('p', BALANCE_FIELD), doc('p', BALANCE_FIELD)],
  })
  assert.equal(composed.grantsAuthority, false)
  assert.equal(composed.isRanked, false)
  for (const banned of ['evidenceRank', 'confidenceScore', 'maxEvidence', 'score']) {
    assert.equal(JSON.stringify(composed).includes(banned), false, banned)
  }
})

test('the external-origin limitation is stated, not quietly assumed', () => {
  const source = readFileSync(
    path.join(repoRoot, 'src/lib/integrations/providerEvidence.js'), 'utf8')
  // The contract proves shape, identity and proposition consistency. It does
  // not prove a record truly came from a named provider.
  assert.ok(/cannot (prove|authenticate)[\s\S]{0,200}orig/i.test(source))
  // CODE only: saying "no signature is invented here" is the documentation
  // this repair should carry; what must not exist is a call to one.
  const code = source.split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n').toLowerCase()
  for (const invented of ['hmac', 'createhash', 'crypto', 'sign(']) {
    assert.equal(code.includes(invented), false, invented)
  }
})

test('the observation module no longer claims to store bytes', () => {
  const source = readFileSync(
    path.join(repoRoot, 'src/lib/integrations/providerObservation.js'), 'utf8')
  for (const overstatement of ['Same bytes', 'same bytes', 'exactly what the provider sent',
    'bytes, verbatim', 'literally returned']) {
    assert.equal(source.includes(overstatement), false, overstatement)
  }
  assert.ok(/structured (JSON )?(observation )?snapshot/i.test(source))
  assert.ok(/signature verification/i.test(source), 'the CP6 exact-byte requirement stays recorded')
})
