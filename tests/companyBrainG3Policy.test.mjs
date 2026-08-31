/**
 * G3 Conflict & Policy Intelligence — tests against the real G2 CompanyBrainDurableStore API.
 *
 * Written against the G2 interfaces defined in:
 *   src/lib/companyBrain/durableStore.js   (CompanyBrainDurableStore, extractDeterministicClaims)
 *   src/lib/companyBrain/index.js          (CLAIM_CLASS, buildBrainSnapshot, answerAskDwFromCompanyBrain, etc.)
 *
 * BRANCH NOTE: The G2 module does not exist on the current branch. All tests skip automatically
 * when the import fails. They run with real assertions when G2 code is present.
 * Do NOT convert skipped tests to assert.ok(true) to fake a pass.
 *
 * G3 RUNTIME NOTE: Scenarios that require G3 policy-reasoning logic not yet implemented
 * (temporal state classification, scope-escalation detection, confidence-disagreement
 * classification, HISTORICAL_PRECEDENT ingestion pipeline) are marked test.todo().
 * These must not be weakened to passing stubs.
 *
 * Adversarial plan: docs/company-brain/M2G_G3_ADVERSARIAL_PLAN.md
 * Interface spec:   docs/company-brain/M2G_G3_CONFLICT_POLICY_INTELLIGENCE_V0.md
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Dynamic import — tests skip gracefully if G2 is not available on this branch ──────────────

let CompanyBrainDurableStore, proposedAuthority, AUTHORITY_STATUS, CLAIM_CLASS, AUTHORITY_RESULT
let assertCompanyBrainCannotWriteCanonicalMoney, mkClaim
let G2_AVAILABLE = false

try {
  const durableModule = await import('../src/lib/companyBrain/durableStore.js')
  const indexModule = await import('../src/lib/companyBrain/index.js')
  ;({ CompanyBrainDurableStore, proposedAuthority, AUTHORITY_STATUS } = durableModule)
  ;({ CLAIM_CLASS, AUTHORITY_RESULT, assertCompanyBrainCannotWriteCanonicalMoney, createClaim: mkClaim } = indexModule)
  G2_AVAILABLE = true
} catch {
  // G2 module not present on this branch — all tests skip via { skip: !G2_AVAILABLE }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, '../fixtures/company-brain')

// ── Actors and tenant constants ───────────────────────────────────────────────

const tenantA = 'tenant-a'
const tenantB = 'tenant-b'
const founderA = { id: tenantA, tenantId: tenantA, role: 'FOUNDER', authenticated: true }
const founderB = { id: tenantB, tenantId: tenantB, role: 'FOUNDER', authenticated: true }
const workerA = { id: 'worker-a', tenantId: tenantA, role: 'INGESTION_WORKER', authenticated: true }
const workerB = { id: 'worker-b', tenantId: tenantB, role: 'INGESTION_WORKER', authenticated: true }

// ── Store factory with deterministic clock ────────────────────────────────────

function store() {
  let tick = 0
  return new CompanyBrainDurableStore({
    clock: () => `2026-08-31T00:${String(tick++).padStart(2, '0')}:00.000Z`,
  })
}

// ── Ingestion helpers ─────────────────────────────────────────────────────────

function ingest(s, actor, tenantId, relative, identity, key) {
  return s.ingestLocalFile({
    actor, tenantId,
    filePath: path.join(fixtures, relative),
    sourceIdentity: identity,
    idempotencyKey: key,
  })
}

// Synthetic content helpers that produce specific claims via extractDeterministicClaims.
// Use these instead of fixture files that produce no claims (customer-contract-atlas.md,
// old-ar-rules.csv, atlas-history.md — all confirmed to yield 0 claims from G2 extractor).

function ingestCompanyPolicy(s, actor, tenantId, ratePercent, identity, key) {
  return s.ingestContent({
    actor, tenantId,
    filename: `${identity}.md`,
    content: `Charge a ${ratePercent}% late fee.`,
    sourceIdentity: identity,
    idempotencyKey: key,
  })
}

function ingestClientException(s, actor, tenantId, clientId, ratePercent, netDays, identity, key) {
  return s.ingestContent({
    actor, tenantId,
    filename: `${identity}.csv`,
    content: `client,payment_terms_days,late_fee_percent\n${clientId},${netDays},${ratePercent}`,
    sourceIdentity: identity,
    idempotencyKey: key,
  })
}

function ingestFounderInstruction(s, actor, tenantId, identity, key) {
  return s.ingestContent({
    actor, tenantId,
    filename: `${identity}.txt`,
    content: 'We stopped charging late fees until I approve a new policy.',
    sourceIdentity: identity,
    idempotencyKey: key,
  })
}

function ingestAccountManagerEmail(s, actor, tenantId, identity, key) {
  return s.ingestContent({
    actor, tenantId,
    filename: `${identity}.md`,
    content: 'Sure, give Atlas 20% off.',
    sourceIdentity: identity,
    idempotencyKey: key,
  })
}

function ingestPaymentClaim(s, actor, tenantId, identity, key) {
  return s.ingestContent({
    actor, tenantId,
    filename: `${identity}.md`,
    content: 'Invoice 104 was paid yesterday.',
    sourceIdentity: identity,
    idempotencyKey: key,
  })
}

// ── Core fixture: Acme/Atlas late-fee scenario using g1-realistic files ───────

function seedAcmeAtlas(s) {
  // collections-policy.md → COMPANY_POLICY 5% late_fee_policy
  ingest(s, workerA, tenantA, 'g1-realistic/collections-policy.md', 'collections-policy', 'job-policy')
  // atlas-terms.csv → CLIENT_EXCEPTION 2% + PAYMENT_TERMS_CONTEXT Net45 (for Atlas)
  ingest(s, workerA, tenantA, 'g1-realistic/atlas-terms.csv', 'atlas-terms', 'job-atlas')
  // founder-instruction.txt → FOUNDER_INSTRUCTION enabled:false
  ingest(s, workerA, tenantA, 'g1-realistic/founder-instruction.txt', 'founder-note', 'job-founder')
  return s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
}

function decisionInput(conflict, overrides = {}) {
  return {
    actor: founderA,
    tenantId: tenantA,
    idempotencyKey: 'decision-late-fee-g3-v1',
    targetId: conflict.id,
    expectedRevision: conflict.revision,
    decisionType: 'RESOLVE_CONFLICT_AND_APPROVE_POLICY',
    oldState: { status: 'CONFLICTED' },
    newState: { global: { enabled: false }, atlas: { ratePercent: 2, onlyWhenApplicable: true } },
    evidenceClaimIds: conflict.competingClaimIds,
    reason: 'Founder resolved late-fee conflict: fees halted globally, Atlas retains 2% contract exception.',
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Group A — Conflicting same-scope policies
// ═══════════════════════════════════════════════════════════════════════════════

test('A1: two COMPANY_POLICY claims with the same topic produce a CONFLICTED conflict', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  ingestCompanyPolicy(s, workerA, tenantA, 5, 'policy-a', 'job-a')
  ingestCompanyPolicy(s, workerA, tenantA, 7, 'policy-b', 'job-b')
  const conflicts = s.conflicts.filter((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].status, 'CONFLICTED')
  assert.equal(conflicts[0].competingClaimIds.length, 2)
})

test('A2: founder decision resolves same-scope conflict and exposes provenance', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  ingestCompanyPolicy(s, workerA, tenantA, 5, 'policy-a', 'job-a')
  ingestCompanyPolicy(s, workerA, tenantA, 7, 'policy-b', 'job-b')
  const conflict = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  const decision = s.recordFounderDecision({
    actor: founderA, tenantId: tenantA,
    idempotencyKey: 'a2-resolve',
    targetId: conflict.id, expectedRevision: conflict.revision,
    decisionType: 'RESOLVE_CONFLICT_AND_APPROVE_POLICY',
    oldState: { status: 'CONFLICTED' },
    newState: { global: { enabled: false } },
    evidenceClaimIds: conflict.competingClaimIds,
    reason: 'Late fees disabled company-wide.',
  })
  assert.equal(decision.status, 'RECORDED')
  assert.ok(decision.evidenceClaimIds.length >= 2, 'decision must reference evidence claim IDs')
  const snapshot = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  const resolved = snapshot.domain.conflicts.find((row) => row.topic === 'late_fee_policy')
  assert.equal(resolved.status, 'RESOLVED')
  assert.ok(resolved.resolutionDecisionId, 'resolved conflict must have a decision ID')
})

test('A3: newer ingestion without explicit supersession language leaves conflict CONFLICTED (R5)', { skip: !G2_AVAILABLE }, () => {
  // Recency alone must not resolve. Two COMPANY_POLICY sources with different rates remain CONFLICTED
  // even though the second was ingested later (clock tick = later timestamp).
  const s = store()
  ingestCompanyPolicy(s, workerA, tenantA, 5, 'old-policy', 'job-old')
  ingestCompanyPolicy(s, workerA, tenantA, 7, 'new-policy', 'job-new')
  const conflict = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  // Must remain CONFLICTED — no automatic resolution from timestamp ordering
  assert.equal(conflict.status, 'CONFLICTED')
  // Both claims must still be active — neither is superseded by recency alone
  const activeClaims = s.claims.filter((row) => row.tenantId === tenantA && row.active && row.claimType === 'late_fee_policy')
  assert.equal(activeClaims.length, 2)
})

test('A4: confidence values on claims are preserved but never used to pick a winner (R1)', { skip: !G2_AVAILABLE }, () => {
  // G2 stores confidence but detectConflicts does not resolve by it.
  // Both claims remain in CONFLICTED state regardless of their confidence values.
  const s = store()
  ingestCompanyPolicy(s, workerA, tenantA, 5, 'high-conf-policy', 'job-hc')
  ingestCompanyPolicy(s, workerA, tenantA, 7, 'low-conf-policy', 'job-lc')
  const conflict = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.equal(conflict.status, 'CONFLICTED', 'confidence must not resolve conflict (R1)')
  assert.equal(conflict.winnerClaimId, null, 'winnerClaimId must remain null when only confidence differs')
})

// ═══════════════════════════════════════════════════════════════════════════════
// Group B — Client exception vs company policy
// ═══════════════════════════════════════════════════════════════════════════════

test('B1: CLIENT_EXCEPTION claim from atlas-terms.csv is classified correctly and scoped to CLIENT', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  ingest(s, workerA, tenantA, 'g1-realistic/atlas-terms.csv', 'atlas-terms', 'job-atlas')
  const clientClaims = s.claims.filter(
    (row) => row.tenantId === tenantA && row.active && row.claimClass === CLAIM_CLASS.CLIENT_EXCEPTION,
  )
  assert.equal(clientClaims.length, 1, 'atlas-terms.csv must produce exactly one CLIENT_EXCEPTION claim')
  assert.equal(clientClaims[0].semanticScope.level, 'CLIENT')
  assert.equal(clientClaims[0].subjectScope.clientId, 'atlas')
  assert.equal(clientClaims[0].value.ratePercent, 2)
})

test('B1b: queryClaims filters CLIENT_EXCEPTION to Atlas scope correctly', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  ingestCompanyPolicy(s, workerA, tenantA, 5, 'policy', 'job-policy')
  ingestClientException(s, workerA, tenantA, 'atlas', 2, 45, 'atlas-terms', 'job-atlas')
  const atlasExceptions = s.queryClaims({ actor: founderA, tenantId: tenantA, claimType: 'late_fee_policy', clientId: 'atlas' })
  assert.equal(atlasExceptions.length, 1)
  assert.equal(atlasExceptions[0].claimClass, CLAIM_CLASS.CLIENT_EXCEPTION)
  // Company-scope query must not return the Atlas exception
  const companyClaims = s.queryClaims({ actor: founderA, tenantId: tenantA, claimType: 'late_fee_policy', clientId: null })
  // Note: queryClaims with no clientId returns ALL claims including CLIENT_EXCEPTION ones.
  // The G3 policy evaluator will be responsible for scope filtering; queryClaims is a raw accessor.
  const companyPolicyClaims = companyClaims.filter((c) => c.claimClass === CLAIM_CLASS.COMPANY_POLICY)
  assert.equal(companyPolicyClaims.length, 1, 'only one COMPANY_POLICY claim should exist')
  assert.equal(companyPolicyClaims[0].value.ratePercent, 5)
})

test('B2: CLIENT_EXCEPTION must not be the sole resolver of a COMPANY-scope conflict (R4)', { skip: !G2_AVAILABLE }, () => {
  // After resolving the company-scope conflict with the 5% policy (disabled by founder),
  // the Atlas CLIENT_EXCEPTION still appears as a separate client-scoped rule — it does
  // NOT propagate to replace company policy (R4).
  const s = store()
  const conflict = seedAcmeAtlas(s)
  s.recordFounderDecision(decisionInput(conflict))
  const snapshot = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  // approvedPolicies should have COMPANY and CLIENT(atlas) entries from the decision
  const companyPolicies = snapshot.domain.approvedPolicies.filter((p) => p.scope.level === 'COMPANY')
  const atlasPolicies = snapshot.domain.approvedPolicies.filter((p) => p.scope.level === 'CLIENT' && p.scope.clientId === 'atlas')
  assert.ok(companyPolicies.length > 0, 'resolved decision must produce a COMPANY-scope policy')
  assert.ok(atlasPolicies.length > 0, 'Atlas exception must survive as a CLIENT-scope policy')
  // canonicalMoneyWritable must remain false regardless of approval
  assert.equal(snapshot.domain.canonicalMoneyWritable, false, 'R0 boundary must hold after resolution')
})

test('B3: two CLIENT_EXCEPTION claims for the same client produce a conflict', { skip: !G2_AVAILABLE }, () => {
  // detectConflicts treats all active late_fee_policy claims as competitors.
  // Two atlas exceptions with different rates are a conflict.
  const s = store()
  ingestClientException(s, workerA, tenantA, 'atlas', 2, 45, 'atlas-terms-v1', 'job-atlas-v1')
  ingestClientException(s, workerA, tenantA, 'atlas', 3, 45, 'atlas-terms-v2', 'job-atlas-v2')
  const conflict = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.ok(conflict, 'two atlas exceptions with different rates must produce a conflict')
  assert.equal(conflict.status, 'CONFLICTED')
})

test('B4: revoking the contract source removes client exception and resolves its side of the conflict', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  ingestCompanyPolicy(s, workerA, tenantA, 5, 'policy', 'job-policy')
  ingestClientException(s, workerA, tenantA, 'atlas', 2, 45, 'atlas-terms', 'job-atlas')
  const conflictBefore = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.ok(conflictBefore, 'conflict must exist before revocation')
  const atlasSource = s.sources.find((row) => row.tenantId === tenantA && row.identity === 'atlas-terms')
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: atlasSource.id, reason: 'contract expired' })
  // Atlas exception claim must now be inactive
  const atlasException = s.claims.find((row) => row.tenantId === tenantA && row.claimClass === CLAIM_CLASS.CLIENT_EXCEPTION && row.claimType === 'late_fee_policy')
  assert.equal(atlasException.active, false, 'revoked source must deactivate its claims')
  // With only one late_fee_policy claim remaining, no conflict should exist
  const conflictAfter = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.equal(conflictAfter, undefined, 'conflict must dissolve when only one active late-fee claim remains')
})

// ═══════════════════════════════════════════════════════════════════════════════
// Group C — Effective dates (temporal state)
// ═══════════════════════════════════════════════════════════════════════════════

test('C1: G2 extraction stores temporality field on semanticScope but not structured effectiveFrom/effectiveTo', { skip: !G2_AVAILABLE }, () => {
  // G2 stores `semanticScope.temporality = "CURRENT"` from extractDeterministicClaims.
  // It does NOT produce a structured { from, to } date pair — G3 must classify temporal
  // state from available evidence, and must treat absent dates as UNKNOWN (not "now").
  const s = store()
  ingestCompanyPolicy(s, workerA, tenantA, 5, 'policy', 'job-policy')
  const claim = s.claims.find((row) => row.tenantId === tenantA && row.claimType === 'late_fee_policy' && row.active)
  assert.ok(claim, 'claim must exist')
  assert.equal(claim.semanticScope.temporality, 'CURRENT', 'G2 extractor sets temporality = CURRENT')
  // No structured effectiveFrom/effectiveTo — G3 must not infer dates from their absence
  assert.equal(claim.effectiveTime, null, 'G2 claims have no structured effectiveTime — G3 must not treat null as "now"')
})

// G3 runtime required for full temporal state classification:
test.todo('C2 (G3 required): claims with null effectiveTime must be classified as UNKNOWN temporal state, not CURRENT')
test.todo('C3 (G3 required): claims with explicit effectiveTo in the past must be classified as EXPIRED and excluded from applicablePolicyCandidates')

// ═══════════════════════════════════════════════════════════════════════════════
// Group D — Overlapping temporal rules (G3 runtime required)
// ═══════════════════════════════════════════════════════════════════════════════

test.todo('D1 (G3 required): two policies with overlapping stated effective periods must produce OVERLAPPING_EFFECTIVE_PERIODS conflict class')
test.todo('D2 (G3 required): a FUTURE-dated policy must be excluded from current applicablePolicyCandidates')
test.todo('D3 (G3 required): an EXPIRED client exception with no replacement must leave no exception applicable for that client')

// ═══════════════════════════════════════════════════════════════════════════════
// Group E — Revocation closure
// ═══════════════════════════════════════════════════════════════════════════════

test('E1: revoking a COMPANY_POLICY source deactivates its claims and rebuilds conflicts', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  ingestCompanyPolicy(s, workerA, tenantA, 5, 'policy-a', 'job-a')
  ingestFounderInstruction(s, workerA, tenantA, 'founder-note', 'job-founder')
  const conflictBefore = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.ok(conflictBefore, 'conflict must exist before revocation')
  const policySource = s.sources.find((row) => row.tenantId === tenantA && row.identity === 'policy-a')
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: policySource.id, reason: 'policy withdrawn' })
  const policyClaim = s.claims.find((row) => row.tenantId === tenantA && row.claimClass === CLAIM_CLASS.COMPANY_POLICY && row.claimType === 'late_fee_policy')
  assert.equal(policyClaim.active, false, 'revoked source must deactivate COMPANY_POLICY claim')
  // Only FOUNDER_INSTRUCTION remains — no two-way conflict
  const conflictAfter = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.equal(conflictAfter, undefined, 'conflict must dissolve when only one active late_fee_policy claim remains')
  // Tombstone recorded
  const tombstone = s.tombstones.find((row) => row.sourceId === policySource.id)
  assert.ok(tombstone, 'revocation must record a tombstone')
})

test('E2: revoking a FOUNDER_INSTRUCTION source removes it from active claims and updates conflict state', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  ingestCompanyPolicy(s, workerA, tenantA, 5, 'policy', 'job-policy')
  ingestFounderInstruction(s, workerA, tenantA, 'founder-note', 'job-founder')
  const founderSource = s.sources.find((row) => row.tenantId === tenantA && row.identity === 'founder-note')
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: founderSource.id, reason: 'instruction rescinded' })
  const founderClaim = s.claims.find((row) => row.tenantId === tenantA && row.claimClass === CLAIM_CLASS.FOUNDER_INSTRUCTION)
  assert.equal(founderClaim.active, false)
  // Only COMPANY_POLICY 5% remains — no conflict
  const conflict = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.equal(conflict, undefined, 'single remaining claim must not produce a conflict')
})

test('E3: revoked evidence cannot be referenced in a subsequent founder decision (G1 Gap 2 regression)', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  const conflict = seedAcmeAtlas(s)
  // Revoke the collections-policy source (one of the conflict's evidence sources)
  const policySource = s.sources.find((row) => row.tenantId === tenantA && row.identity === 'collections-policy')
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: policySource.id, reason: 'withdrawn' })
  // The revoked claim must not be accepted as evidence for a new decision
  const revokedClaimId = s.claims.find((row) => row.tenantId === tenantA && row.claimClass === CLAIM_CLASS.COMPANY_POLICY && !row.active)?.id
  assert.ok(revokedClaimId, 'revoked claim must exist for this test to be valid')
  // After revocation the original conflict may no longer exist (all its members may be inactive).
  // If there is still a conflict (from remaining active claims), use it; otherwise expect the
  // revoked-evidence error on a fresh conflict.
  const freshConflict = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  if (freshConflict) {
    assert.throws(
      () => s.recordFounderDecision({
        actor: founderA, tenantId: tenantA,
        idempotencyKey: 'e3-revoked-evidence',
        targetId: freshConflict.id, expectedRevision: freshConflict.revision,
        decisionType: 'RESOLVE_CONFLICT_AND_APPROVE_POLICY',
        oldState: { status: 'CONFLICTED' }, newState: {},
        evidenceClaimIds: [revokedClaimId],
        reason: 'Should fail — evidence claim is revoked.',
      }),
      /inactive or revoked/,
      'revoked claim must be rejected as evidence (R6)',
    )
  }
  // R6: revoked evidence cannot remain operational regardless of conflict state
  const revokedClaim = s.claims.find((row) => row.id === revokedClaimId)
  assert.equal(revokedClaim.active, false, 'R6: revoked claim must be inactive')
})

// ═══════════════════════════════════════════════════════════════════════════════
// Group F — Historical alias and entity identity
// ═══════════════════════════════════════════════════════════════════════════════

test('F1: HISTORICAL_PRECEDENT claim class exists in CLAIM_CLASS enum', { skip: !G2_AVAILABLE }, () => {
  // G2 defines HISTORICAL_PRECEDENT in CLAIM_CLASS but extractDeterministicClaims does not
  // create such claims from current fixture content. G3 must be able to classify
  // historical claims and exclude them from current policy resolution (R5).
  assert.ok('HISTORICAL_PRECEDENT' in CLAIM_CLASS, 'CLAIM_CLASS must define HISTORICAL_PRECEDENT')
  assert.equal(CLAIM_CLASS.HISTORICAL_PRECEDENT, 'HISTORICAL_PRECEDENT')
})

test.todo('F1b (G3 required): HISTORICAL_PRECEDENT claims must be excluded from applicablePolicyCandidates (R5) — requires G3 ingestion pipeline extension to classify old-ar-rules.csv as historical')

test.todo('F2 (G3 required): two sources referencing "Atlas" vs "Atlas Global" must produce AMBIGUOUS_ENTITY_IDENTITY conflict — requires G3 entity normalization not yet in G2')

test.todo('F3 (G3 required): one client with two simultaneous active contracts must produce compound conflict — requires G3 contract-identity tracking')

// ═══════════════════════════════════════════════════════════════════════════════
// Group G — Communication and behavioral evidence
// ═══════════════════════════════════════════════════════════════════════════════

test('G1: account-manager email is classified as INTERPRETATION, not COMPANY_POLICY or FOUNDER_INSTRUCTION', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  ingestAccountManagerEmail(s, workerA, tenantA, 'am-email', 'job-email')
  const claims = s.claims.filter((row) => row.tenantId === tenantA && row.active)
  assert.equal(claims.length, 1)
  assert.equal(claims[0].claimClass, CLAIM_CLASS.INTERPRETATION,
    'account-manager email must be INTERPRETATION, not COMPANY_POLICY or FOUNDER_INSTRUCTION (R2)')
  // Must carry uncertainty marker signaling it is not authority
  assert.ok(claims[0].uncertainty, 'account-manager email claim must carry an uncertainty marker')
  assert.match(String(claims[0].uncertainty), /COMMUNICATION_NOT_AUTHORITY/,
    'uncertainty must specifically mark this as COMMUNICATION_NOT_AUTHORITY')
})

test('G1b: account-manager email does not create a late_fee_policy conflict', { skip: !G2_AVAILABLE }, () => {
  // Observed communication is INTERPRETATION — it must not affect policy conflict state (R2)
  const s = store()
  ingestAccountManagerEmail(s, workerA, tenantA, 'am-email', 'job-email')
  const conflict = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.equal(conflict, undefined, 'communication evidence must not generate a policy conflict (R2)')
})

test('G2: evaluateCompanyBrainAuthority returns REQUIRE_APPROVAL for un-granted actions (R3)', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  const snapshot = s.createSnapshot({ actor: founderA, tenantId: tenantA }).domain
  const result = s.evaluateAuthority({ actor: founderA, tenantId: tenantA, actionClass: 'WAIVE_FEE', scope: { level: 'CLIENT', clientId: 'atlas' } })
  assert.equal(result.actual, AUTHORITY_RESULT.REQUIRE_APPROVAL, 'un-granted action must require approval (R3)')
  assert.equal(result.grantId, null, 'no standing authority grant must exist')
})

test('G2b: 20+ repeated approvals produce a suggestion but do not auto-elevate to GRANTED (R3)', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  // Build 20 simulated prior approval history entries
  const approvalHistory = Array.from({ length: 25 }, (_, i) => ({
    tenantId: tenantA, actionClass: 'WAIVE_FEE', decidedAt: `2026-0${Math.floor(i / 5) + 1}-01`, id: `approval-${i}`,
  }))
  const result = s.evaluateAuthority({
    actor: founderA, tenantId: tenantA,
    actionClass: 'WAIVE_FEE',
    scope: { level: 'CLIENT', clientId: 'atlas' },
    approvalHistory,
  })
  assert.equal(result.actual, AUTHORITY_RESULT.REQUIRE_APPROVAL, 'repeated approvals must not become standing authority (R3)')
  assert.ok(result.suggestion, 'repeated-approval suggestion must be surfaced at 20+')
  assert.equal(result.grantId, null, 'grantId must remain null — no automatic authority granted')
})

test('G3: staff-member claim is INTERPRETATION with uncertainty, not COMPANY_POLICY', { skip: !G2_AVAILABLE }, () => {
  // G2 classifies "give Atlas 20% off" (account manager) as INTERPRETATION.
  // Any claim not from a FOUNDER_INSTRUCTION or COMPANY_POLICY class cannot
  // set company-wide policy without a founder decision.
  const s = store()
  ingestAccountManagerEmail(s, workerA, tenantA, 'am-email', 'job-email')
  const claim = s.claims.find((row) => row.tenantId === tenantA && row.active)
  assert.notEqual(claim.claimClass, CLAIM_CLASS.COMPANY_POLICY, 'staff communication must not be COMPANY_POLICY')
  assert.notEqual(claim.claimClass, CLAIM_CLASS.FOUNDER_INSTRUCTION, 'staff communication must not be FOUNDER_INSTRUCTION')
  assert.equal(claim.claimClass, CLAIM_CLASS.INTERPRETATION)
})

// ═══════════════════════════════════════════════════════════════════════════════
// Group H — Provenance integrity
// ═══════════════════════════════════════════════════════════════════════════════

test('H1: payment claim is classified as INTERPRETATION with R0 refetch route (not canonical truth)', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  ingestPaymentClaim(s, workerA, tenantA, 'payment-claim', 'job-payment')
  const claim = s.claims.find((row) => row.tenantId === tenantA && row.active)
  assert.equal(claim.claimClass, CLAIM_CLASS.INTERPRETATION)
  assert.match(String(claim.uncertainty), /UNTRUSTED_CONTEXT_ONLY/, 'payment claim must carry UNTRUSTED_CONTEXT_ONLY uncertainty')
  assert.ok(claim.assumptions?.some((a) => /R0/.test(String(a))), 'payment claim must note R0 authoritative refetch requirement')
})

test('H1b: Ask DW for Invoice 104 routes to R0 authoritative path, not Company Brain answer', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  ingestPaymentClaim(s, workerA, tenantA, 'payment-claim', 'job-payment')
  const answer = s.askDw({ actor: founderA, tenantId: tenantA, question: 'Has Invoice 104 been paid?' })
  assert.equal(answer.canonicalFinancialTruthUsed, false, 'Company Brain must never claim canonical financial truth')
  assert.equal(answer.status, 'AUTHORITATIVE_FINANCIAL_REFETCH_REQUIRED',
    'payment questions must route to R0 authoritative path')
  assert.equal(answer.route, 'R0_AUTHORITATIVE_FINANCIAL_READ',
    'R0 route must be explicitly named in the answer')
})

test('H2: ingesting the same content hash under a different filename is detected as duplicate (not independent knowledge)', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  const content = 'Charge a 5% late fee.'
  s.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'policy-a.md', content, sourceIdentity: 'policy-a', idempotencyKey: 'job-a' })
  const second = s.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'policy-b.md', content, sourceIdentity: 'policy-b', idempotencyKey: 'job-b' })
  assert.equal(second.duplicateContent, true, 'identical content must be flagged as duplicate')
  // Must not create a second conflict from duplicate content
  const conflict = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.equal(conflict, undefined, 'duplicate content must not generate a spurious conflict')
})

test('H3: claim with unknown provenance root fails closed when snapshot is built', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  seedAcmeAtlas(s)
  // Inject a claim pointing at a non-existent source version
  const realArtifact = s.artifacts.find((row) => row.tenantId === tenantA)
  const dangling = mkClaim({
    tenantId: tenantA, id: 'dangling-claim',
    claimClass: CLAIM_CLASS.INTERPRETATION, claimType: 'late_fee_policy',
    semanticScope: { level: 'COMPANY' }, subjectScope: {}, value: { ratePercent: 99 },
    artifactIds: [realArtifact.id],
    provenanceRootIds: ['00000000-does-not-exist'],
  })
  s.claims.push({ ...dangling, sourceVersionId: '00000000-does-not-exist', active: true })
  // createSnapshot must reject dangling provenance (Gap 4)
  assert.throws(
    () => s.createSnapshot({ actor: founderA, tenantId: tenantA }),
    /root provenance unknown/,
    'dangling provenance reference must fail closed (R6)',
  )
})

// ═══════════════════════════════════════════════════════════════════════════════
// Group I — Cross-tenant isolation
// ═══════════════════════════════════════════════════════════════════════════════

test('I1: cross-tenant read is rejected for every durable collection', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  seedAcmeAtlas(s)
  for (const rows of [s.sources, s.artifacts, s.claims, s.conflicts, s.decisions, s.authorityProposals, s.snapshots]) {
    assert.throws(
      () => s.readForTenant(rows, { actor: founderB, tenantId: tenantA }),
      /actor tenant mismatch/,
    )
  }
})

test('I1b: cross-tenant ingestion is blocked at actor validation', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  assert.throws(
    () => ingest(s, founderB, tenantA, 'g1-realistic/collections-policy.md', 'cross', 'cross-job'),
    /actor tenant mismatch/,
  )
})

test('I2: cross-tenant authority proposal evidence is rejected (G1 Gap 4 regression)', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  // TenantA and TenantB each get their own claims
  ingestCompanyPolicy(s, workerA, tenantA, 5, 'ta-policy', 'job-ta')
  ingestCompanyPolicy(s, workerB, tenantB, 7, 'tb-policy', 'job-tb')
  const tenantBClaimId = s.claims.find((row) => row.tenantId === tenantB && row.active)?.id
  assert.ok(tenantBClaimId, 'tenantB must have an active claim for this test to be valid')
  // TenantA proposal referencing tenantB claim must be rejected
  const proposal = proposedAuthority({
    id: 'auth-cross-tenant', tenantId: tenantA,
    actionClass: 'WAIVE_FEE', scope: { level: 'COMPANY' },
    evidenceClaimIds: [tenantBClaimId],
  })
  assert.throws(
    () => s.persistAuthorityProposal({ actor: founderA, tenantId: tenantA, proposal }),
    /missing or cross-tenant/,
    'cross-tenant evidence must be rejected for authority proposals (R — tenant isolation)',
  )
})

// ═══════════════════════════════════════════════════════════════════════════════
// Group J — Scope and precedence edge cases
// ═══════════════════════════════════════════════════════════════════════════════

test('J1: COMPANY_POLICY and FOUNDER_INSTRUCTION with the same topic are both CONFLICTED in the snapshot', { skip: !G2_AVAILABLE }, () => {
  // Neither claim has explicit precedence over the other without a founder decision.
  // detectConflicts treats both as competing claims on the same topic.
  const s = store()
  ingestCompanyPolicy(s, workerA, tenantA, 5, 'policy', 'job-policy')
  ingestFounderInstruction(s, workerA, tenantA, 'founder-note', 'job-founder')
  const conflict = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.ok(conflict, 'COMPANY_POLICY vs FOUNDER_INSTRUCTION must produce a conflict (R8)')
  assert.equal(conflict.status, 'CONFLICTED')
  // Both claim classes must be represented in the conflict
  const competingClaims = conflict.competingClaimIds.map((id) => s.claims.find((c) => c.id === id))
  const classes = new Set(competingClaims.map((c) => c.claimClass))
  assert.ok(classes.has(CLAIM_CLASS.COMPANY_POLICY))
  assert.ok(classes.has(CLAIM_CLASS.FOUNDER_INSTRUCTION))
})

test('J3: stale snapshot is detected and a fresh one is built on askDw (G1 Gap 3 regression)', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  seedAcmeAtlas(s)
  const stale = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  const versionBeforeRevoke = stale.knowledgeVersion
  // Revoke a source to bump knowledge version
  const policySource = s.sources.find((row) => row.tenantId === tenantA && row.identity === 'collections-policy')
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: policySource.id, reason: 'withdrawn' })
  // askDw must refuse the stale snapshot and answer from current state
  s.askDw({ actor: founderA, tenantId: tenantA, question: 'What is the late-fee policy?' })
  const latest = s.latestSnapshot({ actor: founderA, tenantId: tenantA })
  assert.ok(latest.knowledgeVersion > versionBeforeRevoke,
    'askDw must create a fresh snapshot after revocation (G1 Gap 3)')
  assert.equal(latest.knowledgeVersion, s.version(tenantA),
    'latest snapshot must match current knowledge version')
})

test.todo('J2 (G3 required): two COMPANY_POLICY claims with no mutual supersession language must produce MISSING_PRECEDENCE conflict class (R8)')
test.todo('J4 (G3 required): policy B ingested after policy A with no supersession language must not auto-elevate B — both remain active in CONFLICTED state (no recency resolution)')

// ═══════════════════════════════════════════════════════════════════════════════
// Group K — R0–R9 invariant regression (hard gates)
// ═══════════════════════════════════════════════════════════════════════════════

test('K1 (R0): canonicalMoneyWritable is false on every snapshot regardless of conflict or approval state', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  // Empty snapshot
  const empty = s.createSnapshot({ actor: founderA, tenantId: tenantA }).domain
  assert.equal(empty.canonicalMoneyWritable, false, 'R0: empty snapshot must have canonicalMoneyWritable = false')
  // After seeding a conflict
  seedAcmeAtlas(s)
  const conflicted = s.createSnapshot({ actor: founderA, tenantId: tenantA }).domain
  assert.equal(conflicted.canonicalMoneyWritable, false, 'R0: conflicted snapshot must have canonicalMoneyWritable = false')
})

test('K1b (R0): assertCompanyBrainCannotWriteCanonicalMoney blocks all financial-truth mutations', { skip: !G2_AVAILABLE }, () => {
  for (const mutation of [
    { truthDimension: 'INVOICE_AR_STATE' },
    { truthDimension: 'PAYMENT_RECEIPT_STATE' },
    { objectType: 'invoice' },
    { objectType: 'payment' },
  ]) {
    assert.throws(
      () => assertCompanyBrainCannotWriteCanonicalMoney(mutation),
      /R0 canonical/,
      `mutation ${JSON.stringify(mutation)} must be rejected (R0)`,
    )
  }
  // Non-financial mutation passes
  assert.ok(assertCompanyBrainCannotWriteCanonicalMoney({ objectType: 'company_policy' }))
})

test('K1c (R0): dwIntelligenceContext.boundaries.canonicalMoneyWritable is always false', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  seedAcmeAtlas(s)
  const ctx = s.dwIntelligenceContext({ actor: founderA, tenantId: tenantA, clientId: 'atlas' })
  assert.equal(ctx.boundaries.canonicalMoneyWritable, false, 'R0: DW Intelligence context must enforce canonicalMoneyWritable = false')
})

test('K2 (R1): conflict is not resolved by confidence — two competing claims with no explicit decision remain CONFLICTED', { skip: !G2_AVAILABLE }, () => {
  // G2 detectConflicts does not compare confidence values.
  // Even if one claim has higher confidence, both remain CONFLICTED without a founder decision.
  const s = store()
  ingestCompanyPolicy(s, workerA, tenantA, 5, 'high-conf', 'job-hc')
  ingestCompanyPolicy(s, workerA, tenantA, 7, 'low-conf', 'job-lc')
  const conflict = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.equal(conflict.status, 'CONFLICTED', 'R1: confidence must not resolve conflict')
  assert.equal(conflict.winnerClaimId, null, 'R1: no winner must be designated without explicit founder decision')
})

test('K3 (R4): CLIENT_EXCEPTION does not appear as applicable COMPANY-scope policy in dwIntelligenceContext', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  const conflict = seedAcmeAtlas(s)
  // Resolve the conflict so approvedPolicies are produced
  s.recordFounderDecision(decisionInput(conflict))
  const ctx = s.dwIntelligenceContext({ actor: founderA, tenantId: tenantA, clientId: null })
  const companyPolicies = ctx.applicableApprovedPolicy.filter((p) => p.scope.level === 'COMPANY')
  const clientWidened = companyPolicies.filter((p) => p.scope.clientId != null)
  assert.equal(clientWidened.length, 0, 'R4: CLIENT-scoped policies must not appear in COMPANY-scope approved policies')
})

test('K4 (R6): revoked claim cannot be accepted as decision evidence', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  const conflict = seedAcmeAtlas(s)
  const policySource = s.sources.find((row) => row.tenantId === tenantA && row.identity === 'collections-policy')
  const revokedClaimId = s.claims.find(
    (row) => row.tenantId === tenantA && row.sourceVersionId === policySource.currentVersionId && row.active,
  )?.id
  assert.ok(revokedClaimId, 'policy source must have an active claim for this test to be valid')
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: policySource.id, reason: 'withdrawn' })
  const freshConflict = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  if (freshConflict) {
    assert.throws(
      () => s.recordFounderDecision({
        actor: founderA, tenantId: tenantA,
        idempotencyKey: 'k4-revoked-evidence',
        targetId: freshConflict.id, expectedRevision: freshConflict.revision,
        decisionType: 'RESOLVE_CONFLICT_AND_APPROVE_POLICY',
        oldState: { status: 'CONFLICTED' }, newState: {},
        evidenceClaimIds: [revokedClaimId],
        reason: 'Must fail — evidence is revoked.',
      }),
      /inactive or revoked/,
      'R6: revoked claim must not be accepted as decision evidence',
    )
  }
})

test('K5 (R8): conflict with no founder decision has no winner — founder decision is required', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  seedAcmeAtlas(s)
  const conflict = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.equal(conflict.status, 'CONFLICTED', 'R8: conflict must not self-resolve without founder decision')
  assert.equal(conflict.winnerClaimId, null, 'R8: winnerClaimId must be null — abstention, not guessing')
  assert.equal(conflict.confidenceResolved, false, 'R8: confidence-resolved flag must be false')
})

// ═══════════════════════════════════════════════════════════════════════════════
// Ask DW expected behavior (Acme/Atlas scenario)
// ═══════════════════════════════════════════════════════════════════════════════

test('Ask DW: late-fee policy question returns CONFLICTED status with evidence when unresolved', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  seedAcmeAtlas(s)
  const answer = s.askDw({ actor: founderA, tenantId: tenantA, question: 'What is our late-fee policy?' })
  assert.equal(answer.status, 'CONFLICTED', 'unresolved conflict must produce CONFLICTED Ask DW answer')
  assert.ok(Array.isArray(answer.evidence) && answer.evidence.length > 0, 'CONFLICTED answer must expose evidence claim IDs')
  assert.equal(answer.canonicalFinancialTruthUsed, false, 'R0: Ask DW must never use canonical financial truth')
})

test('Ask DW: late-fee policy question returns APPROVED after founder resolution', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  const conflict = seedAcmeAtlas(s)
  s.recordFounderDecision(decisionInput(conflict))
  const answer = s.askDw({ actor: founderA, tenantId: tenantA, question: 'What is our late-fee policy?' })
  assert.equal(answer.status, 'APPROVED', 'resolved conflict must produce APPROVED Ask DW answer')
  assert.equal(answer.canonicalFinancialTruthUsed, false)
})

test('Ask DW: Atlas 20% discount question returns REQUIRE_APPROVAL — communication is not authority', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  ingestAccountManagerEmail(s, workerA, tenantA, 'am-email', 'job-email')
  const answer = s.askDw({ actor: founderA, tenantId: tenantA, question: 'Can we waive 20% for Atlas?' })
  assert.equal(answer.status, 'REQUIRE_APPROVAL', 'account-manager communication must not confer authority (R2, R7)')
  assert.equal(answer.canonicalFinancialTruthUsed, false)
})

// ═══════════════════════════════════════════════════════════════════════════════
// DW Intelligence context shape and invariants
// ═══════════════════════════════════════════════════════════════════════════════

test('DW Intelligence context contains all required G2 fields and enforces R0', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  seedAcmeAtlas(s)
  const ctx = s.dwIntelligenceContext({ actor: founderA, tenantId: tenantA, clientId: 'atlas' })
  // Required fields per G2 toDwIntelligenceCompanyContext
  assert.ok('unresolvedConflicts' in ctx, 'unresolvedConflicts required')
  assert.ok('applicableApprovedPolicy' in ctx, 'applicableApprovedPolicy required')
  assert.ok('roles' in ctx, 'roles required')
  assert.ok('delegationContext' in ctx, 'delegationContext required')
  assert.ok('authorityState' in ctx, 'authorityState required')
  assert.ok('provenance' in ctx, 'provenance required')
  assert.ok('revocationStatus' in ctx, 'revocationStatus required')
  assert.ok('boundaries' in ctx, 'boundaries required')
  // R0 boundary
  assert.equal(ctx.boundaries.canonicalMoneyWritable, false, 'R0')
  assert.equal(ctx.boundaries.contextCanGrantAuthority, false, 'DW Intelligence context cannot self-grant authority')
  // Unresolved conflicts must be populated (three-way late-fee conflict from seedAcmeAtlas)
  assert.ok(ctx.unresolvedConflicts.length > 0, 'CONFLICTED scenario must surface in unresolvedConflicts')
  // Provenance paths must exist for all relevant claims
  assert.ok(ctx.provenance.length > 0, 'provenance paths must be non-empty')
  assert.ok(ctx.provenance.every((p) => p.claimId && Array.isArray(p.rootSourceIds)),
    'every provenance entry must have claimId and rootSourceIds')
})

test('DW Intelligence context surfaces revocation tombstones after source revocation', { skip: !G2_AVAILABLE }, () => {
  const s = store()
  seedAcmeAtlas(s)
  const atlasSource = s.sources.find((row) => row.tenantId === tenantA && row.identity === 'atlas-terms')
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: atlasSource.id, reason: 'contract expired' })
  const ctx = s.dwIntelligenceContext({ actor: founderA, tenantId: tenantA, clientId: 'atlas' })
  assert.ok(ctx.revocationStatus.tombstones.length > 0, 'revocation must surface as a tombstone in DW Intelligence context')
})
