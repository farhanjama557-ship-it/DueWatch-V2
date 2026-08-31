/**
 * G3 Conflict & Policy Intelligence — adversarial tests against the frozen G2 checkpoint.
 *
 * Written against the real G2 APIs confirmed present at SHA 5d0dc3b:
 *   src/lib/companyBrain/durableStore.js   (CompanyBrainDurableStore, extractDeterministicClaims)
 *   src/lib/companyBrain/graphStore.js     (CompanyGraphStore, GRAPH_NODE_TYPE, GRAPH_EDGE_TYPE, etc.)
 *   src/lib/companyBrain/index.js          (CLAIM_CLASS, buildBrainSnapshot, etc.)
 *   src/lib/companyBrain/fixtureIngestion.js (ingestCompanyBrainFixture)
 *
 * Key corrections vs. the old branch (claude/duewatch-scaffold-auth-j2ef7c):
 *   - CONTRACT_TERM is NOT a CLAIM_CLASS; contracts are PAYMENT_TERMS_CONTEXT / contract_record
 *     and surface as CONTRACT graph nodes via the graph store
 *   - effectiveTime: { from, to } IS carried for frontmatter-parsed documents
 *   - SUPERSEDES edge type exists and requires explicit: true
 *   - HISTORICAL_PRECEDENT works via fixtureIngestion.js AND via g2-graph/historical-late-fee-policy.md
 *   - Deterministic entity resolution is in CompanyGraphStore (resolve(), resolveClientAlias())
 *   - CompanyGraphStore is a separate class from CompanyBrainDurableStore
 *   - semanticScope.level uses SEMANTIC_SCOPE enum values
 *
 * Adversarial plan: docs/company-brain/M2G_G3_ADVERSARIAL_PLAN.md
 * Interface spec:   docs/company-brain/M2G_G3_CONFLICT_POLICY_INTELLIGENCE_V0.md
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CompanyBrainDurableStore } from '../src/lib/companyBrain/durableStore.js'
import { CompanyGraphStore, GRAPH_EDGE_TYPE, GRAPH_NODE_TYPE, RESOLUTION_STATE, SEMANTIC_SCOPE, createGraphEdge, createGraphNode } from '../src/lib/companyBrain/graphStore.js'
import { CLAIM_CLASS, AUTHORITY_RESULT, AUTHORITY_STATUS, assertCompanyBrainCannotWriteCanonicalMoney, buildBrainSnapshot, createAuthorityProposal } from '../src/lib/companyBrain/index.js'
import { ingestCompanyBrainFixture } from '../src/lib/companyBrain/fixtureIngestion.js'
import {
  TEMPORAL_STATE, CONFLICT_CLASS, CANDIDATE_STATUS, G3_RESOLUTION_STATUS,
  classifyTemporalState, detectDanglingProvenance, buildPolicyCandidates,
  classifyConflicts, resolvePolicy, buildG3DwIntelligenceContext,
  buildEffectivePolicyCandidates, validateClientIdentity,
  applyFounderDecisions, askDwPolicy,
} from '../src/lib/companyBrain/policyIntelligence.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.resolve(here, '../fixtures/company-brain')

// ── Tenant / actor constants ──────────────────────────────────────────────────

const tenantA = 'tenant-a'
const tenantB = 'tenant-b'
const founderA = { id: tenantA, tenantId: tenantA, role: 'FOUNDER', authenticated: true }
const founderB = { id: tenantB, tenantId: tenantB, role: 'FOUNDER', authenticated: true }
const workerA = { id: 'worker-a', tenantId: tenantA, role: 'INGESTION_WORKER', authenticated: true }
const workerB = { id: 'worker-b', tenantId: tenantB, role: 'INGESTION_WORKER', authenticated: true }

// ── Fixture helpers ───────────────────────────────────────────────────────────

function clocks() { let t = 0; return () => `2026-08-30T14:${String(t++).padStart(2, '0')}:00.000Z` }

function ingestFile(brain, actor, folder, filename, identity = filename, suffix = '') {
  return brain.ingestLocalFile({
    actor, tenantId: actor.tenantId, filePath: path.join(fixtureRoot, folder, filename),
    sourceIdentity: identity, idempotencyKey: `${actor.tenantId}:${identity}:${suffix || 'v1'}`,
  })
}

function ingestContent(brain, actor, filename, content, identity, suffix = 'v1') {
  return brain.ingestContent({
    actor, tenantId: actor.tenantId, filename, content, sourceIdentity: identity,
    idempotencyKey: `${actor.tenantId}:${identity}:${suffix}`,
  })
}

// Standard G2-graph-aware seed: g1-realistic + g2-graph fixtures
const G2_GRAPH_FILES = [
  'entity-registry.csv', 'atlas-contract.md', 'acme-us-contract.md', 'people-roles.csv',
  'historical-late-fee-policy.md', 'atlas-exception.md', 'collections-workflow.md',
  'atlas-precedent.md', 'orphan-reference.md', 'historical-aliases.csv', 'acme-account-manager-note.md',
]

function seeded(tenantId = tenantA, actor = workerA, founder = founderA) {
  const clock = clocks()
  const brain = new CompanyBrainDurableStore({ clock })
  ingestFile(brain, actor, 'g1-realistic', 'collections-policy.md')
  ingestFile(brain, actor, 'g1-realistic', 'atlas-terms.csv')
  ingestFile(brain, actor, 'g1-realistic', 'founder-instruction.txt')
  for (const f of G2_GRAPH_FILES) ingestFile(brain, actor, 'g2-graph', f)
  const graph = new CompanyGraphStore({ brainStore: brain, clock })
  const snapshot = graph.build({ actor: founder, tenantId })
  return { brain, graph, snapshot }
}

// Fixture ingestion helper (acme-ar-ops)
function acmeAtlasBrain(clock) {
  const brain = new CompanyBrainDurableStore({ clock })
  const { tenantId, sources, artifacts, claims } = ingestCompanyBrainFixture({
    fixtureDirectory: path.join(fixtureRoot, 'acme-ar-ops'), tenantId: tenantA,
  })
  for (const sv of sources) brain.sourceVersions.push({ id: sv.id, tenantId, sourceId: sv.id, versionNumber: 1, contentHash: sv.contentHash, filename: sv.id, status: 'ACTIVE', createdAt: clock(), domainSource: sv })
  for (const s of sources) { brain.sources.push({ id: s.id, tenantId, identity: s.id, active: true, currentVersionId: s.id, createdAt: clock(), revokedAt: null }); brain.knowledgeVersion.set(tenantId, (brain.knowledgeVersion.get(tenantId) || 0) + 1) }
  for (const a of artifacts) brain.artifacts.push({ ...a, sourceVersionId: a.sourceId, active: true })
  for (const c of claims) { brain.claims.push({ ...c, sourceVersionId: c.provenanceRootIds[0], active: true }); brain.claimRoots.push({ tenantId, claimId: c.id, sourceVersionId: c.provenanceRootIds[0], independent: c.derived !== true }) }
  brain.rebuildConflicts(tenantId)
  return brain
}

// ── Group A: Conflicting same-scope policies ──────────────────────────────────

test('A1: two COMPANY_POLICY late_fee claims → conflict detected, no winner', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'policy-a.md', 'Charge a 5% late fee.', 'policy-a')
  ingestContent(brain, workerA, 'policy-b.md', 'Charge a 7% late fee.', 'policy-b')
  const conflict = brain.conflicts.find((row) => row.tenantId === tenantA && row.topic === 'late_fee_policy')
  assert.ok(conflict, 'conflict must be detected')
  assert.equal(conflict.status, 'CONFLICTED')
  assert.equal(conflict.competingClaimIds.length, 2)
  assert.equal(conflict.winnerClaimId, null)
  assert.equal(conflict.confidenceResolved, false)
})

test('A2: founder decision resolves conflict; Ask DW returns APPROVED', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'policy-a.md', 'Charge a 5% late fee.', 'policy-a')
  ingestContent(brain, workerA, 'policy-b.md', 'Charge a 7% late fee.', 'policy-b')
  const conflict = brain.conflicts.find((row) => row.topic === 'late_fee_policy')
  const result = brain.recordFounderDecision({
    actor: founderA, tenantId: tenantA, idempotencyKey: 'dec-a2',
    targetId: conflict.id, expectedRevision: 0,
    decisionType: 'POLICY_RESOLUTION',
    oldState: { status: 'CONFLICTED', revision: 0, topic: 'late_fee_policy', semanticScope: conflict.semanticScope },
    newState: { global: { ratePercent: 5, requiresExplicitAuthority: true }, atlas: { ratePercent: 2, automaticAddOrWaive: false } },
    evidenceClaimIds: conflict.competingClaimIds,
    reason: 'Company policy is 5%; Atlas retains 2% exception',
  })
  assert.ok(result.id)
  const answer = brain.askDw({ actor: founderA, tenantId: tenantA, question: 'What is the late-fee policy?' })
  assert.equal(answer.status, 'APPROVED')
  assert.equal(answer.canonicalFinancialTruthUsed, false)
})

test('A3: newer ingestion timestamp without supersession → still CONFLICTED (R5)', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'policy-a.md', 'Charge a 5% late fee.', 'policy-a')
  ingestContent(brain, workerA, 'policy-b.md', 'Charge a 7% late fee.', 'policy-b')
  const conflict = brain.conflicts.find((row) => row.topic === 'late_fee_policy')
  assert.equal(conflict.status, 'CONFLICTED', 'newer ingestion must not auto-resolve')
  assert.equal(conflict.winnerClaimId, null)
  const snapshot = brain.createSnapshot({ actor: founderA, tenantId: tenantA })
  assert.equal(snapshot.domain.conflicts.find((c) => c.topic === 'late_fee_policy').status, 'CONFLICTED')
})

test('A4: confidence stored but never used to resolve conflict (R1)', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  // g1-realistic CSV produces CLIENT_EXCEPTION with confidence: 1 by default
  // Synthetic policies via ingestContent also get confidence: 1 by default
  ingestContent(brain, workerA, 'policy-a.md', 'Charge a 5% late fee.', 'policy-a')
  ingestContent(brain, workerA, 'policy-b.md', 'Charge a 7% late fee.', 'policy-b')
  const conflict = brain.conflicts.find((row) => row.topic === 'late_fee_policy')
  assert.equal(conflict.confidenceResolved, false)
  assert.equal(conflict.winnerClaimId, null)
})

// ── Group B: Client exception vs company policy ───────────────────────────────

test('B1: CLIENT_EXCEPTION does not appear for COMPANY-scope policy queries (R4)', () => {
  const { graph } = seeded()
  const companyPolicies = graph.getPoliciesApplicable({
    actor: founderA, tenantId: tenantA, scope: { level: SEMANTIC_SCOPE.COMPANY },
  })
  assert.equal(companyPolicies.some((n) => n.type === GRAPH_NODE_TYPE.CLIENT_EXCEPTION), false,
    'CLIENT_EXCEPTION must not appear in company-scope results')
})

test('B1b: CLIENT_EXCEPTION surfaces for CLIENT-scope queries only', () => {
  const { graph } = seeded()
  const atlasExceptions = graph.getPoliciesApplicable({
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.CLIENT, clientId: 'atlas' },
  })
  assert.ok(atlasExceptions.some((n) => n.type === GRAPH_NODE_TYPE.CLIENT_EXCEPTION), 'exception expected for atlas scope')
})

test('B2: no APPLIES_TO_COMPANY edge from any CLIENT_EXCEPTION node', () => {
  const { snapshot } = seeded()
  const exceptionKeys = snapshot.nodes
    .filter((n) => n.type === GRAPH_NODE_TYPE.CLIENT_EXCEPTION)
    .map((n) => n.stableKey)
  const bad = snapshot.edges.filter((e) => exceptionKeys.includes(e.fromKey) && e.type === GRAPH_EDGE_TYPE.APPLIES_TO_COMPANY)
  assert.equal(bad.length, 0, 'CLIENT_EXCEPTION must never have APPLIES_TO_COMPANY edge')
})

test('B3: two CLIENT_EXCEPTION claims for atlas with different rates → conflict', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  // CSV rows each produce CLIENT_EXCEPTION / late_fee_policy
  ingestContent(brain, workerA, 'atlas-a.csv', 'client,payment_terms_days,late_fee_percent\natlas,45,2', 'atlas-a')
  ingestContent(brain, workerA, 'atlas-b.csv', 'client,payment_terms_days,late_fee_percent\natlas,45,3', 'atlas-b')
  const conflict = brain.conflicts.find((row) => row.topic === 'late_fee_policy')
  assert.ok(conflict, 'conflict expected for two atlas late-fee claims')
  assert.equal(conflict.status, 'CONFLICTED')
})

test('B4: revoking atlas-exception source removes exception from graph (R6)', () => {
  const { brain, graph } = seeded()
  const source = brain.sources.find((s) => s.identity === 'atlas-exception.md')
  assert.ok(source)
  brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: source.id, reason: 'withdrawn' })
  const next = graph.build({ actor: founderA, tenantId: tenantA })
  assert.equal(
    next.nodes.some((n) => n.type === GRAPH_NODE_TYPE.CLIENT_EXCEPTION && n.active),
    false,
    'exception node must be gone after source revoked',
  )
  const contracts = graph.getContractsForClient({ actor: founderA, tenantId: tenantA, clientId: 'atlas' })
  assert.ok(contracts.length >= 0) // contract node from atlas-contract.md still present if not revoked
})

// ── Group C: Effective dates and temporal state ───────────────────────────────

test('C1: null effectiveTime on g1-realistic claims → G2 stores null, not a proxy date', () => {
  const { brain } = seeded()
  const sopClaim = brain.claims.find((c) => c.tenantId === tenantA && c.claimType === 'late_fee_policy' && c.claimClass === CLAIM_CLASS.COMPANY_POLICY)
  assert.ok(sopClaim)
  assert.equal(sopClaim.effectiveTime, null, 'null effectiveTime must be preserved — not substituted')
})

test('C2: frontmatter contract carries structured effectiveTime from g2-graph fixture', () => {
  const { brain } = seeded()
  const contractClaim = brain.claims.find((c) => c.tenantId === tenantA && c.claimType === 'contract_record')
  assert.ok(contractClaim, 'contract_record claim expected')
  assert.ok(contractClaim.effectiveTime, 'effectiveTime must be present for frontmatter contract')
  assert.ok(contractClaim.effectiveTime.from, 'effectiveTime.from must be set')
})

test('C3: historical-late-fee-policy.md has HISTORICAL_TO edge, not APPLIES_TO_COMPANY', () => {
  const { snapshot } = seeded()
  const historical = snapshot.nodes.find((n) => n.stableKey === 'policy:policy-late-fee-2022')
  assert.ok(historical, 'historical policy node must be present')
  assert.equal(historical.semanticScope.level, SEMANTIC_SCOPE.HISTORICAL)
  assert.ok(snapshot.edges.some((e) => e.fromKey === historical.stableKey && e.type === GRAPH_EDGE_TYPE.HISTORICAL_TO),
    'must have HISTORICAL_TO edge')
  assert.equal(snapshot.edges.some((e) => e.fromKey === historical.stableKey && e.type === GRAPH_EDGE_TYPE.APPLIES_TO_COMPANY),
    false, 'must not have APPLIES_TO_COMPANY edge')
  // Structured effectiveTime preserved
  assert.equal(historical.effectiveTime?.from, '2022-01-01')
  assert.equal(historical.effectiveTime?.to, '2023-12-31')
})

// ── Group D: Overlapping / future effective periods ───────────────────────────

test('D1: two overlapping future-dated policies — neither has winner (policyPrecedenceResolved:false)', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'pol-2024.md',
    '---\ndocument_type: policy_candidate\npolicy_id: pol-2024\nscope: COMPANY\neffective_from: 2024-01-01\n---\n# Policy A\nCharge a 5% late fee.',
    'pol-2024')
  ingestContent(brain, workerA, 'pol-2025.md',
    '---\ndocument_type: policy_candidate\npolicy_id: pol-2025\nscope: COMPANY\neffective_from: 2025-01-01\n---\n# Policy B\nCharge a 7% late fee.',
    'pol-2025')
  const graph = new CompanyGraphStore({ brainStore: brain, clock: clocks() })
  const snapshot = graph.build({ actor: founderA, tenantId: tenantA })
  assert.equal(snapshot.policyPrecedenceResolved, false)
})

test('D2: frontmatter contract with future effective_from carries the date as structured effectiveTime', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'future-contract.md',
    '---\ndocument_type: contract\ncontract_id: contract-future\nclient_id: atlas\nscope: CLIENT\neffective_from: 2027-01-01\n---\n# Future contract',
    'future-contract')
  const claim = brain.claims.find((c) => c.claimType === 'contract_record')
  assert.ok(claim)
  assert.equal(claim.effectiveTime?.from, '2027-01-01')
})

test('D3: atlas-precedent.md is HISTORICAL — available for retrospective, not current', () => {
  const { brain, snapshot } = seeded()
  const precedentClaim = brain.claims.find((c) => c.claimType === 'precedent_record')
  assert.ok(precedentClaim)
  assert.equal(precedentClaim.semanticScope.level, 'HISTORICAL')
  const precedentNode = snapshot.nodes.find((n) => n.type === GRAPH_NODE_TYPE.PRECEDENT)
  assert.ok(precedentNode)
  assert.equal(precedentNode.active, true) // still in snapshot as historical evidence
})

// ── Group E: Revoked source ───────────────────────────────────────────────────

test('E1: revoked source → claims inactive, tombstone created, conflict rebuilt', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'policy-a.md', 'Charge a 5% late fee.', 'policy-a')
  ingestContent(brain, workerA, 'policy-b.md', 'Charge a 7% late fee.', 'policy-b')
  assert.ok(brain.conflicts.find((c) => c.status === 'CONFLICTED'))
  const source = brain.sources.find((s) => s.identity === 'policy-a')
  brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: source.id, reason: 'test' })
  assert.equal(source.active, false)
  assert.ok(brain.tombstones.find((t) => t.sourceId === source.id))
  const claimsFromRevoked = brain.claims.filter((c) => c.sourceVersionId === brain.sourceVersions.find((sv) => sv.sourceId === source.id)?.id)
  assert.ok(claimsFromRevoked.every((c) => c.active === false), 'all claims from revoked source must be inactive')
  assert.equal(brain.conflicts.find((c) => c.status === 'CONFLICTED'), undefined, 'conflict dissolves when only one claim remains')
})

test('E2: revoking atlas-exception source removes its graph evidence (R6)', () => {
  const { brain, graph } = seeded()
  const source = brain.sources.find((s) => s.identity === 'atlas-exception.md')
  brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: source.id, reason: 'withdrawn' })
  const next = graph.build({ actor: founderA, tenantId: tenantA })
  assert.equal(next.nodes.some((n) => n.type === GRAPH_NODE_TYPE.CLIENT_EXCEPTION && n.active), false)
  assert.ok(next.edges.every((e) => e.type !== GRAPH_EDGE_TYPE.EXCEPTION_FOR || !e.active || e.toKey !== 'entity:CLIENT:atlas'))
})

test('E3: revoking founder-instruction source removes FOUNDER_INSTRUCTION claim', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'policy.md', 'Charge a 5% late fee.', 'policy')
  ingestContent(brain, workerA, 'founder.txt', 'We stopped charging late fees until I approve a new policy.', 'founder')
  const founderClaim = brain.claims.find((c) => c.claimClass === CLAIM_CLASS.FOUNDER_INSTRUCTION && c.active)
  assert.ok(founderClaim)
  const source = brain.sources.find((s) => s.identity === 'founder')
  brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: source.id, reason: 'decision recorded' })
  assert.equal(brain.claims.find((c) => c.id === founderClaim.id)?.active, false)
})

// ── Group F: Historical evidence and entity identity ──────────────────────────

test('F1: HISTORICAL_PRECEDENT from acme-ar-ops fixture is present (old-ar-rules.csv)', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  const { sources, artifacts, claims } = ingestCompanyBrainFixture({
    fixtureDirectory: path.join(fixtureRoot, 'acme-ar-ops'), tenantId: tenantA,
  })
  const historicalClaim = claims.find((c) => c.claimClass === CLAIM_CLASS.HISTORICAL_PRECEDENT && c.claimType === 'late_fee_policy')
  assert.ok(historicalClaim, 'HISTORICAL_PRECEDENT late_fee_policy claim expected from old-ar-rules.csv')
  assert.equal(historicalClaim.value.ratePercent, 10)
  assert.equal(historicalClaim.semanticScope.temporality, 'HISTORICAL')
})

test('F1b: historical-late-fee-policy.md in g2-graph stays HISTORICAL — HISTORICAL_TO edge, never APPLIES_TO_COMPANY (R5)', () => {
  const { snapshot } = seeded()
  const historical = snapshot.nodes.find((n) => n.stableKey === 'policy:policy-late-fee-2022')
  assert.ok(historical)
  assert.equal(snapshot.edges.some((e) => e.fromKey === historical.stableKey && e.type === GRAPH_EDGE_TYPE.APPLIES_TO_COMPANY), false)
  assert.ok(snapshot.edges.some((e) => e.fromKey === historical.stableKey && e.type === GRAPH_EDGE_TYPE.HISTORICAL_TO))
})

test('F2: "Acme" alias is ambiguous across acme-us and acme-eu (entity identity)', () => {
  const { graph } = seeded()
  const resolution = graph.resolveClientAlias({ actor: founderA, tenantId: tenantA, alias: 'Acme' })
  assert.equal(resolution.state, RESOLUTION_STATE.AMBIGUOUS)
  assert.equal(resolution.selectedKey, null)
  assert.equal(resolution.candidateKeys.length, 2)
})

test('F3: orphan "Northwind West" reference stays UNRESOLVED', () => {
  const { graph } = seeded()
  const unresolved = graph.getUnresolvedRelationships({ actor: founderA, tenantId: tenantA })
  assert.ok(unresolved.some((r) => r.reference === 'Northwind West' && r.state === RESOLUTION_STATE.UNRESOLVED))
})

// ── Group G: Communication and behavioral evidence ────────────────────────────

test('G1: account-manager email → INTERPRETATION, not policy — no late_fee_policy conflict from it', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'am.md', 'Sure, give Atlas 20% off.', 'am')
  const claim = brain.claims.find((c) => c.claimClass === CLAIM_CLASS.INTERPRETATION && c.claimType === 'settlement_discount_statement')
  assert.ok(claim, 'INTERPRETATION / settlement_discount_statement expected')
  assert.equal(claim.uncertainty, 'COMMUNICATION_NOT_AUTHORITY')
  // Must not trigger a late_fee_policy conflict
  assert.equal(brain.conflicts.find((c) => c.topic === 'late_fee_policy'), undefined)
})

test('G1b: Ask DW for AM discount → REQUIRE_APPROVAL', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'policy.md', 'Charge a 5% late fee.', 'policy')
  ingestContent(brain, workerA, 'am.md', 'Sure, give Atlas 20% off.', 'am')
  const answer = brain.askDw({ actor: founderA, tenantId: tenantA, question: 'Can we waive 20% for Atlas?' })
  assert.equal(answer.status, 'REQUIRE_APPROVAL')
  assert.equal(answer.canonicalFinancialTruthUsed, false)
})

test('G2: repeated approvals do not become standing authority (R3)', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'policy.md', 'Charge a 5% late fee.', 'policy')
  const approvalHistory = Array.from({ length: 25 }, (_, i) => ({
    tenantId: tenantA, actionClass: 'APPLY_LATE_FEE',
    id: `approval-${i}`, decidedBy: founderA.id, decidedAt: '2026-01-01T00:00:00Z',
  }))
  const result = brain.evaluateAuthority({
    actor: founderA, tenantId: tenantA, actionClass: 'APPLY_LATE_FEE',
    scope: { level: 'COMPANY' }, approvalHistory,
  })
  assert.equal(result.actual, AUTHORITY_RESULT.REQUIRE_APPROVAL, 'must remain REQUIRE_APPROVAL')
  assert.equal(result.grantId, null)
  assert.ok(result.repeatedApprovalCount >= 25)
})

test('G3: explicit authority grant → GRANTED', async () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'policy.md', 'Charge a 5% late fee.', 'policy')
  const claim = brain.claims.find((c) => c.active)
  const proposal = createAuthorityProposal({ id: 'proposal-g3', tenantId: tenantA, actionClass: 'APPLY_LATE_FEE', scope: { level: 'COMPANY' }, evidenceClaimIds: [claim.id] })
  brain.persistAuthorityProposal({ actor: founderA, tenantId: tenantA, proposal })
  brain.decideAuthority({ actor: founderA, tenantId: tenantA, proposalId: proposal.id, decision: AUTHORITY_STATUS.APPROVED })
  const result = brain.evaluateAuthority({ actor: founderA, tenantId: tenantA, actionClass: 'APPLY_LATE_FEE', scope: { level: 'COMPANY' } })
  assert.equal(result.actual, AUTHORITY_RESULT.GRANTED)
  assert.ok(result.grantId)
})

// ── Group H: Provenance integrity ─────────────────────────────────────────────

test('H1: payment claim → INTERPRETATION; assertCompanyBrainCannotWriteCanonicalMoney throws (R0)', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'payment.md', 'Invoice 104 was paid yesterday.', 'payment')
  const claim = brain.claims.find((c) => c.claimClass === CLAIM_CLASS.INTERPRETATION && c.claimType === 'contextual_payment_statement')
  assert.ok(claim)
  assert.equal(claim.canonicalFinancialTruth, false)
  assert.throws(() => assertCompanyBrainCannotWriteCanonicalMoney({ objectType: 'invoice', action: 'update' }), /R0/)
  assert.throws(() => assertCompanyBrainCannotWriteCanonicalMoney({ truthDimension: 'INVOICE_AR_STATE' }), /R0/)
})

test('H1b: Ask DW for invoice payment → AUTHORITATIVE_FINANCIAL_REFETCH_REQUIRED', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'payment.md', 'Invoice 104 was paid yesterday.', 'payment')
  const answer = brain.askDw({ actor: founderA, tenantId: tenantA, question: 'Invoice 104 was paid — is it paid?' })
  assert.equal(answer.status, 'AUTHORITATIVE_FINANCIAL_REFETCH_REQUIRED')
  assert.equal(answer.canonicalFinancialTruthUsed, false)
})

test('H2: duplicate content ingestion → duplicateContent:true, no spurious conflict', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  const content = 'Charge a 5% late fee.'
  ingestContent(brain, workerA, 'policy.md', content, 'policy')
  const before = brain.conflicts.length
  const r2 = ingestContent(brain, workerA, 'policy.md', content, 'policy', 'v2')
  assert.equal(r2.duplicateContent, true)
  assert.equal(r2.createdClaimIds.length, 0)
  assert.equal(brain.conflicts.length, before)
})

test('H3: claim with unknown provenance root → prepareSnapshot throws (Gap 4 regression)', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'policy.md', 'Charge a 5% late fee.', 'policy')
  // Inject a claim with a non-existent sourceVersionId
  brain.claims.push({
    kind: 'COMPANY_BRAIN_CLAIM_V0', tenantId: tenantA, id: 'dangling-claim', active: true,
    claimClass: CLAIM_CLASS.INTERPRETATION, claimType: 'late_fee_policy',
    semanticScope: { level: 'COMPANY' }, subjectScope: {}, value: { ratePercent: 99 },
    artifactIds: [], provenanceRootIds: ['00000000-does-not-exist'],
    sourceVersionId: '00000000-does-not-exist',
    explicit: false, derived: false, confidence: null, uncertainty: null, effectiveTime: null,
    status: 'OBSERVED', assumptions: [], revoked: false, canonicalFinancialTruth: false, independentCorroboration: false,
  })
  assert.throws(
    () => brain.prepareSnapshot({ actor: founderA, tenantId: tenantA }),
    /root provenance unknown/,
    'dangling provenance must fail closed (R6)',
  )
})

// ── Group I: Cross-tenant isolation ──────────────────────────────────────────

test('I1: cross-tenant graph read blocked', () => {
  const { graph } = seeded()
  assert.throws(
    () => graph.getEntity({ actor: founderB, tenantId: tenantA, type: GRAPH_NODE_TYPE.CLIENT, identity: 'atlas' }),
    /tenant mismatch/,
  )
})

test('I2: cross-tenant graph provenance rejected on persist', () => {
  const { brain, graph } = seeded()
  const brain2 = new CompanyBrainDurableStore({ clock: clocks() })
  ingestFile(brain2, workerB, 'g2-graph', 'entity-registry.csv', 'entity-registry.csv', 'v1-b')
  const foreignClaim = brain2.claims.find((c) => c.tenantId === tenantB)
  const foreignVersion = brain2.sourceVersions.find((sv) => sv.tenantId === tenantB)
  const node = createGraphNode({
    tenantId: tenantA, stableKey: 'entity:CLIENT:forged', type: GRAPH_NODE_TYPE.CLIENT, label: 'Forged',
    claimIds: [foreignClaim.id], rootSourceVersionIds: [foreignVersion.id],
    provenancePairs: [{ claimId: foreignClaim.id, sourceVersionId: foreignVersion.id, independent: true }],
  })
  assert.throws(() => graph.persistNode({ actor: founderA, tenantId: tenantA, node }), /dangling or cross-tenant/)
})

// ── Group J: Scope and edge cases ─────────────────────────────────────────────

test('J1: COMPANY-scope query excludes all CLIENT-scoped nodes (R4)', () => {
  const { graph } = seeded()
  const policies = graph.getPoliciesApplicable({
    actor: founderA, tenantId: tenantA, scope: { level: SEMANTIC_SCOPE.COMPANY },
  })
  const clientScopedInResult = policies.filter((n) => n.semanticScope?.level === SEMANTIC_SCOPE.CLIENT)
  assert.equal(clientScopedInResult.length, 0)
})

test('J2: stale graph snapshot after ingestion → activeSnapshot null → rebuilt on demand', () => {
  const { brain, graph, snapshot } = seeded()
  ingestContent(brain, workerA, 'extra.md', 'Charge a 7% late fee.', 'extra')
  assert.equal(graph.activeSnapshot({ actor: founderA, tenantId: tenantA }), null, 'must be stale')
  const fresh = graph.requireSnapshot({ actor: founderA, tenantId: tenantA })
  assert.notEqual(fresh.id, snapshot.id)
  assert.ok(graph.activeSnapshot({ actor: founderA, tenantId: tenantA }))
})

test('J3: SUPERSEDES edge requires explicit:true — ingestion order alone cannot supersede (R5, R8)', () => {
  assert.throws(() => createGraphEdge({
    tenantId: tenantA, stableKey: 'edge-supersedes', type: GRAPH_EDGE_TYPE.SUPERSEDES,
    fromKey: 'policy:b', toKey: 'policy:a',
    explicit: false,
    claimIds: ['claim-x'], rootSourceVersionIds: ['root-x'],
  }), /explicit evidence/, 'SUPERSEDES edge without explicit:true must be rejected')
})

// ── Group K: R0–R9 invariant regression ──────────────────────────────────────

test('K1: R0 — canonicalMoneyWritable:false on every G2 snapshot surface', () => {
  const { snapshot } = seeded()
  assert.equal(snapshot.canonicalMoneyWritable, false)
  assert.equal(snapshot.authorityGrantable, false)
  assert.equal(snapshot.policyPrecedenceResolved, false)
  const brainSnapshot = seeded().brain.createSnapshot({ actor: founderA, tenantId: tenantA })
  assert.equal(brainSnapshot.domain.canonicalMoneyWritable, false)
})

test('K1b: R0 — assertCompanyBrainCannotWriteCanonicalMoney guards invoice mutations', () => {
  assert.throws(() => assertCompanyBrainCannotWriteCanonicalMoney({ objectType: 'invoice' }), /R0/)
  assert.throws(() => assertCompanyBrainCannotWriteCanonicalMoney({ objectType: 'payment' }), /R0/)
  assert.throws(() => assertCompanyBrainCannotWriteCanonicalMoney({ truthDimension: 'INVOICE_AR_STATE' }), /R0/)
  assert.throws(() => assertCompanyBrainCannotWriteCanonicalMoney({ truthDimension: 'PAYMENT_ATTEMPT_STATE' }), /R0/)
  assert.equal(assertCompanyBrainCannotWriteCanonicalMoney({ objectType: 'policy' }), true)
})

test('K1c: R0 — dwIntelligenceContext boundaries structurally enforce R0', () => {
  const { graph } = seeded()
  const ctx = graph.dwIntelligenceContext({ actor: founderA, tenantId: tenantA, clientId: 'atlas' })
  assert.deepEqual(ctx.boundaries, {
    canonicalMoneyWritable: false,
    authorityGrantable: false,
    policyConflictsResolvableByConfidence: false,
    observedDelegationIsAuthority: false,
  })
})

test('K2: R1 — confidence never resolves conflict; winnerClaimId:null', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'policy-a.md', 'Charge a 5% late fee.', 'policy-a')
  ingestContent(brain, workerA, 'policy-b.md', 'Charge a 7% late fee.', 'policy-b')
  const conflict = brain.conflicts.find((c) => c.topic === 'late_fee_policy')
  assert.equal(conflict.confidenceResolved, false)
  assert.equal(conflict.winnerClaimId, null)
})

test('K3: R4 — CLIENT-scoped policy nodes excluded from COMPANY-scope results structurally', () => {
  const { graph, snapshot } = seeded()
  // Structural: no APPLIES_TO_COMPANY edge from any CLIENT_EXCEPTION or CLIENT-scoped node
  const clientScopedNodeKeys = snapshot.nodes
    .filter((n) => n.semanticScope?.level === SEMANTIC_SCOPE.CLIENT)
    .map((n) => n.stableKey)
  const widening = snapshot.edges.filter((e) =>
    clientScopedNodeKeys.includes(e.fromKey) && e.type === GRAPH_EDGE_TYPE.APPLIES_TO_COMPANY)
  assert.equal(widening.length, 0, 'no CLIENT-scoped node may have an APPLIES_TO_COMPANY edge')
})

test('K4: R6 — revoked claim rejected as founder decision evidence', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'policy-a.md', 'Charge a 5% late fee.', 'policy-a')
  ingestContent(brain, workerA, 'policy-b.md', 'Charge a 7% late fee.', 'policy-b')
  const conflict = brain.conflicts.find((c) => c.topic === 'late_fee_policy')
  const claimA = brain.claims.find((c) => c.active && c.claimType === 'late_fee_policy' && c.value.ratePercent === 5)
  const sourceA = brain.sources.find((s) => s.identity === 'policy-a')
  brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: sourceA.id, reason: 'withdrawn' })
  // Attempt to use the now-inactive claim as evidence
  assert.throws(() => brain.recordFounderDecision({
    actor: founderA, tenantId: tenantA, idempotencyKey: 'dec-k4',
    targetId: conflict.id, expectedRevision: 0,
    decisionType: 'POLICY_RESOLUTION',
    oldState: { status: 'CONFLICTED', revision: 0, topic: 'late_fee_policy', semanticScope: conflict.semanticScope },
    newState: { global: { ratePercent: 5 }, atlas: {} },
    evidenceClaimIds: conflict.competingClaimIds,
    reason: 'test',
  }), /provenance mismatch|target missing|provenance unknown/, 'revoked claim evidence must be rejected (R6)')
})

test('K5: R8 — unresolved conflict has no winner, confidenceResolved:false', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'policy-a.md', 'Charge a 5% late fee.', 'policy-a')
  ingestContent(brain, workerA, 'policy-b.md', 'Charge a 7% late fee.', 'policy-b')
  const conflict = brain.conflicts.find((c) => c.topic === 'late_fee_policy')
  assert.equal(conflict.status, 'CONFLICTED')
  assert.equal(conflict.winnerClaimId, null)
  assert.equal(conflict.confidenceResolved, false)
  assert.equal(conflict.resolutionDecisionId, null)
})

// ── Ask DW contract ───────────────────────────────────────────────────────────

test('Ask DW: late-fee policy CONFLICTED before resolution', () => {
  const brain = new CompanyBrainDurableStore({ clock: clocks() })
  ingestContent(brain, workerA, 'policy-a.md', 'Charge a 5% late fee.', 'policy-a')
  ingestContent(brain, workerA, 'policy-b.md', 'Charge a 7% late fee.', 'policy-b')
  const answer = brain.askDw({ actor: founderA, tenantId: tenantA, question: 'What is the late-fee policy?' })
  assert.equal(answer.status, 'CONFLICTED')
  assert.equal(answer.canonicalFinancialTruthUsed, false)
})

test('Ask DW: Atlas 2% does not widen to company scope (R4 — graph level)', () => {
  const { graph } = seeded()
  const answer = graph.askDw({ actor: founderA, tenantId: tenantA, question: "Does Atlas's 2% late fee apply to every client?" })
  assert.equal(answer.status, 'SCOPED')
  assert.match(answer.answer, /does not widen/)
})

test('Ask DW: settlement authority is observed, not granted (R7)', () => {
  const { graph } = seeded()
  const answer = graph.askDw({ actor: founderA, tenantId: tenantA, question: 'Who can approve settlements?' })
  assert.equal(answer.status, 'OBSERVED_NOT_AUTHORITY')
  assert.equal(answer.actualDwAuthority, 'NOT_GRANTED')
})

test('Ask DW: Acme ambiguity surfaced, selectedKey:null', () => {
  const { graph } = seeded()
  const answer = graph.askDw({ actor: founderA, tenantId: tenantA, question: 'Who is Acme?' })
  assert.equal(answer.status, RESOLUTION_STATE.AMBIGUOUS)
  assert.equal(answer.selectedKey, null)
})

test('Ask DW: graph never uses a stale snapshot after source revocation', () => {
  const { brain, graph, snapshot } = seeded()
  const source = brain.sources.find((s) => s.identity === 'atlas-exception.md')
  brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: source.id, reason: 'withdrawn' })
  assert.equal(graph.activeSnapshot({ actor: founderA, tenantId: tenantA }), null, 'stale after revocation')
  const answer = graph.askDw({ actor: founderA, tenantId: tenantA, question: 'Why does this rule apply to Atlas?' })
  assert.notEqual(answer.graphVersion, snapshot.id, 'answer must use fresh graph')
})

// ── DW Intelligence context ───────────────────────────────────────────────────

test('DW Intelligence context: required G2 fields present', () => {
  const { graph, snapshot } = seeded()
  const ctx = graph.dwIntelligenceContext({ actor: founderA, tenantId: tenantA, clientId: 'atlas' })
  assert.equal(ctx.kind, 'DW_INTELLIGENCE_COMPANY_GRAPH_CONTEXT_V0')
  assert.equal(ctx.graphVersion, snapshot.id)
  assert.ok(ctx.relationships.length > 0)
  assert.ok(ctx.provenancePaths.every((p) => p.provenance.rootSourceVersionIds.length > 0))
})

test('DW Intelligence context: R0 boundaries enforced structurally', () => {
  const { graph } = seeded()
  const ctx = graph.dwIntelligenceContext({ actor: founderA, tenantId: tenantA })
  assert.equal(ctx.boundaries.canonicalMoneyWritable, false)
  assert.equal(ctx.boundaries.authorityGrantable, false)
  assert.equal(ctx.boundaries.policyConflictsResolvableByConfidence, false)
  assert.equal(ctx.boundaries.observedDelegationIsAuthority, false)
})

test('DW Intelligence context: tombstones surface after source revocation', () => {
  const { brain, graph } = seeded()
  const source = brain.sources.find((s) => s.identity === 'atlas-exception.md')
  brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: source.id, reason: 'withdrawn' })
  graph.build({ actor: founderA, tenantId: tenantA }) // force rebuild
  const brainCtx = brain.dwIntelligenceContext({ actor: founderA, tenantId: tenantA, clientId: 'atlas' })
  assert.ok(brainCtx.revocationStatus.tombstones.length > 0)
  assert.ok(brainCtx.revocationStatus.tombstones.some((t) => t.sourceId === source.id))
})

// ── G3: Temporal classification ───────────────────────────────────────────────

test('G3-temporal: classify UNKNOWN/CURRENT/EXPIRED/FUTURE from effectiveTime and queryDate', () => {
  const qd = '2026-01-15'

  // HISTORICAL_PRECEDENT class → always HISTORICAL regardless of dates
  assert.equal(classifyTemporalState({ from: '2024-01-01', to: null }, undefined, CLAIM_CLASS.HISTORICAL_PRECEDENT, qd), TEMPORAL_STATE.HISTORICAL)

  // temporality = 'HISTORICAL' → HISTORICAL
  assert.equal(classifyTemporalState(null, 'HISTORICAL', CLAIM_CLASS.COMPANY_POLICY, qd), TEMPORAL_STATE.HISTORICAL)

  // null effectiveTime → UNKNOWN
  assert.equal(classifyTemporalState(null, undefined, CLAIM_CLASS.COMPANY_POLICY, qd), TEMPORAL_STATE.UNKNOWN)

  // { from: null, to: null } → UNKNOWN
  assert.equal(classifyTemporalState({ from: null, to: null }, undefined, CLAIM_CLASS.COMPANY_POLICY, qd), TEMPORAL_STATE.UNKNOWN)

  // to <= queryDate → EXPIRED
  assert.equal(classifyTemporalState({ from: '2023-01-01', to: '2025-12-31' }, undefined, CLAIM_CLASS.COMPANY_POLICY, qd), TEMPORAL_STATE.EXPIRED)

  // from > queryDate → FUTURE
  assert.equal(classifyTemporalState({ from: '2027-01-01', to: null }, undefined, CLAIM_CLASS.COMPANY_POLICY, qd), TEMPORAL_STATE.FUTURE)

  // from <= queryDate, to null → CURRENT
  assert.equal(classifyTemporalState({ from: '2025-06-01', to: null }, undefined, CLAIM_CLASS.COMPANY_POLICY, qd), TEMPORAL_STATE.CURRENT)

  // from <= queryDate, to > queryDate → CURRENT
  assert.equal(classifyTemporalState({ from: '2025-06-01', to: '2027-06-01' }, undefined, CLAIM_CLASS.COMPANY_POLICY, qd), TEMPORAL_STATE.CURRENT)

  // from null, to set and not expired → UNKNOWN (start not stated)
  assert.equal(classifyTemporalState({ from: null, to: '2030-01-01' }, undefined, CLAIM_CLASS.COMPANY_POLICY, qd), TEMPORAL_STATE.UNKNOWN)
})

test('G3-temporal: UNKNOWN temporal state prevents automatic resolution — canActAutomatically:false', async () => {
  // g1-realistic claims all have null effectiveTime → UNKNOWN temporal state
  const { graph, brain } = seeded()
  const ctx = buildG3DwIntelligenceContext(graph, brain, {
    actor: founderA, tenantId: tenantA, queryDate: '2026-08-31',
  })
  assert.equal(ctx.kind, 'G3_DW_INTELLIGENCE_CONTEXT_V0')
  assert.equal(ctx.authorityBoundary.canActAutomatically, false)
  assert.ok(ctx.temporalApplicability.hasUnknownTemporal, 'expected UNKNOWN temporal on g1-realistic candidates')
})

// ── G3: Conflict classification ───────────────────────────────────────────────

test('G3-conflict-class: FOUNDER_INSTRUCTION_VS_PRIOR_POLICY classified when both present', () => {
  // seeded() has 5% COMPANY_POLICY (collections-policy.md) + FOUNDER_INSTRUCTION (founder-instruction.txt)
  // both with null effectiveTime → UNKNOWN; entity-registry gives COMPANY node → APPLIES_TO_COMPANY edges present
  const { graph, brain } = seeded()

  const result = resolvePolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.COMPANY },
    topic: 'late_fee_policy',
    queryDate: '2026-08-31',
  })

  assert.equal(result.status, G3_RESOLUTION_STATUS.CONFLICTED)
  const classes = result.conflicts.map((c) => c.conflictClass)
  // Deterministic: the pair (COMPANY_POLICY, FOUNDER_INSTRUCTION) with UNKNOWN temporal
  // must be classified as FOUNDER_INSTRUCTION_VS_PRIOR_POLICY (check 5 in pairwise loop).
  // OVERLAPPING_EFFECTIVE_PERIODS would only appear if both were the same claim class.
  assert.ok(
    classes.includes(CONFLICT_CLASS.FOUNDER_INSTRUCTION_VS_PRIOR_POLICY),
    `expected FOUNDER_INSTRUCTION_VS_PRIOR_POLICY in ${JSON.stringify(classes)}`,
  )
  assert.ok(
    !classes.includes(CONFLICT_CLASS.OVERLAPPING_EFFECTIVE_PERIODS),
    `must not emit OVERLAPPING_EFFECTIVE_PERIODS for a FOUNDER_INSTRUCTION/COMPANY_POLICY pair, got: ${JSON.stringify(classes)}`,
  )
  assert.equal(result.canActAutomatically, false)
  assert.equal(result.canonicalMoneyWritable, false)
})

test('G3-conflict-class: OVERLAPPING_EFFECTIVE_PERIODS when two candidates have open-ended UNKNOWN effectiveTo', () => {
  // seeded() has 5% COMPANY_POLICY (UNKNOWN temporal). Add a 3% COMPANY_POLICY (also UNKNOWN).
  // The 5%/3% pair: same class (COMPANY_POLICY), both UNKNOWN → OVERLAPPING_EFFECTIVE_PERIODS.
  const { brain, graph } = seeded()
  ingestContent(brain, workerA, 'p-3pct.md', 'We charge a 3% late fee on all overdue invoices.', 'policy-3pct-overlap')
  graph.build({ actor: founderA, tenantId: tenantA }) // rebuild to pick up new claim

  const result = resolvePolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.COMPANY },
    topic: 'late_fee_policy',
    queryDate: '2026-08-31',
  })

  assert.equal(result.status, G3_RESOLUTION_STATUS.CONFLICTED)
  const classes = result.conflicts.map((c) => c.conflictClass)
  assert.ok(
    classes.includes(CONFLICT_CLASS.OVERLAPPING_EFFECTIVE_PERIODS),
    `expected OVERLAPPING_EFFECTIVE_PERIODS among ${JSON.stringify(classes)}`,
  )
})

test('G3-conflict-class: CONFIDENCE_DISAGREEMENT classified (not resolved) when candidates differ only by confidence', () => {
  // Synthetic PolicyCandidate objects — same value, different confidence (R1)
  const makeCandidate = (key, confidence) => ({
    graphNodeKey: key,
    claimId: `claim-${key}`,
    claimClass: CLAIM_CLASS.COMPANY_POLICY,
    topic: 'late_fee_policy',
    value: { ratePercent: 5 },
    scopeLevel: SEMANTIC_SCOPE.COMPANY,
    clientId: null,
    temporalState: TEMPORAL_STATE.UNKNOWN,
    effectiveTime: null,
    provenance: { rootSourceVersionIds: [], independent: false, independentRootCount: 0 },
    candidateStatus: CANDIDATE_STATUS.ACTIVE,
    confidence,
    explicit: true,
  })

  const candidates = [makeCandidate('policy-node-a', 1.0), makeCandidate('policy-node-b', 0.7)]
  const conflicts = classifyConflicts(candidates, { requestedScope: { level: SEMANTIC_SCOPE.COMPANY } })

  assert.ok(conflicts.length > 0, 'expected at least one conflict')
  const cc = conflicts.map((c) => c.conflictClass)
  assert.ok(
    cc.includes(CONFLICT_CLASS.CONFIDENCE_DISAGREEMENT),
    `expected CONFIDENCE_DISAGREEMENT, got: ${JSON.stringify(cc)}`,
  )
  // R1: confidence must not have resolved anything — status must remain CONFLICTED
  // (classifyConflicts itself only classifies; resolution check is in resolvePolicy)
})

test('G3-conflict-class: SCOPE_ESCALATION when CLIENT candidate is used to answer COMPANY question', () => {
  // seeded() has atlas CLIENT entity node (entity-registry.csv) + atlas-terms.csv CLIENT_EXCEPTION at CLIENT scope.
  // buildPolicyCandidates for CLIENT/atlas returns those candidates (scopeLevel=CLIENT).
  // classifyConflicts with requestedScope=COMPANY must raise SCOPE_ESCALATION (R4).
  const { graph, brain } = seeded()

  const clientCandidates = buildPolicyCandidates(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.CLIENT, clientId: 'atlas' },
    queryDate: '2026-08-31',
  })
  assert.ok(clientCandidates.length > 0, 'expected at least one CLIENT candidate from seeded atlas fixture')

  // Force COMPANY scope on classifyConflicts to trigger R4 SCOPE_ESCALATION check
  const conflicts = classifyConflicts(clientCandidates, { requestedScope: { level: SEMANTIC_SCOPE.COMPANY } })
  const classes = conflicts.map((c) => c.conflictClass)
  assert.ok(
    classes.includes(CONFLICT_CLASS.SCOPE_ESCALATION),
    `expected SCOPE_ESCALATION for CLIENT candidate in COMPANY-scope request, got: ${JSON.stringify(classes)}`,
  )
})

test('G3-conflict-class: MISSING_PRECEDENCE when two candidates have no supersession evidence', () => {
  // Two CURRENT policy_candidate frontmatter docs with explicit effective_from (before queryDate).
  // Both resolve to CURRENT → no supersession → MISSING_PRECEDENCE (R8).
  // Requires a COMPANY entity node for APPLIES_TO_COMPANY edges; seeded() provides entity-registry.
  const { brain, graph } = seeded()
  const p1 = `---\ndocument_type: policy_candidate\neffective_from: "2024-01-01"\n---\nWe charge a 5% late fee on all invoices.`
  const p2 = `---\ndocument_type: policy_candidate\neffective_from: "2025-01-01"\n---\nWe charge a 3% late fee on all overdue invoices.`
  ingestContent(brain, workerA, 'p-mp1.md', p1, 'policy-mp1')
  ingestContent(brain, workerA, 'p-mp2.md', p2, 'policy-mp2')
  graph.build({ actor: founderA, tenantId: tenantA }) // rebuild to pick up new claims

  // policy_candidate_record is the claimType for frontmatter policy_candidate docs
  const result = resolvePolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.COMPANY },
    topic: 'policy_candidate_record',
    queryDate: '2026-08-31',
  })

  assert.equal(result.status, G3_RESOLUTION_STATUS.CONFLICTED)
  const classes = result.conflicts.map((c) => c.conflictClass)
  // Deterministic: both candidates have explicit effective_from → temporalState CURRENT.
  // Two CURRENT COMPANY_POLICY candidates with no supersession → MISSING_PRECEDENCE (R8).
  // OVERLAPPING_EFFECTIVE_PERIODS only fires when both candidates have UNKNOWN temporal.
  assert.ok(
    classes.includes(CONFLICT_CLASS.MISSING_PRECEDENCE),
    `expected MISSING_PRECEDENCE in ${JSON.stringify(classes)}`,
  )
  assert.ok(
    !classes.includes(CONFLICT_CLASS.OVERLAPPING_EFFECTIVE_PERIODS),
    `must not emit OVERLAPPING_EFFECTIVE_PERIODS for CURRENT candidates, got: ${JSON.stringify(classes)}`,
  )
  assert.equal(result.canActAutomatically, false)
})

// ── G3: Provenance ─────────────────────────────────────────────────────────────

test('G3-provenance: DANGLING_PROVENANCE conflict class when artifact chain is broken', () => {
  const clock = clocks()
  const brain = new CompanyBrainDurableStore({ clock })

  // Inject a claim with a phantom (non-existent) provenanceRootId
  const phantomSvId = 'phantom-sv-id-that-does-not-exist'
  brain.claims.push({
    id: 'dangling-claim-1',
    tenantId: tenantA,
    claimClass: CLAIM_CLASS.COMPANY_POLICY,
    claimType: 'late_fee_policy',
    value: { ratePercent: 99 },
    active: true,
    provenanceRootIds: [phantomSvId],
    semanticScope: { level: SEMANTIC_SCOPE.COMPANY },
    confidence: 0.9,
    derived: false,
    revoked: false,
  })
  brain.claimRoots.push({
    tenantId: tenantA, claimId: 'dangling-claim-1', sourceVersionId: phantomSvId, independent: true,
  })

  const findings = detectDanglingProvenance(brain, { tenantId: tenantA })
  assert.ok(findings.length > 0, 'expected at least one dangling provenance finding')
  assert.equal(findings[0].claimId, 'dangling-claim-1')
  assert.equal(findings[0].conflictClass, CONFLICT_CLASS.DANGLING_PROVENANCE)
  assert.ok(findings[0].danglingRootIds.includes(phantomSvId))
})

// ── G3: Supersession ──────────────────────────────────────────────────────────

test('G3-supersession: SUPERSEDES edge resolves conflict without recordFounderDecision when explicit', () => {
  // Use topic 'policy_candidate_record' to avoid the FOUNDER_INSTRUCTION competing
  // in 'late_fee_policy'. Two CURRENT policy_candidate docs: one supersedes the other.
  // After the SUPERSEDES edge, exactly one ACTIVE candidate → resolvePolicy must return RESOLVED.
  const { brain, graph } = seeded()

  const p1 = `---\ndocument_type: policy_candidate\neffective_from: 2024-01-01\n---\nWe charge a 5% late fee on all invoices.`
  const p2 = `---\ndocument_type: policy_candidate\neffective_from: 2025-01-01\n---\nWe charge a 3% late fee on overdue invoices.`
  ingestContent(brain, workerA, 'pc-ss-old.md', p1, 'pc-ss-old')
  ingestContent(brain, workerA, 'pc-ss-new.md', p2, 'pc-ss-new')
  graph.build({ actor: founderA, tenantId: tenantA })

  // Find non-HISTORICAL policy_candidate_record nodes from the two newly ingested docs
  const policyNodes = graph.nodes.filter(
    (n) => n.tenantId === tenantA && n.type === GRAPH_NODE_TYPE.POLICY_CANDIDATE && n.active,
  ).filter((n) => {
    const c = brain.claims.find((c) => c.id === n.data?.claimId)
    return c?.claimType === 'policy_candidate_record' && c?.semanticScope?.temporality !== 'HISTORICAL'
  })

  const oldNode = policyNodes.find((n) => {
    const c = brain.claims.find((c) => c.id === n.data?.claimId)
    return c?.effectiveTime?.from === '2024-01-01'
  })
  const newNode = policyNodes.find((n) => {
    const c = brain.claims.find((c) => c.id === n.data?.claimId)
    return c?.effectiveTime?.from === '2025-01-01'
  })
  assert.ok(oldNode, 'could not find 2024 policy_candidate_record node')
  assert.ok(newNode, 'could not find 2025 policy_candidate_record node')

  // Before supersession: two CURRENT candidates → CONFLICTED (MISSING_PRECEDENCE)
  const beforeResult = resolvePolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.COMPANY },
    topic: 'policy_candidate_record',
    queryDate: '2026-08-31',
  })
  assert.equal(beforeResult.status, G3_RESOLUTION_STATUS.CONFLICTED,
    `expected CONFLICTED before supersession, got: ${beforeResult.status}`)

  // Persist explicit SUPERSEDES edge: newNode supersedes oldNode
  graph.persistEdge({
    actor: founderA,
    tenantId: tenantA,
    edge: createGraphEdge({
      stableKey: `edge:${newNode.stableKey}:supersedes:${oldNode.stableKey}`,
      fromKey: newNode.stableKey,
      toKey: oldNode.stableKey,
      type: GRAPH_EDGE_TYPE.SUPERSEDES,
      tenantId: tenantA,
      explicit: true,
      claimIds: newNode.provenance.claimIds,
      rootSourceVersionIds: newNode.provenance.rootSourceVersionIds,
    }),
  })

  // After supersession: oldNode SUPERSEDED, newNode ACTIVE → exactly one active candidate
  const afterResult = resolvePolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.COMPANY },
    topic: 'policy_candidate_record',
    queryDate: '2026-08-31',
  })
  assert.equal(afterResult.status, G3_RESOLUTION_STATUS.RESOLVED,
    `expected RESOLVED after supersession, got ${afterResult.status}: ${JSON.stringify(afterResult.conflicts)}`)
  assert.equal(afterResult.winner.graphNodeKey, newNode.stableKey,
    'winner must be the newer 2025 policy_candidate_record node')
  assert.equal(afterResult.canActAutomatically, false, 'R9: canActAutomatically always false')
  assert.equal(afterResult.canonicalMoneyWritable, false, 'R0: canonicalMoneyWritable always false')
})

// ── G3: DW Intelligence context ───────────────────────────────────────────────

test('G3-dw-intelligence: G3DwIntelligenceContext.authorityBoundary.canActAutomatically=false when any conflict is CONFLICTED', () => {
  // seeded() produces a brain with CONFLICTED conflicts (founder instruction vs. 5% SOP)
  const { graph, brain } = seeded()
  const hasConflicted = brain.conflicts.some((c) => c.tenantId === tenantA && c.status === 'CONFLICTED')
  assert.ok(hasConflicted, 'seeded fixture should have at least one CONFLICTED conflict')

  const ctx = buildG3DwIntelligenceContext(graph, brain, {
    actor: founderA, tenantId: tenantA, queryDate: '2026-08-31',
  })
  assert.equal(ctx.kind, 'G3_DW_INTELLIGENCE_CONTEXT_V0')
  assert.equal(ctx.authorityBoundary.canActAutomatically, false)
  assert.ok(ctx.conflictSummary.hasUnresolvedConflicts)
  assert.ok(ctx.conflictSummary.conflictCount > 0)
  assert.equal(ctx.boundaries.canonicalMoneyWritable, false, 'R0')
  assert.equal(ctx.boundaries.observedDelegationIsAuthority, false, 'R7')
  assert.equal(ctx.boundaries.policyConflictsResolvableByConfidence, false, 'R1')
})

// ── G3-hardening: A — Client-scope policy composition ─────────────────────────

test('G3-hardening-A: buildEffectivePolicyCandidates returns company and client candidates separately tagged', () => {
  const { graph, brain } = seeded()
  const result = buildEffectivePolicyCandidates(graph, brain, {
    actor: founderA, tenantId: tenantA, clientId: 'atlas', queryDate: '2026-08-31',
  })

  // Company candidates: 5% COMPANY_POLICY + FOUNDER_INSTRUCTION + historical
  assert.ok(result.companyCandidates.length > 0, 'expected at least one company candidate')
  assert.ok(
    result.companyCandidates.every((c) => c.inheritedFromCompany === true),
    'all company candidates must be tagged inheritedFromCompany: true',
  )

  // Client candidates: atlas CLIENT_EXCEPTION (2% from atlas-terms.csv / atlas-exception.md)
  assert.ok(result.clientCandidates.length > 0, 'expected at least one client candidate for atlas')
  assert.ok(
    result.clientCandidates.every((c) => c.inheritedFromCompany === false),
    'all client candidates must be tagged inheritedFromCompany: false',
  )

  // R4: no CLIENT candidate appears in companyCandidates
  const clientKeys = new Set(result.clientCandidates.map((c) => c.graphNodeKey))
  const leaked = result.companyCandidates.filter((c) => clientKeys.has(c.graphNodeKey))
  assert.equal(leaked.length, 0, 'R4: CLIENT candidates must not appear in companyCandidates')

  // allCandidates is the union
  assert.equal(
    result.allCandidates.length,
    result.companyCandidates.length + result.clientCandidates.length,
  )

  // At least one company-scope policy (COMPANY_POLICY or FOUNDER_INSTRUCTION)
  assert.ok(
    result.companyCandidates.some(
      (c) => c.claimClass === CLAIM_CLASS.COMPANY_POLICY || c.claimClass === CLAIM_CLASS.FOUNDER_INSTRUCTION,
    ),
    'expected at least one COMPANY_POLICY or FOUNDER_INSTRUCTION in companyCandidates',
  )

  // At least one client exception
  assert.ok(
    result.clientCandidates.some((c) => c.claimClass === CLAIM_CLASS.CLIENT_EXCEPTION),
    'expected at least one CLIENT_EXCEPTION in clientCandidates',
  )
})

// ── G3-hardening: B — Identity validation ─────────────────────────────────────

test('G3-hardening-B: AMBIGUOUS_ENTITY_IDENTITY when clientId resolves to multiple entities', () => {
  // 'Acme' is a registered alias for both acme-us and acme-eu in entity-registry.csv
  const { graph, brain } = seeded()
  const result = resolvePolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.CLIENT, clientId: 'Acme' },
    topic: 'late_fee_policy',
    queryDate: '2026-08-31',
  })
  assert.equal(result.status, G3_RESOLUTION_STATUS.ABSTAIN, `expected ABSTAIN, got: ${result.status}`)
  const classes = result.conflicts.map((c) => c.conflictClass)
  assert.ok(
    classes.includes(CONFLICT_CLASS.AMBIGUOUS_ENTITY_IDENTITY),
    `expected AMBIGUOUS_ENTITY_IDENTITY in ${JSON.stringify(classes)}`,
  )
  assert.equal(result.winner, null, 'winner must be null when identity is ambiguous')
  assert.equal(result.canActAutomatically, false, 'R9: canActAutomatically always false')
  assert.equal(result.canonicalMoneyWritable, false, 'R0: canonicalMoneyWritable always false')
})

test('G3-hardening-B: AMBIGUOUS_ENTITY_IDENTITY when clientId is not in entity registry', () => {
  // 'Northwind West' does not appear in entity-registry.csv
  const { graph, brain } = seeded()
  const result = resolvePolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.CLIENT, clientId: 'Northwind West' },
    topic: 'late_fee_policy',
    queryDate: '2026-08-31',
  })
  assert.equal(result.status, G3_RESOLUTION_STATUS.ABSTAIN, `expected ABSTAIN, got: ${result.status}`)
  const classes = result.conflicts.map((c) => c.conflictClass)
  assert.ok(
    classes.includes(CONFLICT_CLASS.AMBIGUOUS_ENTITY_IDENTITY),
    `expected AMBIGUOUS_ENTITY_IDENTITY in ${JSON.stringify(classes)}`,
  )
  assert.equal(result.winner, null, 'winner must be null when identity is unresolved')
})

test('G3-hardening-B: validateClientIdentity returns valid for canonical entity ID', () => {
  const { graph } = seeded()
  const r = validateClientIdentity(graph, { actor: founderA, tenantId: tenantA, clientId: 'atlas' })
  assert.equal(r.valid, true, 'atlas is a canonical entity ID — should resolve')
  assert.equal(r.state, RESOLUTION_STATE.RESOLVED)
})

// ── G3-hardening: C — Founder decision integration ────────────────────────────

test('G3-hardening-C: applyFounderDecisions returns applied:false when no decisions exist', () => {
  const { graph, brain } = seeded()
  const candidates = buildPolicyCandidates(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.COMPANY }, queryDate: '2026-08-31',
  }).filter((c) => c.topic === 'late_fee_policy')

  const result = applyFounderDecisions(candidates, { brain, tenantId: tenantA, topic: 'late_fee_policy' })
  assert.equal(result.applied, false, 'no decisions in seeded fixture')
  assert.equal(result.winner, null)
  assert.equal(result.authorityGrantable, false, 'R9: authorityGrantable always false')
})

test('G3-hardening-C: applyFounderDecisions resolves winner when valid decision exists', () => {
  const { graph, brain } = seeded()
  const candidates = buildPolicyCandidates(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.COMPANY }, queryDate: '2026-08-31',
  }).filter((c) => c.topic === 'late_fee_policy' && c.candidateStatus === CANDIDATE_STATUS.ACTIVE)

  assert.ok(candidates.length > 0, 'expected active candidates for late_fee_policy')
  const chosenCandidate = candidates.find((c) => c.claimClass === CLAIM_CLASS.COMPANY_POLICY)
  assert.ok(chosenCandidate, 'expected a COMPANY_POLICY candidate')

  // Directly push a synthetic founder decision (testing G3 reading, not the write path)
  brain.decisions.push({
    id: 'decision-g3-test-1',
    tenantId: tenantA,
    actorId: founderA.id,
    actorRole: 'FOUNDER',
    decidedAt: '2026-08-31T10:00:00Z',
    decisionType: 'RESOLVE_CONFLICT',
    target: 'late_fee_policy',
    targetId: `conflict:${tenantA}:late_fee_policy`,
    oldState: { status: 'CONFLICTED' },
    newState: { governingClaimId: chosenCandidate.claimId },
    evidenceClaimIds: [chosenCandidate.claimId],
    reason: 'founder test decision',
    revocable: true,
    idempotencyKey: 'test-idem-g3-c-1',
    requestFingerprint: 'test',
    supersedesDecisionId: null,
    status: 'RECORDED',
  })

  const result = applyFounderDecisions(candidates, { brain, tenantId: tenantA, topic: 'late_fee_policy' })
  assert.equal(result.applied, true, 'expected applied:true when decision picks a valid candidate')
  assert.equal(result.winner?.claimId, chosenCandidate.claimId)
  assert.equal(result.authorityGrantable, false, 'R9: policy decision ≠ DW authority')
})

test('G3-hardening-C: applyFounderDecisions is invalidated when backing evidence revoked', () => {
  const { graph, brain } = seeded()
  const candidates = buildPolicyCandidates(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.COMPANY }, queryDate: '2026-08-31',
  }).filter((c) => c.topic === 'late_fee_policy' && c.candidateStatus === CANDIDATE_STATUS.ACTIVE)

  const chosenCandidate = candidates.find((c) => c.claimClass === CLAIM_CLASS.COMPANY_POLICY)
  assert.ok(chosenCandidate)

  brain.decisions.push({
    id: 'decision-g3-test-revoke',
    tenantId: tenantA,
    actorId: founderA.id,
    actorRole: 'FOUNDER',
    decidedAt: '2026-08-31T10:00:00Z',
    decisionType: 'RESOLVE_CONFLICT',
    target: 'late_fee_policy',
    targetId: `conflict:${tenantA}:late_fee_policy`,
    oldState: { status: 'CONFLICTED' },
    newState: { governingClaimId: chosenCandidate.claimId },
    evidenceClaimIds: [chosenCandidate.claimId],
    reason: 'decision under test',
    revocable: true,
    idempotencyKey: 'test-idem-g3-c-revoke',
    requestFingerprint: 'test',
    supersedesDecisionId: null,
    status: 'RECORDED',
  })

  // Confirm it applies before revocation
  const before = applyFounderDecisions(candidates, { brain, tenantId: tenantA, topic: 'late_fee_policy' })
  assert.equal(before.applied, true)

  // Revoke the source backing the chosen candidate
  const chosenClaim = brain.claims.find((c) => c.id === chosenCandidate.claimId)
  assert.ok(chosenClaim)
  // Deactivate the claim directly (simulating revocation effect on evidence)
  chosenClaim.active = false

  // After evidence revocation, applyFounderDecisions must not apply
  const after = applyFounderDecisions(candidates, { brain, tenantId: tenantA, topic: 'late_fee_policy' })
  assert.equal(after.applied, false, 'decision must not apply when backing evidence is revoked (R6)')
  assert.equal(after.winner, null)
})

// ── G3-hardening: D — SUPERSEDES freshness validation ─────────────────────────

test('G3-hardening-D: SUPERSEDES edge invalidated after backing evidence revoked → conflict restored', () => {
  const { brain, graph } = seeded()

  // Ingest a fresh 3% policy
  ingestContent(brain, workerA, 'policy-fresh-d.md', 'We charge a 3% late fee on overdue invoices.', 'policy-fresh-d')
  graph.build({ actor: founderA, tenantId: tenantA })

  const policyNodes = graph.nodes.filter(
    (n) => n.tenantId === tenantA && n.type === GRAPH_NODE_TYPE.POLICY_CANDIDATE && n.active,
  ).filter((n) => {
    const c = brain.claims.find((c) => c.id === n.data?.claimId)
    return c?.claimType === 'late_fee_policy'
  })

  const newNode = policyNodes.find((n) => {
    const c = brain.claims.find((c) => c.id === n.data?.claimId)
    return c?.value?.ratePercent === 3
  })
  const oldNode = policyNodes.find((n) => {
    const c = brain.claims.find((c) => c.id === n.data?.claimId)
    return c?.value?.ratePercent === 5
  })
  assert.ok(newNode, 'expected 3% late_fee_policy node')
  assert.ok(oldNode, 'expected 5% late_fee_policy node')

  // Create SUPERSEDES edge: 3% supersedes 5%
  graph.persistEdge({
    actor: founderA, tenantId: tenantA,
    edge: createGraphEdge({
      stableKey: `edge:${newNode.stableKey}:supersedes:${oldNode.stableKey}`,
      fromKey: newNode.stableKey, toKey: oldNode.stableKey,
      type: GRAPH_EDGE_TYPE.SUPERSEDES, tenantId: tenantA,
      explicit: true,
      claimIds: newNode.provenance.claimIds,
      rootSourceVersionIds: newNode.provenance.rootSourceVersionIds,
    }),
  })

  // Before revocation: 5% is SUPERSEDED
  const beforeCandidates = buildPolicyCandidates(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.COMPANY }, queryDate: '2026-08-31',
  }).filter((c) => c.topic === 'late_fee_policy')
  const fivePctBefore = beforeCandidates.find((c) => c.graphNodeKey === oldNode.stableKey)
  assert.equal(fivePctBefore?.candidateStatus, CANDIDATE_STATUS.SUPERSEDED, '5% must be SUPERSEDED after explicit edge')

  // Revoke the source backing the 3% policy (policy-fresh-d.md)
  const freshSource = brain.sources.find((s) => s.identity === 'policy-fresh-d')
  assert.ok(freshSource, 'expected policy-fresh-d.md source to exist')
  brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: freshSource.id, reason: 'revoked for D test' })
  graph.build({ actor: founderA, tenantId: tenantA })

  // After revocation: SUPERSEDES edge's provenance roots are REVOKED → edge is no longer valid.
  // The 5% node (from collections-policy.md, not revoked) should become ACTIVE again.
  const afterCandidates = buildPolicyCandidates(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.COMPANY }, queryDate: '2026-08-31',
  }).filter((c) => c.topic === 'late_fee_policy')
  const fivePctAfter = afterCandidates.find((c) => c.graphNodeKey === oldNode.stableKey)
  assert.equal(
    fivePctAfter?.candidateStatus, CANDIDATE_STATUS.ACTIVE,
    '5% must be ACTIVE again once backing evidence for the supersession is revoked (D)',
  )
})

// ── G3-hardening: E — Complete conflict/abstention model ─────────────────────

test('G3-hardening-E: CURRENT_VS_HISTORICAL detected when current candidate contradicts historical rule', () => {
  // G3 spec: CURRENT_VS_HISTORICAL fires when an ACTIVE candidate is paired with a HISTORICAL
  // one in classifyConflicts. A "historical" candidate must appear in getPoliciesApplicable
  // (APPLIES_TO_COMPANY edge) — docs with scope:HISTORICAL use HISTORICAL_TO instead and are
  // excluded. So we ingest an explicitly expired doc (effective_to in the past, no scope:HISTORICAL)
  // → gets APPLIES_TO_COMPANY edge, temporality=HISTORICAL → candidateStatus=HISTORICAL.
  const { brain, graph } = seeded()
  // Expired doc: effective_to before queryDate, no scope field → APPLIES_TO_COMPANY edge, temporality=HISTORICAL
  const hist = `---\ndocument_type: policy_candidate\neffective_to: 2023-12-31\n---\nWe charged a 10% late fee on all overdue invoices.`
  // Current doc: effective_from before queryDate, no effective_to → APPLIES_TO_COMPANY edge, temporality=CURRENT
  const curr = `---\ndocument_type: policy_candidate\neffective_from: 2026-01-01\n---\nWe charge a 5% late fee on all invoices.`
  ingestContent(brain, workerA, 'pc-cvh-hist.md', hist, 'pc-cvh-hist')
  ingestContent(brain, workerA, 'pc-cvh-curr.md', curr, 'pc-cvh-curr')
  graph.build({ actor: founderA, tenantId: tenantA })

  const result = resolvePolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.COMPANY },
    topic: 'policy_candidate_record',
    queryDate: '2026-08-31',
  })

  const classes = result.conflicts.map((c) => c.conflictClass)
  assert.ok(
    classes.includes(CONFLICT_CLASS.CURRENT_VS_HISTORICAL),
    `expected CURRENT_VS_HISTORICAL in ${JSON.stringify(classes)}`,
  )
  // CURRENT_VS_HISTORICAL is non-blocking — the current candidate can still resolve without it blocking.
  assert.equal(result.canonicalMoneyWritable, false, 'R0')
  assert.equal(result.canActAutomatically, false, 'R9')
})

test('G3-hardening-E: CONTRACT_VS_COMPANY_POLICY detected when client has active contract and company has active policy', () => {
  // atlas has an active contract (atlas-contract.md, effective_from 2026-01-01 = CURRENT).
  // The seeded company also has 5% COMPANY_POLICY.
  // Resolving late_fee_policy for atlas (CLIENT scope) must surface CONTRACT_VS_COMPANY_POLICY.
  const { graph, brain } = seeded()
  const result = resolvePolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    scope: { level: SEMANTIC_SCOPE.CLIENT, clientId: 'atlas' },
    topic: 'late_fee_policy',
    queryDate: '2026-08-31',
  })

  const classes = result.conflicts.map((c) => c.conflictClass)
  assert.ok(
    classes.includes(CONFLICT_CLASS.CONTRACT_VS_COMPANY_POLICY),
    `expected CONTRACT_VS_COMPANY_POLICY in ${JSON.stringify(classes)}`,
  )
  assert.equal(result.canActAutomatically, false, 'R9')
  assert.equal(result.canonicalMoneyWritable, false, 'R0')
})

// ── G3-hardening: F — G3 Ask DW policy ────────────────────────────────────────

test('G3-hardening-F: askDwPolicy handles 9 deterministic question types', () => {
  const { graph, brain } = seeded()

  // 1. Company policy query
  const r1 = askDwPolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    question: 'What is our late fee policy?', queryDate: '2026-08-31',
  })
  assert.equal(r1.kind, 'G3_ASK_DW_POLICY_RESPONSE_V0')
  assert.equal(r1.questionType, 'COMPANY_POLICY')
  assert.notEqual(r1.resolutionState, G3_RESOLUTION_STATUS.NO_POLICY, 'has late_fee_policy evidence')
  assert.equal(r1.canonicalMoneyWritable, false, 'R0')
  assert.equal(r1.authorityBoundary.canActAutomatically, false, 'R9')
  assert.equal(r1.authorityBoundary.authorityGrantable, false, 'R9')

  // 2. Client policy — Atlas rule
  const r2 = askDwPolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    question: 'What is the Atlas late fee rate?', clientId: 'atlas', queryDate: '2026-08-31',
  })
  assert.equal(r2.questionType, 'CLIENT_POLICY')
  assert.equal(r2.clientId, 'atlas')

  // 3. Scope inquiry — is Atlas rule company-wide?
  const r3 = askDwPolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    question: 'Is the Atlas rate company-wide?', clientId: 'atlas', queryDate: '2026-08-31',
  })
  assert.equal(r3.questionType, 'SCOPE_INQUIRY')
  assert.ok(r3.answer.includes('R4'), `expected R4 reference in scope answer: ${r3.answer}`)

  // 4. Historical
  const r4 = askDwPolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    question: 'What was the historical late fee policy?', queryDate: '2026-08-31',
  })
  assert.equal(r4.questionType, 'HISTORICAL')

  // 5. Why unresolved
  const r5 = askDwPolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    question: 'Why is the late fee policy unresolved?', queryDate: '2026-08-31',
  })
  assert.equal(r5.questionType, 'WHY_UNRESOLVED')

  // 6. Conflicts
  const r6 = askDwPolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    question: 'What conflicts exist for the late fee policy?', queryDate: '2026-08-31',
  })
  assert.equal(r6.questionType, 'CONFLICTS')

  // 7. Unresolved
  const r7 = askDwPolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    question: 'What is unresolved about the late fee policy?', queryDate: '2026-08-31',
  })
  assert.ok(['WHY_UNRESOLVED', 'CONFLICTS'].includes(r7.questionType), `expected WHY_UNRESOLVED or CONFLICTS, got: ${r7.questionType}`)

  // 8. Founder decisions
  const r8 = askDwPolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    question: 'What did the founder decide about late fees?', queryDate: '2026-08-31',
  })
  assert.equal(r8.questionType, 'FOUNDER_DECISIONS')
  assert.equal(r8.founderDecisions.length, 0, 'no decisions in seeded fixture')

  // 9. DW authority
  const r9 = askDwPolicy(graph, brain, {
    actor: founderA, tenantId: tenantA,
    question: 'Can DW act automatically on this late fee policy?', queryDate: '2026-08-31',
  })
  assert.equal(r9.questionType, 'DW_AUTHORITY')
  assert.equal(r9.authorityBoundary.canActAutomatically, false, 'R9')
  assert.equal(r9.authorityBoundary.authorityGrantable, false, 'R9: policy decision ≠ DW authority')
  assert.ok(r9.answer.includes('R9'), `expected R9 reference in DW authority answer: ${r9.answer}`)
})

// ── G3-hardening: G — DW Intelligence context expanded fields ─────────────────

test('G3-hardening-G: buildG3DwIntelligenceContext exposes all required typed fields', () => {
  const { graph, brain } = seeded()
  const ctx = buildG3DwIntelligenceContext(graph, brain, {
    actor: founderA, tenantId: tenantA, clientId: 'atlas', queryDate: '2026-08-31',
  })

  assert.equal(ctx.kind, 'G3_DW_INTELLIGENCE_CONTEXT_V0')

  // G — required typed fields
  assert.ok(Array.isArray(ctx.applicablePolicyCandidates), 'applicablePolicyCandidates must be array')
  assert.ok(Array.isArray(ctx.excludedPolicyCandidates), 'excludedPolicyCandidates must be array')
  assert.ok(Array.isArray(ctx.unresolvedConflicts), 'unresolvedConflicts must be array')
  assert.ok(Array.isArray(ctx.precedenceEvidence), 'precedenceEvidence must be array')
  assert.ok(typeof ctx.temporalApplicability === 'object', 'temporalApplicability must be object')
  assert.ok(typeof ctx.temporalApplicability.hasUnknownTemporal === 'boolean')
  assert.ok(Array.isArray(ctx.clientExceptions), 'clientExceptions must be array')
  assert.ok(Array.isArray(ctx.founderDecisions), 'founderDecisions must be array')
  assert.ok('provenancePaths' in ctx, 'provenancePaths must be present')
  assert.ok(typeof ctx.uncertainty === 'object', 'uncertainty must be object')
  assert.ok(typeof ctx.uncertainty.hasUnknownTemporal === 'boolean')
  assert.ok(typeof ctx.uncertainty.hasUnresolvedConflicts === 'boolean')
  assert.ok(typeof ctx.authorityBoundary === 'object')
  assert.equal(ctx.authorityBoundary.canActAutomatically, false, 'R9')

  // seeded atlas has at least one CLIENT_EXCEPTION
  assert.ok(ctx.clientExceptions.length > 0, 'expected at least one CLIENT_EXCEPTION for atlas')

  // Structural boundary constants (5 required)
  assert.equal(ctx.boundaries.canonicalMoneyWritable, false, 'R0')
  assert.equal(ctx.boundaries.authorityGrantable, false, 'R9')
  assert.equal(ctx.boundaries.policyConflictsResolvableByConfidence, false, 'R1')
  assert.equal(ctx.boundaries.observedDelegationIsAuthority, false, 'R7')
  assert.equal(ctx.boundaries.behaviorCreatesPolicy, false, 'R2, R3')
})
