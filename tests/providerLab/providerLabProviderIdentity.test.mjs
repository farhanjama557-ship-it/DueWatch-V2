/**
 * M2H-CP1 final closure — provider-scoped evidence and admission identity.
 *
 * Six defects from independent review, all of the same family: the kernel knew
 * WHAT was being proved but was careless about WHERE.
 *
 *   E3 and E6 ignored the provider, so QuickBooks' schema and Xero's docs
 *   "agreed" — a sentence that means nothing, because neither system makes
 *   claims about the other.
 *
 *   Provider-derived evidence could exist with no provider at all, so two
 *   anonymous captures earned E5.
 *
 *   E7 counted providers but not support, so two hypotheses became
 *   "multi-provider supported".
 *
 *   The E8 artifact check trusted a public `kind` string, so a plain object
 *   literal minted E8 — the very forgery the previous repair claimed to close.
 *
 *   Claim admission bound tenant and provider account but never the provider,
 *   so the same account id under a different provider passed.
 *
 * That last one is the one that would bite first in production: account ids
 * are not globally unique across providers.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EVIDENCE_CLASS, OBSERVATION_ENVIRONMENT, DOMAIN_SUPPORT_KIND,
  SUPPORT_BEARING_EVIDENCE_CLASSES,
  recordEvidence, composeEvidence, createDomainSupportArtifact, providerSetOf,
} from '../../src/lib/integrations/providerEvidence.js'
import {
  PROVIDER_CLAIM_ADMISSION, admitProviderClaim, governingClaims,
} from '../../src/lib/integrations/providerContract.js'
import { PROVIDER_TRUTH_DIMENSION as T } from '../../src/lib/integrations/providerTruthModel.js'
import { FRESHNESS_STATE } from '../../src/lib/integrations/providerFreshness.js'

import {
  LAB_TENANT, LAB_TENANT_B, LAB_ACCOUNT, LAB_ACCOUNT_B,
  MOCK_LEDGER_ADAPTER, MOCK_PROCESSOR_ADAPTER, observeThrough,
} from './harness.mjs'

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
const hypothesis = (provider, propositionKey = BALANCE) => recordEvidence({
  evidenceClass: EVIDENCE_CLASS.E0_HYPOTHESIS, provider, propositionKey,
  environment: OBSERVATION_ENVIRONMENT.MOCK,
})

// ── A/B — E3 and E6 are statements about ONE provider ────────────────────────

test('A E3 refuses one provider\'s schema and another\'s documentation', () => {
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('qbo_like'), doc('xero_like')],
  }), /same provider/i)
})

test('A E3 succeeds when the schema and the docs are the same provider\'s', () => {
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('qbo_like'), doc('qbo_like')],
  })
  assert.equal(composed.evidenceClass, EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC)
  assert.deepEqual([...composed.providers], ['qbo_like'])
})

test('B E6 refuses documentation and empirical behaviour from different providers', () => {
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
    components: [doc('qbo_like'), observed('xero_like', 'capture-1')],
  }), /same provider/i)
  // Including when the empirical half is a reproduction rather than one look.
  const xeroReproduced = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED,
    components: [observed('xero_like', 'capture-1'), observed('xero_like', 'capture-2')],
  })
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
    components: [doc('qbo_like'), xeroReproduced],
  }), /same provider/i)
})

test('B E6 succeeds for one provider, with either strength of sandbox evidence', () => {
  assert.equal(composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
    components: [doc('qbo_like'), observed('qbo_like', 'capture-1')],
  }).evidenceClass, EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX)
  const reproduced = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED,
    components: [observed('qbo_like', 'capture-1'), observed('qbo_like', 'capture-2')],
  })
  assert.equal(composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
    components: [doc('qbo_like'), reproduced],
  }).evidenceClass, EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX)
})

// ── C — provider evidence needs a provider ───────────────────────────────────

test('C provider-derived classes require an explicit provider', () => {
  for (const [cls, extra] of [
    [EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED, {}],
    [EVIDENCE_CLASS.E2_DOC_CONFIRMED, {}],
    [EVIDENCE_CLASS.E4_SANDBOX_OBSERVED, { captureId: 'capture-1' }],
  ]) {
    assert.throws(() => recordEvidence({
      evidenceClass: cls, propositionKey: BALANCE, refs: ['r'],
      environment: cls === EVIDENCE_CLASS.E4_SANDBOX_OBSERVED
        ? OBSERVATION_ENVIRONMENT.PROVIDER_SANDBOX : OBSERVATION_ENVIRONMENT.MOCK,
      ...extra,
    }), /requires a provider/i, cls)
  }
})

test('C a hypothesis may remain provider-neutral', () => {
  const guess = recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E0_HYPOTHESIS, propositionKey: BALANCE,
    environment: OBSERVATION_ENVIRONMENT.MOCK,
  })
  assert.equal(guess.provider, null)
  assert.deepEqual([...providerSetOf(guess)], [])
})

test('C two provider-less captures cannot earn E5 — there is no provider to reproduce', () => {
  // Guarded at the record boundary now, so the composition can never see them.
  assert.throws(() => recordEvidence({
    evidenceClass: EVIDENCE_CLASS.E4_SANDBOX_OBSERVED, propositionKey: BALANCE,
    captureId: 'capture-1', environment: OBSERVATION_ENVIRONMENT.PROVIDER_SANDBOX, refs: ['a'],
  }), /requires a provider/i)
})

// ── D — E7 requires actual support, not agreement between guesses ────────────

test('D two hypotheses are not multi-provider support', () => {
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED,
    components: [hypothesis('provider_a'), hypothesis('provider_b')],
  }), /support/i)
})

test('D one supported provider plus one guess is one supported provider', () => {
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED,
    components: [doc('provider_a'), hypothesis('provider_b')],
  }), /support|distinct provider/i)
})

test('D two supported distinct providers earn E7', () => {
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED,
    components: [doc('provider_a'), doc('provider_b')],
  })
  assert.deepEqual([...composed.providers].sort(), ['provider_a', 'provider_b'])
})

test('D the support-bearing set is explicit and excludes hypotheses', () => {
  assert.equal(SUPPORT_BEARING_EVIDENCE_CLASSES.includes(EVIDENCE_CLASS.E0_HYPOTHESIS), false)
  assert.deepEqual([...SUPPORT_BEARING_EVIDENCE_CLASSES].sort(), [
    EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED, EVIDENCE_CLASS.E2_DOC_CONFIRMED,
    EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC, EVIDENCE_CLASS.E4_SANDBOX_OBSERVED,
    EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED, EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
  ].sort())
})

// ── Nested composites keep their provider identity ───────────────────────────

test('E7 accepts nested provider-scoped composites and preserves both providers', () => {
  const qbo = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('qbo_like', RECEIPT), doc('qbo_like', RECEIPT)],
  })
  const xero = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('xero_like', RECEIPT), doc('xero_like', RECEIPT)],
  })
  assert.deepEqual([...providerSetOf(qbo)], ['qbo_like'])
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED, components: [qbo, xero],
  })
  assert.deepEqual([...composed.providers].sort(), ['qbo_like', 'xero_like'])
  assert.equal(composed.propositionKey, RECEIPT)
})

test('a nested composite of ONE provider cannot masquerade as two', () => {
  const qboA = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
    components: [schema('qbo_like', RECEIPT), doc('qbo_like', RECEIPT)],
  })
  const qboB = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
    components: [doc('qbo_like', RECEIPT), observed('qbo_like', 'capture-7', RECEIPT)],
  })
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED, components: [qboA, qboB],
  }), /distinct provider/i)
})

test('composed provenance retains the identity it claims to retain', () => {
  const composed = composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
    components: [doc('qbo_like'), observed('qbo_like', 'capture-1')],
  })
  for (const component of composed.components) {
    assert.ok(component.evidenceId, 'component identity')
    assert.ok(component.evidenceClass)
    assert.equal(component.propositionKey, BALANCE)
    assert.ok(Array.isArray(component.providers))
    assert.ok(Array.isArray(component.refs))
    assert.ok(component.environment)
  }
  assert.deepEqual([...composed.captureIds], ['capture-1'])
})

// ── E — the domain artifact must have passed the constructor ─────────────────

test('E a forged full-shape domain artifact is refused', () => {
  const forged = {
    kind: DOMAIN_SUPPORT_KIND, artifactId: 'gaap-ar-001', propositionKey: BALANCE,
    domainCategory: 'ACCOUNTING_PRINCIPLE', citation: 'standard://example',
    recordedAt: '2026-09-04T00:00:00Z', grantsAuthority: false,
  }
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [doc('provider_a')], domainSupport: forged,
  }), /constructor|createDomainSupportArtifact/i)
})

test('E a minimal object carrying only the public kind is refused', () => {
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [doc('provider_a')], domainSupport: { kind: DOMAIN_SUPPORT_KIND },
  }), /constructor|createDomainSupportArtifact/i)
})

test('E a copy of a genuine artifact is not the genuine artifact', () => {
  const genuine = createDomainSupportArtifact({
    artifactId: 'gaap-ar-001', propositionKey: BALANCE,
    domainCategory: 'ACCOUNTING_PRINCIPLE', citation: 'standard://example',
    recordedAt: '2026-09-04T00:00:00Z',
  })
  assert.throws(() => composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [doc('provider_a')], domainSupport: { ...genuine },
  }), /constructor|createDomainSupportArtifact/i)
  // The genuine object itself passes.
  assert.equal(composeEvidence({
    evidenceClass: EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED,
    components: [doc('provider_a')], domainSupport: genuine,
  }).evidenceClass, EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED)
})

test('E the constructor registry is private and honestly described', () => {
  const source = readFileSync(
    path.join(repoRoot, 'src/lib/integrations/providerEvidence.js'), 'utf8')
  assert.equal(/export\s+(const|let)\s+\w*[Rr]egistry/.test(source), false,
    'the registry must not be exported')
  assert.ok(source.includes('WeakSet'))
  // No copyable trust flag: a caller can copy a boolean, not a WeakSet entry.
  // CODE only — the module explains why `trusted: true` would be wrong, and
  // scanning that explanation would flag the documentation for saying so.
  const code = source.split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n')
  for (const copyable of ['valid: true', 'trusted: true', 'constructed: true']) {
    assert.equal(code.includes(copyable), false, copyable)
  }
  // And it must say what it does NOT prove.
  assert.ok(/local[\s\S]{0,200}not[\s\S]{0,200}external|external provenance/i.test(source))
})

// ── F — admission binds tenant AND provider AND account ──────────────────────

const claimInputs = (adapter, overrides = {}) => {
  const { observation, interpretation } = observeThrough(adapter, {
    payload: adapter.emit({ invoiceId: 'inv-1', balance: 100, amountMinor: 1000 }),
    ...overrides,
  })
  return { observation, interpretation }
}

test('F the full tuple is accepted', () => {
  const { observation, interpretation } = claimInputs(MOCK_LEDGER_ADAPTER)
  const result = admitProviderClaim({
    tenantId: LAB_TENANT, provider: MOCK_LEDGER_ADAPTER.provider,
    providerAccountId: LAB_ACCOUNT, observation, interpretation,
  })
  assert.equal(result.admitted, true, result.reason ?? '')
})

test('F a wrong provider is rejected even with the right tenant and account', () => {
  // The realistic hazard: account ids are not globally unique across
  // providers, so "acct-lab-1" at one provider is a different thing entirely
  // from "acct-lab-1" at another.
  const { observation, interpretation } = claimInputs(MOCK_PROCESSOR_ADAPTER)
  const result = admitProviderClaim({
    tenantId: LAB_TENANT, provider: MOCK_LEDGER_ADAPTER.provider,
    providerAccountId: LAB_ACCOUNT, observation, interpretation,
  })
  assert.equal(result.admitted, false)
  assert.equal(result.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_PROVIDER)
  assert.equal(result.claim, null)
})

test('F a missing expected provider fails closed, and says WHY it failed', () => {
  const { observation, interpretation } = claimInputs(MOCK_LEDGER_ADAPTER)
  const result = admitProviderClaim({
    tenantId: LAB_TENANT, providerAccountId: LAB_ACCOUNT, observation, interpretation,
  })
  assert.equal(result.admitted, false)
  assert.equal(result.admission, PROVIDER_CLAIM_ADMISSION.REJECTED_PROVIDER)
  // The diagnosis matters and is asserted: "you did not tell me which
  // connection this is" is a caller bug, while "this observation is from
  // another provider" is a data problem. Collapsing them hides the first.
  assert.match(result.reason, /connection context must name it/i)
})

test('F tenant and account mismatches keep their own typed outcomes', () => {
  const { observation, interpretation } = claimInputs(MOCK_LEDGER_ADAPTER)
  const base = { provider: MOCK_LEDGER_ADAPTER.provider, observation, interpretation }
  assert.equal(admitProviderClaim({
    ...base, tenantId: LAB_TENANT_B, providerAccountId: LAB_ACCOUNT,
  }).admission, PROVIDER_CLAIM_ADMISSION.REJECTED_TENANT)
  assert.equal(admitProviderClaim({
    ...base, tenantId: LAB_TENANT, providerAccountId: LAB_ACCOUNT_B,
  }).admission, PROVIDER_CLAIM_ADMISSION.REJECTED_PROVIDER_ACCOUNT)
})

test('F a rejected claim never reaches the governing set', () => {
  const { observation, interpretation } = claimInputs(MOCK_PROCESSOR_ADAPTER)
  const rejected = admitProviderClaim({
    tenantId: LAB_TENANT, provider: MOCK_LEDGER_ADAPTER.provider,
    providerAccountId: LAB_ACCOUNT, observation, interpretation,
  })
  const governed = governingClaims([rejected], T.T3_PAYMENT_RECEIPT_STATE)
  assert.deepEqual(governed.governing, [])
})

test('F provider is never inferred from the payload or the observation', () => {
  const source = readFileSync(
    path.join(repoRoot, 'src/lib/integrations/providerContract.js'), 'utf8')
  // The expected provider comes from the connection context the caller holds,
  // never from anything the observation itself carries.
  assert.ok(/expected/i.test(source))
  assert.equal(/provider\s*=\s*observation\.provider/.test(source), false)
  assert.equal(/provider\s*\?\?\s*observation\.provider/.test(source), false)
})

test('F the connection tuple is recorded honestly, with no invented persistence', () => {
  const source = readFileSync(
    path.join(repoRoot, 'src/lib/integrations/providerContract.js'), 'utf8')
  assert.ok(/CP6/.test(source), 'the durable connection binding must be named as future work')
  for (const invented of ['connectionRegistry', 'connectionStore', 'saveConnection']) {
    assert.equal(source.includes(invented), false, invented)
  }
})
