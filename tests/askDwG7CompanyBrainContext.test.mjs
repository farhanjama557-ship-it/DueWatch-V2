/**
 * M2G-G7 checkpoint 1: conversational turn classification and the read-only
 * Company Brain conversational context built from the frozen G6 seams.
 *
 * These tests use the real fixtures and the real G6 derivation. Nothing here
 * stubs Company Brain, because the point is that G7 consumes G6 rather than
 * reimplementing it.
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
  FounderReviewStore,
  REVIEW_ACTION,
  buildFounderReviewItems,
  buildFounderReviewReadModel,
  deriveFounderReviewState,
} from '../src/lib/companyBrain/founderReview.js'
import {
  APPROVAL_REQUIREMENT,
  AUTHORITY_ACTION,
  AUTHORITY_SCOPE,
  AuthorityDelegationStore,
  buildAuthorityReadModel,
} from '../src/lib/companyBrain/authorityDelegation.js'
import {
  ASK_DW_CORRECTION_KIND,
  ASK_DW_TURN,
  askDwTurnIsSmallTalk,
  askDwTurnToJob,
  classifyAskDwConversationalTurn,
} from '../src/lib/dwIntelligence/askDwConversationalTurn.js'
import {
  askDwCompanyBrainAssertables,
  askDwCompanyBrainHasUnresolvedConflict,
  buildAskDwCompanyBrainContext,
} from '../src/lib/dwIntelligence/askDwCompanyBrainContext.js'
import { ASK_DW_JOB, ASK_DW_SCOPE } from '../src/lib/dwIntelligence/askDwIntent.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const fixtureRoot = path.join(repoRoot, 'fixtures/company-brain')
const contextSource = fs.readFileSync(
  path.join(repoRoot, 'src/lib/dwIntelligence/askDwCompanyBrainContext.js'), 'utf8')
const turnSource = fs.readFileSync(
  path.join(repoRoot, 'src/lib/dwIntelligence/askDwConversationalTurn.js'), 'utf8')

const tenantA = 'tenant-a'
const tenantB = 'tenant-b'
const founderA = { id: tenantA, tenantId: tenantA, role: 'FOUNDER', authenticated: true }
const founderB = { id: tenantB, tenantId: tenantB, role: 'FOUNDER', authenticated: true }
const workerA = { id: 'worker-a', tenantId: tenantA, role: 'INGESTION_WORKER', authenticated: true }
const workerB = { id: 'worker-b', tenantId: tenantB, role: 'INGESTION_WORKER', authenticated: true }
const fingerprintA = 'a'.repeat(64)
const asOfDate = '2026-08-31'
const generatedAt = '2026-09-01T13:00:00.000Z'

const G2_FILES = [
  'entity-registry.csv', 'atlas-contract.md', 'acme-us-contract.md', 'people-roles.csv',
  'historical-late-fee-policy.md', 'atlas-exception.md', 'collections-workflow.md',
  'atlas-precedent.md', 'orphan-reference.md', 'historical-aliases.csv', 'acme-account-manager-note.md',
]

function clock(base = Date.UTC(2026, 8, 1, 12, 0, 0)) {
  let tick = 0
  return () => new Date(base + (tick++) * 1000).toISOString()
}

function seeded(worker = workerA, founder = founderA) {
  const now = clock()
  const brain = new CompanyBrainDurableStore({ clock: now })
  const ingest = (folder, filename) => brain.ingestLocalFile({
    actor: worker, tenantId: worker.tenantId, filePath: path.join(fixtureRoot, folder, filename),
    sourceIdentity: filename, idempotencyKey: `${worker.tenantId}:${filename}:g7cp1`,
  })
  ingest('g1-realistic', 'collections-policy.md')
  ingest('g1-realistic', 'atlas-terms.csv')
  ingest('g1-realistic', 'founder-instruction.txt')
  for (const filename of G2_FILES) ingest('g2-graph', filename)
  const graph = new CompanyGraphStore({ brainStore: brain, clock: now })
  graph.build({ actor: founder, tenantId: founder.tenantId })
  return { brain, graph, now }
}

function authorityModelFor(tenantId, founder, { withGrant = false } = {}) {
  const store = new AuthorityDelegationStore({ clock: clock(Date.UTC(2026, 8, 1, 14, 0, 0)) })
  const currentState = {
    references: [
      { tenantId, kind: 'CLIENT', id: 'atlas', active: true, resolutionState: 'RESOLVED' },
      { tenantId, kind: 'CLAIM', id: 'claim-reminder', active: true, resolutionState: 'RESOLVED' },
      { tenantId, kind: 'POLICY', id: 'reminder-policy:atlas', fingerprint: fingerprintA, active: true, resolutionState: 'RESOLVED' },
    ],
  }
  if (withGrant) {
    store.grantAuthority({
      actor: founder, tenantId, idempotencyKey: 'g7-grant', currentState,
      explicitGrant: true, grantee: { type: 'DW', id: 'DUEWATCH' },
      action: AUTHORITY_ACTION.SEND_REMINDER,
      scope: { level: AUTHORITY_SCOPE.CLIENT, clientId: 'atlas' },
      limits: null, conditions: { daysOverdue: 7 },
      effectiveWindow: { effectiveFrom: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' },
      channel: 'EMAIL', approvalRequirement: APPROVAL_REQUIREMENT.NONE,
      provenance: [{ tenantId, kind: 'CLAIM', id: 'claim-reminder', requiredCurrent: false }],
      reviewedState: {
        reviewedAt: '2026-09-01T11:00:00.000Z',
        dependencies: [{ tenantId, kind: 'POLICY', id: 'reminder-policy:atlas', fingerprint: fingerprintA }],
      },
    })
  }
  return {
    store,
    model: buildAuthorityReadModel({
      actor: founder, tenantId, store, currentState, asOf: '2026-09-01T15:00:00.000Z',
    }),
  }
}

function readModelFor({
  worker = workerA, founder = founderA, withGrant = false, reviewStore = null,
} = {}) {
  const state = seeded(worker, founder)
  const tenantId = founder.tenantId
  const operatingModel = buildOperatingModelProposal({
    actor: founder, tenantId, brain: state.brain, graph: state.graph,
    queryDate: asOfDate, generatedAt: '2026-08-31T18:00:00.000Z',
  })
  const authority = authorityModelFor(tenantId, founder, { withGrant })
  const items = buildFounderReviewItems({
    actor: founder, tenantId, brain: state.brain, graph: state.graph,
    operatingModel, authorityReadModel: authority.model, asOfDate, generatedAt,
  })
  const store = reviewStore || new FounderReviewStore({ clock: clock() })
  const reviewState = deriveFounderReviewState({
    actor: founder, tenantId, store, items, generatedAt, asOfDate,
  })
  return {
    tenantId,
    items,
    store,
    authorityStore: authority.store,
    readModel: buildFounderReviewReadModel({
      actor: founder, tenantId, state: reviewState, authorityReadModel: authority.model, store,
    }),
  }
}

const baseline = readModelFor()
const baseContext = buildAskDwCompanyBrainContext({
  readModel: baseline.readModel, tenantId: tenantA,
})

// ── turn classification ───────────────────────────────────────────────────────

test('G7-T1 everyday openers are recognised as conversation, not AR commands', () => {
  for (const text of ['hi', 'hey', 'hello', 'morning', 'good morning']) {
    assert.equal(classifyAskDwConversationalTurn({ text }).turnType, ASK_DW_TURN.GREETING, text)
  }
  for (const text of ['thanks', 'got it', 'okay', 'ok', 'cool', 'makes sense']) {
    assert.equal(classifyAskDwConversationalTurn({ text }).turnType, ASK_DW_TURN.ACKNOWLEDGEMENT, text)
  }
})

test('G7-T2 operational questions map to their own turn types', () => {
  const expectations = [
    ['what should i do today?', ASK_DW_TURN.DAILY_PRIORITIES],
    ['anything important?', ASK_DW_TURN.DAILY_PRIORITIES],
    ['anything urgent?', ASK_DW_TURN.DAILY_PRIORITIES],
    ['who should i look at first?', ASK_DW_TURN.DAILY_PRIORITIES],
    ["what's the biggest issue?", ASK_DW_TURN.DAILY_PRIORITIES],
    ['are we good?', ASK_DW_TURN.PORTFOLIO_STATUS],
    ["how's AR?", ASK_DW_TURN.PORTFOLIO_STATUS],
    ['how are things?', ASK_DW_TURN.PORTFOLIO_STATUS],
    ['what are you watching?', ASK_DW_TURN.PORTFOLIO_STATUS],
    ['what needs me?', ASK_DW_TURN.NEEDS_FOUNDER],
    ['what am i forgetting?', ASK_DW_TURN.NEEDS_FOUNDER],
    ['what changed?', ASK_DW_TURN.WHAT_CHANGED],
    ['what happened overnight?', ASK_DW_TURN.WHAT_CHANGED],
  ]
  for (const [text, expected] of expectations) {
    assert.equal(classifyAskDwConversationalTurn({ text }).turnType, expected, text)
  }
})

test('G7-T3 very short follow-ups stay follow-ups', () => {
  for (const text of ['why', 'why?', 'why not', 'anything else?', 'what else', 'next', 'more', 'and Atlas?', 'what about Atlas?', 'what about them?']) {
    assert.equal(classifyAskDwConversationalTurn({ text }).turnType, ASK_DW_TURN.FOLLOW_UP, text)
  }
})

test('G7-T4 the four correction kinds are kept distinct', () => {
  const referent = classifyAskDwConversationalTurn({ text: 'no, I meant the second invoice' })
  assert.equal(referent.turnType, ASK_DW_TURN.CORRECTION)
  assert.equal(referent.correctionKind, ASK_DW_CORRECTION_KIND.REFERENT)

  const evidence = classifyAskDwConversationalTurn({ text: 'no, Atlas emailed us yesterday' })
  assert.equal(evidence.correctionKind, ASK_DW_CORRECTION_KIND.NEW_EVIDENCE)
  // An assertion in chat is not admitted evidence.
  assert.equal(evidence.requiresEvidencePath, true)

  for (const text of ["no, you're wrong", 'are you sure?', 'really?', 'wrong']) {
    const challenge = classifyAskDwConversationalTurn({ text })
    assert.equal(challenge.turnType, ASK_DW_TURN.CHALLENGE, text)
    assert.equal(challenge.founderPressure, true)
  }
})

test('G7-T5 a real AR command still reaches the existing AR job taxonomy', () => {
  const act = classifyAskDwConversationalTurn({ text: 'send a reminder to Atlas' })
  assert.equal(act.turnType, ASK_DW_TURN.AR_JOB)
  assert.equal(act.job, ASK_DW_JOB.ACT)
  assert.equal(act.actionIntent, true)
  const investigate = classifyAskDwConversationalTurn({ text: 'what happened with invoice INV-4?' })
  assert.equal(investigate.turnType, ASK_DW_TURN.AR_JOB)
  assert.equal(investigate.job, ASK_DW_JOB.INVESTIGATE)
  // The existing taxonomy keeps its own judgement: G7 delegates to it rather
  // than re-deciding, so a phrasing it reads as EXPLAIN stays EXPLAIN.
  const explain = classifyAskDwConversationalTurn({ text: 'what went wrong on invoice INV-4?' })
  assert.equal(explain.turnType, ASK_DW_TURN.AR_JOB)
  assert.equal(explain.job, ASK_DW_JOB.EXPLAIN)
})

test('G7-T6 no conversational turn is ever an action or grants anything', () => {
  const texts = ['hi', 'thanks', 'what should i do today?', 'why?', 'show me',
    'are you sure?', 'what does our policy say?', 'can you handle it?', 'what changed?']
  for (const text of texts) {
    const turn = classifyAskDwConversationalTurn({ text })
    assert.equal(turn.grantsAuthority, false, text)
    assert.equal(turn.mutatesCompanyBrain, false, text)
    assert.equal(turn.mutatesCanonicalMoney, false, text)
    const job = askDwTurnToJob(turn)
    assert.equal(job.actionIntent, false, text)
    assert.notEqual(job.job, ASK_DW_JOB.ACT, text)
  }
})

test('G7-T7 priority questions decide, they do not act', () => {
  const job = askDwTurnToJob(classifyAskDwConversationalTurn({ text: 'what should i do today?' }))
  assert.equal(job.job, ASK_DW_JOB.DECIDE)
  assert.equal(job.scope, ASK_DW_SCOPE.PORTFOLIO)
  assert.equal(job.actionIntent, false)
})

test('G7-T8 small talk is identified so it need not force AR retrieval', () => {
  assert.equal(askDwTurnIsSmallTalk(classifyAskDwConversationalTurn({ text: 'hi' })), true)
  assert.equal(askDwTurnIsSmallTalk(classifyAskDwConversationalTurn({ text: 'thanks' })), true)
  assert.equal(askDwTurnIsSmallTalk(classifyAskDwConversationalTurn({ text: 'what should i do today?' })), false)
})

test('G7-T9 an empty turn is rejected rather than guessed', () => {
  assert.throws(() => classifyAskDwConversationalTurn({ text: '   ' }), /text required/)
})

// ── Company Brain conversational context ─────────────────────────────────────

test('G7-C1 the context is built from the real G6 read model', () => {
  assert.equal(baseContext.available, true)
  assert.equal(baseContext.schemaVersion, 'ASK_DW_COMPANY_BRAIN_CONTEXT_V0')
  assert.ok(baseContext.understanding.length > 0)
  assert.ok(baseContext.conflicts.length > 0)
  assert.ok(baseContext.roles.length > 0)
  assert.equal(baseContext.summary.conflictsUnresolved, baseline.readModel.summary.conflictsUnresolved)
})

test('G7-C2 an unresolved conflict keeps every side and states no safe result', () => {
  const conflict = baseContext.conflicts.find((entry) => entry.competingPositions.length > 1)
  assert.ok(conflict, 'the fixture must carry a real competing-evidence conflict')
  assert.ok(conflict.competingPositions.length >= 2)
  assert.equal(conflict.currentResult, 'NO_SAFE_CURRENT_INSTRUCTION')
  assert.equal(askDwCompanyBrainHasUnresolvedConflict(baseContext), true)
})

test('G7-C3 canonical money can never travel inside the Company Brain context', () => {
  const serialized = JSON.stringify(baseContext)
  for (const forbidden of ['"balance"', '"amount_paid"', '"canonicalFacts"', '"arState"', '"due_date"']) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not appear`)
  }
  assert.equal(baseContext.boundaries.isCanonicalFinancialTruth, false)
})

test('G7-C4 a forbidden field is rejected loudly rather than stripped silently', () => {
  const poisoned = {
    ...baseline.readModel,
    items: [...baseline.readModel.items, {
      reviewKey: 'review-poison', category: 'COMPANY_UNDERSTANDING', itemType: 'UNDERSTANDING',
      subject: 'poison', scope: { level: 'COMPANY' }, clientId: null, reviewStatus: 'PENDING',
      conflictStatus: 'NONE', why: 'x', evidence: [], claims: [],
      // A caller trying to smuggle money truth through the seam.
      proposedValue: { balance: '100.00' },
    }],
  }
  assert.throws(
    () => buildAskDwCompanyBrainContext({ readModel: poisoned, tenantId: tenantA }),
    /forbidden Company Brain context field/,
  )
})

test('G7-C5 the context is deeply frozen and cannot be mutated by a caller', () => {
  assert.ok(Object.isFrozen(baseContext))
  assert.ok(Object.isFrozen(baseContext.understanding))
  assert.ok(Object.isFrozen(baseContext.understanding[0]))
  assert.throws(() => { baseContext.boundaries.canGrantAuthority = true }, TypeError)
})

test('G7-C6 the context carries no capability to mutate anything', () => {
  for (const [key, value] of Object.entries(baseContext.boundaries)) {
    if (key === 'readOnly') { assert.equal(value, true); continue }
    assert.equal(value, false, `${key} must be false`)
  }
})

test('G7-C7 tenant isolation is enforced, not assumed', () => {
  assert.throws(
    () => buildAskDwCompanyBrainContext({ readModel: baseline.readModel, tenantId: tenantB }),
    /tenant mismatch/,
  )
  assert.throws(() => buildAskDwCompanyBrainContext({ readModel: baseline.readModel }), /tenantId required/)
  const other = readModelFor({ worker: workerB, founder: founderB })
  const otherContext = buildAskDwCompanyBrainContext({ readModel: other.readModel, tenantId: tenantB })
  assert.equal(otherContext.tenantId, tenantB)
  // No tenant A review key may appear in tenant B's conversational context.
  const tenantAKeys = new Set(baseContext.understanding.map((entry) => entry.reviewKey))
  assert.ok(otherContext.understanding.every((entry) => !tenantAKeys.has(entry.reviewKey)) ||
    tenantAKeys.size === 0)
})

test('G7-C8 a failed Company Brain read is unavailable, never "nothing to say"', () => {
  const unavailable = buildAskDwCompanyBrainContext({ readModel: null, tenantId: tenantA })
  assert.equal(unavailable.available, false)
  assert.equal(unavailable.unavailableReason, 'COMPANY_BRAIN_READ_UNAVAILABLE')
  assert.deepEqual(unavailable.understanding, [])
  // Crucially it does not claim there are zero conflicts.
  assert.equal(unavailable.summary, undefined)
  assert.equal(askDwCompanyBrainHasUnresolvedConflict(unavailable), false)
})

test('G7-C9 a founder correction is what the context states, not DW proposal', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const fresh = readModelFor({ reviewStore: store })
  const target = fresh.items.find((item) => item.itemType === 'UNDERSTANDING')
  store.recordReviewDecision({
    actor: founderA, tenantId: tenantA, item: target, action: REVIEW_ACTION.EDIT,
    expectedRevision: 0, subjectFingerprint: target.subjectFingerprint,
    reviewedValue: { reminderDays: 5 }, idempotencyKey: 'g7-edit',
  })
  const corrected = readModelFor({ reviewStore: store })
  const context = buildAskDwCompanyBrainContext({ readModel: corrected.readModel, tenantId: tenantA })
  const item = context.understanding.find((entry) => entry.reviewKey === target.reviewKey)
  assert.ok(item)
  assert.equal(item.founderCorrected, true)
  assert.deepEqual(item.statedValue, { reminderDays: 5 })
})

test('G7-C10 authority appears as a read-only projection with every dimension named', () => {
  const withGrant = readModelFor({ withGrant: true })
  const context = buildAskDwCompanyBrainContext({ readModel: withGrant.readModel, tenantId: tenantA })
  assert.equal(context.authority.activeGrantCount, 1)
  const grant = context.authority.currentGrants[0]
  for (const field of ['action', 'scope', 'clientId', 'channel', 'approvalRequirement', 'conditions', 'effectiveFrom', 'expiresAt', 'status']) {
    assert.ok(field in grant, `${field} must be described`)
  }
  assert.equal(context.boundaries.canGrantAuthority, false)
  assert.equal(context.boundaries.canRevokeAuthority, false)
})

test('G7-C11 zero standing authority is stated as such, not as an error', () => {
  assert.equal(baseContext.authority.activeGrantCount, 0)
  assert.equal(baseContext.authority.noStandingAuthorityConfigured, true)
})

test('G7-C12 reviewing understanding never becomes authority in the context', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const fresh = readModelFor({ reviewStore: store })
  for (const item of fresh.items.filter((entry) => entry.reviewableActions.includes(REVIEW_ACTION.APPROVE))) {
    store.recordReviewDecision({
      actor: founderA, tenantId: tenantA, item, action: REVIEW_ACTION.APPROVE,
      expectedRevision: 0, subjectFingerprint: item.subjectFingerprint,
      idempotencyKey: `approve-${item.reviewKey}`,
    })
  }
  const approved = readModelFor({ reviewStore: store })
  const context = buildAskDwCompanyBrainContext({ readModel: approved.readModel, tenantId: tenantA })
  assert.ok(context.understanding.some((entry) => entry.reviewStatus === 'APPROVED'))
  // Many approvals, still no permission.
  assert.equal(context.authority.activeGrantCount, 0)
  assert.ok(context.understanding.every((entry) => entry.authorityImpact === 'NONE'))
})

test('G7-C13 assertables enumerate exactly what an answer may claim', () => {
  const assertables = askDwCompanyBrainAssertables(baseContext)
  assert.ok(assertables.length > 0)
  assert.ok(assertables.every((entry) => typeof entry.kind === 'string'))
  assert.equal(askDwCompanyBrainAssertables(
    buildAskDwCompanyBrainContext({ readModel: null, tenantId: tenantA })).length, 0)
})

test('G7-C14 the context module holds no mutation or execution path', () => {
  for (const pattern of [
    /grantAuthority\(/, /revokeAuthority\(/, /recordReviewDecision/, /recordFounderDecision/,
    /\.rpc\(/, /supabase/, /\bfetch\(/, /sendReminder/, /sendEmail/,
  ]) {
    assert.doesNotMatch(contextSource, pattern)
  }
  for (const pattern of [/\.rpc\(/, /supabase/, /\bfetch\(/, /grantAuthority/]) {
    assert.doesNotMatch(turnSource, pattern)
  }
})

test('G7-C15 focus narrows to a client without inventing cross-client material', () => {
  const focused = buildAskDwCompanyBrainContext({
    readModel: baseline.readModel, tenantId: tenantA, focus: { clientId: 'atlas' },
  })
  assert.ok(focused.understanding.every((entry) => entry.clientId == null || entry.clientId === 'atlas'))
  assert.ok(focused.conflicts.every((entry) => entry.clientId == null || entry.clientId === 'atlas'))
  assert.ok(focused.understanding.length <= baseContext.understanding.length)
})
