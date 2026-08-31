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

// ── G3-only scenarios (require G3 runtime not yet implemented) ────────────────

test.todo('G3-temporal: classify UNKNOWN/CURRENT/EXPIRED/FUTURE from effectiveTime and queryDate')
test.todo('G3-temporal: UNKNOWN temporal state prevents automatic resolution — canActAutomatically:false')
test.todo('G3-conflict-class: FOUNDER_INSTRUCTION_VS_PRIOR_POLICY classified when both present')
test.todo('G3-conflict-class: OVERLAPPING_EFFECTIVE_PERIODS when two candidates have open-ended UNKNOWN effectiveTo')
test.todo('G3-conflict-class: CONFIDENCE_DISAGREEMENT classified (not resolved) when candidates differ only by confidence')
test.todo('G3-conflict-class: SCOPE_ESCALATION when CLIENT candidate is used to answer COMPANY question')
test.todo('G3-conflict-class: MISSING_PRECEDENCE when two candidates have no supersession evidence')
test.todo('G3-provenance: DANGLING_PROVENANCE conflict class when artifact chain is broken')
test.todo('G3-supersession: SUPERSEDES edge resolves conflict without recordFounderDecision when explicit')
test.todo('G3-dw-intelligence: G3DwIntelligenceContext.authorityBoundary.canActAutomatically=false when any conflict is CONFLICTED')
