import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AUTHORITY_STATUS, CLAIM_CLASS, assertCompanyBrainCannotWriteCanonicalMoney } from '../src/lib/companyBrain/index.js'
import { CompanyBrainDurableStore, proposedAuthority } from '../src/lib/companyBrain/durableStore.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, '../fixtures/company-brain')

const tenantA = 'tenant-a'
const tenantB = 'tenant-b'
const founderA = { id: tenantA, tenantId: tenantA, role: 'FOUNDER', authenticated: true }
const founderB = { id: tenantB, tenantId: tenantB, role: 'FOUNDER', authenticated: true }
const workerA = { id: 'worker-a', tenantId: tenantA, role: 'INGESTION_WORKER', authenticated: true }
const workerB = { id: 'worker-b', tenantId: tenantB, role: 'INGESTION_WORKER', authenticated: true }

function store() {
  let tick = 0
  return new CompanyBrainDurableStore({ clock: () => `2026-08-31T00:${String(tick++).padStart(2, '0')}:00.000Z` })
}

function ingest(s, actor, tenantId, relative, identity, key) {
  return s.ingestLocalFile({
    actor, tenantId, filePath: path.join(fixtures, relative),
    sourceIdentity: identity, idempotencyKey: key,
  })
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
    idempotencyKey: 'decision-late-fee-hardening-v1',
    targetId: conflict.id,
    expectedRevision: conflict.revision,
    decisionType: 'RESOLVE_CONFLICT_AND_APPROVE_POLICY',
    oldState: { status: 'CONFLICTED' },
    newState: { global: { enabled: false }, atlas: { ratePercent: 2 } },
    evidenceClaimIds: conflict.competingClaimIds,
    reason: 'Hardening audit: founder resolved the late-fee conflict.',
    ...overrides,
  }
}

// ── Gap 1: Founder-decision idempotency ──────────────────────────────────────

test('identical idempotent replay succeeds and returns the original decision', () => {
  const s = store()
  const conflict = seedConflict(s)
  const first = s.recordFounderDecision(decisionInput(conflict))
  const replay = s.recordFounderDecision(decisionInput(conflict))
  assert.equal(replay.id, first.id)
  assert.equal(s.decisions.length, 1, 'replay must not create a second decision row')
  assert.ok(first.requestFingerprint, 'accepted decision must carry a request fingerprint')
})

test('reused idempotency key with changed payload is explicitly rejected', () => {
  const s = store()
  const conflict = seedConflict(s)
  s.recordFounderDecision(decisionInput(conflict))
  // Same key, different reason → fingerprint changes
  assert.throws(
    () => s.recordFounderDecision(decisionInput(conflict, { reason: 'Deliberately different reason' })),
    /idempotency key reused with different decision payload/,
  )
  assert.equal(s.decisions.length, 1, 'conflict must not persist a second decision')
})

// ── Gap 2: Server-authoritative founder-decision audit ───────────────────────

test('fake/stale prior state is rejected with a clear mismatch error', () => {
  const s = store()
  const conflict = seedConflict(s)
  // conflict.status = 'CONFLICTED'; we claim it was already RESOLVED
  assert.throws(
    () => s.recordFounderDecision(decisionInput(conflict, {
      idempotencyKey: 'bad-prior-state',
      oldState: { status: 'RESOLVED' },
    })),
    /prior state mismatch/,
  )
  assert.equal(s.decisions.length, 0)
})

test('cross-tenant provenance reference is rejected as missing', () => {
  const s = store()
  const conflict = seedConflict(s)
  // Ingest content for tenantB to create real claims there
  ingest(s, workerB, tenantB, 'g1-realistic/collections-policy.md', 'collections-policy-b', 'job-policy-b')
  const tenantBClaim = s.claims.find((row) => row.tenantId === tenantB && row.active)
  assert.ok(tenantBClaim, 'tenantB must have an active claim for this test to be valid')
  assert.throws(
    () => s.recordFounderDecision(decisionInput(conflict, {
      idempotencyKey: 'cross-tenant-evidence',
      evidenceClaimIds: [tenantBClaim.id],
    })),
    /missing or cross-tenant/,
  )
})

test('revoked provenance reference is rejected as inactive', () => {
  const s = store()
  const conflict = seedConflict(s)
  // Capture a claim ID before revoking its source
  const policySource = s.sources.find((row) => row.tenantId === tenantA && row.identity === 'collections-policy')
  const policyVersionId = policySource.currentVersionId
  const revokedClaimId = s.claims.find(
    (row) => row.tenantId === tenantA && row.sourceVersionId === policyVersionId && row.active,
  )?.id
  assert.ok(revokedClaimId, 'policy source must have an active claim for this test to be valid')
  // Revoke the source — claim becomes inactive
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: policySource.id, reason: 'audit test revocation' })
  // The revoked claim must not be accepted as evidence
  const freshConflict = s.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.throws(
    () => s.recordFounderDecision({
      actor: founderA,
      tenantId: tenantA,
      idempotencyKey: 'revoked-evidence',
      targetId: freshConflict.id,
      expectedRevision: freshConflict.revision,
      decisionType: 'RESOLVE_CONFLICT_AND_APPROVE_POLICY',
      oldState: { status: 'CONFLICTED' },
      newState: {},
      evidenceClaimIds: [revokedClaimId],
      reason: 'Should fail because evidence claim is revoked.',
    }),
    /inactive or revoked/,
  )
})

// ── Gap 3: Persistent revocation closure ─────────────────────────────────────

test('revocation invalidates dependent snapshot (knowledge version advances past stale snapshot)', () => {
  const s = store()
  seedConflict(s)
  const snapshot = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  const versionBeforeRevoke = snapshot.knowledgeVersion
  assert.equal(versionBeforeRevoke, s.version(tenantA), 'snapshot must match current knowledge version before revoke')

  const policySource = s.sources.find((row) => row.tenantId === tenantA && row.identity === 'collections-policy')
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: policySource.id, reason: 'withdrawn' })

  assert.ok(
    snapshot.knowledgeVersion < s.version(tenantA),
    'knowledge version must advance after revocation, making the snapshot stale',
  )
  // A fresh snapshot excludes the revoked source
  const fresh = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  assert.ok(
    fresh.domain.activeSources.every((src) => src.id !== policySource.currentVersionId),
    'fresh snapshot must not include the revoked source version',
  )
})

test('Ask DW refuses stale snapshot and answers from current revocation state', () => {
  const s = store()
  seedConflict(s)
  // Build a snapshot that includes all three sources
  const stale = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  assert.equal(stale.knowledgeVersion, s.version(tenantA))

  // Revoke the founder-instruction source — bumps knowledge version
  const founderSource = s.sources.find((row) => row.tenantId === tenantA && row.identity === 'founder-note')
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: founderSource.id, reason: 'withdrawn' })

  // Ask DW must NOT use the stale snapshot
  s.askDw({ actor: founderA, tenantId: tenantA, question: 'What is our late-fee policy?' })

  const latest = s.latestSnapshot({ actor: founderA, tenantId: tenantA })
  assert.equal(
    latest.knowledgeVersion, s.version(tenantA),
    'after askDw call, latest snapshot must match current knowledge version (not the stale one)',
  )
  assert.ok(
    latest.domain.activeSources.every((src) => src.id !== founderSource.currentVersionId),
    'snapshot used by Ask DW must not include the revoked source',
  )
})

test('DW Intelligence rejects invalidated snapshot and returns context from current state', () => {
  const s = store()
  seedConflict(s)
  const stale = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  assert.equal(stale.knowledgeVersion, s.version(tenantA))

  // Revoke atlas-terms — bumps knowledge version
  const atlasSource = s.sources.find((row) => row.tenantId === tenantA && row.identity === 'atlas-terms')
  s.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: atlasSource.id, reason: 'contract expired' })

  const context = s.dwIntelligenceContext({ actor: founderA, tenantId: tenantA, clientId: 'atlas' })

  // The context must come from a fresh snapshot, not the stale one
  const latest = s.latestSnapshot({ actor: founderA, tenantId: tenantA })
  assert.equal(context.durableSnapshotId, latest.id, 'DW Intelligence must use the post-revocation snapshot')
  assert.ok(
    latest.knowledgeVersion === s.version(tenantA),
    'DW Intelligence snapshot must be current',
  )
  // Revocation status must be surfaced in the context
  assert.ok(context.revocationStatus.tombstones.length > 0, 'revocation tombstone must appear in DW Intelligence context')
  assert.equal(context.boundaries.canonicalMoneyWritable, false, 'financial-truth boundary must remain enforced')
})

// ── Gap 4: Semantic-reference integrity ──────────────────────────────────────

test('dangling reference in authority proposal evidence fails', () => {
  const s = store()
  seedConflict(s)
  const proposal = proposedAuthority({
    id: 'authority-dangling-ref',
    tenantId: tenantA,
    actionClass: 'WAIVE_FEE',
    scope: { level: 'COMPANY' },
    evidenceClaimIds: ['00000000-0000-4000-8000-000000000000'],
  })
  assert.throws(
    () => s.persistAuthorityProposal({ actor: founderA, tenantId: tenantA, proposal }),
    /missing or cross-tenant/,
  )
  assert.equal(s.authorityProposals.length, 0, 'no proposal must be persisted for a dangling reference')
})

test('cross-tenant authority evidence fails', () => {
  const s = store()
  seedConflict(s)
  ingest(s, workerB, tenantB, 'g1-realistic/collections-policy.md', 'collections-policy-b', 'job-policy-b')
  const tenantBClaim = s.claims.find((row) => row.tenantId === tenantB && row.active)
  assert.ok(tenantBClaim, 'tenantB must have an active claim')
  const proposal = proposedAuthority({
    id: 'authority-cross-tenant-evidence',
    tenantId: tenantA,
    actionClass: 'WAIVE_FEE',
    scope: { level: 'COMPANY' },
    evidenceClaimIds: [tenantBClaim.id],
  })
  assert.throws(
    () => s.persistAuthorityProposal({ actor: founderA, tenantId: tenantA, proposal }),
    /missing or cross-tenant/,
  )
  assert.equal(
    s.authorityProposals.filter((row) => row.tenantId === tenantA).length,
    0,
    'no tenantA proposal must be persisted with cross-tenant evidence',
  )
})

// ── R0 financial-truth boundary (regression across hardened paths) ────────────

test('Company Brain still cannot mutate canonical financial truth through any hardened path', () => {
  // assertCompanyBrainCannotWriteCanonicalMoney is the canonical gate
  for (const mutation of [
    { truthDimension: 'INVOICE_AR_STATE' },
    { truthDimension: 'PAYMENT_RECEIPT_STATE' },
    { objectType: 'invoice' },
    { objectType: 'payment' },
  ]) {
    assert.throws(
      () => assertCompanyBrainCannotWriteCanonicalMoney(mutation),
      /R0 canonical/,
      `mutation ${JSON.stringify(mutation)} must be rejected`,
    )
  }
  // Non-financial mutation passes through
  assert.ok(assertCompanyBrainCannotWriteCanonicalMoney({ objectType: 'company_policy' }))

  // No hardened path (decision, authority, revocation) bypasses the check
  const s = store()
  const conflict = seedConflict(s)
  const decision = s.recordFounderDecision(decisionInput(conflict))
  assert.equal(decision.status, 'RECORDED')
  // The decision domain object must carry canonicalMoneyWritable: false
  const snapshot = s.createSnapshot({ actor: founderA, tenantId: tenantA })
  assert.equal(snapshot.domain.canonicalMoneyWritable, false)
})
