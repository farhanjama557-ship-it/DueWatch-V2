import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'pgsql-parser'

import { CompanyBrainDurableStore } from '../src/lib/companyBrain/durableStore.js'
import { CompanyGraphStore, SEMANTIC_SCOPE } from '../src/lib/companyBrain/graphStore.js'
import {
  CANDIDATE_STATUS,
  G3_RESOLUTION_STATUS,
  TEMPORAL_STATE,
  buildPolicyCandidates,
  resolvePolicy,
} from '../src/lib/companyBrain/policyIntelligence.js'
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

function persist(store, state, proposal = build(state), overrides = {}) {
  return persistOperatingModelProposal(store, {
    actor: founderA,
    tenantId: tenantA,
    proposal,
    brain: state.brain,
    graph: state.graph,
    ...overrides,
  })
}

function review(state, proposal = build(state), overrides = {}) {
  return toOperatingModelReviewContext(proposal, {
    actor: founderA,
    tenantId: tenantA,
    brain: state.brain,
    graph: state.graph,
    ...overrides,
  })
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
  persistOperatingModelProposal(store, {
    actor: founderA, tenantId: tenantA, proposal: proposalA, brain, graph,
  })
  assert.equal(getOperatingModelProposal(store, { actor: founderB, tenantId: tenantB }), null)
  assert.throws(() => getOperatingModelProposal(store, { actor: founderB, tenantId: tenantA }), /tenant mismatch/)
})

test('G4-13 same fingerprint persists idempotently', () => {
  const state = seeded()
  const proposal = build(state)
  const store = new OperatingModelProposalStore({ clock: clock() })
  const first = persist(store, state, proposal)
  const second = persist(store, state, proposal)
  assert.equal(first, second)
  assert.equal(store.rows.length, 1)
})

test('G4-14 changed upstream state creates a new revision and supersedes prior proposal', () => {
  const state = seeded()
  const store = new OperatingModelProposalStore({ clock: clock() })
  const before = persist(store, state)
  addAtlasDecision(state)
  const after = persist(store, state)
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
  const state = seeded()
  const proposal = build(state)
  const store = new OperatingModelProposalStore({ clock: clock() })
  persist(store, state, proposal)
  const replay = getOperatingModelProposal(store, { actor: founderA, tenantId: tenantA, proposalId: proposal.proposalId })
  assert.deepEqual(replay.provenance, proposal.provenance)
  assert.deepEqual(replay.evidenceIndex, proposal.evidenceIndex)
  const context = review(state, replay)
  assert.equal(context.reviewOnly, true)
  assert.equal(context.approvalCapabilityAvailable, false)
  assert.equal(context.stale, false)
  assert.equal(context.reviewBlocked, false)
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
  assert.match(sql, /coalesce\(source_state ->> 'fingerprint', ''\) = source_fingerprint/)
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

test('G4-24 stale proposal cannot be persisted or replayed as current', () => {
  const state = seeded()
  const proposal = build(state)
  const store = new OperatingModelProposalStore({ clock: clock() })
  const current = persist(store, state, proposal)
  state.brain.revokeSource({
    actor: founderA, tenantId: tenantA, sourceId: state.receipts.collections.sourceId,
    reason: 'G4 freshness closure persistence test',
  })
  assert.equal(isOperatingModelStale({
    proposal, actor: founderA, tenantId: tenantA, brain: state.brain, graph: state.graph,
  }), true)
  assert.throws(() => persist(store, state, proposal), /stale operating model/)
  assert.equal(store.rows.length, 1)
  assert.equal(current.status === OPERATING_MODEL_STATUS.PROPOSED || current.status === OPERATING_MODEL_STATUS.BLOCKED, true)
  assert.equal(store.rows[0].status, OPERATING_MODEL_STATUS.STALE)
  assert.ok(store.rows[0].invalidatedAt)
  assert.equal(store.rows.some((row) => [OPERATING_MODEL_STATUS.PROPOSED, OPERATING_MODEL_STATUS.BLOCKED].includes(row.status)), false)
  assert.throws(() => persist(new OperatingModelProposalStore(), state, proposal), /stale operating model/)
})

test('G4-25 stale proposal review context is explicitly stale and blocked', () => {
  const state = seeded()
  const proposal = build(state)
  state.brain.revokeSource({
    actor: founderA, tenantId: tenantA, sourceId: state.receipts.collections.sourceId,
    reason: 'G4 freshness closure review test',
  })
  const context = review(state, proposal)
  assert.equal(context.status, OPERATING_MODEL_STATUS.STALE)
  assert.equal(context.stale, true)
  assert.equal(context.reviewBlocked, true)
})

test('G4-26 future and expired operating evidence are not current while current evidence remains usable', () => {
  const now = clock()
  const brain = new CompanyBrainDurableStore({ clock: now })
  const contracts = [
    ['future-contract.md', 'future-contract', '2030-01-01', null],
    ['expired-contract.md', 'expired-contract', '2020-01-01', '2021-01-01'],
    ['current-contract.md', 'current-contract', '2026-01-01', null],
  ]
  for (const [filename, contractId, from, to] of contracts) {
    brain.ingestContent({
      actor: workerA, tenantId: tenantA, filename,
      content: `---\ndocument_type: contract\ncontract_id: ${contractId}\nscope: COMPANY\neffective_from: ${from}${to ? `\neffective_to: ${to}` : ''}\n---\nContract evidence.`,
      sourceIdentity: contractId, idempotencyKey: `g4-26:${contractId}`,
    })
  }
  const graph = new CompanyGraphStore({ brainStore: brain, clock: now })
  graph.build({ actor: founderA, tenantId: tenantA })
  const proposal = build({ brain, graph })
  const byId = Object.fromEntries(proposal.billing.map((statement) => [statement.value.contract_id, statement]))
  assert.deepEqual(byId['future-contract'].effectiveTime, { from: '2030-01-01', to: null })
  assert.equal(byId['future-contract'].temporalState, TEMPORAL_STATE.FUTURE)
  assert.equal(byId['future-contract'].currentApplicable, false)
  assert.notEqual(byId['future-contract'].state, OPERATING_STATEMENT_STATE.CONFIRMED)
  assert.ok([TEMPORAL_STATE.EXPIRED, TEMPORAL_STATE.HISTORICAL].includes(byId['expired-contract'].temporalState))
  assert.equal(byId['expired-contract'].state, OPERATING_STATEMENT_STATE.HISTORICAL_ONLY)
  assert.equal(byId['expired-contract'].currentApplicable, false)
  assert.equal(byId['current-contract'].temporalState, TEMPORAL_STATE.CURRENT)
  assert.equal(byId['current-contract'].state, OPERATING_STATEMENT_STATE.CONFIRMED)
  assert.equal(byId['current-contract'].currentApplicable, true)
})

test('G4-27 identity and unsupported metadata do not route into collections', () => {
  const proposal = build(seeded())
  const forbidden = new Set(['entity_record', 'alias_record', 'orphan_reference_record'])
  assert.equal(proposal.collections.some((statement) => forbidden.has(statement.topic)), false)
  assert.equal(everyStatement(proposal).some((statement) => forbidden.has(statement.topic)), false)
  assert.ok(proposal.unresolvedQuestions.some((question) => question.topic === 'entity_identity'))
})

test('G4-28 semantic tampering and nested client-override tampering are rejected', () => {
  const state = seeded()
  const proposal = build(state)
  const topLevel = structuredClone(proposal)
  const topStatement = Object.values(topLevel)
    .filter(Array.isArray).flat()
    .find((entry) => entry?.kind === 'OPERATING_MODEL_STATEMENT_V0')
  assert.ok(topStatement)
  topStatement.value = { tampered: true }
  assert.throws(() => persist(new OperatingModelProposalStore(), state, topLevel), /semantic fingerprint/)

  const nested = structuredClone(proposal)
  const nestedStatement = nested.clientOverrides.flatMap((entry) => entry.statements)[0]
  assert.ok(nestedStatement)
  nestedStatement.value = { nestedTamper: true }
  assert.throws(() => review(state, nested), /semantic fingerprint/)

  const nestedProvenance = structuredClone(proposal)
  const currentNested = nestedProvenance.clientOverrides
    .flatMap((entry) => entry.statements)
    .find((statement) => statement.state === OPERATING_STATEMENT_STATE.CONFIRMED)
  assert.ok(currentNested)
  currentNested.rootSourceVersionIds = []
  assert.throws(() => review(state, nestedProvenance), /exact provenance/)
})

test('G4-29 SQL binds current rows to active exact Brain/graph lineage and source state', async () => {
  const sql = fs.readFileSync(migrationPath, 'utf8')
  const normalized = sql.toLowerCase()
  await assert.doesNotReject(parse(sql))
  assert.match(normalized, /new\.status in \('proposed','blocked'\)[\s\S]+not v_snapshot_active[\s\S]+not v_graph_active/)
  assert.match(normalized, /v_graph_brain_snapshot_id <> new\.brain_snapshot_id/)
  assert.match(normalized, /v_snapshot_knowledge_version <> new\.brain_knowledge_version/)
  assert.match(normalized, /v_graph_fingerprint is distinct from new\.source_state ->> 'graphfingerprint'/)
  assert.match(normalized, /coalesce\(source_state ->> 'brainsnapshotid', ''\) = brain_snapshot_id::text/)
  assert.match(normalized, /coalesce\(source_state ->> 'graphversion', ''\) = graph_version_id::text/)
  assert.match(normalized, /coalesce\(model_payload -> 'sourcestate', 'null'::jsonb\) = source_state/)
  const corrupted = normalized.replace("not v_snapshot_active or not v_graph_active", 'false')
  assert.doesNotMatch(corrupted, /new\.status in \('proposed','blocked'\)[\s\S]+not v_snapshot_active[\s\S]+not v_graph_active/)
})

test('G4-30 a different as-of date cannot masquerade as current', () => {
  const state = seeded()
  const proposal = build(state, { queryDate: '2026-08-31' })
  assert.equal(proposal.asOfDate, '2026-08-31')
  assert.equal(proposal.sourceState.asOfDate, '2026-08-31')
  assert.equal(isOperatingModelStale({
    proposal, actor: founderA, tenantId: tenantA, brain: state.brain, graph: state.graph,
    asOfDate: '2026-09-01',
  }), true)
  const context = review(state, proposal, { asOfDate: '2026-09-01' })
  assert.equal(context.status, OPERATING_MODEL_STATUS.STALE)
  assert.equal(context.reviewBlocked, true)
  assert.throws(
    () => persist(new OperatingModelProposalStore(), state, proposal, { asOfDate: '2026-09-01' }),
    /stale operating model/,
  )
  assert.notEqual(build(state, { queryDate: '2026-09-01' }).fingerprint, proposal.fingerprint)
})
