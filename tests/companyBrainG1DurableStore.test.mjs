import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AUTHORITY_RESULT, AUTHORITY_STATUS, CLAIM_CLASS, createClaim } from '../src/lib/companyBrain/index.js'
import { CompanyBrainDurableStore, proposedAuthority } from '../src/lib/companyBrain/durableStore.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, '../fixtures/company-brain')
const tenantA = 'tenant-a'
const tenantB = 'tenant-b'
const founderA = { id: tenantA, tenantId: tenantA, role: 'FOUNDER', authenticated: true }
const founderB = { id: tenantB, tenantId: tenantB, role: 'FOUNDER', authenticated: true }
const workerA = { id: 'worker-a', tenantId: tenantA, role: 'INGESTION_WORKER', authenticated: true }

function store() {
  let tick = 0
  return new CompanyBrainDurableStore({ clock: () => `2026-08-30T12:${String(tick++).padStart(2, '0')}:00.000Z` })
}

function ingest(s, actor, tenantId, relative, identity, key, extra = {}) {
  return s.ingestLocalFile({ actor, tenantId, filePath: path.join(fixtures, relative), sourceIdentity: identity, idempotencyKey: key, ...extra })
}

function seedConflict(s) {
  ingest(s, workerA, tenantA, 'g1-realistic/collections-policy.md', 'collections-policy', 'job-policy')
  ingest(s, workerA, tenantA, 'g1-realistic/atlas-terms.csv', 'atlas-terms', 'job-atlas')
  ingest(s, workerA, tenantA, 'g1-realistic/founder-instruction.txt', 'founder-note', 'job-founder')
  return s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
}

function decisionInput(conflict, overrides = {}) {
  return {
    actor: founderA,
    tenantId: tenantA,
    idempotencyKey: 'decision-late-fee-v1',
    targetId: conflict.id,
    expectedRevision: 0,
    decisionType: 'RESOLVE_CONFLICT_AND_APPROVE_POLICY',
    oldState: { status: 'CONFLICTED' },
    newState: { global: { enabled: false }, atlas: { ratePercent: 2, onlyWhenApplicable: true }, dwAuthority: 'REQUIRE_EXPLICIT_AUTHORITY' },
    evidenceClaimIds: conflict.competingClaimIds,
    reason: 'Founder explicitly resolved the scoped late-fee policy.',
    ...overrides,
  }
}

test('realistic Markdown, text, and CSV files persist source versions, artifacts, claims, roots, and conflicts', () => {
  const s = store()
  const conflict = seedConflict(s)
  assert.equal(s.sources.length, 3)
  assert.equal(s.sourceVersions.filter((row) => row.status === 'ACTIVE').length, 3)
  assert.equal(s.artifacts.filter((row) => row.active).length, 3)
  assert.ok(s.claims.filter((row) => row.active).length >= 5)
  assert.equal(s.claimRoots.length, s.claims.length)
  assert.equal(conflict.status, 'CONFLICTED')
  assert.ok(s.conflictMembers.filter((row) => row.conflictId === conflict.id).length >= 3)
})

test('persisted cross-tenant reads are blocked for every durable family', () => {
  const s = store(); seedConflict(s)
  for (const rows of [s.sources, s.artifacts, s.claims, s.conflicts, s.decisions, s.authorityProposals, s.snapshots]) {
    assert.throws(() => s.readForTenant(rows, { actor: founderB, tenantId: tenantA }), /actor tenant mismatch/)
  }
})

test('persisted cross-tenant writes are blocked', () => {
  const s = store()
  assert.throws(() => ingest(s, founderB, tenantA, 'g1-realistic/collections-policy.md', 'policy', 'cross-write'), /actor tenant mismatch/)
})

test('provenance-root tenant mismatch fails when the active snapshot is built', () => {
  const s = store(); seedConflict(s)
  const ownArtifact = s.artifacts.find((row) => row.tenantId === tenantA)
  const foreignVersion = 'foreign-version'
  const forged = createClaim({ tenantId: tenantA, id: 'forged', claimClass: CLAIM_CLASS.INTERPRETATION, claimType: 'note', semanticScope: { level: 'COMPANY' }, subjectScope: {}, value: {}, artifactIds: [ownArtifact.id], provenanceRootIds: [foreignVersion] })
  s.claims.push({ ...forged, sourceVersionId: foreignVersion, active: true })
  assert.throws(() => s.createSnapshot({ actor: founderA, tenantId: tenantA }), /root provenance unknown/)
})

test('durable claim without root provenance is rejected', () => {
  assert.throws(() => createClaim({ tenantId: tenantA, id: 'bad', claimClass: CLAIM_CLASS.INTERPRETATION, claimType: 'note', artifactIds: ['a'], value: {} }), /root provenance/)
})

test('exact re-ingestion with the same idempotency key is idempotent', () => {
  const s = store()
  const first = ingest(s, workerA, tenantA, 'g1-realistic/collections-policy.md', 'policy', 'same-job')
  const second = ingest(s, workerA, tenantA, 'g1-realistic/collections-policy.md', 'policy', 'same-job')
  assert.equal(second.idempotentReplay, true)
  assert.equal(second.sourceVersionId, first.sourceVersionId)
  assert.equal(s.sourceVersions.length, 1)
})

test('same normalized content under a different filename does not create independent knowledge', () => {
  const s = store()
  const content = '# Policy\r\n\r\nCharge a 5% late fee.\r\n'
  const first = s.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'one.md', content, sourceIdentity: 'one', idempotencyKey: 'one' })
  const second = s.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'copy.txt', content: '# Policy\n\nCharge a 5% late fee.\n', sourceIdentity: 'copy', idempotencyKey: 'copy' })
  assert.equal(second.duplicateContent, true)
  assert.equal(second.sourceVersionId, first.sourceVersionId)
  assert.equal(s.claimRoots.filter((row) => row.independent).length, 1)
})

test('modified source creates a distinct version and exact-version provenance', () => {
  const s = store()
  const first = s.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'policy.md', content: 'Charge a 5% late fee.', sourceIdentity: 'policy', idempotencyKey: 'v1' })
  const second = s.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'policy.md', content: 'Charge a 6% late fee.', sourceIdentity: 'policy', idempotencyKey: 'v2' })
  assert.notEqual(first.sourceVersionId, second.sourceVersionId)
  assert.equal(s.sourceVersions.find((row) => row.id === first.sourceVersionId).status, 'SUPERSEDED')
  assert.ok(s.claims.filter((row) => row.sourceVersionId === second.sourceVersionId).every((row) => row.provenanceRootIds.includes(second.sourceVersionId)))
})

test('duplicate root referenced by two ingestion jobs is not independent corroboration', () => {
  const s = store()
  const first = ingest(s, workerA, tenantA, 'g1-realistic/collections-policy.md', 'policy', 'job-1')
  const second = ingest(s, workerA, tenantA, 'g1-realistic/collections-policy.md', 'policy-alias', 'job-2')
  assert.equal(first.sourceVersionId, second.sourceVersionId)
  assert.equal(s.claimRoots.filter((row) => row.sourceVersionId === first.sourceVersionId && row.independent).length, 2)
  assert.equal(new Set(s.claimRoots.filter((row) => row.sourceVersionId === first.sourceVersionId).map((row) => row.claimId)).size, 2)
})

test('retry after partial ingestion failure completes without duplicate version or claims', () => {
  const s = store()
  assert.throws(() => s.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'policy.md', content: 'Charge a 5% late fee.', sourceIdentity: 'policy', idempotencyKey: 'retry', failAfterPersistingVersion: true }), /simulated partial/)
  const receipt = s.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'policy.md', content: 'Charge a 5% late fee.', sourceIdentity: 'policy', idempotencyKey: 'retry' })
  assert.equal(receipt.createdClaimIds.length, 1)
  assert.equal(s.sourceVersions.length, 1)
  assert.equal(s.claims.length, 1)
  assert.equal(s.ingestionJobs[0].attempts, 2)
})

test('root revocation invalidates dependent active claims while preserving history', () => {
  const s = store()
  const receipt = ingest(s, workerA, tenantA, 'g1-realistic/collections-policy.md', 'policy', 'policy')
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: receipt.sourceId, reason: 'withdrawn' })
  assert.equal(s.claims.some((row) => row.sourceVersionId === receipt.sourceVersionId && row.active), false)
  assert.ok(s.claims.some((row) => row.sourceVersionId === receipt.sourceVersionId))
  assert.equal(s.tombstones.length, 1)
})

test('source revocation during extraction rejects stale output', () => {
  const s = store()
  const receipt = s.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'policy.md', content: 'Charge a 5% late fee.', sourceIdentity: 'policy', idempotencyKey: 'race-revoke', beforeCommit: (storeInstance, prepared) => storeInstance.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: prepared.sourceId, reason: 'revoked during extraction' }) })
  assert.equal(receipt.staleOutputRejected, true)
  assert.ok(s.claims.filter((row) => row.sourceVersionId === receipt.sourceVersionId).every((row) => !row.active))
})

test('source version change during extraction prevents stale output becoming current', () => {
  const s = store()
  const old = s.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'policy.md', content: 'Charge a 5% late fee.', sourceIdentity: 'policy', idempotencyKey: 'old', beforeCommit: (storeInstance) => storeInstance.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'policy.md', content: 'Charge a 6% late fee.', sourceIdentity: 'policy', idempotencyKey: 'new' }) })
  assert.equal(old.staleOutputRejected, true)
  assert.equal(s.sourceVersions.find((row) => row.id === old.sourceVersionId).status, 'INVALIDATED')
  assert.equal(s.sourceVersions.filter((row) => row.status === 'ACTIVE').length, 1)
})

test('snapshot is reproducible and carries exact source-version lineage', () => {
  const s = store(); seedConflict(s)
  const first = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  const second = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  assert.equal(second.id, first.id)
  assert.deepEqual(second.sourceVersionIds, first.sourceVersionIds)
  assert.equal(second.knowledgeVersion, first.knowledgeVersion)
})

test('snapshot generation race creates complete distinguishable versions without mixing', () => {
  const s = store()
  ingest(s, workerA, tenantA, 'g1-realistic/collections-policy.md', 'policy', 'policy')
  const preparedOld = s.prepareSnapshot({ actor: founderA, tenantId: tenantA })
  ingest(s, workerA, tenantA, 'g1-realistic/founder-instruction.txt', 'founder', 'founder')
  const preparedNew = s.prepareSnapshot({ actor: founderA, tenantId: tenantA })
  const oldSnapshot = s.commitPreparedSnapshot(preparedOld)
  const newSnapshot = s.commitPreparedSnapshot(preparedNew)
  assert.notEqual(oldSnapshot.id, newSnapshot.id)
  assert.equal(oldSnapshot.sourceVersionIds.length, 1)
  assert.equal(newSnapshot.sourceVersionIds.length, 2)
  assert.notEqual(oldSnapshot.knowledgeVersion, newSnapshot.knowledgeVersion)
})

test('founder decision requires authenticated founder actor', () => {
  const s = store(); const conflict = seedConflict(s)
  assert.throws(() => s.recordFounderDecision(decisionInput(conflict, { actor: { id: tenantA, tenantId: tenantA, role: 'FOUNDER', authenticated: false } })), /authenticated actor/)
  assert.throws(() => s.recordFounderDecision(decisionInput(conflict, { actor: workerA })), /founder role/)
})

test('cross-tenant founder decision is rejected', () => {
  const s = store(); const conflict = seedConflict(s)
  assert.throws(() => s.recordFounderDecision(decisionInput(conflict, { actor: founderB })), /actor tenant mismatch/)
})

test('stale concurrent founder update fails and both attempts remain auditable', () => {
  const s = store(); const conflict = seedConflict(s)
  const first = s.recordFounderDecision(decisionInput(conflict))
  assert.equal(first.targetRevision, 1)
  assert.throws(() => s.recordFounderDecision(decisionInput(conflict, { idempotencyKey: 'decision-racing', reason: 'conflicting second decision' })), /stale founder decision/)
  assert.equal(s.decisions.length, 1)
  assert.equal(s.decisionAttempts.length, 1)
  assert.equal(s.decisionAttempts[0].outcome, 'REJECTED_STALE')
})

test('founder decision idempotency returns the original durable decision', () => {
  const s = store(); const conflict = seedConflict(s)
  const first = s.recordFounderDecision(decisionInput(conflict))
  const replay = s.recordFounderDecision(decisionInput(conflict))
  assert.equal(replay.id, first.id)
  assert.equal(s.decisions.length, 1)
})

test('20 repeated approvals do not persist or self-promote standing authority', () => {
  const s = store(); seedConflict(s); s.createSnapshot({ actor: founderA, tenantId: tenantA })
  const history = Array.from({ length: 20 }, (_, index) => ({ tenantId: tenantA, actionClass: 'WAIVE_SETTLEMENT', caseId: index }))
  const result = s.evaluateAuthority({ actor: founderA, tenantId: tenantA, actionClass: 'WAIVE_SETTLEMENT', scope: { level: 'CLIENT', clientId: 'atlas' }, approvalHistory: history })
  assert.equal(result.actual, AUTHORITY_RESULT.REQUIRE_APPROVAL)
  assert.equal(s.authorityProposals.length, 0)
})

test('explicit scoped authority persists only exact scope and revocation takes effect', () => {
  const s = store(); seedConflict(s)
  const evidenceClaimIds = [s.claims.find((row) => row.tenantId === tenantA).id]
  const proposal = proposedAuthority({ id: 'authority-atlas-discuss', tenantId: tenantA, actionClass: 'DISCUSS_INVOICE', scope: { level: 'CLIENT', clientId: 'atlas' }, evidenceClaimIds })
  s.persistAuthorityProposal({ actor: founderA, tenantId: tenantA, proposal })
  s.decideAuthority({ actor: founderA, tenantId: tenantA, proposalId: proposal.id, decision: AUTHORITY_STATUS.APPROVED })
  s.createSnapshot({ actor: founderA, tenantId: tenantA })
  assert.equal(s.evaluateAuthority({ actor: founderA, tenantId: tenantA, actionClass: 'DISCUSS_INVOICE', scope: { level: 'CLIENT', clientId: 'atlas' } }).actual, AUTHORITY_RESULT.GRANTED)
  assert.equal(s.evaluateAuthority({ actor: founderA, tenantId: tenantA, actionClass: 'DISCUSS_INVOICE', scope: { level: 'CLIENT', clientId: 'globex' } }).actual, AUTHORITY_RESULT.REQUIRE_APPROVAL)
  s.decideAuthority({ actor: founderA, tenantId: tenantA, proposalId: proposal.id, decision: AUTHORITY_STATUS.REVOKED })
  s.createSnapshot({ actor: founderA, tenantId: tenantA })
  assert.equal(s.evaluateAuthority({ actor: founderA, tenantId: tenantA, actionClass: 'DISCUSS_INVOICE', scope: { level: 'CLIENT', clientId: 'atlas' } }).actual, AUTHORITY_RESULT.REQUIRE_APPROVAL)
})

test('contextual paid statement remains non-canonical and Ask DW routes to R0', () => {
  const s = store()
  ingest(s, workerA, tenantA, 'g1-realistic/payment-note.txt', 'payment-note', 'payment-note')
  s.createSnapshot({ actor: founderA, tenantId: tenantA })
  const claim = s.claims[0]
  assert.equal(claim.canonicalFinancialTruth, false)
  assert.equal(s.askDw({ actor: founderA, tenantId: tenantA, question: 'Did invoice 104 get paid?' }).status, 'AUTHORITATIVE_FINANCIAL_REFETCH_REQUIRED')
})

test('durable Atlas waiver statement remains contextual and approval-required', () => {
  const s = store()
  ingest(s, workerA, tenantA, 'g1-realistic/account-manager-email.txt', 'atlas-account-manager-email', 'atlas-waiver-email')
  s.createSnapshot({ actor: founderA, tenantId: tenantA })
  const answer = s.askDw({ actor: founderA, tenantId: tenantA, question: 'Can I waive 20% for Atlas?' })
  assert.equal(answer.status, 'REQUIRE_APPROVAL')
  assert.equal(answer.canonicalFinancialTruthUsed, false)
  assert.equal(answer.evidence.length, 1)
})

test('retrieval cannot widen client semantic scope', () => {
  const s = store(); seedConflict(s)
  const atlas = s.queryClaims({ actor: founderA, tenantId: tenantA, claimType: 'late_fee_policy', semanticScope: { level: 'CLIENT', clientId: 'atlas' }, clientId: 'atlas' })
  const globex = s.queryClaims({ actor: founderA, tenantId: tenantA, claimType: 'late_fee_policy', semanticScope: { level: 'CLIENT', clientId: 'globex' }, clientId: 'globex' })
  assert.equal(atlas.length, 1)
  assert.equal(globex.length, 0)
})

test('Ask DW sees durable conflict and exposes root provenance', () => {
  const s = store(); seedConflict(s); s.createSnapshot({ actor: founderA, tenantId: tenantA })
  const answer = s.askDw({ actor: founderA, tenantId: tenantA, question: 'What is our late-fee policy?' })
  assert.equal(answer.status, 'CONFLICTED')
  assert.ok(answer.evidence.every((item) => item.rootSourceIds.length > 0))
})

test('Atlas durable terms retain client scope and contract-like source provenance', () => {
  const s = store(); seedConflict(s); s.createSnapshot({ actor: founderA, tenantId: tenantA })
  const answer = s.askDw({ actor: founderA, tenantId: tenantA, question: 'Why does Atlas have different terms?' })
  assert.equal(answer.status, 'OBSERVED')
  assert.ok(answer.evidence.length >= 2)
})

test('DW Intelligence receives typed durable approved/conflicted/authority context', () => {
  const s = store(); seedConflict(s); const snapshot = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  const context = s.dwIntelligenceContext({ actor: founderA, tenantId: tenantA, clientId: 'atlas' })
  assert.equal(context.kind, 'DW_INTELLIGENCE_COMPANY_CONTEXT_V0')
  assert.equal(context.durableSnapshotId, snapshot.id)
  assert.equal(context.boundaries.canonicalMoneyWritable, false)
  assert.ok(context.unresolvedConflicts.length > 0)
})

test('durable revocation removes influence from Ask DW and DW Intelligence', () => {
  const s = store(); seedConflict(s)
  const founderSource = s.sources.find((row) => row.identity === 'founder-note')
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: founderSource.id, reason: 'withdrawn' })
  s.createSnapshot({ actor: founderA, tenantId: tenantA })
  const context = s.dwIntelligenceContext({ actor: founderA, tenantId: tenantA, clientId: 'atlas' })
  assert.ok(context.revocationStatus.tombstones.length > 0)
  assert.equal(context.provenance.some((item) => item.rootSourceIds.some((root) => root === founderSource.currentVersionId)), false)
})

test('complete G1 durable loop passes while canonical financial truth remains untouched', () => {
  const s = store(); const conflict = seedConflict(s)
  const before = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  s.recordFounderDecision(decisionInput(conflict))
  const after = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  assert.notEqual(after.id, before.id)
  assert.equal(s.askDw({ actor: founderA, tenantId: tenantA, question: 'What is our late-fee policy?' }).status, 'APPROVED')
  const policySource = s.sources.find((row) => row.identity === 'collections-policy')
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: policySource.id, reason: 'superseded' })
  const revoked = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  assert.equal(revoked.domain.canonicalMoneyWritable, false)
  assert.ok(revoked.tombstoneWatermark > 0)
  assert.equal(s.claims.some((row) => row.sourceVersionId === policySource.currentVersionId && row.active), false)
})
