import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CompanyBrainDurableStore } from '../src/lib/companyBrain/durableStore.js'
import { CompanyGraphStore, SEMANTIC_SCOPE } from '../src/lib/companyBrain/graphStore.js'
import {
  CANDIDATE_STATUS,
  buildPolicyCandidates,
  deriveFounderDecisionState,
} from '../src/lib/companyBrain/policyIntelligence.js'
import { buildOperatingModelProposal } from '../src/lib/companyBrain/operatingModel.js'
import {
  APPROVAL_REQUIREMENT,
  AUTHORITY_ACTION,
  AUTHORITY_DECISION,
  AUTHORITY_SCOPE,
  AUTHORITY_STATUS,
  AuthorityDelegationStore,
  buildAuthorityReadModel,
  createG5AuthorityProposal,
  evaluateAuthority,
} from '../src/lib/companyBrain/authorityDelegation.js'
import {
  FounderReviewStore,
  REVIEW_ACTION,
  REVIEW_CATEGORY,
  REVIEW_ITEM_TYPE,
  REVIEW_REQUIRED_REASON,
  REVIEW_RESOLUTION_PATH,
  REVIEW_STATUS,
  buildFounderReviewItems,
  buildFounderReviewItemsFromRecords,
  buildFounderReviewReadModel,
  deriveFounderReviewState,
  getAuthorityReviewState,
  getBootstrapReadiness,
  getChangedSinceReview,
  getCurrentCompanyUnderstanding,
  getFounderReviewItem,
  getFounderReviewSummary,
  getPendingFounderDecisions,
  listFounderReviewItems,
  toFounderReviewReadContext,
} from '../src/lib/companyBrain/founderReview.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const fixtureRoot = path.join(repoRoot, 'fixtures/company-brain')
const reviewModulePath = path.join(repoRoot, 'src/lib/companyBrain/founderReview.js')
const presentationPath = path.join(repoRoot, 'src/lib/companyBrain/founderReviewPresentation.js')
const loaderPath = path.join(repoRoot, 'src/lib/companyBrain/founderReviewLoader.js')

const tenantA = 'tenant-a'
const tenantB = 'tenant-b'
const founderA = { id: tenantA, tenantId: tenantA, role: 'FOUNDER', authenticated: true }
const founderB = { id: tenantB, tenantId: tenantB, role: 'FOUNDER', authenticated: true }
const workerA = { id: 'worker-a', tenantId: tenantA, role: 'INGESTION_WORKER', authenticated: true }
const workerB = { id: 'worker-b', tenantId: tenantB, role: 'INGESTION_WORKER', authenticated: true }
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

function ingestFile(brain, actor, folder, filename) {
  return brain.ingestLocalFile({
    actor,
    tenantId: actor.tenantId,
    filePath: path.join(fixtureRoot, folder, filename),
    sourceIdentity: filename,
    idempotencyKey: `${actor.tenantId}:${filename}:g6`,
  })
}

function seedTenant(brain, actor) {
  const receipts = {}
  receipts.collections = ingestFile(brain, actor, 'g1-realistic', 'collections-policy.md')
  receipts.atlasTerms = ingestFile(brain, actor, 'g1-realistic', 'atlas-terms.csv')
  receipts.founderInstruction = ingestFile(brain, actor, 'g1-realistic', 'founder-instruction.txt')
  for (const filename of G2_FILES) ingestFile(brain, actor, 'g2-graph', filename)
  return receipts
}

function seeded(actor = workerA, founder = founderA) {
  const now = clock()
  const brain = new CompanyBrainDurableStore({ clock: now })
  const receipts = seedTenant(brain, actor)
  const graph = new CompanyGraphStore({ brainStore: brain, clock: now })
  graph.build({ actor: founder, tenantId: founder.tenantId })
  return { brain, graph, receipts, now }
}

function operatingModelFor(state, founder = founderA) {
  return buildOperatingModelProposal({
    actor: founder,
    tenantId: founder.tenantId,
    brain: state.brain,
    graph: state.graph,
    queryDate: asOfDate,
    generatedAt: '2026-08-31T18:00:00.000Z',
  })
}

function itemsFor(state, { founder = founderA, authorityReadModel = null } = {}) {
  return buildFounderReviewItems({
    actor: founder,
    tenantId: founder.tenantId,
    brain: state.brain,
    graph: state.graph,
    operatingModel: operatingModelFor(state, founder),
    authorityReadModel,
    asOfDate,
    generatedAt,
  })
}

function stateFor(store, items, { founder = founderA } = {}) {
  return deriveFounderReviewState({
    actor: founder,
    tenantId: founder.tenantId,
    store,
    items,
    generatedAt,
    asOfDate,
  })
}

function firstOfType(items, itemType) {
  const item = items.find((entry) => entry.itemType === itemType)
  assert.ok(item, `expected a ${itemType} review item in the derived Company Brain`)
  return item
}

function review(store, item, action, {
  founder = founderA, expectedRevision = 0, subjectFingerprint = item.subjectFingerprint,
  idempotencyKey = `${item.reviewKey}:${expectedRevision}:${action}`, ...rest
} = {}) {
  return store.recordReviewDecision({
    actor: founder,
    tenantId: founder.tenantId,
    item,
    action,
    expectedRevision,
    subjectFingerprint,
    idempotencyKey,
    ...rest,
  })
}

function authorityCurrentState(tenantId = tenantA) {
  return {
    references: [
      { tenantId, kind: 'CLIENT', id: 'atlas', active: true, resolutionState: 'RESOLVED' },
      { tenantId, kind: 'CLAIM', id: 'claim-reminder', active: true, resolutionState: 'RESOLVED' },
      { tenantId, kind: 'POLICY', id: 'reminder-policy:atlas', fingerprint: fingerprintA, active: true, resolutionState: 'RESOLVED' },
    ],
  }
}

function grantInput(tenantId = tenantA, overrides = {}) {
  return {
    explicitGrant: true,
    grantee: { type: 'DW', id: 'DUEWATCH' },
    action: AUTHORITY_ACTION.SEND_REMINDER,
    scope: { level: AUTHORITY_SCOPE.CLIENT, clientId: 'atlas' },
    limits: null,
    conditions: { daysOverdue: 7 },
    effectiveWindow: { effectiveFrom: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' },
    channel: 'EMAIL',
    approvalRequirement: APPROVAL_REQUIREMENT.NONE,
    provenance: [{ tenantId, kind: 'CLAIM', id: 'claim-reminder', requiredCurrent: false }],
    reviewedState: {
      reviewedAt: '2026-09-01T11:00:00.000Z',
      dependencies: [{ tenantId, kind: 'POLICY', id: 'reminder-policy:atlas', fingerprint: fingerprintA }],
    },
    ...overrides,
  }
}

function authorityStoreWithGrant({ tenantId = tenantA, founder = founderA, overrides = {} } = {}) {
  const store = new AuthorityDelegationStore({ clock: clock(Date.UTC(2026, 8, 1, 14, 0, 0)) })
  const grant = store.grantAuthority({
    actor: founder,
    tenantId,
    idempotencyKey: `${tenantId}:reminder-grant`,
    currentState: authorityCurrentState(tenantId),
    ...grantInput(tenantId, overrides),
  })
  return { store, grant }
}

function authorityModel(store, { founder = founderA, tenantId = tenantA } = {}) {
  return buildAuthorityReadModel({
    actor: founder,
    tenantId,
    store,
    currentState: authorityCurrentState(tenantId),
    asOf: '2026-09-01T15:00:00.000Z',
  })
}

const sharedState = seeded()
const sharedItems = itemsFor(sharedState)

// ── A–H: approving understanding never creates authority ──────────────────────

test('G6-A approving understanding does not create DW authority', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  const revision = review(store, item, REVIEW_ACTION.APPROVE)
  assert.equal(revision.status, REVIEW_STATUS.APPROVED)
  assert.equal(revision.authorityGranted, false)
  assert.equal(revision.authorityImpact, 'NONE')
  const authority = authorityModel(new AuthorityDelegationStore({ clock: clock() }))
  assert.equal(authority.currentAuthorityGrants.length, 0)
})

test('G6-B approving an operating-model statement does not create authority', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = sharedItems.find((entry) => entry.category === REVIEW_CATEGORY.OPERATING_MODEL)
  assert.ok(item)
  const revision = review(store, item, REVIEW_ACTION.APPROVE)
  assert.equal(revision.authorityGranted, false)
  assert.equal(authorityModel(new AuthorityDelegationStore({ clock: clock() })).currentAuthorityGrants.length, 0)
})

test('G6-C approving a policy interpretation does not create authority', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.POLICY_OR_RULE)
  assert.equal(review(store, item, REVIEW_ACTION.APPROVE).authorityGranted, false)
})

test('G6-D resolving a conflict through G3 does not create authority', () => {
  const state = seeded()
  const conflict = state.brain.conflicts.find((row) => row.tenantId === tenantA)
  assert.ok(conflict)
  const decision = state.brain.recordFounderDecision({
    actor: founderA,
    tenantId: tenantA,
    idempotencyKey: 'g6-conflict-decision',
    targetId: conflict.id,
    expectedRevision: 0,
    decisionType: 'RESOLVE_CONFLICT',
    oldState: { status: 'CONFLICTED', revision: 0, topic: conflict.topic, semanticScope: conflict.semanticScope },
    newState: { status: 'RESOLVED', governingClaimId: conflict.competingClaimIds[0] },
    evidenceClaimIds: conflict.competingClaimIds,
    reason: 'The founder chose the governing evidence.',
  })
  assert.equal(decision.actorRole, 'FOUNDER')
  const authority = authorityModel(new AuthorityDelegationStore({ clock: clock() }))
  assert.equal(authority.currentAuthorityGrants.length, 0)
  const evaluation = evaluateAuthority({
    actor: founderA,
    tenantId: tenantA,
    request: { actor: { type: 'DW', id: 'DUEWATCH' }, action: AUTHORITY_ACTION.APPLY_LATE_FEE, scope: { level: AUTHORITY_SCOPE.COMPANY }, amountMinor: 500, currency: 'USD' },
    grants: [],
    currentState: authorityCurrentState(),
    asOf: '2026-09-01T15:00:00.000Z',
  })
  assert.notEqual(evaluation.decision, AUTHORITY_DECISION.ALLOWED)
})

test('G6-E approving a role understanding does not create authority', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.ROLE_OR_RESPONSIBILITY)
  const revision = review(store, item, REVIEW_ACTION.APPROVE)
  assert.equal(revision.authorityGranted, false)
  assert.equal(item.describesHumanResponsibility, true)
})

test('G6-F approving observed human delegation does not create DW authority', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.DELEGATION)
  const revision = review(store, item, REVIEW_ACTION.APPROVE)
  assert.equal(revision.authorityGranted, false)
  assert.equal(item.boundaries.humanDelegationIsDwAuthority, false)
  assert.equal(authorityModel(new AuthorityDelegationStore({ clock: clock() })).currentAuthorityGrants.length, 0)
})

test('G6-G repeated approvals across items create no authority', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const approvable = sharedItems.filter((entry) => entry.reviewableActions.includes(REVIEW_ACTION.APPROVE))
  for (const item of approvable) review(store, item, REVIEW_ACTION.APPROVE)
  assert.ok(store.revisions.length >= 10)
  assert.ok(store.revisions.every((row) => row.authorityGranted === false))
  assert.equal(authorityModel(new AuthorityDelegationStore({ clock: clock() })).currentAuthorityGrants.length, 0)
})

test('G6-H one hundred repeated approvals never become standing authority', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  let accepted = 0
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // Each approval must cite the revision it saw, so a hundred blind repeats
    // are refused rather than silently accumulating into a permission.
    try {
      review(store, item, REVIEW_ACTION.APPROVE, { expectedRevision: 0, idempotencyKey: `repeat-${attempt}` })
      accepted += 1
    } catch (error) {
      assert.match(error.message, /stale founder review revision/)
    }
  }
  assert.equal(accepted, 1)
  assert.ok(store.revisions.every((row) => row.authorityGranted === false))
  const authority = authorityModel(new AuthorityDelegationStore({ clock: clock() }))
  assert.equal(authority.currentAuthorityGrants.length, 0)
})

// ── I–N: proposals stay inert; only G5 grants ─────────────────────────────────

test('G6-I an authority proposal remains inert in the review surface', () => {
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  authorityStore.recordProposal({
    actor: founderA,
    tenantId: tenantA,
    proposal: createG5AuthorityProposal({
      actor: founderA, tenantId: tenantA, action: AUTHORITY_ACTION.SEND_REMINDER,
      scope: { level: AUTHORITY_SCOPE.COMPANY }, proposedConfiguration: { channel: 'EMAIL' },
      createdAt: '2026-09-01T10:00:00.000Z',
    }),
  })
  const items = itemsFor(sharedState, { authorityReadModel: authorityModel(authorityStore) })
  const proposal = firstOfType(items, REVIEW_ITEM_TYPE.AUTHORITY_PROPOSAL)
  assert.equal(proposal.proposalIsInert, true)
  assert.equal(proposal.authorityGranted, false)
  assert.equal(proposal.grantableByInference, false)
  assert.equal(proposal.resolutionPath, REVIEW_RESOLUTION_PATH.G5_EXPLICIT_AUTHORITY_GRANT)
  assert.equal(authorityModel(authorityStore).currentAuthorityGrants.length, 0)
})

test('G6-J viewing or reading an authority proposal grants nothing', () => {
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  authorityStore.recordProposal({
    actor: founderA,
    tenantId: tenantA,
    proposal: createG5AuthorityProposal({
      actor: founderA, tenantId: tenantA, action: AUTHORITY_ACTION.APPLY_LATE_FEE,
      scope: { level: AUTHORITY_SCOPE.COMPANY }, proposedConfiguration: {},
      createdAt: '2026-09-01T10:00:00.000Z',
    }),
  })
  const model = authorityModel(authorityStore)
  const items = itemsFor(sharedState, { authorityReadModel: model })
  const store = new FounderReviewStore({ clock: clock() })
  const state = stateFor(store, items)
  const read = buildFounderReviewReadModel({ actor: founderA, tenantId: tenantA, state, authorityReadModel: model, store })
  assert.equal(read.authority.activeGrantCount, 0)
  assert.equal(read.authority.proposalCount, 1)
  assert.equal(authorityModel(authorityStore).currentAuthorityGrants.length, 0)
})

test('G6-K building the review surface grants nothing', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  const state = stateFor(store, sharedItems)
  buildFounderReviewReadModel({ actor: founderA, tenantId: tenantA, state, authorityReadModel: authorityModel(authorityStore), store })
  assert.equal(authorityStore.grants.length, 0)
})

test('G6-L completing the whole bootstrap review grants no authority', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  for (const item of sharedItems) {
    const action = item.reviewableActions.includes(REVIEW_ACTION.APPROVE) ? REVIEW_ACTION.APPROVE : item.reviewableActions[0]
    if (action) review(store, item, action)
  }
  const state = stateFor(store, sharedItems)
  const readiness = getBootstrapReadiness({ actor: founderA, tenantId: tenantA, state, authorityReadModel: authorityModel(authorityStore) })
  assert.equal(readiness.dwStandingAuthorityConfigured, false)
  assert.equal(readiness.autopilotReady, false)
  assert.equal(authorityStore.grants.length, 0)
})

test('G6-M understanding can be fully reviewed with zero standing authority', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  const understanding = sharedItems.filter((entry) => entry.category === REVIEW_CATEGORY.COMPANY_UNDERSTANDING)
  for (const item of understanding) review(store, item, REVIEW_ACTION.APPROVE)
  const state = stateFor(store, sharedItems)
  const current = getCurrentCompanyUnderstanding({ actor: founderA, tenantId: tenantA, state })
  assert.equal(current.confirmed.length, understanding.length)
  const readiness = getBootstrapReadiness({ actor: founderA, tenantId: tenantA, state, authorityReadModel: authorityModel(authorityStore) })
  assert.equal(readiness.zeroAuthorityIsValidCompletion, true)
  assert.equal(readiness.authorityConfigured, false)
})

test('G6-N only the explicit G5 grant path creates standing authority', () => {
  const { store: authorityStore, grant } = authorityStoreWithGrant()
  assert.equal(grant.status, AUTHORITY_STATUS.GRANTED)
  assert.equal(authorityModel(authorityStore).currentAuthorityGrants.length, 1)
  assert.throws(() => authorityStore.grantAuthority({
    actor: founderA, tenantId: tenantA, idempotencyKey: 'implicit', currentState: authorityCurrentState(),
    ...grantInput(tenantA), explicitGrant: false,
  }), /explicit authority-grant operation required/)
})

// ── O–R: forged identity cannot mutate anything ───────────────────────────────

test('G6-O a forged founder identity cannot record a review decision or grant', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  const forged = { id: 'not-the-owner', tenantId: tenantA, role: 'FOUNDER', authenticated: true }
  assert.throws(() => review(store, item, REVIEW_ACTION.APPROVE, { founder: forged }), /tenant owner reviewer required/)
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  assert.throws(() => authorityStore.grantAuthority({
    actor: forged, tenantId: tenantA, idempotencyKey: 'forged', currentState: authorityCurrentState(), ...grantInput(),
  }), /tenant owner grantor required/)
})

test('G6-P a forged tenant cannot record a review decision', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  assert.throws(() => store.recordReviewDecision({
    actor: founderA, tenantId: tenantB, item, action: REVIEW_ACTION.APPROVE,
    expectedRevision: 0, subjectFingerprint: item.subjectFingerprint, idempotencyKey: 'x',
  }), /actor tenant mismatch/)
})

test('G6-Q a client-supplied isFounder flag cannot record a review decision', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  const claimed = { id: tenantA, tenantId: tenantA, role: 'VIEWER', authenticated: true, isFounder: true }
  assert.throws(() => review(store, item, REVIEW_ACTION.APPROVE, { founder: claimed }), /founder role required/)
  assert.throws(() => review(store, item, REVIEW_ACTION.APPROVE, { isFounder: true }), /cannot carry authority field 'isFounder'/)
})

test('G6-R model-generated grant language cannot grant through a review write', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  assert.throws(() => review(store, item, REVIEW_ACTION.APPROVE, { explicitGrant: true }), /cannot carry authority field 'explicitGrant'/)
  assert.throws(() => review(store, item, REVIEW_ACTION.APPROVE, { grantee: { type: 'DW', id: 'DUEWATCH' } }), /cannot carry authority field 'grantee'/)
  assert.throws(() => review(store, item, REVIEW_ACTION.APPROVE, { authorityGranted: true }), /cannot carry authority field 'authorityGranted'/)
})

// ── S–W: tenant isolation ─────────────────────────────────────────────────────

test('G6-S tenant A cannot read tenant B review items', () => {
  const stateB = seeded(workerB, founderB)
  const itemsB = itemsFor(stateB, { founder: founderB })
  const store = new FounderReviewStore({ clock: clock() })
  const mixed = deriveFounderReviewState({
    actor: founderA, tenantId: tenantA, store, items: [...sharedItems, ...itemsB], generatedAt, asOfDate,
  })
  assert.ok(mixed.items.every((item) => item.tenantId === tenantA))
  assert.throws(() => deriveFounderReviewState({
    actor: founderA, tenantId: tenantB, store, items: itemsB, generatedAt, asOfDate,
  }), /actor tenant mismatch/)
})

test('G6-T tenant A cannot mutate tenant B review state', () => {
  const stateB = seeded(workerB, founderB)
  const itemB = firstOfType(itemsFor(stateB, { founder: founderB }), REVIEW_ITEM_TYPE.UNDERSTANDING)
  const store = new FounderReviewStore({ clock: clock() })
  assert.throws(() => store.recordReviewDecision({
    actor: founderA, tenantId: tenantA, item: itemB, action: REVIEW_ACTION.APPROVE,
    expectedRevision: 0, subjectFingerprint: itemB.subjectFingerprint, idempotencyKey: 'cross',
  }), /founder review item tenant mismatch/)
})

test('G6-U tenant A cannot see tenant B authority state', () => {
  const { store: authorityStore } = authorityStoreWithGrant({ tenantId: tenantB, founder: founderB })
  assert.throws(() => buildAuthorityReadModel({
    actor: founderA, tenantId: tenantB, store: authorityStore, currentState: authorityCurrentState(tenantB), asOf: '2026-09-01T15:00:00.000Z',
  }), /actor tenant mismatch/)
  const ownModel = buildAuthorityReadModel({
    actor: founderA, tenantId: tenantA, store: authorityStore, currentState: authorityCurrentState(tenantA), asOf: '2026-09-01T15:00:00.000Z',
  })
  assert.equal(ownModel.currentAuthorityGrants.length, 0)
  assert.throws(() => getAuthorityReviewState({ actor: founderA, tenantId: tenantB, authorityReadModel: ownModel }), /tenant mismatch/)
})

test('G6-V tenant A cannot grant tenant B authority', () => {
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  assert.throws(() => authorityStore.grantAuthority({
    actor: founderA, tenantId: tenantB, idempotencyKey: 'cross-grant',
    currentState: authorityCurrentState(tenantB), ...grantInput(tenantB),
  }), /actor tenant mismatch/)
})

test('G6-W tenant A cannot revoke tenant B authority', () => {
  const { store: authorityStore, grant } = authorityStoreWithGrant({ tenantId: tenantB, founder: founderB })
  assert.throws(() => authorityStore.revokeAuthority({
    actor: founderA, tenantId: tenantB, grantId: grant.id, idempotencyKey: 'cross-revoke', reason: 'no',
  }), /actor tenant mismatch/)
  assert.equal(authorityStore.grants[0].status, AUTHORITY_STATUS.GRANTED)
})

// ── X–Z: reject, hold, defer semantics ────────────────────────────────────────

test('G6-X rejecting an understanding never asserts the inverse proposition', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  const revision = review(store, item, REVIEW_ACTION.REJECT)
  assert.equal(revision.status, REVIEW_STATUS.REJECTED)
  assert.equal(revision.assertsInverseProposition, false)
  assert.equal(revision.inferredOppositeValue, null)
  assert.equal(revision.reviewedValue, null)
  const state = stateFor(store, sharedItems)
  const current = getCurrentCompanyUnderstanding({ actor: founderA, tenantId: tenantA, state })
  assert.ok(!current.confirmed.some((entry) => entry.reviewKey === item.reviewKey))
})

test('G6-Y a held item stays unresolved and never becomes a default', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  review(store, item, REVIEW_ACTION.HOLD)
  const state = stateFor(store, sharedItems)
  const resolved = getFounderReviewItem({ actor: founderA, tenantId: tenantA, state, reviewKey: item.reviewKey })
  assert.equal(resolved.reviewStatus, REVIEW_STATUS.HELD)
  const current = getCurrentCompanyUnderstanding({ actor: founderA, tenantId: tenantA, state })
  assert.ok(!current.confirmed.some((entry) => entry.reviewKey === item.reviewKey))
})

test('G6-Z a deferred item stays unresolved and distinct from held', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  review(store, item, REVIEW_ACTION.DEFER)
  const state = stateFor(store, sharedItems)
  const resolved = getFounderReviewItem({ actor: founderA, tenantId: tenantA, state, reviewKey: item.reviewKey })
  assert.equal(resolved.reviewStatus, REVIEW_STATUS.DEFERRED)
  assert.notEqual(REVIEW_STATUS.DEFERRED, REVIEW_STATUS.HELD)
  const current = getCurrentCompanyUnderstanding({ actor: founderA, tenantId: tenantA, state })
  assert.ok(!current.confirmed.some((entry) => entry.reviewKey === item.reviewKey))
})

// ── AA–AD: revision lineage, supersession, no resurrection ────────────────────

test('G6-AA editing an understanding creates an auditable revision with lineage', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  const first = review(store, item, REVIEW_ACTION.APPROVE)
  const second = review(store, item, REVIEW_ACTION.EDIT, {
    expectedRevision: 1, reviewedValue: { reminderDays: 5 },
  })
  assert.equal(second.revision, 2)
  assert.equal(second.supersedesRevisionId, first.id)
  assert.deepEqual(second.reviewedValue, { reminderDays: 5 })
  assert.deepEqual(second.proposedValue, item.proposedValue)
})

test('G6-AB the prior revision stays auditable after supersession', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  const first = review(store, item, REVIEW_ACTION.APPROVE)
  review(store, item, REVIEW_ACTION.EDIT, { expectedRevision: 1, reviewedValue: { reminderDays: 5 } })
  const history = store.readHistory({ actor: founderA, tenantId: tenantA })
  assert.equal(history.revisions.length, 2)
  assert.ok(history.revisions.some((row) => row.id === first.id && row.status === REVIEW_STATUS.APPROVED))
})

test('G6-AC explicit supersession selects the current revision', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  review(store, item, REVIEW_ACTION.APPROVE)
  const second = review(store, item, REVIEW_ACTION.EDIT, { expectedRevision: 1, reviewedValue: { reminderDays: 5 } })
  const state = stateFor(store, sharedItems)
  const resolved = getFounderReviewItem({ actor: founderA, tenantId: tenantA, state, reviewKey: item.reviewKey })
  assert.equal(resolved.currentReviewRevision.id, second.id)
  assert.equal(resolved.reviewStatus, REVIEW_STATUS.EDITED)
  assert.equal(resolved.supersededReviewRevisions.length, 1)
})

test('G6-AD a stale successor never resurrects its predecessor', () => {
  const state = seeded()
  const items = itemsFor(state)
  const item = firstOfType(items, REVIEW_ITEM_TYPE.UNDERSTANDING)
  const store = new FounderReviewStore({ clock: clock() })
  review(store, item, REVIEW_ACTION.APPROVE)
  const second = review(store, item, REVIEW_ACTION.EDIT, { expectedRevision: 1, reviewedValue: { reminderDays: 5 } })
  // The successor is now stale against a changed subject; the approved
  // predecessor must not come back as current truth.
  const changed = { ...item, subjectFingerprint: 'f'.repeat(64) }
  const derived = deriveFounderReviewState({
    actor: founderA, tenantId: tenantA, store, items: [changed], generatedAt, asOfDate,
  })
  const resolved = derived.items[0]
  assert.equal(resolved.reviewStatus, REVIEW_STATUS.REVIEW_REQUIRED)
  assert.equal(resolved.reviewRequiredReason, REVIEW_REQUIRED_REASON.SUBJECT_CHANGED_SINCE_REVIEW)
  assert.equal(resolved.currentReviewRevision.id, second.id)
  assert.notEqual(resolved.reviewStatus, REVIEW_STATUS.APPROVED)
})

// ── AE–AH: freshness and material change ──────────────────────────────────────

test('G6-AE source revocation affects only the dependent review item', () => {
  const state = seeded()
  const items = itemsFor(state)
  const store = new FounderReviewStore({ clock: clock() })
  for (const item of items.filter((entry) => entry.reviewableActions.includes(REVIEW_ACTION.APPROVE))) {
    review(store, item, REVIEW_ACTION.APPROVE)
  }
  const before = stateFor(store, items)
  const approvedBefore = before.items.filter((entry) => entry.reviewStatus === REVIEW_STATUS.APPROVED).length
  state.brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: state.receipts.collections.sourceId, reason: 'superseded policy' })
  state.graph.build({ actor: founderA, tenantId: tenantA })
  const after = stateFor(store, itemsFor(state))
  const approvedAfter = after.items.filter((entry) => entry.reviewStatus === REVIEW_STATUS.APPROVED).length
  assert.ok(approvedAfter < approvedBefore, 'the revoked source must affect some reviewed items')
  assert.ok(approvedAfter > 0, 'unrelated approved understanding must survive an unrelated revocation')
})

test('G6-AF an unrelated source change does not stale unrelated review items', () => {
  const state = seeded()
  const items = itemsFor(state)
  const store = new FounderReviewStore({ clock: clock() })
  const target = firstOfType(items, REVIEW_ITEM_TYPE.UNDERSTANDING)
  review(store, target, REVIEW_ACTION.APPROVE)
  state.brain.ingestContent({
    actor: workerA, tenantId: tenantA, filename: 'atlas-discount-message.txt',
    content: 'Give Atlas 20% off.',
    sourceIdentity: 'atlas-discount-message', idempotencyKey: `${tenantA}:atlas-discount-message:g6`,
  })
  state.graph.build({ actor: founderA, tenantId: tenantA })
  const after = stateFor(store, itemsFor(state))
  const resolved = after.items.find((entry) => entry.reviewKey === target.reviewKey)
  assert.ok(resolved)
  assert.equal(resolved.changedSinceReview, false)
  assert.equal(resolved.reviewStatus, REVIEW_STATUS.APPROVED)
})

test('G6-AG a material change to the reviewed subject produces review-required', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  review(store, item, REVIEW_ACTION.APPROVE)
  const changed = { ...item, subjectFingerprint: 'c'.repeat(64) }
  const derived = deriveFounderReviewState({ actor: founderA, tenantId: tenantA, store, items: [changed], generatedAt, asOfDate })
  assert.equal(derived.items[0].reviewStatus, REVIEW_STATUS.REVIEW_REQUIRED)
  const changedSince = getChangedSinceReview({ actor: founderA, tenantId: tenantA, state: derived })
  assert.equal(changedSince.count, 1)
  assert.equal(changedSince.items[0].authorityImpact, 'GOVERNED_BY_G5_MATERIAL_DEPENDENCIES')
})

test('G6-AH authority freshness stays governed by G5 dependency semantics', () => {
  const { store: authorityStore, grant } = authorityStoreWithGrant()
  const stale = buildAuthorityReadModel({
    actor: founderA, tenantId: tenantA, store: authorityStore, asOf: '2026-09-01T15:00:00.000Z',
    currentState: { references: [
      { tenantId: tenantA, kind: 'CLIENT', id: 'atlas', active: true, resolutionState: 'RESOLVED' },
      { tenantId: tenantA, kind: 'CLAIM', id: 'claim-reminder', active: true, resolutionState: 'RESOLVED' },
      { tenantId: tenantA, kind: 'POLICY', id: 'reminder-policy:atlas', fingerprint: 'b'.repeat(64), active: true, resolutionState: 'RESOLVED' },
    ] },
  })
  assert.equal(stale.currentAuthorityGrants.length, 0)
  assert.equal(stale.staleAuthority.length, 1)
  assert.equal(stale.staleAuthority[0].grant.id, grant.id)
  // G6 did not decide this: it is the G5 reviewed-dependency fingerprint.
  assert.equal(stale.staleAuthority[0].derivedReason, 'REVIEWED_DEPENDENCY_CHANGED')
})

// ── AI–AL: nothing else escalates ─────────────────────────────────────────────

test('G6-AI confidence never grants authority', () => {
  const withConfidence = sharedItems.filter((entry) => entry.confidence != null)
  for (const item of withConfidence) {
    assert.equal(item.authorityImpact, 'NONE')
    assert.equal(item.boundaries.modelConfidenceIsAuthority, false)
  }
  const store = new FounderReviewStore({ clock: clock() })
  const item = withConfidence[0] || firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  assert.equal(review(store, item, item.reviewableActions[0]).authorityGranted, false)
})

test('G6-AJ provider capability never grants authority', () => {
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  const model = authorityModel(authorityStore)
  const review = getAuthorityReviewState({ actor: founderA, tenantId: tenantA, authorityReadModel: model })
  assert.equal(review.activeGrantCount, 0)
  assert.equal(review.boundaries.providerCapabilityIsAuthority, false)
  const evaluation = evaluateAuthority({
    actor: founderA, tenantId: tenantA,
    request: { actor: { type: 'DW', id: 'DUEWATCH' }, action: AUTHORITY_ACTION.SEND_REMINDER, scope: { level: AUTHORITY_SCOPE.COMPANY }, channel: 'EMAIL', providerCapability: 'GMAIL_SEND' },
    grants: [], currentState: authorityCurrentState(), asOf: '2026-09-01T15:00:00.000Z',
  })
  assert.notEqual(evaluation.decision, AUTHORITY_DECISION.ALLOWED)
})

test('G6-AK a human role never grants DW authority', () => {
  const roleItems = sharedItems.filter((entry) => entry.itemType === REVIEW_ITEM_TYPE.ROLE_OR_RESPONSIBILITY)
  assert.ok(roleItems.length > 0)
  for (const item of roleItems) {
    assert.equal(item.authorityImpact, 'NONE')
    assert.equal(item.boundaries.roleUnderstandingIsAuthority, false)
  }
})

test('G6-AL human authority does not equal DW authority', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  const delegations = sharedItems.filter((entry) => entry.itemType === REVIEW_ITEM_TYPE.DELEGATION)
  for (const item of delegations) review(store, item, REVIEW_ACTION.APPROVE)
  assert.equal(authorityModel(authorityStore).currentAuthorityGrants.length, 0)
  assert.ok(store.revisions.every((row) => row.authorityImpact === 'NONE'))
})

// ── AM–AO: idempotency and proposal edits ─────────────────────────────────────

test('G6-AM a semantic retry of the same decision is idempotent', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  const first = review(store, item, REVIEW_ACTION.APPROVE, { idempotencyKey: 'retry-1' })
  const replay = review(store, item, REVIEW_ACTION.APPROVE, { idempotencyKey: 'retry-1' })
  assert.equal(replay.id, first.id)
  assert.equal(store.revisions.length, 1)
  assert.throws(() => review(store, item, REVIEW_ACTION.REJECT, { idempotencyKey: 'retry-1' }), /idempotency conflict/)
})

test('G6-AN a genuinely distinct revision stays distinct', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  review(store, item, REVIEW_ACTION.APPROVE, { idempotencyKey: 'd1' })
  const second = review(store, item, REVIEW_ACTION.EDIT, { expectedRevision: 1, reviewedValue: { a: 1 }, idempotencyKey: 'd2' })
  const third = review(store, item, REVIEW_ACTION.EDIT, { expectedRevision: 2, reviewedValue: { a: 2 }, idempotencyKey: 'd3' })
  assert.equal(store.revisions.length, 3)
  assert.notDeepEqual(second.reviewedValue, third.reviewedValue)
})

test('G6-AO editing an authority proposal leaves it inert', () => {
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  authorityStore.recordProposal({
    actor: founderA, tenantId: tenantA,
    proposal: createG5AuthorityProposal({
      actor: founderA, tenantId: tenantA, action: AUTHORITY_ACTION.SEND_REMINDER,
      scope: { level: AUTHORITY_SCOPE.COMPANY }, proposedConfiguration: { channel: 'EMAIL', clients: 'ALL' },
      createdAt: '2026-09-01T10:00:00.000Z',
    }),
  })
  const items = itemsFor(sharedState, { authorityReadModel: authorityModel(authorityStore) })
  const proposal = firstOfType(items, REVIEW_ITEM_TYPE.AUTHORITY_PROPOSAL)
  const store = new FounderReviewStore({ clock: clock() })
  // An approve on a proposal would read as a grant, so it is not offered.
  assert.ok(!proposal.reviewableActions.includes(REVIEW_ACTION.APPROVE))
  const edited = review(store, proposal, REVIEW_ACTION.EDIT, { reviewedValue: { channel: 'EMAIL', clients: ['cedar', 'riverbend'] } })
  assert.equal(edited.authorityGranted, false)
  assert.equal(authorityModel(authorityStore).currentAuthorityGrants.length, 0)
})

// ── AP–AY: every G5 dimension survives the grant ──────────────────────────────

test('G6-AP..AY an explicit grant preserves every G5 dimension exactly', () => {
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  const grant = authorityStore.grantAuthority({
    actor: founderA, tenantId: tenantA, idempotencyKey: 'dimensions',
    currentState: authorityCurrentState(),
    ...grantInput(tenantA, {
      action: AUTHORITY_ACTION.APPLY_LATE_FEE,
      scope: { level: AUTHORITY_SCOPE.CLIENT, clientId: 'atlas' },
      limits: { maxAmountMinor: 5000, currency: 'usd' },
      channel: null,
      conditions: { daysOverdue: 30, noActivePromise: true },
      approvalRequirement: APPROVAL_REQUIREMENT.FOUNDER,
    }),
  })
  assert.equal(grant.action, AUTHORITY_ACTION.APPLY_LATE_FEE)                 // AP ACTION
  assert.equal(grant.scope.level, AUTHORITY_SCOPE.CLIENT)                     // AQ SCOPE
  assert.equal(grant.scope.clientId, 'atlas')                                 // AR CLIENT
  assert.equal(grant.limits.maxAmountMinor, 5000)                             // AS AMOUNT
  assert.equal(grant.limits.currency, 'USD')                                  // AT CURRENCY
  assert.deepEqual(grant.conditions, { daysOverdue: 30, noActivePromise: true }) // AU CONDITION
  assert.equal(grant.effectiveWindow.effectiveFrom, '2026-09-01T00:00:00.000Z')  // AV TIME
  assert.equal(grant.effectiveWindow.expiresAt, '2026-10-01T00:00:00.000Z')
  assert.equal(grant.channel, null)                                           // AW CHANNEL
  assert.equal(grant.approvalRequirement, APPROVAL_REQUIREMENT.FOUNDER)       // AX APPROVAL
  const model = authorityModel(authorityStore)
  const item = firstOfType(itemsFor(sharedState, { authorityReadModel: model }), REVIEW_ITEM_TYPE.AUTHORITY_STATE)
  assert.equal(item.proposition.amount, 5000)
  assert.equal(item.proposition.currency, 'USD')
  assert.equal(item.proposition.approval, APPROVAL_REQUIREMENT.FOUNDER)
})

test('G6-AY a missing scope dimension never becomes a wildcard', () => {
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  assert.throws(() => authorityStore.grantAuthority({
    actor: founderA, tenantId: tenantA, idempotencyKey: 'no-scope',
    currentState: authorityCurrentState(),
    ...grantInput(tenantA, { scope: { level: AUTHORITY_SCOPE.CLIENT } }),
  }), /client scope clientId required/)
  const evaluation = evaluateAuthority({
    actor: founderA, tenantId: tenantA,
    request: { actor: { type: 'DW', id: 'DUEWATCH' }, action: AUTHORITY_ACTION.SEND_REMINDER, scope: { level: AUTHORITY_SCOPE.COMPANY }, channel: 'EMAIL', conditions: { daysOverdue: 7 } },
    grants: authorityStoreWithGrant().store.grants,
    currentState: authorityCurrentState(), asOf: '2026-09-01T15:00:00.000Z',
  })
  // A client-scoped grant does not silently answer a company-scoped request.
  assert.notEqual(evaluation.decision, AUTHORITY_DECISION.ALLOWED)
})

// ── AZ–BD: revocation, independence, history ──────────────────────────────────

test('G6-AZ revocation is immediate', () => {
  const { store: authorityStore, grant } = authorityStoreWithGrant()
  assert.equal(authorityModel(authorityStore).currentAuthorityGrants.length, 1)
  authorityStore.revokeAuthority({ actor: founderA, tenantId: tenantA, grantId: grant.id, idempotencyKey: 'rev-1', reason: 'no longer wanted' })
  const model = authorityModel(authorityStore)
  assert.equal(model.currentAuthorityGrants.length, 0)
  assert.equal(model.revokedAuthority.length, 1)
})

test('G6-BA revoked authority stays auditable', () => {
  const { store: authorityStore, grant } = authorityStoreWithGrant()
  authorityStore.revokeAuthority({ actor: founderA, tenantId: tenantA, grantId: grant.id, idempotencyKey: 'rev-2', reason: 'season ended' })
  const history = authorityStore.readHistory({ actor: founderA, tenantId: tenantA })
  assert.equal(history.grants.length, 1)
  assert.equal(history.revocations.length, 1)
  assert.equal(history.revocations[0].reason, 'season ended')
})

test('G6-BB changing authority does not rewrite the understanding history', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  const revision = review(store, item, REVIEW_ACTION.APPROVE)
  const { store: authorityStore, grant } = authorityStoreWithGrant()
  authorityStore.revokeAuthority({ actor: founderA, tenantId: tenantA, grantId: grant.id, idempotencyKey: 'rev-3', reason: 'changed my mind' })
  const history = store.readHistory({ actor: founderA, tenantId: tenantA })
  assert.equal(history.revisions.length, 1)
  assert.equal(history.revisions[0].id, revision.id)
  assert.equal(history.revisions[0].status, REVIEW_STATUS.APPROVED)
})

test('G6-BC changing understanding does not silently rewrite authority', () => {
  const { store: authorityStore, grant } = authorityStoreWithGrant()
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  review(store, item, REVIEW_ACTION.APPROVE)
  review(store, item, REVIEW_ACTION.EDIT, { expectedRevision: 1, reviewedValue: { reminderDays: 5 } })
  const model = authorityModel(authorityStore)
  assert.equal(model.currentAuthorityGrants.length, 1)
  assert.equal(model.currentAuthorityGrants[0].id, grant.id)
  assert.equal(model.currentAuthorityGrants[0].revision, grant.revision)
})

test('G6-BD review history cannot overwrite an earlier founder decision', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  const first = review(store, item, REVIEW_ACTION.APPROVE)
  review(store, item, REVIEW_ACTION.REJECT, { expectedRevision: 1 })
  const history = store.readHistory({ actor: founderA, tenantId: tenantA })
  assert.equal(history.revisions.length, 2)
  assert.deepEqual(history.revisions[0], first)
  assert.ok(Object.isFrozen(history.revisions[0]))
})

// ── BE–BI: read models ────────────────────────────────────────────────────────

test('G6-BE the review summary is deterministic', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const one = getFounderReviewSummary({ actor: founderA, tenantId: tenantA, state: stateFor(store, sharedItems) })
  const two = getFounderReviewSummary({ actor: founderA, tenantId: tenantA, state: stateFor(store, sharedItems) })
  assert.deepEqual(one, two)
  assert.equal(one.reviewedFraction.of, one.reviewableItems)
})

test('G6-BF the review summary is tenant-scoped', () => {
  const stateB = seeded(workerB, founderB)
  const itemsB = itemsFor(stateB, { founder: founderB })
  const store = new FounderReviewStore({ clock: clock() })
  const mixed = deriveFounderReviewState({ actor: founderA, tenantId: tenantA, store, items: [...sharedItems, ...itemsB], generatedAt, asOfDate })
  const summary = getFounderReviewSummary({ actor: founderA, tenantId: tenantA, state: mixed })
  assert.equal(summary.totalItems, sharedItems.length)
})

test('G6-BG pending founder decisions are deterministic and complete', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const state = stateFor(store, sharedItems)
  const pending = getPendingFounderDecisions({ actor: founderA, tenantId: tenantA, state })
  assert.equal(pending.count, sharedItems.length)
  assert.deepEqual(pending, getPendingFounderDecisions({ actor: founderA, tenantId: tenantA, state }))
})

test('G6-BH returned read models are deeply frozen', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const state = stateFor(store, sharedItems)
  const model = buildFounderReviewReadModel({ actor: founderA, tenantId: tenantA, state, store })
  assert.ok(Object.isFrozen(model))
  assert.ok(Object.isFrozen(model.items))
  assert.ok(Object.isFrozen(model.items[0]))
  assert.ok(Object.isFrozen(model.items[0].evidence))
  assert.ok(Object.isFrozen(model.summary))
  assert.ok(Object.isFrozen(model.readiness))
})

test('G6-BI an external caller cannot mutate review state through returned objects', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  review(store, item, REVIEW_ACTION.APPROVE)
  const state = stateFor(store, sharedItems)
  const model = buildFounderReviewReadModel({ actor: founderA, tenantId: tenantA, state, store })
  assert.throws(() => { model.items[0].reviewStatus = REVIEW_STATUS.APPROVED }, TypeError)
  assert.throws(() => { model.history.revisions[0].authorityGranted = true }, TypeError)
  assert.equal(store.revisions[0].authorityGranted, false)
})

// ── BJ–BQ: no execution, no money, no generic writes ──────────────────────────

test('G6-BJ no G6 API exposes an accounts-receivable execution path', () => {
  const source = fs.readFileSync(reviewModulePath, 'utf8')
  for (const pattern of [/sendReminder/, /sendEmail/, /sendSms/, /markPaid/, /applyLateFee\(/, /issueRefund\(/, /writeOff\(/, /execute\(/]) {
    assert.doesNotMatch(source, pattern)
  }
  const store = new FounderReviewStore({ clock: clock() })
  assert.equal(typeof store.execute, 'undefined')
  assert.equal(typeof store.grantAuthority, 'undefined')
  assert.equal(typeof store.revokeAuthority, 'undefined')
  assert.equal(typeof store.evaluateAuthority, 'undefined')
})

test('G6-BK an ALLOWED authority evaluation still stops before execution', () => {
  const { store: authorityStore } = authorityStoreWithGrant()
  const evaluation = evaluateAuthority({
    actor: founderA, tenantId: tenantA,
    request: { actor: { type: 'DW', id: 'DUEWATCH' }, action: AUTHORITY_ACTION.SEND_REMINDER, scope: { level: AUTHORITY_SCOPE.CLIENT, clientId: 'atlas' }, channel: 'EMAIL', conditions: { daysOverdue: 7 } },
    grants: authorityStore.grants, currentState: authorityCurrentState(), asOf: '2026-09-01T15:00:00.000Z',
  })
  assert.equal(evaluation.decision, AUTHORITY_DECISION.ALLOWED)
  assert.equal(evaluation.executed, false)
  assert.equal(evaluation.canonicalMoneyMutated, false)
})

test('G6-BL..BN G6 introduces no email, SMS or provider write path', () => {
  for (const file of [reviewModulePath, presentationPath]) {
    const source = fs.readFileSync(file, 'utf8')
    for (const pattern of [/nodemailer/, /twilio/, /stripe/i, /sendgrid/i, /\bfetch\(/, /XMLHttpRequest/]) {
      assert.doesNotMatch(source, pattern)
    }
  }
})

test('G6-BO G6 writes no canonical money state', () => {
  const sources = [reviewModulePath, presentationPath, loaderPath].map((file) => fs.readFileSync(file, 'utf8')).join('\n')
  for (const pattern of [
    /amount_paid/, /invoice_balance/, /payment_attempt/, /payment_receipt/,
    /from\('invoices'\)/, /from\('payments'\)/, /from\('payment_attempts'\)/,
  ]) {
    assert.doesNotMatch(sources, pattern)
  }
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  const revision = review(store, item, REVIEW_ACTION.APPROVE)
  assert.equal(revision.canonicalMoneyMutated, false)
  assert.equal(revision.executed, false)
})

test('G6-BP the loader performs no generic unrestricted database write', () => {
  const source = fs.readFileSync(loaderPath, 'utf8')
  // Only the two owning RPCs may mutate; nothing writes tables directly.
  const rpcs = [...source.matchAll(/\.rpc\('([a-z0-9_]+)'/g)].map((match) => match[1]).sort()
  assert.deepEqual(rpcs, [
    'grant_company_brain_authority_g5',
    'record_company_brain_founder_review_g6',
    'revoke_company_brain_authority_g5',
  ])
  assert.doesNotMatch(source, /\.update\(|\.insert\(|\.upsert\(|\.delete\(/)
})

test('G6-BQ the loader derives the tenant only from the authenticated session', () => {
  const source = fs.readFileSync(loaderPath, 'utf8')
  assert.match(source, /auth\.getUser\(\)/)
  assert.doesNotMatch(source, /localStorage|sessionStorage|searchParams|isFounder\s*=/)
})

// ── BR–BY: independence, preservation, honesty ────────────────────────────────

test('G6-BR authority and understanding remain independently representable', () => {
  const { store: authorityStore } = authorityStoreWithGrant()
  const store = new FounderReviewStore({ clock: clock() })
  const state = stateFor(store, sharedItems)
  const readiness = getBootstrapReadiness({ actor: founderA, tenantId: tenantA, state, authorityReadModel: authorityModel(authorityStore) })
  assert.equal(readiness.companyBrainReviewComplete, false)
  assert.equal(readiness.dwStandingAuthorityConfigured, true)
})

test('G6-BS the founder can approve understanding while rejecting the authority proposal', () => {
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  authorityStore.recordProposal({
    actor: founderA, tenantId: tenantA,
    proposal: createG5AuthorityProposal({
      actor: founderA, tenantId: tenantA, action: AUTHORITY_ACTION.SEND_REMINDER,
      scope: { level: AUTHORITY_SCOPE.COMPANY }, proposedConfiguration: { channel: 'EMAIL' },
      createdAt: '2026-09-01T10:00:00.000Z',
    }),
  })
  const items = itemsFor(sharedState, { authorityReadModel: authorityModel(authorityStore) })
  const store = new FounderReviewStore({ clock: clock() })
  review(store, firstOfType(items, REVIEW_ITEM_TYPE.UNDERSTANDING), REVIEW_ACTION.APPROVE)
  review(store, firstOfType(items, REVIEW_ITEM_TYPE.AUTHORITY_PROPOSAL), REVIEW_ACTION.REJECT)
  const state = stateFor(store, items)
  assert.equal(state.items.filter((entry) => entry.reviewStatus === REVIEW_STATUS.APPROVED).length, 1)
  assert.equal(state.items.filter((entry) => entry.reviewStatus === REVIEW_STATUS.REJECTED).length, 1)
  assert.equal(authorityModel(authorityStore).currentAuthorityGrants.length, 0)
})

test('G6-BT rejecting an understanding leaves unrelated authority untouched', () => {
  const { store: authorityStore, grant } = authorityStoreWithGrant()
  const store = new FounderReviewStore({ clock: clock() })
  review(store, firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING), REVIEW_ACTION.REJECT)
  const model = authorityModel(authorityStore)
  assert.equal(model.currentAuthorityGrants.length, 1)
  assert.equal(model.currentAuthorityGrants[0].id, grant.id)
})

test('G6-BU revoking authority does not rewrite Company Brain understanding', () => {
  const { store: authorityStore, grant } = authorityStoreWithGrant()
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  review(store, item, REVIEW_ACTION.APPROVE)
  const before = stateFor(store, sharedItems)
  authorityStore.revokeAuthority({ actor: founderA, tenantId: tenantA, grantId: grant.id, idempotencyKey: 'rev-bu', reason: 'stop' })
  const after = stateFor(store, sharedItems)
  assert.deepEqual(after.items, before.items)
})

test('G6-BV editing an understanding does not auto-grant new authority', () => {
  const authorityStore = new AuthorityDelegationStore({ clock: clock() })
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  review(store, item, REVIEW_ACTION.EDIT, { reviewedValue: { reminderDays: 5 } })
  assert.equal(authorityStore.grants.length, 0)
  assert.equal(authorityModel(authorityStore).currentAuthorityGrants.length, 0)
})

test('G6-BW a stale review submission cannot overwrite a newer revision', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  review(store, item, REVIEW_ACTION.APPROVE, { idempotencyKey: 'first' })
  assert.throws(() => review(store, item, REVIEW_ACTION.REJECT, { expectedRevision: 0, idempotencyKey: 'stale' }), /stale founder review revision/)
  // A write against a subject that changed after it was opened is refused too.
  assert.throws(() => review(store, item, REVIEW_ACTION.REJECT, {
    expectedRevision: 1, subjectFingerprint: 'e'.repeat(64), idempotencyKey: 'changed',
  }), /subject changed since it was opened/)
  assert.equal(store.revisions.length, 1)
  assert.equal(store.revisions[0].status, REVIEW_STATUS.APPROVED)
  const outcomes = store.attempts.map((row) => row.outcome)
  assert.ok(outcomes.includes('REJECTED_STALE_REVISION'))
  assert.ok(outcomes.includes('REJECTED_SUBJECT_CHANGED'))
})

test('G6-BX losing conflict evidence survives a founder decision', () => {
  const state = seeded()
  const conflict = state.brain.conflicts.find((row) => row.tenantId === tenantA)
  const competing = [...conflict.competingClaimIds]
  state.brain.recordFounderDecision({
    actor: founderA, tenantId: tenantA, idempotencyKey: 'g6-bx',
    targetId: conflict.id, expectedRevision: 0, decisionType: 'RESOLVE_CONFLICT',
    oldState: { status: 'CONFLICTED', revision: 0, topic: conflict.topic, semanticScope: conflict.semanticScope },
    newState: { status: 'RESOLVED', governingClaimId: competing[0] },
    evidenceClaimIds: competing, reason: 'Contract governs.',
  })
  const items = itemsFor(state)
  const conflictItem = items.find((entry) => entry.conflictId === conflict.id)
  assert.ok(conflictItem)
  const preserved = conflictItem.proposition.competingPositions.map((position) => position.claimId)
  for (const claimId of competing) assert.ok(preserved.includes(claimId), 'every competing claim stays visible')
  const decisions = deriveFounderDecisionState(state.brain, { tenantId: tenantA })
  assert.equal(decisions.currentDecisions.length, 1)
})

test('G6-BY revoked source history stays visible and is never shown as current', () => {
  const state = seeded()
  state.brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: state.receipts.collections.sourceId, reason: 'replaced' })
  state.graph.build({ actor: founderA, tenantId: tenantA })
  const tombstones = state.brain.tombstones.filter((row) => row.tenantId === tenantA)
  assert.equal(tombstones.length, 1)
  const items = itemsFor(state)
  for (const item of items) {
    for (const entry of item.evidence) {
      if (!entry.active) assert.ok(entry.revokedAt || entry.tombstoned || !entry.present)
    }
  }
})

// ── BZ: G7 has not begun ──────────────────────────────────────────────────────

test('G6-BZ no G7 Ask DW × Company Brain behaviour is introduced', () => {
  const sources = [reviewModulePath, presentationPath, loaderPath]
  for (const file of sources) {
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /askDwPolicy|askCompanyBrain|answerAskDw|conversationRuntime|openai|groq/i)
    assert.doesNotMatch(source, /from '.*dwIntelligence/)
  }
  const g7Paths = [
    'src/lib/companyBrain/askDwCompanyBrain.js',
    'src/lib/companyBrain/g7.js',
    'tests/companyBrainG7.test.mjs',
  ]
  for (const relative of g7Paths) assert.equal(fs.existsSync(path.join(repoRoot, relative)), false)
  const store = new FounderReviewStore({ clock: clock() })
  const state = stateFor(store, sharedItems)
  const context = toFounderReviewReadContext({ actor: founderA, tenantId: tenantA, state, store })
  assert.equal(context.boundaries.readOnly, true)
  assert.equal(context.boundaries.askDwCompanyBrainAnswering, false)
})

// ── repository-specific adversarial cases found during inspection ─────────────

test('G6-R1 a conflict cannot be approved away inside G6', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const conflict = firstOfType(sharedItems, REVIEW_ITEM_TYPE.CONFLICT)
  assert.deepEqual([...conflict.reviewableActions], [REVIEW_ACTION.HOLD, REVIEW_ACTION.DEFER])
  assert.equal(conflict.resolutionPath, REVIEW_RESOLUTION_PATH.G3_FOUNDER_DECISION)
  assert.throws(() => review(store, conflict, REVIEW_ACTION.APPROVE), /is unavailable for this item/)
  assert.ok(store.attempts.some((row) => row.outcome === 'REJECTED_ACTION_UNAVAILABLE'))
})

test('G6-R2 current authority offers no G6 review action at all', () => {
  const { store: authorityStore } = authorityStoreWithGrant()
  const items = itemsFor(sharedState, { authorityReadModel: authorityModel(authorityStore) })
  const authorityItem = firstOfType(items, REVIEW_ITEM_TYPE.AUTHORITY_STATE)
  assert.deepEqual([...authorityItem.reviewableActions], [])
  const store = new FounderReviewStore({ clock: clock() })
  for (const action of Object.values(REVIEW_ACTION)) {
    assert.throws(() => review(store, authorityItem, action, {
      reviewedValue: action === REVIEW_ACTION.EDIT ? { any: true } : undefined,
      idempotencyKey: `authority-${action}`,
    }), /is unavailable for this item/)
  }
})

test('G6-R3 an unknown or malformed review action is refused', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  assert.throws(() => review(store, item, 'GRANT'), /unknown founder review action/)
  assert.throws(() => review(store, item, REVIEW_ACTION.APPROVE, { reviewedValue: { x: 1 } }), /only an edit may carry a corrected value/)
  assert.throws(() => review(store, item, REVIEW_ACTION.EDIT), /requires an explicit corrected value/)
})

test('G6-R4 a foreign object cannot masquerade as a review item', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  const forged = { ...item, kind: 'SOMETHING_ELSE' }
  assert.throws(() => review(store, forged, REVIEW_ACTION.APPROVE), /founder review item required/)
})

test('G6-R5 a previously reviewed subject that disappears surfaces as review-required', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const item = firstOfType(sharedItems, REVIEW_ITEM_TYPE.UNDERSTANDING)
  review(store, item, REVIEW_ACTION.APPROVE)
  const derived = deriveFounderReviewState({ actor: founderA, tenantId: tenantA, store, items: [], generatedAt, asOfDate })
  assert.equal(derived.items.length, 1)
  assert.equal(derived.items[0].itemType, REVIEW_ITEM_TYPE.STALE_OR_CHANGED_ITEM)
  assert.equal(derived.items[0].reviewRequiredReason, REVIEW_REQUIRED_REASON.REVIEWED_SUBJECT_NO_LONGER_PRESENT)
  assert.deepEqual([...derived.items[0].reviewableActions], [])
})

test('G6-R6 the record-backed derivation matches the store-backed derivation', () => {
  const operatingModel = operatingModelFor(sharedState)
  const snapshot = sharedState.brain.prepareSnapshot({ actor: founderA, tenantId: tenantA })
  const fromRecords = buildFounderReviewItemsFromRecords({
    actor: founderA, tenantId: tenantA,
    knowledge: { sources: snapshot.sources, claims: snapshot.claims, tombstones: snapshot.tombstones },
    operatingModel, conflicts: sharedState.brain.conflicts, founderDecisions: [],
    asOfDate, generatedAt,
  })
  assert.deepEqual(fromRecords, sharedItems)
})

test('G6-R7 listing by category and item type stays tenant-scoped and deterministic', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const state = stateFor(store, sharedItems)
  const conflicts = listFounderReviewItems({ actor: founderA, tenantId: tenantA, state, category: REVIEW_CATEGORY.CONFLICTS })
  assert.ok(conflicts.length > 0)
  assert.ok(conflicts.every((item) => item.category === REVIEW_CATEGORY.CONFLICTS && item.tenantId === tenantA))
  assert.throws(() => listFounderReviewItems({ actor: founderB, tenantId: tenantA, state }), /actor tenant mismatch/)
})

test('G6-R8 an unresolved conflict is never reported as a safe current instruction', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const state = stateFor(store, sharedItems)
  const conflicts = listFounderReviewItems({ actor: founderA, tenantId: tenantA, state, itemType: REVIEW_ITEM_TYPE.CONFLICT })
  for (const conflict of conflicts) {
    if (conflict.conflictStatus !== 'CONFLICTED') continue
    assert.equal(conflict.currentSafeInstructionAvailable, false)
    assert.equal(conflict.reviewStatus, REVIEW_STATUS.REVIEW_REQUIRED)
    assert.equal(conflict.confidenceResolved, false)
  }
})

test('G6-R9 held and deferred items are never counted as reviewed understanding', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const understanding = sharedItems.filter((entry) => entry.category === REVIEW_CATEGORY.COMPANY_UNDERSTANDING)
  review(store, understanding[0], REVIEW_ACTION.HOLD)
  review(store, understanding[1], REVIEW_ACTION.DEFER)
  const state = stateFor(store, sharedItems)
  const summary = getFounderReviewSummary({ actor: founderA, tenantId: tenantA, state })
  assert.equal(summary.understandingReviewed, 0)
  assert.equal(summary.held, 1)
  assert.equal(summary.deferred, 1)
})

test('G6-R10 the review surface reports no fabricated completion percentage', () => {
  const store = new FounderReviewStore({ clock: clock() })
  const empty = deriveFounderReviewState({ actor: founderA, tenantId: tenantA, store, items: [], generatedAt, asOfDate })
  const summary = getFounderReviewSummary({ actor: founderA, tenantId: tenantA, state: empty })
  assert.equal(summary.reviewedFraction, null)
  const readiness = getBootstrapReadiness({ actor: founderA, tenantId: tenantA, state: empty })
  assert.equal(readiness.hasCompanyBrainMaterial, false)
  assert.equal(readiness.understandingReviewed, false)
  assert.equal(readiness.companyBrainReviewComplete, false)
})
