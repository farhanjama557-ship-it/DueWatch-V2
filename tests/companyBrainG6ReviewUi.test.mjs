import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CompanyBrainDurableStore } from '../src/lib/companyBrain/durableStore.js'
import { CompanyGraphStore } from '../src/lib/companyBrain/graphStore.js'
import { buildOperatingModelProposal } from '../src/lib/companyBrain/operatingModel.js'
import {
  APPROVAL_REQUIREMENT,
  AUTHORITY_ACTION,
  AUTHORITY_SCOPE,
  AuthorityDelegationStore,
  buildAuthorityReadModel,
  createG5AuthorityProposal,
} from '../src/lib/companyBrain/authorityDelegation.js'
import {
  FounderReviewStore,
  REVIEW_ACTION,
  REVIEW_ITEM_TYPE,
  buildFounderReviewItems,
  buildFounderReviewReadModel,
  deriveFounderReviewState,
} from '../src/lib/companyBrain/founderReview.js'
import {
  REVIEW_SURFACE_STATE,
  REVIEW_TAB,
  buildFounderReviewView,
  describeAuthorityDimensions,
  describeValue,
} from '../src/lib/companyBrain/founderReviewPresentation.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const fixtureRoot = path.join(repoRoot, 'fixtures/company-brain')
const surfacePath = path.join(repoRoot, 'src/features/companyBrain/CompanyBrainReview.jsx')
const pagePath = path.join(repoRoot, 'src/pages/CompanyBrain.jsx')
const cssPath = path.join(repoRoot, 'src/features/companyBrain/companyBrainReview.css')
const surface = fs.readFileSync(surfacePath, 'utf8')
const page = fs.readFileSync(pagePath, 'utf8')
const css = fs.readFileSync(cssPath, 'utf8')

const tenantA = 'tenant-a'
const founderA = { id: tenantA, tenantId: tenantA, role: 'FOUNDER', authenticated: true }
const workerA = { id: 'worker-a', tenantId: tenantA, role: 'INGESTION_WORKER', authenticated: true }
const fingerprintA = 'a'.repeat(64)
const asOfDate = '2026-08-31'
const generatedAt = '2026-09-01T13:00:00.000Z'

function clock(base = Date.UTC(2026, 8, 1, 12, 0, 0)) {
  let tick = 0
  return () => new Date(base + (tick++) * 1000).toISOString()
}

const G2_FILES = [
  'entity-registry.csv', 'atlas-contract.md', 'acme-us-contract.md', 'people-roles.csv',
  'historical-late-fee-policy.md', 'atlas-exception.md', 'collections-workflow.md',
  'atlas-precedent.md', 'orphan-reference.md', 'historical-aliases.csv', 'acme-account-manager-note.md',
]

function seeded() {
  const now = clock()
  const brain = new CompanyBrainDurableStore({ clock: now })
  const ingest = (folder, filename) => brain.ingestLocalFile({
    actor: workerA, tenantId: tenantA, filePath: path.join(fixtureRoot, folder, filename),
    sourceIdentity: filename, idempotencyKey: `${tenantA}:${filename}:g6ui`,
  })
  ingest('g1-realistic', 'collections-policy.md')
  ingest('g1-realistic', 'atlas-terms.csv')
  ingest('g1-realistic', 'founder-instruction.txt')
  for (const filename of G2_FILES) ingest('g2-graph', filename)
  const graph = new CompanyGraphStore({ brainStore: brain, clock: now })
  graph.build({ actor: founderA, tenantId: tenantA })
  return { brain, graph }
}

function authorityState() {
  return {
    references: [
      { tenantId: tenantA, kind: 'CLIENT', id: 'atlas', active: true, resolutionState: 'RESOLVED' },
      { tenantId: tenantA, kind: 'CLAIM', id: 'claim-reminder', active: true, resolutionState: 'RESOLVED' },
      { tenantId: tenantA, kind: 'POLICY', id: 'reminder-policy:atlas', fingerprint: fingerprintA, active: true, resolutionState: 'RESOLVED' },
    ],
  }
}

function fullModel({ withAuthority = true, reviewed = false } = {}) {
  const state = seeded()
  const authorityStore = new AuthorityDelegationStore({ clock: clock(Date.UTC(2026, 8, 1, 14, 0, 0)) })
  if (withAuthority) {
    authorityStore.grantAuthority({
      actor: founderA, tenantId: tenantA, idempotencyKey: 'ui-grant', currentState: authorityState(),
      explicitGrant: true, grantee: { type: 'DW', id: 'DUEWATCH' },
      action: AUTHORITY_ACTION.SEND_REMINDER,
      scope: { level: AUTHORITY_SCOPE.CLIENT, clientId: 'atlas' },
      limits: null, conditions: { daysOverdue: 7 },
      effectiveWindow: { effectiveFrom: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' },
      channel: 'EMAIL', approvalRequirement: APPROVAL_REQUIREMENT.NONE,
      provenance: [{ tenantId: tenantA, kind: 'CLAIM', id: 'claim-reminder', requiredCurrent: false }],
      reviewedState: { reviewedAt: '2026-09-01T11:00:00.000Z', dependencies: [{ tenantId: tenantA, kind: 'POLICY', id: 'reminder-policy:atlas', fingerprint: fingerprintA }] },
    })
    authorityStore.recordProposal({
      actor: founderA, tenantId: tenantA,
      proposal: createG5AuthorityProposal({
        actor: founderA, tenantId: tenantA, action: AUTHORITY_ACTION.APPLY_LATE_FEE,
        scope: { level: AUTHORITY_SCOPE.COMPANY }, proposedConfiguration: {},
        createdAt: '2026-09-01T10:00:00.000Z',
      }),
    })
  }
  const authorityReadModel = buildAuthorityReadModel({
    actor: founderA, tenantId: tenantA, store: authorityStore,
    currentState: authorityState(), asOf: '2026-09-01T15:00:00.000Z',
  })
  const items = buildFounderReviewItems({
    actor: founderA, tenantId: tenantA, brain: state.brain, graph: state.graph,
    operatingModel: buildOperatingModelProposal({
      actor: founderA, tenantId: tenantA, brain: state.brain, graph: state.graph,
      queryDate: asOfDate, generatedAt: '2026-08-31T18:00:00.000Z',
    }),
    authorityReadModel, asOfDate, generatedAt,
  })
  const store = new FounderReviewStore({ clock: clock() })
  if (reviewed) {
    const target = items.find((item) => item.itemType === REVIEW_ITEM_TYPE.UNDERSTANDING)
    store.recordReviewDecision({
      actor: founderA, tenantId: tenantA, item: target, action: REVIEW_ACTION.APPROVE,
      expectedRevision: 0, subjectFingerprint: target.subjectFingerprint, idempotencyKey: 'ui-approve',
    })
  }
  const reviewState = deriveFounderReviewState({ actor: founderA, tenantId: tenantA, store, items, generatedAt, asOfDate })
  return buildFounderReviewReadModel({
    actor: founderA, tenantId: tenantA, state: reviewState, authorityReadModel, store, consumer: 'FOUNDER_REVIEW_UI',
  })
}

test('G6-U1 the view exposes loading, error and empty states explicitly', () => {
  assert.equal(buildFounderReviewView({ loading: true }).surfaceState, REVIEW_SURFACE_STATE.LOADING)
  assert.equal(buildFounderReviewView({ error: 'boom' }).surfaceState, REVIEW_SURFACE_STATE.ERROR)
  assert.equal(buildFounderReviewView({}).surfaceState, REVIEW_SURFACE_STATE.EMPTY)
  // A failed read is never rendered as a completed review.
  assert.equal(buildFounderReviewView({ error: 'boom' }).summary, null)
  assert.equal(buildFounderReviewView({ error: 'boom' }).readiness, null)
})

test('G6-U2 the ready view carries every review section', () => {
  const view = buildFounderReviewView({ readModel: fullModel() })
  assert.equal(view.surfaceState, REVIEW_SURFACE_STATE.READY)
  for (const tab of Object.values(REVIEW_TAB)) assert.ok(Array.isArray(view.sections[tab]), `${tab} section missing`)
  assert.equal(view.tabs.length, Object.values(REVIEW_TAB).length)
})

test('G6-U3 review actions and the grant control are never the same control', () => {
  const view = buildFounderReviewView({ readModel: fullModel() })
  const reviewLabels = view.sections[REVIEW_TAB.UNDERSTANDING].flatMap((card) => card.actions.map((action) => action.label))
  assert.ok(reviewLabels.includes('Approve understanding'))
  assert.ok(!reviewLabels.includes('Grant authority'))
  assert.ok(view.sections[REVIEW_TAB.UNDERSTANDING].every((card) => card.actions.every((action) => action.grantsAuthority === false)))
  assert.equal(view.authority.proposals[0].grantLabel, 'Grant authority')
})

test('G6-U4 no control is pre-selected and no approval is bundled with a grant', () => {
  const view = buildFounderReviewView({ readModel: fullModel() })
  for (const card of view.sections[REVIEW_TAB.UNDERSTANDING]) {
    assert.ok(card.actions.every((action) => action.preselected === false))
  }
  for (const proposal of view.authority.proposals) {
    assert.equal(proposal.grantPreselected, false)
    assert.equal(proposal.grantBundledWithApproval, false)
    assert.equal(proposal.inert, true)
  }
})

test('G6-U5 every G5 dimension is named on an authority card, and none becomes a wildcard', () => {
  const view = buildFounderReviewView({ readModel: fullModel() })
  const expected = ['ACTION', 'SCOPE', 'CLIENT', 'AMOUNT', 'CURRENCY', 'CONDITION', 'TIME', 'CHANNEL', 'APPROVAL']
  assert.deepEqual(view.authority.grants[0].dimensions.map((entry) => entry.dimension), expected)
  const empty = describeAuthorityDimensions({})
  assert.deepEqual(empty.map((entry) => entry.dimension), expected)
  const scopeValue = empty.find((entry) => entry.dimension === 'SCOPE').value
  assert.match(scopeValue, /no authority is implied/)
  assert.ok(!empty.some((entry) => /any|all clients$/i.test(entry.value)))
})

test('G6-U6 zero standing authority is presented as valid, not as an error', () => {
  const view = buildFounderReviewView({ readModel: fullModel({ withAuthority: false }) })
  assert.equal(view.authority.noStandingAuthority, true)
  assert.match(view.authority.noStandingAuthorityLabel, /valid setup/)
  assert.equal(view.readiness.authorityStatement, 'DW standing authority: 0 grants')
  assert.equal(view.readiness.zeroAuthorityIsValidCompletion, true)
})

test('G6-U7 understanding and authority readiness are two separate statements', () => {
  const view = buildFounderReviewView({ readModel: fullModel() })
  assert.notEqual(view.readiness.understandingStatement, view.readiness.authorityStatement)
  assert.match(view.readiness.understandingStatement, /Company understanding/)
  assert.match(view.readiness.authorityStatement, /DW standing authority/)
  assert.equal(view.readiness.autopilotReady, false)
})

test('G6-U8 a conflict card shows every side and no confidence score verdict', () => {
  const view = buildFounderReviewView({ readModel: fullModel() })
  const conflicts = view.sections[REVIEW_TAB.CONFLICTS]
  assert.ok(conflicts.length > 0)
  const withSides = conflicts.find((card) => card.competingPositions.length > 0)
  assert.ok(withSides, 'a conflict card must show its competing positions')
  assert.ok(withSides.competingPositions.length >= 2)
  assert.match(withSides.currentResult, /No safe current instruction|founder decision/)
  assert.ok(conflicts.every((card) => card.confidenceGrantsAuthority === false))
})

test('G6-U9 every card states that reviewing does not grant authority', () => {
  const view = buildFounderReviewView({ readModel: fullModel() })
  const cards = Object.values(view.sections).flat().filter((entry) => entry.reviewKey)
  assert.ok(cards.length > 0)
  assert.ok(cards.every((card) => card.authorityImpact === 'NONE'))
  assert.ok(cards.every((card) => /does not give DW permission/.test(card.authorityNote)))
})

test('G6-U10 revoked authority stays visible as history', () => {
  const model = fullModel()
  const view = buildFounderReviewView({ readModel: model })
  assert.equal(view.authority.grants.length, 1)
  assert.equal(view.authority.grants[0].editPath, 'G5_SUPERSEDING_GRANT')
  assert.ok(Array.isArray(view.authority.revoked))
})

test('G6-U11 evidence keeps its own state and revoked material is not shown as current', () => {
  const view = buildFounderReviewView({ readModel: fullModel() })
  const withEvidence = view.sections[REVIEW_TAB.UNDERSTANDING].find((card) => card.evidence.length > 0)
  assert.ok(withEvidence)
  for (const entry of withEvidence.evidence) {
    assert.ok(typeof entry.state === 'string' && entry.state.length > 0)
    if (!entry.presentedAsCurrentEvidence) assert.notEqual(entry.state, 'Current')
  }
})

test('G6-U12 history renders the founder decision trail with no authority impact', () => {
  const view = buildFounderReviewView({ readModel: fullModel({ reviewed: true }) })
  const history = view.sections[REVIEW_TAB.HISTORY]
  assert.equal(history.length, 1)
  assert.equal(history[0].actionLabel, 'Approve understanding')
  assert.equal(history[0].authorityImpact, 'NONE')
  assert.equal(history[0].revision, 1)
})

test('G6-U13 the view is deeply frozen and cannot be mutated by a caller', () => {
  const view = buildFounderReviewView({ readModel: fullModel() })
  assert.ok(Object.isFrozen(view))
  assert.ok(Object.isFrozen(view.sections))
  assert.ok(Object.isFrozen(view.authority))
  assert.throws(() => { view.readiness.autopilotReady = true }, TypeError)
})

test('G6-U14 structured values render without inventing prose', () => {
  assert.equal(describeValue(null), 'No safe current value')
  assert.equal(describeValue({ b: 2, a: 1 }), 'A: 1 · B: 2')
  assert.equal(describeValue(['x', 'y']), 'x, y')
})

test('G6-U15 the surface component executes nothing and grants nothing', () => {
  for (const pattern of [
    /sendReminder/, /sendEmail/, /markPaid/, /applyLateFee/, /issueRefund/,
    /grantAuthority\(/, /grant_company_brain_authority/, /supabase/, /\bfetch\(/,
  ]) {
    assert.doesNotMatch(surface, pattern)
  }
  assert.match(surface, /buildFounderReviewView/)
})

test('G6-U16 the review page reads the tenant from the session and fails closed', () => {
  assert.match(page, /loadFounderReviewReadModel/)
  assert.doesNotMatch(page, /tenantId:|user_id|isFounder/)
  // On a failed load the page clears the model rather than showing a stale review.
  assert.match(page, /setReadModel\(null\)/)
  assert.match(page, /setError\(/)
})

test('G6-U17 the surface is keyboard operable and does not rely on colour alone', () => {
  assert.match(surface, /type="button"/)
  assert.match(surface, /aria-label=/)
  assert.match(surface, /aria-live="polite"/)
  assert.match(surface, /role="alert"/)
  assert.match(surface, /aria-current=/)
  assert.match(surface, /htmlFor=/)
  assert.match(css, /:focus-visible/)
  // Status text accompanies every status colour.
  assert.match(surface, /label=\{card\.statusLabel\}/)
})

test('G6-U18 the surface is responsive and adds no unrelated global styling', () => {
  assert.match(css, /@media \(max-width: 720px\)/)
  assert.doesNotMatch(css, /^\s*(body|html|\*)\s*\{/m)
})

test('G6-U19 the route is reachable from the app shell', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'src/App.jsx'), 'utf8')
  const sidebar = fs.readFileSync(path.join(repoRoot, 'src/components/Sidebar.jsx'), 'utf8')
  assert.match(app, /path="\/company-brain"/)
  assert.match(app, /<CompanyBrain \/>/)
  assert.match(sidebar, /to: '\/company-brain'/)
})

test('G6-U20 no dead review control is rendered for an item with no available action', () => {
  const model = fullModel()
  const view = buildFounderReviewView({ readModel: model })
  const authorityCards = view.sections[REVIEW_TAB.AUTHORITY].filter((card) => card.itemType === REVIEW_ITEM_TYPE.AUTHORITY_STATE)
  assert.ok(authorityCards.length > 0)
  assert.ok(authorityCards.every((card) => card.actions.length === 0))
  assert.match(surface, /card\.actions\.length > 0/)
})
