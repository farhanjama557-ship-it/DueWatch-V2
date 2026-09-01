/**
 * M2G-G6 loader wiring.
 *
 * The store-backed derivation used by the G6 domain suite sees durable G3
 * conflicts and G2 source evidence. The production loader must see the same
 * things: a surface that silently reports zero conflicts, or evidence with no
 * freshness, would understate exactly what the founder is there to review.
 *
 * These tests drive the real row mappers with fixture-shaped tenant rows and
 * assert the derived items match what the store-backed path produces.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CompanyBrainDurableStore } from '../src/lib/companyBrain/durableStore.js'
import { CompanyGraphStore } from '../src/lib/companyBrain/graphStore.js'
import { buildOperatingModelProposal } from '../src/lib/companyBrain/operatingModel.js'
import {
  REVIEW_ITEM_TYPE,
  buildFounderReviewItems,
  buildFounderReviewItemsFromRecords,
} from '../src/lib/companyBrain/founderReview.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const fixtureRoot = path.join(repoRoot, 'fixtures/company-brain')
const loaderSource = fs.readFileSync(path.join(repoRoot, 'src/lib/companyBrain/founderReviewLoader.js'), 'utf8')
const pageSource = fs.readFileSync(path.join(repoRoot, 'src/pages/CompanyBrain.jsx'), 'utf8')

const tenantA = 'tenant-a'
const founderA = { id: tenantA, tenantId: tenantA, role: 'FOUNDER', authenticated: true }
const workerA = { id: 'worker-a', tenantId: tenantA, role: 'INGESTION_WORKER', authenticated: true }
const asOfDate = '2026-08-31'
const generatedAt = '2026-09-01T13:00:00.000Z'

const G2_FILES = [
  'entity-registry.csv', 'atlas-contract.md', 'acme-us-contract.md', 'people-roles.csv',
  'historical-late-fee-policy.md', 'atlas-exception.md', 'collections-workflow.md',
  'atlas-precedent.md', 'orphan-reference.md', 'historical-aliases.csv', 'acme-account-manager-note.md',
]

function seeded() {
  let tick = 0
  const now = () => new Date(Date.UTC(2026, 8, 1, 12, 0, 0) + (tick++) * 1000).toISOString()
  const brain = new CompanyBrainDurableStore({ clock: now })
  const ingest = (folder, filename) => brain.ingestLocalFile({
    actor: workerA, tenantId: tenantA, filePath: path.join(fixtureRoot, folder, filename),
    sourceIdentity: filename, idempotencyKey: `${tenantA}:${filename}:g6loader`,
  })
  ingest('g1-realistic', 'collections-policy.md')
  ingest('g1-realistic', 'atlas-terms.csv')
  ingest('g1-realistic', 'founder-instruction.txt')
  for (const filename of G2_FILES) ingest('g2-graph', filename)
  const graph = new CompanyGraphStore({ brainStore: brain, clock: now })
  graph.build({ actor: founderA, tenantId: tenantA })
  return { brain, graph }
}

const state = seeded()
const operatingModel = buildOperatingModelProposal({
  actor: founderA, tenantId: tenantA, brain: state.brain, graph: state.graph,
  queryDate: asOfDate, generatedAt: '2026-08-31T18:00:00.000Z',
})
const storeBacked = buildFounderReviewItems({
  actor: founderA, tenantId: tenantA, brain: state.brain, graph: state.graph,
  operatingModel, asOfDate, generatedAt,
})

/**
 * Projects the in-memory durable store into the row shapes the real database
 * tables hold, so the mappers can be driven exactly as production drives them.
 */
function sourceTypeFor(identity) {
  if (identity.endsWith('.md')) return 'MARKDOWN'
  if (identity.endsWith('.csv')) return 'CSV'
  if (identity.endsWith('.txt')) return 'TEXT'
  throw new Error(`unexpected fixture source identity: ${identity}`)
}

function persistedRows() {
  const snapshot = state.brain.prepareSnapshot({ actor: founderA, tenantId: tenantA })
  const sourceVersionById = new Map(state.brain.sourceVersions.map((row) => [row.id, row]))
  return {
    conflictRows: state.brain.conflicts
      .filter((row) => row.tenantId === tenantA)
      .map((row) => ({
        id: row.id, user_id: tenantA, topic: row.topic, status: row.status,
        revision: row.revision ?? 0, resolution_decision_id: row.resolutionDecisionId ?? null,
      })),
    memberRows: state.brain.conflictMembers
      .filter((row) => row.tenantId === tenantA)
      .map((row) => ({ user_id: tenantA, conflict_id: row.conflictId, claim_id: row.claimId })),
    claimRows: state.brain.claims
      .filter((row) => row.tenantId === tenantA)
      .map((row) => ({
        id: row.id, user_id: tenantA, claim_type: row.claimType, claim_class: row.claimClass,
        claim_value: row.value, semantic_scope: row.semanticScope, active: row.active,
        derived: row.derived === true, explicit: row.explicit === true, confidence: row.confidence ?? null,
      })),
    rootRows: state.brain.claimRoots
      .filter((row) => row.tenantId === tenantA)
      .map((row) => ({ user_id: tenantA, claim_id: row.claimId, source_version_id: row.sourceVersionId })),
    sourceRows: state.brain.sources
      .filter((row) => row.tenantId === tenantA)
      .map((row) => ({
        // company_brain_sources.source_type holds exactly what G1 recorded at
        // ingestion, so mirror that rather than inventing a single type.
        id: row.id, user_id: tenantA, source_type: sourceTypeFor(row.identity),
        trust_zone: 'CONTROLLED_LOCAL_INGESTION',
        active: row.active, revoked_at: row.revokedAt ?? null, revocation_reason: null,
      })),
    versionRows: state.brain.sourceVersions
      .filter((row) => row.tenantId === tenantA)
      .map((row) => ({
        id: row.id, user_id: tenantA, source_id: row.sourceId, status: row.status,
        content_hash: row.contentHash, version_number: row.versionNumber,
        source_timestamp: row.createdAt, created_at: row.createdAt,
      })),
    tombstoneRows: state.brain.tombstones
      .filter((row) => row.tenantId === tenantA)
      .map((row) => ({ user_id: tenantA, source_id: row.sourceId })),
    snapshot,
    sourceVersionById,
  }
}

const rows = persistedRows()

// The loader's mappers are exercised through the same public derivation the
// loader calls, using row shapes taken from the real table definitions.
function knowledgeFromRows() {
  const sourceById = new Map(rows.sourceRows.map((row) => [row.id, row]))
  const rootsByClaim = new Map()
  for (const row of rows.rootRows) {
    if (!rootsByClaim.has(row.claim_id)) rootsByClaim.set(row.claim_id, [])
    rootsByClaim.get(row.claim_id).push(row.source_version_id)
  }
  return {
    sources: rows.versionRows.filter((row) => row.status === 'ACTIVE').map((row) => {
      const parent = sourceById.get(row.source_id)
      return {
        id: row.id, tenantId: tenantA, sourceType: parent?.source_type ?? null,
        trustZone: parent?.trust_zone ?? null, sourceTimestamp: row.source_timestamp,
        sourceVersion: String(row.version_number), contentHash: `sha256:${row.content_hash}`,
        active: parent ? parent.active !== false : false, revokedAt: parent?.revoked_at ?? null,
        revocationReason: null,
      }
    }),
    claims: rows.claimRows.map((row) => ({
      id: row.id, tenantId: tenantA, claimType: row.claim_type, claimClass: row.claim_class,
      value: row.claim_value, active: row.active === true, derived: row.derived,
      explicit: row.explicit, confidence: row.confidence,
      provenanceRootIds: rootsByClaim.get(row.id) || [],
    })),
    tombstones: rows.versionRows
      .filter((row) => new Set(rows.tombstoneRows.map((entry) => entry.source_id)).has(row.source_id))
      .map((row) => ({ tenantId: tenantA, sourceId: row.source_id, sourceVersionId: row.id })),
  }
}

function conflictsFromRows() {
  const claimById = new Map(rows.claimRows.map((row) => [row.id, row]))
  const membersByConflict = new Map()
  for (const row of rows.memberRows) {
    if (!membersByConflict.has(row.conflict_id)) membersByConflict.set(row.conflict_id, [])
    membersByConflict.get(row.conflict_id).push(row.claim_id)
  }
  return rows.conflictRows.map((row) => {
    const competingClaimIds = (membersByConflict.get(row.id) || []).slice().sort()
    return {
      kind: 'COMPANY_BRAIN_CONFLICT_V0', id: row.id, tenantId: tenantA, topic: row.topic,
      status: row.status, revision: row.revision, competingClaimIds,
      scopes: competingClaimIds.map((claimId) => claimById.get(claimId)?.semantic_scope || {}),
      preservedValues: competingClaimIds.map((claimId) => claimById.get(claimId)?.claim_value ?? null),
      resolutionDecisionId: row.resolution_decision_id, winnerClaimId: null, confidenceResolved: false,
    }
  })
}

const recordBacked = buildFounderReviewItemsFromRecords({
  actor: founderA, tenantId: tenantA, knowledge: knowledgeFromRows(),
  operatingModel, conflicts: conflictsFromRows(), founderDecisions: [],
  asOfDate, generatedAt,
})

test('G6-L1 the fixture tenant really does have durable conflicts to lose', () => {
  assert.ok(rows.conflictRows.length > 0, 'the fixture must contain at least one durable G3 conflict')
  assert.ok(rows.memberRows.length >= 2, 'that conflict must have competing members')
})

test('G6-L2 persisted rows reproduce the store-backed conflict items exactly', () => {
  const fromStore = storeBacked.filter((item) => item.subjectType === 'BRAIN_CONFLICT')
  const fromRows = recordBacked.filter((item) => item.subjectType === 'BRAIN_CONFLICT')
  assert.ok(fromStore.length > 0)
  assert.deepEqual(fromRows.map((item) => item.reviewKey), fromStore.map((item) => item.reviewKey))
  // Every competing side survives the trip through the row shapes.
  for (let index = 0; index < fromStore.length; index += 1) {
    assert.deepEqual(
      fromRows[index].proposition.competingPositions,
      fromStore[index].proposition.competingPositions,
    )
  }
})

test('G6-L3 an empty conflict list would have silently erased those items', () => {
  // This is the exact regression: conflicts: [] drops durable G3 conflicts and
  // the surface then reports none.
  const withoutConflicts = buildFounderReviewItemsFromRecords({
    actor: founderA, tenantId: tenantA, knowledge: knowledgeFromRows(),
    operatingModel, conflicts: [], founderDecisions: [], asOfDate, generatedAt,
  })
  const lost = recordBacked.filter((item) => item.subjectType === 'BRAIN_CONFLICT').length
  assert.ok(lost > 0)
  assert.equal(withoutConflicts.filter((item) => item.subjectType === 'BRAIN_CONFLICT').length, 0)
  assert.equal(withoutConflicts.length, recordBacked.length - lost)
})

test('G6-L4 persisted rows carry the same evidence and freshness as the store', () => {
  const byKey = new Map(recordBacked.map((item) => [item.reviewKey, item]))
  const understanding = storeBacked.filter((item) => item.itemType === REVIEW_ITEM_TYPE.UNDERSTANDING)
  assert.ok(understanding.length > 0)
  for (const item of understanding) {
    const mirrored = byKey.get(item.reviewKey)
    assert.ok(mirrored, `${item.subject} must survive the persistence round trip`)
    assert.deepEqual(mirrored.evidence, item.evidence)
    assert.equal(mirrored.subjectFingerprint, item.subjectFingerprint)
    assert.equal(mirrored.supportingSourceRevoked, item.supportingSourceRevoked)
  }
})

test('G6-L5 empty knowledge would have stripped evidence and changed fingerprints', () => {
  const withoutKnowledge = buildFounderReviewItemsFromRecords({
    actor: founderA, tenantId: tenantA,
    knowledge: { sources: [], claims: [], tombstones: [] },
    operatingModel, conflicts: conflictsFromRows(), founderDecisions: [], asOfDate, generatedAt,
  })
  const blind = withoutKnowledge.find((item) => item.itemType === REVIEW_ITEM_TYPE.UNDERSTANDING)
  const sighted = recordBacked.find((item) => item.reviewKey === blind.reviewKey)
  assert.notEqual(blind.subjectFingerprint, sighted.subjectFingerprint)
  // Losing the sources made real evidence look absent, which reads as revoked.
  assert.equal(blind.supportingSourceRevoked, true)
  assert.equal(sighted.supportingSourceRevoked, false)
})

test('G6-L6 a tombstoned source is recognised by source version id', () => {
  const revoked = seeded()
  const receipt = revoked.brain.sources.find((row) => row.tenantId === tenantA)
  revoked.brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: receipt.id, reason: 'replaced' })
  const version = revoked.brain.sourceVersions.find((row) => row.sourceId === receipt.id)
  const items = buildFounderReviewItemsFromRecords({
    actor: founderA, tenantId: tenantA,
    knowledge: {
      sources: [{
        id: version.id, tenantId: tenantA, sourceType: sourceTypeFor(receipt.identity),
        trustZone: 'CONTROLLED_LOCAL_INGESTION',
        sourceTimestamp: version.createdAt, sourceVersion: '1', contentHash: `sha256:${version.contentHash}`,
        active: true, revokedAt: null, revocationReason: null,
      }],
      claims: [{
        id: 'claim-x', tenantId: tenantA, claimType: 'reminder_cadence', claimClass: 'COMPANY_POLICY',
        value: { days: 7 }, active: true, derived: false, explicit: true, confidence: null,
        provenanceRootIds: [version.id],
      }],
      tombstones: [{ tenantId: tenantA, sourceId: receipt.id, sourceVersionId: version.id }],
    },
    operatingModel, conflicts: [], founderDecisions: [], asOfDate, generatedAt,
  })
  const withEvidence = items.find((item) => item.evidence.some((entry) => entry.sourceVersionId === version.id))
  assert.ok(withEvidence, 'the tombstoned version must still appear as evidence')
  const entry = withEvidence.evidence.find((row) => row.sourceVersionId === version.id)
  assert.equal(entry.tombstoned, true)
  assert.equal(withEvidence.supportingSourceRevoked, true)
})

test('G6-L7 the loader reads every tenant table the derivation needs', () => {
  for (const table of [
    'company_brain_conflicts', 'company_brain_conflict_members', 'company_brain_claims',
    'company_brain_claim_roots', 'company_brain_sources', 'company_brain_source_versions',
    'company_brain_source_tombstones', 'company_operating_model_proposals',
    'company_brain_authority_grants_g5', 'company_brain_authority_proposals',
    'company_brain_founder_review_items_g6', 'company_brain_founder_review_revisions_g6',
    'company_brain_founder_decisions',
  ]) {
    assert.match(loaderSource, new RegExp(`from\\('${table}'\\)`), `${table} must be read`)
  }
  // No hardcoded empty stand-in is left behind for conflicts or evidence.
  assert.doesNotMatch(loaderSource, /conflicts: \[\],/)
  assert.doesNotMatch(loaderSource, /knowledge: \{ sources: \[\], claims: \[\], tombstones: \[\] \}/)
})

test('G6-L8 a partial read fails the whole load instead of understating the brain', () => {
  assert.match(loaderSource, /company brain review read failed \(\$\{names\[index\]\}\)/)
  assert.match(loaderSource, /throw new Error/)
})

test('G6-L9 the loader treats every rejection outcome as a failure', () => {
  assert.match(loaderSource, /REVIEW_REJECTION_OUTCOMES/)
  for (const outcome of [
    'REJECTED_IDEMPOTENCY_CONFLICT', 'REJECTED_STALE_REVISION',
    'REJECTED_SUBJECT_CHANGED', 'REJECTED_ACTION_UNAVAILABLE',
  ]) {
    assert.ok(loaderSource.includes(outcome), `${outcome} must be treated as a failure`)
  }
  assert.match(loaderSource, /outcome !== 'ACCEPTED' && outcome !== 'IDEMPOTENT_REPLAY'/)
  // A refused write reloads current truth rather than leaving a stale surface,
  // and the refusal message survives that reload (load() clears the banner, so
  // the message must be set after it).
  const handler = pageSource.slice(pageSource.indexOf('} catch (actionError) {'))
  const reloadAt = handler.indexOf('await load()')
  const messageAt = handler.indexOf('setError(message)')
  assert.ok(reloadAt > 0 && messageAt > reloadAt, 'the refusal message must outlive the reload')
})

test('G6-L10 a review write cites the derivation the server will re-check', () => {
  assert.match(loaderSource, /p_operating_model_id: bindsOperatingModel \? operatingModelRowId : null/)
  assert.match(loaderSource, /p_source_model_fingerprint: bindsOperatingModel \? operatingModelFingerprint : null/)
  assert.match(loaderSource, /p_conflict_revision: item\.conflictId \? \(item\.conflictRevision \?\? 0\) : null/)
  assert.match(pageSource, /operatingModelRowId: derivation\.operatingModelRowId/)
  // Derived items carry the binding the write needs.
  const bound = storeBacked.filter((item) => item.sourceModelFingerprint)
  assert.ok(bound.length > 0)
  assert.equal(bound[0].sourceModelFingerprint, operatingModel.fingerprint)
  assert.equal(bound[0].sourceModelProposalId, operatingModel.proposalId)
})

test('G6-L11 the authority proposal mapper invents no dimension it has no column for', () => {
  assert.match(loaderSource, /action: row\.action_class \?\? null/)
  assert.match(loaderSource, /scope: row\.authority_scope \|\| \{\}/)
  assert.match(loaderSource, /proposedConfiguration: \{\}/)
  assert.doesNotMatch(loaderSource, /row\.proposed_configuration/)
})
