import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'pgsql-parser'

import { CompanyBrainDurableStore } from '../src/lib/companyBrain/durableStore.js'
import { CompanyGraphStore, SEMANTIC_SCOPE } from '../src/lib/companyBrain/graphStore.js'
import { CANDIDATE_STATUS, G3_RESOLUTION_STATUS, buildPolicyCandidates, resolvePolicy } from '../src/lib/companyBrain/policyIntelligence.js'
import {
  OPERATING_MODEL_STATUS,
  OPERATING_STATEMENT_STATE,
  OperatingModelProposalStore,
  buildOperatingModelProposal,
  getOperatingModelProposal,
  isOperatingModelStale,
  persistOperatingModelProposal,
  toOperatingModelReviewContext,
} from '../src/lib/companyBrain/operatingModel.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const fixtureRoot = path.join(repoRoot, 'fixtures/company-brain')
const migrationPath = path.join(repoRoot, 'supabase/migrations/20260901034230_company_operating_model_g4.sql')
const operatingModelPath = path.join(repoRoot, 'src/lib/companyBrain/operatingModel.js')
const tenantA = 'tenant-a'
const tenantB = 'tenant-b'
const founderA = { id: tenantA, tenantId: tenantA, role: 'FOUNDER', authenticated: true }
const founderB = { id: tenantB, tenantId: tenantB, role: 'FOUNDER', authenticated: true }
const workerA = { id: 'worker-a', tenantId: tenantA, role: 'INGESTION_WORKER', authenticated: true }
const workerB = { id: 'worker-b', tenantId: tenantB, role: 'INGESTION_WORKER', authenticated: true }

function clock() {
  let tick = 0
  return () => `2026-08-31T16:${String(tick++).padStart(2, '0')}:00.000Z`
}

const G2_FILES = [
  'entity-registry.csv', 'atlas-contract.md', 'acme-us-contract.md', 'people-roles.csv',
  'historical-late-fee-policy.md', 'atlas-exception.md', 'collections-workflow.md',
  'atlas-precedent.md', 'orphan-reference.md', 'historical-aliases.csv', 'acme-account-manager-note.md',
]

function ingestFile(brain, actor, folder, filename, identity = filename) {
  return brain.ingestLocalFile({
    actor,
    tenantId: actor.tenantId,
    filePath: path.join(fixtureRoot, folder, filename),
    sourceIdentity: identity,
    idempotencyKey: `${actor.tenantId}:${identity}:g4`,
  })
}

function seedTenant(brain, actor) {
  const receipts = {}
  receipts.collections = ingestFile(brain, actor, 'g1-realistic', 'collections-policy.md')
  receipts.atlasTerms = ingestFile(brain, actor, 'g1-realistic', 'atlas-terms.csv')
  receipts.founderInstruction = ingestFile(brain, actor, 'g1-realistic', 'founder-instruction.txt')
  for (const filename of G2_FILES) ingestFile(brain, actor, 'g2-graph', filename)
  receipts.discount = brain.ingestContent({
    actor,
    tenantId: actor.tenantId,
    filename: 'atlas-discount-message.txt',
    content: 'Give Atlas 20% off.',
    sourceIdentity: 'atlas-discount-message',
    idempotencyKey: `${actor.tenantId}:atlas-discount-message:g4`,
  })
  return receipts
}

function seeded() {
  const now = clock()
  const brain = new CompanyBrainDurableStore({ clock: now })
  const receipts = seedTenant(brain, workerA)
  const graph = new CompanyGraphStore({ brainStore: brain, clock: now })
  graph.build({ actor: founderA, tenantId: tenantA })
  return { brain, graph, receipts, now }
}

function build(state, overrides = {}) {
  return buildOperatingModelProposal({
    actor: founderA,
    tenantId: tenantA,
    brain: state.brain,
    graph: state.graph,
    queryDate: '2026-08-31',
    generatedAt: '2026-08-31T18:00:00.000Z',
    ...overrides,
  })
}

function everyStatement(proposal) {
  return [...new Map([
    proposal.collections, proposal.billing, proposal.reminders, proposal.promisesToPay,
    proposal.escalation, proposal.disputes, proposal.clientHandling,
    proposal.rolesAndResponsibilities, proposal.communication, proposal.policyOperatingRules,
    proposal.clientOverrides.flatMap((entry) => entry.statements),
  ].flat().map((statement) => [statement.id, statement])).values()]
}

function addAtlasDecision(state) {
  const scope = { level: SEMANTIC_SCOPE.CLIENT, clientId: 'atlas' }
  const candidates = buildPolicyCandidates(state.graph, state.brain, {
    actor: founderA, tenantId: tenantA, scope, queryDate: '2026-08-31',
  }).filter((candidate) =>
    candidate.topic === 'late_fee_policy' &&
    candidate.candidateStatus === CANDIDATE_STATUS.ACTIVE &&
    candidate.scopeLevel === SEMANTIC_SCOPE.CLIENT,
  )
  const winner = candidates[0]
  assert.ok(winner, 'Atlas policy candidate required')
  state.brain.decisions.push({
    kind: 'COMPANY_BRAIN_FOUNDER_DECISION_V0',
    id: 'g4-atlas-policy-decision', tenantId: tenantA,
    actorId: founderA.id, actorRole: 'FOUNDER', decidedAt: '2026-08-31T19:00:00.000Z',
    decisionType: 'RESOLVE_CONFLICT', target: 'late_fee_policy', scope,
    oldState: { status: 'CONFLICTED' }, newState: { governingClaimId: winner.claimId },
    evidenceClaimIds: [winner.claimId], reason: 'Explicit Atlas-scoped G3 decision', revocable: true,
    idempotencyKey: 'g4-atlas-policy-decision', requestFingerprint: 'g4-test',
    supersedesDecisionId: null, status: 'RECORDED',
  })
  state.brain.bump(tenantA)
  return winner
}

test('G4-1 deterministic baseline proposal has stable semantic identity', () => {
  const state = seeded()
  const first = build(state)
  const second = build(state, { generatedAt: '2026-08-31T19:00:00.000Z' })
  assert.equal(first.kind, 'COMPANY_OPERATING_MODEL_PROPOSAL_V0')
  assert.equal(first.fingerprint, second.fingerprint)
  assert.equal(first.proposalId, second.proposalId)
  assert.notEqual(first.generatedAt, second.generatedAt)
})

test('G4-2 every confirmed statement has exact claim, graph, and root provenance', () => {
  const proposal = build(seeded())
  const confirmed = everyStatement(proposal).filter((statement) => statement.state === OPERATING_STATEMENT_STATE.CONFIRMED)
  assert.ok(confirmed.length > 0)
  for (const statement of confirmed) {
    assert.ok(statement.sourceClaimIds.length > 0)
    assert.ok(statement.sourceGraphNodeKeys.length > 0)
    assert.ok(statement.rootSourceVersionIds.length > 0)
    for (const claimId of statement.sourceClaimIds) assert.ok(proposal.evidenceIndex[claimId])
  }
})

test('G4-3 unresolved G3 company conflict remains conflicted with null value', () => {
  const state = seeded()
  const g3 = resolvePolicy(state.graph, state.brain, {
    actor: founderA, tenantId: tenantA, scope: { level: SEMANTIC_SCOPE.COMPANY },
    topic: 'late_fee_policy', queryDate: '2026-08-31',
  })
  const proposal = build(state)
  const statement = proposal.policyOperatingRules.find((entry) => entry.topic === 'late_fee_policy')
  assert.equal(g3.status, G3_RESOLUTION_STATUS.CONFLICTED)
  assert.equal(statement.state, OPERATING_STATEMENT_STATE.CONFLICTED)
  assert.equal(statement.value, null)
  assert.equal(statement.founderReviewRequired, true)
})

test('G4-4 confidence never selects a policy winner', () => {
  const state = seeded()
  const claims = state.brain.claims.filter((claim) => claim.tenantId === tenantA && claim.claimType === 'late_fee_policy')
  claims.forEach((claim, index) => { claim.confidence = index === 0 ? 1 : 0.01 })
  const statement = build(state).policyOperatingRules.find((entry) => entry.topic === 'late_fee_policy')
  assert.equal(statement.state, OPERATING_STATEMENT_STATE.CONFLICTED)
  assert.equal(statement.value, null)
})

test('G4-5 Atlas exception remains client-only and never widens to company scope', () => {
  const proposal = build(seeded())
  const atlas = proposal.clientOverrides.find((entry) => entry.clientId === 'atlas')
  assert.ok(atlas)
  assert.equal(atlas.widenedToCompany, false)
  assert.ok(atlas.statements.some((statement) => statement.topic === 'late_fee_policy'))
  assert.ok(atlas.statements.every((statement) => statement.clientId === 'atlas' || statement.scope.level === 'COMPANY'))
  assert.ok(!proposal.policyOperatingRules.some((statement) => statement.clientId === 'atlas'))
})

test('G4-6 account-manager 20% message stays observed communication, not policy', () => {
  const proposal = build(seeded())
  const message = proposal.communication.find((statement) => statement.topic === 'settlement_discount_statement')
  assert.equal(message.state, OPERATING_STATEMENT_STATE.OBSERVED)
  assert.equal(message.value.discountPercent, 20)
  assert.equal(message.policyResolutionStatus, null)
  assert.ok(!proposal.policyOperatingRules.some((statement) => statement.topic === 'settlement_discount_statement'))
})

test('G4-7 observed role/delegation never grants DW authority', () => {
  const proposal = build(seeded())
  assert.ok(proposal.rolesAndResponsibilities.length > 0)
  assert.ok(proposal.rolesAndResponsibilities.every((statement) => statement.state === OPERATING_STATEMENT_STATE.OBSERVED))
  assert.equal(proposal.boundaries.observedDelegationIsAuthority, false)
  assert.equal(proposal.boundaries.dwAuthorityDerived, false)
  assert.equal(proposal.boundaries.authorityGrantable, false)
})

test('G4-8 historical 10% evidence remains historical-only', () => {
  const proposal = build(seeded())
  const historical = everyStatement(proposal).filter((statement) => statement.state === OPERATING_STATEMENT_STATE.HISTORICAL_ONLY)
  assert.ok(historical.length > 0)
  assert.ok(historical.some((statement) => JSON.stringify(statement.value).includes('10') || statement.topic === 'precedent_record'))
  assert.ok(!proposal.policyOperatingRules.some((statement) => statement.value?.ratePercent === 10))
})

test('G4-9 source revocation makes an existing proposal stale without rebuilding', () => {
  const state = seeded()
  const proposal = build(state)
  state.brain.revokeSource({
    actor: founderA, tenantId: tenantA, sourceId: state.receipts.collections.sourceId,
    reason: 'G4 revocation test',
  })
  assert.equal(isOperatingModelStale({ proposal, actor: founderA, tenantId: tenantA, brain: state.brain, graph: state.graph }), true)
})

test('G4-10 deterministic regeneration after revocation removes affected statements', () => {
  const state = seeded()
  const before = build(state)
  state.brain.revokeSource({
    actor: founderA, tenantId: tenantA, sourceId: state.receipts.collections.sourceId,
    reason: 'G4 regeneration test',
  })
  const after = build(state)
  assert.notEqual(after.fingerprint, before.fingerprint)
  assert.equal(after.reminders.some((statement) => statement.topic === 'reminder_cadence'), false)
  assert.equal(build(state).fingerprint, after.fingerprint)
})

test('G4-11 a G3 founder decision changes Atlas policy state and model fingerprint', () => {
  const now = clock()
  const brain = new CompanyBrainDurableStore({ clock: now })
  brain.ingestContent({
    actor: workerA, tenantId: tenantA, filename: 'company-policy.md',
    content: 'Charge a 5% late fee on all overdue invoices.', sourceIdentity: 'g4-company-policy',
    idempotencyKey: 'g4-company-policy',
  })
  brain.ingestContent({
    actor: workerA, tenantId: tenantA, filename: 'entities.csv',
    content: 'entity_type,entity_id,name,aliases,company_id\nCOMPANY,duewatch-company,DueWatch,,\nCLIENT,atlas,Atlas,Atlas Co,duewatch-company',
    sourceIdentity: 'g4-entities', idempotencyKey: 'g4-entities',
  })
  brain.ingestContent({
    actor: workerA, tenantId: tenantA, filename: 'atlas-terms.csv',
    content: 'client,payment_terms_days,late_fee_percent\natlas,45,2',
    sourceIdentity: 'g4-atlas-terms', idempotencyKey: 'g4-atlas-terms',
  })
  const graph = new CompanyGraphStore({ brainStore: brain, clock: now })
  graph.build({ actor: founderA, tenantId: tenantA })
  const state = { brain, graph }
  const before = build(state)
  addAtlasDecision(state)
  const after = build(state)
  const atlas = after.clientOverrides.find((entry) => entry.clientId === 'atlas')
  const policy = atlas.statements.find((statement) => statement.topic === 'late_fee_policy' && statement.policyResolutionStatus)
  assert.notEqual(after.fingerprint, before.fingerprint)
  assert.equal(policy.policyResolutionStatus, G3_RESOLUTION_STATUS.RESOLVED)
  assert.equal(policy.state, OPERATING_STATEMENT_STATE.UNRESOLVED, 'unknown effective time remains explicit')
})

test('G4-12 exact tenant isolation covers source, node, role, conflict, and persistence reads', () => {
  const now = clock()
  const brain = new CompanyBrainDurableStore({ clock: now })
  seedTenant(brain, workerA)
  seedTenant(brain, workerB)
  const graph = new CompanyGraphStore({ brainStore: brain, clock: now })
  graph.build({ actor: founderA, tenantId: tenantA })
  graph.build({ actor: founderB, tenantId: tenantB })
  const proposalA = buildOperatingModelProposal({
    actor: founderA, tenantId: tenantA, brain, graph,
    queryDate: '2026-08-31', generatedAt: '2026-08-31T18:00:00.000Z',
  })
  assert.equal(proposalA.tenantId, tenantA)
  assert.ok(proposalA.provenance.sourceClaimIds.every((id) =>
    brain.claims.some((claim) => claim.id === id && claim.tenantId === tenantA),
  ))
  const store = new OperatingModelProposalStore({ clock: now })
  persistOperatingModelProposal(store, { actor: founderA, tenantId: tenantA, proposal: proposalA })
  assert.equal(getOperatingModelProposal(store, { actor: founderB, tenantId: tenantB }), null)
  assert.throws(() => getOperatingModelProposal(store, { actor: founderB, tenantId: tenantA }), /tenant mismatch/)
})

test('G4-13 same fingerprint persists idempotently', () => {
  const proposal = build(seeded())
  const store = new OperatingModelProposalStore({ clock: clock() })
  const first = persistOperatingModelProposal(store, { actor: founderA, tenantId: tenantA, proposal })
  const second = persistOperatingModelProposal(store, { actor: founderA, tenantId: tenantA, proposal })
  assert.equal(first, second)
  assert.equal(store.rows.length, 1)
})

test('G4-14 changed upstream state creates a new revision and supersedes prior proposal', () => {
  const state = seeded()
  const store = new OperatingModelProposalStore({ clock: clock() })
  const before = persistOperatingModelProposal(store, { actor: founderA, tenantId: tenantA, proposal: build(state) })
  addAtlasDecision(state)
  const after = persistOperatingModelProposal(store, { actor: founderA, tenantId: tenantA, proposal: build(state) })
  assert.notEqual(after.fingerprint, before.fingerprint)
  assert.ok(after.revision > before.revision)
  assert.equal(store.rows[0].status, OPERATING_MODEL_STATUS.SUPERSEDED)
  assert.equal(store.rows[0].supersededByProposalId, after.proposalId)
})

test('G4-15 runtime and migration contain no canonical financial mutation', () => {
  const text = `${fs.readFileSync(operatingModelPath, 'utf8')}\n${fs.readFileSync(migrationPath, 'utf8')}`
  assert.doesNotMatch(text, /(?:insert\s+into|update|delete\s+from|alter\s+table)\s+(?:public\.)?(?:invoices|payments|payment_attempts|payment_allocations|settlements|payouts|bank_transactions)\b/i)
})

test('G4-16 no execution or scheduling capability is exposed', () => {
  const proposal = build(seeded())
  assert.equal(proposal.boundaries.actionExecutionAvailable, false)
  assert.equal(proposal.boundaries.schedulingAvailable, false)
  assert.doesNotMatch(fs.readFileSync(operatingModelPath, 'utf8'), /sendEmail|scheduleReminder|applyFee|waiveFee|writeOff|recordSettlement/)
})

test('G4-17 missing promises-to-pay evidence becomes a question, not a guessed statement', () => {
  const proposal = build(seeded())
  assert.equal(proposal.promisesToPay.length, 0)
  const question = proposal.unresolvedQuestions.find((entry) => entry.topic === 'promises_to_pay')
  assert.ok(question)
  assert.equal(question.sourceClaimIds.length, 0)
})

test('G4-18 model carries immutable no-approval/no-authority boundaries', () => {
  const proposal = build(seeded())
  assert.deepEqual(
    {
      canonicalMoneyWritable: proposal.boundaries.canonicalMoneyWritable,
      authorityGrantable: proposal.boundaries.authorityGrantable,
      canActAutomatically: proposal.boundaries.canActAutomatically,
      operatingModelApproved: proposal.boundaries.operatingModelApproved,
    },
    { canonicalMoneyWritable: false, authorityGrantable: false, canActAutomatically: false, operatingModelApproved: false },
  )
})

test('G4-19 a proposal cannot self-approve during persistence', () => {
  const proposal = structuredClone(build(seeded()))
  proposal.boundaries.operatingModelApproved = true
  const store = new OperatingModelProposalStore()
  assert.throws(
    () => persistOperatingModelProposal(store, { actor: founderA, tenantId: tenantA, proposal }),
    /safety boundaries/,
  )
})

test('G4-20 provenance survives persistence round trip and review context stays review-only', () => {
  const proposal = build(seeded())
  const store = new OperatingModelProposalStore({ clock: clock() })
  persistOperatingModelProposal(store, { actor: founderA, tenantId: tenantA, proposal })
  const replay = getOperatingModelProposal(store, { actor: founderA, tenantId: tenantA, proposalId: proposal.proposalId })
  assert.deepEqual(replay.provenance, proposal.provenance)
  assert.deepEqual(replay.evidenceIndex, proposal.evidenceIndex)
  const review = toOperatingModelReviewContext(replay)
  assert.equal(review.reviewOnly, true)
  assert.equal(review.approvalCapabilityAvailable, false)
})

test('G4-21 migration parses with the real PostgreSQL parser', async () => {
  const sql = fs.readFileSync(migrationPath, 'utf8')
  await assert.doesNotReject(parse(sql))
  await assert.rejects(parse(`+${sql}`))
})

test('G4-22 migration enforces tenant RLS, exact evidence roots, and automatic staleness', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase()
  for (const table of ['company_operating_model_proposals', 'company_operating_model_proposal_evidence']) {
    assert.ok(sql.includes(`alter table public.${table} enable row level security;`))
  }
  assert.match(sql, /for select to authenticated[\s\S]+using \(\(select auth\.uid\(\)\) = user_id\)/)
  assert.match(sql, /foreign key \(user_id, graph_version_id\)[\s\S]+references public\.company_graph_versions\(user_id, id\)/)
  assert.match(sql, /foreign key \(user_id, claim_id, source_version_id\)[\s\S]+references public\.company_brain_claim_roots\(user_id, claim_id, source_version_id\)/)
  assert.match(sql, /create constraint trigger company_operating_model_evidence_integrity[\s\S]+deferrable initially deferred/)
  assert.match(sql, /select claim_id, source_version_id from declared[\s\S]+except[\s\S]+select claim_id, source_version_id[\s\S]+from public\.company_operating_model_proposal_evidence/)
  assert.doesNotMatch(sql, /select 1 from declared\s+except/)
  assert.match(sql, /company_operating_model_graph_staleness/)
  assert.match(sql, /company_operating_model_brain_staleness/)
  assert.match(sql, /model_payload ->> 'tenantid' = user_id::text/)
  assert.match(sql, /source_state ->> 'fingerprint' = source_fingerprint/)
  assert.equal((sql.match(/coalesce\(\(model_payload #>> '\{boundaries,/g) || []).length, 6)
  assert.doesNotMatch(sql, /grant\s+(?:all|insert|update|delete)[\s\S]*?to\s+(?:anon|authenticated)/)
})

test('G4-23 ambiguous and unresolved G2 identities become founder questions', () => {
  const proposal = build(seeded())
  const identityQuestions = proposal.unresolvedQuestions.filter((entry) => entry.topic === 'entity_identity')
  assert.ok(identityQuestions.length > 0)
  assert.ok(identityQuestions.every((question) => question.conflictKeys[0].startsWith('ENTITY_')))
  assert.ok(identityQuestions.some((question) => /ambiguous|unresolved/i.test(question.whyUnresolved)))
})
