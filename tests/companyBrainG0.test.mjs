import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AUTHORITY_RESULT,
  AUTHORITY_STATUS,
  CLAIM_CLASS,
  answerAskDwFromCompanyBrain,
  assertCompanyBrainCannotWriteCanonicalMoney,
  buildBrainSnapshot,
  buildOperatingModel,
  createArtifact,
  createAuthorityProposal,
  createClaim,
  createFounderDecision,
  createSource,
  decideAuthorityProposal,
  detectConflicts,
  evaluateCompanyBrainAuthority,
  revokeRootSource,
  toDwIntelligenceCompanyContext,
} from '../src/lib/companyBrain/index.js'
import { FIXTURE_FILES, ingestCompanyBrainFixture } from '../src/lib/companyBrain/fixtureIngestion.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureDirectory = path.resolve(here, '../fixtures/company-brain/acme-ar-ops')
const tenantId = 'tenant-acme'
const fixture = ingestCompanyBrainFixture({ fixtureDirectory, tenantId })

function snapshot(overrides = {}) {
  return buildBrainSnapshot({ ...fixture, decisions: [], authorityProposals: [], tombstones: [], ...overrides })
}

function founderDecision() {
  return createFounderDecision({
    id: 'decision-late-fee-v1',
    tenantId,
    actorId: 'founder-1',
    actorRole: 'FOUNDER',
    decidedAt: '2026-08-30T13:00:00.000Z',
    decisionType: 'RESOLVE_CONFLICT_AND_APPROVE_POLICY',
    target: 'late_fee_policy',
    oldState: { status: 'CONFLICTED' },
    newState: { global: { enabled: false }, atlas: { ratePercent: 2, onlyWhenApplicable: true }, dwAuthority: 'REQUIRE_EXPLICIT_AUTHORITY' },
    evidenceClaimIds: ['claim-founder-disable-late-fees', 'claim-atlas-late-fee-2'],
    reason: 'Late fees stay disabled globally; preserve the applicable Atlas contract exception.',
    revocable: true,
  })
}

test('G0 fixture pack is complete and deterministic', () => {
  assert.deepEqual(FIXTURE_FILES, [
    'collections-sop.md', 'customer-contract-atlas.md', 'old-ar-rules.csv', 'founder-note.md',
    'roles.md', 'atlas-history.md', 'account-manager-email.md', 'payment-claim.md',
  ])
  assert.equal(fixture.sources.length, 8)
  assert.equal(fixture.artifacts.length, 8)
  assert.equal(fixture.claims.length, 15)
  assert.equal(ingestCompanyBrainFixture({ fixtureDirectory, tenantId }).sources[0].contentHash, fixture.sources[0].contentHash)
})

test('ingestion classifies artifacts and attaches stable root provenance', () => {
  for (const artifact of fixture.artifacts) {
    assert.equal(artifact.tenantId, tenantId)
    assert.equal(artifact.rootSourceIds.length, 1)
    assert.equal(artifact.rootSourceIds[0], artifact.sourceId)
  }
  for (const claim of fixture.claims) {
    assert.equal(claim.tenantId, tenantId)
    assert.ok(claim.provenanceRootIds.length > 0)
    assert.ok(claim.artifactIds.length > 0)
  }
})

test('cross-tenant claim lookup fails closed', () => {
  assert.throws(() => buildBrainSnapshot({ ...fixture, tenantId: 'tenant-other' }), /tenant mismatch/)
})

test('source-less durable claim is rejected', () => {
  assert.throws(() => createClaim({ tenantId, id: 'bad', claimClass: CLAIM_CLASS.COMPANY_POLICY, claimType: 'late_fee_policy', artifactIds: ['a'], value: 5 }), /root provenance/)
})

test('unknown provenance fails closed', () => {
  const bad = createClaim({ tenantId, id: 'bad-root', claimClass: CLAIM_CLASS.COMPANY_POLICY, claimType: 'late_fee_policy', artifactIds: [fixture.artifacts[0].id], provenanceRootIds: ['missing-source'], value: 5 })
  assert.throws(() => snapshot({ claims: [...fixture.claims, bad] }), /root provenance unknown/)
})

test('Company Brain claim constructors reject canonical financial truth', () => {
  assert.throws(() => createClaim({ tenantId, id: 'money', claimClass: CLAIM_CLASS.INTERPRETATION, claimType: 'PAYMENT_RECEIPT_STATE', artifactIds: ['a'], provenanceRootIds: ['s'], value: true }), /cannot create canonical money truth/)
})

test('company memory cannot write canonical money truth', () => {
  assert.throws(() => assertCompanyBrainCannotWriteCanonicalMoney({ truthDimension: 'INVOICE_AR_STATE', objectType: 'invoice' }), /read-only/)
  assert.equal(assertCompanyBrainCannotWriteCanonicalMoney({ objectType: 'operating_rule_candidate' }), true)
})

test('contextual paid statement does not create canonical payment fact', () => {
  const paid = fixture.claims.find((claim) => claim.id === 'claim-invoice-104-paid-context')
  assert.equal(paid.canonicalFinancialTruth, false)
  assert.equal(paid.claimClass, CLAIM_CLASS.INTERPRETATION)
  assert.match(paid.uncertainty, /UNTRUSTED/)
})

test('model confidence cannot resolve the late-fee conflict', () => {
  const claims = fixture.claims.map((claim) => ({ ...claim, confidence: claim.id === 'claim-late-fee-sop-5' ? 1 : 0.1 }))
  const conflicts = detectConflicts(claims)
  assert.equal(conflicts[0].status, 'CONFLICTED')
  assert.equal(conflicts[0].winnerClaimId, null)
  assert.equal(conflicts[0].confidenceResolved, false)
})

test('client exception does not silently become company-wide policy', () => {
  const brain = snapshot({ decisions: [founderDecision()] })
  const atlas = toDwIntelligenceCompanyContext({ snapshot: brain, clientId: 'atlas' })
  const globex = toDwIntelligenceCompanyContext({ snapshot: brain, clientId: 'globex' })
  assert.equal(atlas.applicableApprovedPolicy.length, 2)
  assert.equal(globex.applicableApprovedPolicy.length, 1)
  assert.equal(globex.applicableApprovedPolicy[0].scope.level, 'COMPANY')
})

test('historical rule does not silently beat newer explicit instruction', () => {
  const brain = snapshot()
  const conflict = brain.conflicts[0]
  assert.equal(conflict.status, 'CONFLICTED')
  assert.ok(conflict.competingClaimIds.includes('claim-late-fee-old-10'))
  assert.ok(conflict.competingClaimIds.includes('claim-founder-disable-late-fees'))
  assert.equal(conflict.winnerClaimId, null)
})

test('account-manager settlement statement does not create settlement authority', () => {
  const brain = snapshot()
  const answer = answerAskDwFromCompanyBrain({ snapshot: brain, question: 'Can DW waive 20% for Atlas?' })
  assert.equal(answer.status, 'REQUIRE_APPROVAL')
  assert.match(answer.answer, /not settlement authority/i)
})

test('proposal is not approval', () => {
  const proposal = createAuthorityProposal({ id: 'auth-atlas-waive', tenantId, actionClass: 'WAIVE_SETTLEMENT', scope: { level: 'CLIENT', clientId: 'atlas' }, evidenceClaimIds: ['claim-delegation-founder-settlement'] })
  assert.equal(proposal.status, AUTHORITY_STATUS.PROPOSED)
  const brain = snapshot({ authorityProposals: [proposal] })
  assert.equal(evaluateCompanyBrainAuthority({ snapshot: brain, actionClass: 'WAIVE_SETTLEMENT', scope: { level: 'CLIENT', clientId: 'atlas' } }).actual, AUTHORITY_RESULT.REQUIRE_APPROVAL)
})

test('20 repeated approvals do not auto-promote authority', () => {
  const history = Array.from({ length: 20 }, (_, index) => ({ tenantId, actionClass: 'WAIVE_SETTLEMENT', caseId: `case-${index}` }))
  const result = evaluateCompanyBrainAuthority({ snapshot: snapshot(), actionClass: 'WAIVE_SETTLEMENT', scope: { level: 'CLIENT', clientId: 'atlas' }, approvalHistory: history })
  assert.equal(result.actual, AUTHORITY_RESULT.REQUIRE_APPROVAL)
  assert.equal(result.requiresApproval, true)
  assert.match(result.suggestion, /standing policy/)
})

test('explicit standing authority grant works only in exact scope', () => {
  const proposed = createAuthorityProposal({ id: 'auth-atlas-discuss', tenantId, actionClass: 'DISCUSS_INVOICE', scope: { level: 'CLIENT', clientId: 'atlas' }, evidenceClaimIds: ['claim-delegation-account-manager'] })
  const approved = decideAuthorityProposal(proposed, { actorId: 'founder-1', actorRole: 'FOUNDER', decidedAt: '2026-08-30T13:10:00.000Z', decision: AUTHORITY_STATUS.APPROVED })
  const brain = snapshot({ authorityProposals: [approved] })
  assert.equal(evaluateCompanyBrainAuthority({ snapshot: brain, actionClass: 'DISCUSS_INVOICE', scope: { level: 'CLIENT', clientId: 'atlas' } }).actual, AUTHORITY_RESULT.GRANTED)
  assert.equal(evaluateCompanyBrainAuthority({ snapshot: brain, actionClass: 'DISCUSS_INVOICE', scope: { level: 'CLIENT', clientId: 'globex' } }).actual, AUTHORITY_RESULT.REQUIRE_APPROVAL)
  assert.equal(evaluateCompanyBrainAuthority({ snapshot: brain, actionClass: 'WAIVE_SETTLEMENT', scope: { level: 'CLIENT', clientId: 'atlas' } }).actual, AUTHORITY_RESULT.REQUIRE_APPROVAL)
})

test('authority revocation takes effect', () => {
  const proposed = createAuthorityProposal({ id: 'auth-atlas-discuss', tenantId, actionClass: 'DISCUSS_INVOICE', scope: { level: 'CLIENT', clientId: 'atlas' }, evidenceClaimIds: ['claim-delegation-account-manager'] })
  const approved = decideAuthorityProposal(proposed, { actorId: 'founder-1', actorRole: 'FOUNDER', decidedAt: '2026-08-30T13:10:00.000Z', decision: AUTHORITY_STATUS.APPROVED })
  const revoked = decideAuthorityProposal(approved, { actorId: 'founder-1', actorRole: 'FOUNDER', decidedAt: '2026-08-30T13:20:00.000Z', decision: AUTHORITY_STATUS.REVOKED })
  const brain = snapshot({ authorityProposals: [revoked] })
  assert.equal(evaluateCompanyBrainAuthority({ snapshot: brain, actionClass: 'DISCUSS_INVOICE', scope: { level: 'CLIENT', clientId: 'atlas' } }).actual, AUTHORITY_RESULT.REQUIRE_APPROVAL)
})

test('founder decision updates snapshot only in explicit scope', () => {
  const before = snapshot()
  const after = snapshot({ decisions: [founderDecision()] })
  assert.notEqual(after.id, before.id)
  assert.equal(before.approvedPolicies.length, 0)
  assert.equal(after.approvedPolicies.length, 2)
  assert.equal(after.approvedAuthority.length, 0)
  assert.equal(after.approvedPolicies.find((item) => item.scope.level === 'COMPANY').value.enabled, false)
})

test('conflict remains inspectable after founder resolution', () => {
  const conflict = snapshot({ decisions: [founderDecision()] }).conflicts[0]
  assert.equal(conflict.status, 'RESOLVED')
  assert.equal(conflict.resolutionDecisionId, 'decision-late-fee-v1')
  assert.ok(conflict.competingClaimIds.length >= 4)
  assert.equal(conflict.winnerClaimId, null)
})

test('revoked root cannot influence active snapshot and provenance remains auditable', () => {
  const revoked = revokeRootSource({ sources: fixture.sources, sourceId: 'source-founder-note', tenantId, revokedAt: '2026-08-30T14:00:00.000Z', reason: 'Founder revoked note' })
  const brain = snapshot({ sources: revoked.sources, tombstones: [revoked.tombstone] })
  assert.equal(brain.activeClaims.some((claim) => claim.id === 'claim-founder-disable-late-fees'), false)
  assert.equal(brain.invalidatedClaims.some((claim) => claim.id === 'claim-founder-disable-late-fees'), true)
  assert.equal(brain.tombstones[0].sourceId, 'source-founder-note')
})

test('derived summary cannot resurrect a revoked root as independent evidence', () => {
  const derivedArtifact = createArtifact({ tenantId, id: 'artifact-derived-founder-summary', sourceId: 'source-founder-note', artifactType: 'MODEL_SUMMARY', rootSourceIds: ['source-founder-note'], locator: 'derived://founder-summary', classifiedAt: '2026-08-30T13:30:00.000Z' })
  const derived = createClaim({ tenantId, id: 'claim-derived-founder-summary', claimClass: CLAIM_CLASS.INTERPRETATION, claimType: 'late_fee_summary', semanticScope: { level: 'COMPANY' }, subjectScope: {}, value: { enabled: false }, artifactIds: [derivedArtifact.id], explicit: false, derived: true, confidence: 0.99, provenanceRootIds: ['source-founder-note'], independentCorroboration: true })
  assert.equal(derived.independentCorroboration, false)
  const revoked = revokeRootSource({ sources: fixture.sources, sourceId: 'source-founder-note', tenantId, revokedAt: '2026-08-30T14:00:00.000Z', reason: 'Founder revoked note' })
  const brain = snapshot({ sources: revoked.sources, artifacts: [...fixture.artifacts, derivedArtifact], claims: [...fixture.claims, derived], tombstones: [revoked.tombstone] })
  assert.equal(brain.activeClaims.some((claim) => claim.id === derived.id), false)
  assert.equal(brain.invalidatedClaims.some((claim) => claim.id === derived.id), true)
})

test('Ask DW exposes conflict instead of inventing certainty', () => {
  const answer = answerAskDwFromCompanyBrain({ snapshot: snapshot(), question: 'What is our late-fee policy?' })
  assert.equal(answer.status, 'CONFLICTED')
  assert.ok(answer.evidence.length >= 4)
  assert.ok(answer.evidence.every((item) => item.rootSourceIds.length > 0))
})

test('Ask DW uses approved scoped knowledge after explicit founder decision', () => {
  const answer = answerAskDwFromCompanyBrain({ snapshot: snapshot({ decisions: [founderDecision()] }), question: 'What is our late-fee policy?' })
  assert.equal(answer.status, 'APPROVED')
  assert.match(answer.answer, /disabled globally/i)
  assert.match(answer.answer, /Atlas.*2%/i)
})

test('Ask DW routes invoice payment truth to the R0 authoritative path', () => {
  const answer = answerAskDwFromCompanyBrain({ snapshot: snapshot(), question: 'Did invoice 104 get paid?' })
  assert.equal(answer.status, 'AUTHORITATIVE_FINANCIAL_REFETCH_REQUIRED')
  assert.equal(answer.route, 'R0_AUTHORITATIVE_FINANCIAL_READ')
  assert.equal(answer.canonicalFinancialTruthUsed, false)
})

test('Ask DW explains Atlas terms from contract provenance', () => {
  const answer = answerAskDwFromCompanyBrain({ snapshot: snapshot(), question: 'Why does Atlas have different terms?' })
  assert.equal(answer.status, 'OBSERVED')
  assert.ok(answer.evidence.length >= 2)
  assert.ok(answer.evidence.every((item) => item.rootSourceIds.includes('source-customer-contract-atlas')))
})

test('operating model distinguishes observed, conflicted, missing, proposed, and approved', () => {
  const before = buildOperatingModel(snapshot())
  assert.ok(before.observed.workflow.length > 0)
  assert.equal(before.conflicted.length, 1)
  assert.ok(before.missing.length > 0)
  assert.ok(before.proposed.length > 0)
  assert.equal(before.approved.length, 0)
  assert.equal(buildOperatingModel(snapshot({ decisions: [founderDecision()] })).approved.length, 2)
})

test('DW Intelligence receives typed context with hard financial and authority boundaries', () => {
  const context = toDwIntelligenceCompanyContext({ snapshot: snapshot(), clientId: 'atlas' })
  assert.equal(context.kind, 'DW_INTELLIGENCE_COMPANY_CONTEXT_V0')
  assert.equal(context.tenantId, tenantId)
  assert.equal(context.boundaries.canonicalMoneyWritable, false)
  assert.equal(context.boundaries.contextCanGrantAuthority, false)
  assert.equal(context.boundaries.unknownProvenanceFailsClosed, true)
  assert.ok(context.provenance.every((item) => item.rootSourceIds.length > 0))
})

test('complete G0 loop changes knowledge but leaves canonical financial truth untouched', () => {
  const before = snapshot()
  const model = buildOperatingModel(before)
  const decision = founderDecision()
  const after = snapshot({ decisions: [decision] })
  const ask = answerAskDwFromCompanyBrain({ snapshot: after, question: 'What is our late-fee policy?' })
  const intelligence = toDwIntelligenceCompanyContext({ snapshot: after, clientId: 'atlas' })
  assert.equal(model.proposed[0].status, 'PROPOSED')
  assert.equal(ask.status, 'APPROVED')
  assert.equal(intelligence.applicableApprovedPolicy.length, 2)
  assert.equal(before.canonicalMoneyWritable, false)
  assert.equal(after.canonicalMoneyWritable, false)
  assert.throws(() => assertCompanyBrainCannotWriteCanonicalMoney({ truthDimension: 'PAYMENT_RECEIPT_STATE' }), /read-only/)
})
