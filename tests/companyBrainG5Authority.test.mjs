import test from 'node:test'
import assert from 'node:assert/strict'

import {
  APPROVAL_REQUIREMENT,
  AUTHORITY_ACTION,
  AUTHORITY_DECISION,
  AUTHORITY_REASON,
  AUTHORITY_SCOPE,
  AUTHORITY_STATUS,
  AuthorityDelegationStore,
  buildAuthorityReadModel,
  createG5AuthorityProposal,
  deriveAuthorityState,
  evaluateAuthority,
  toAskDwAuthorityContext,
  toDwIntelligenceAuthorityContext,
} from '../src/lib/companyBrain/authorityDelegation.js'

const tenantA = 'tenant-a'
const tenantB = 'tenant-b'
const founderA = { id: tenantA, tenantId: tenantA, role: 'FOUNDER', authenticated: true }
const founderB = { id: tenantB, tenantId: tenantB, role: 'FOUNDER', authenticated: true }
const workerA = { id: 'worker-a', tenantId: tenantA, role: 'INGESTION_WORKER', authenticated: true }
const externalA = { id: 'external-agent-a', tenantId: tenantA, role: 'EXTERNAL_AGENT', authenticated: true }
const fingerprintA = 'a'.repeat(64)
const fingerprintB = 'b'.repeat(64)

function clock() {
  let tick = 0
  return () => `2026-09-01T12:${String(tick++).padStart(2, '0')}:00.000Z`
}

function currentState(tenantId = tenantA, overrides = {}) {
  const references = [
    { tenantId, kind: 'CLIENT', id: 'atlas', active: true, resolutionState: 'RESOLVED' },
    { tenantId, kind: 'CLIENT', id: 'acme', active: true, resolutionState: 'RESOLVED' },
    { tenantId, kind: 'INVOICE', id: 'invoice-1', active: true, resolutionState: 'RESOLVED' },
    { tenantId, kind: 'CLAIM', id: 'claim-reminder', active: true, resolutionState: 'RESOLVED' },
    { tenantId, kind: 'SOURCE_VERSION', id: 'source-reminder', active: true, resolutionState: 'RESOLVED' },
    { tenantId, kind: 'POLICY', id: 'reminder-policy:atlas', fingerprint: fingerprintA, active: true, resolutionState: 'RESOLVED' },
    { tenantId, kind: 'OPERATING_MODEL', id: 'operating-model-a', fingerprint: fingerprintA, active: true, resolutionState: 'RESOLVED' },
  ]
  return { references: overrides.references || references, unrelatedKnowledgeVersion: overrides.unrelatedKnowledgeVersion ?? 1 }
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

function createGrant(store, {
  actor = founderA,
  tenantId = tenantA,
  idempotencyKey = `grant-${store.grants.length + 1}`,
  state = currentState(tenantId),
  ...overrides
} = {}) {
  return store.grantAuthority({
    actor,
    tenantId,
    idempotencyKey,
    currentState: state,
    ...grantInput(tenantId, overrides),
  })
}

function request(overrides = {}) {
  return {
    actor: { type: 'DW', id: 'DUEWATCH' },
    action: AUTHORITY_ACTION.SEND_REMINDER,
    scope: { level: AUTHORITY_SCOPE.CLIENT, clientId: 'atlas' },
    channel: 'EMAIL',
    conditions: { daysOverdue: 7 },
    ...overrides,
  }
}

function evaluate(store, overrides = {}) {
  return evaluateAuthority({
    actor: founderA,
    tenantId: tenantA,
    request: request(),
    grants: store.grants,
    currentState: currentState(),
    asOf: '2026-09-15T00:00:00.000Z',
    ...overrides,
  })
}

test('G5-1 observed human delegation remains proposal context and creates no DW authority', () => {
  const result = evaluate(new AuthorityDelegationStore(), { observedHumanDelegation: [{ role: 'ACCOUNT_MANAGER', action: 'SEND_REMINDER' }] })
  assert.equal(result.decision, AUTHORITY_DECISION.NEEDS_APPROVAL)
  assert.equal(result.reason, AUTHORITY_REASON.AUTHORITY_UNCONFIGURED)
})

test('G5-2 observed human role does not create DW authority', () => {
  const result = evaluate(new AuthorityDelegationStore(), { observedHumanDelegation: [{ role: 'FOUNDER', authority: 'ALL' }] })
  assert.notEqual(result.decision, AUTHORITY_DECISION.ALLOWED)
})

test('G5-3 G4 operating-model proposal does not create authority', () => {
  const result = evaluate(new AuthorityDelegationStore(), { operatingModel: { status: 'PROPOSED', authorityGrantable: false } })
  assert.equal(result.decision, AUTHORITY_DECISION.NEEDS_APPROVAL)
})

test('G5-4 founder approval of an operating model alone does not create authority', () => {
  const result = evaluate(new AuthorityDelegationStore(), { operatingModel: { status: 'APPROVED', approvedBy: founderA.id } })
  assert.equal(result.decision, AUTHORITY_DECISION.NEEDS_APPROVAL)
})

test('G5-5 resolved G3 policy remains independently observable and non-authoritative', () => {
  const policy = { status: 'RESOLVED', topic: 'reminder_policy', value: { daysOverdue: 7 } }
  const result = evaluate(new AuthorityDelegationStore(), { resolvedPolicy: policy })
  assert.equal(policy.status, 'RESOLVED')
  assert.equal(result.decision, AUTHORITY_DECISION.NEEDS_APPROVAL)
  assert.equal(result.ignoredNonAuthorityContext.resolvedPolicy, true)
})

test('G5-6 historical precedent and model confidence do not create authority', () => {
  const result = evaluate(new AuthorityDelegationStore(), { modelOutput: { confidence: 1, historicalPrecedent: 1000 } })
  assert.equal(result.decision, AUTHORITY_DECISION.NEEDS_APPROVAL)
})

test('G5-7 one manual approval does not create standing authority', () => {
  const result = evaluate(new AuthorityDelegationStore(), { approvalHistory: [{ tenantId: tenantA, action: AUTHORITY_ACTION.SEND_REMINDER }] })
  assert.equal(result.decision, AUTHORITY_DECISION.NEEDS_APPROVAL)
})

test('G5-8 one hundred repeated approvals remain history and do not create standing authority', () => {
  const approvalHistory = Array.from({ length: 100 }, (_, index) => ({ tenantId: tenantA, id: index }))
  const result = evaluate(new AuthorityDelegationStore(), { approvalHistory })
  assert.equal(result.decision, AUTHORITY_DECISION.NEEDS_APPROVAL)
  assert.equal(result.ignoredNonAuthorityContext.approvalHistory, 100)
})

test('G5-9 an explicit grant operation creates exact scoped authority', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const grant = createGrant(store)
  const result = evaluate(store)
  assert.equal(grant.status, AUTHORITY_STATUS.GRANTED)
  assert.equal(result.decision, AUTHORITY_DECISION.ALLOWED)
  assert.equal(result.grant.id, grant.id)
})

test('G5-10 grant is attributable to the explicit authenticated founder', () => {
  const grant = createGrant(new AuthorityDelegationStore({ clock: clock() }))
  assert.deepEqual(grant.grantor, { actorId: tenantA, role: 'FOUNDER' })
  assert.equal(grant.decidedAt, grant.createdAt)
})

test('G5-11 unauthorized tenant worker cannot grant authority', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  assert.throws(() => createGrant(store, { actor: workerA }), /founder role required/)
  assert.equal(store.grants.length, 0)
})

test('G5-12 client-specific grant cannot authorize another client', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  const result = evaluate(store, { request: request({ scope: { level: 'CLIENT', clientId: 'acme' } }) })
  assert.equal(result.decision, AUTHORITY_DECISION.DENIED)
  assert.equal(result.reason, AUTHORITY_REASON.SCOPE_MISMATCH)
})

test('G5-13 client-specific grant cannot widen to company scope', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  const result = evaluate(store, { request: request({ scope: { level: 'COMPANY' } }) })
  assert.equal(result.decision, AUTHORITY_DECISION.DENIED)
})

test('G5-14 company-wide authority works only when explicitly company-wide', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store, { scope: { level: 'COMPANY' } })
  assert.equal(evaluate(store, { request: request({ scope: { level: 'COMPANY' } }) }).decision, AUTHORITY_DECISION.ALLOWED)
})

test('G5-15 one action cannot authorize another action', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  const result = evaluate(store, { request: request({ action: AUTHORITY_ACTION.APPLY_LATE_FEE, amountMinor: 100, currency: 'USD' }) })
  assert.equal(result.decision, AUTHORITY_DECISION.NEEDS_APPROVAL)
})

test('G5-16 reminder permission cannot authorize late-fee application', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  assert.notEqual(evaluate(store, { request: request({ action: AUTHORITY_ACTION.APPLY_LATE_FEE, amountMinor: 1, currency: 'USD' }) }).decision, AUTHORITY_DECISION.ALLOWED)
})

test('G5-17 amount-limited authority permits the exact limit', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store, { action: AUTHORITY_ACTION.SETTLE_INVOICE, limits: { maxAmountMinor: 50000, currency: 'USD' }, channel: null })
  const result = evaluate(store, { request: request({ action: AUTHORITY_ACTION.SETTLE_INVOICE, amountMinor: 50000, currency: 'USD' }) })
  assert.equal(result.decision, AUTHORITY_DECISION.ALLOWED)
  assert.equal(result.amountEvaluation, 'WITHIN_LIMIT')
})

test('G5-18 amount above the explicit limit is denied', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store, { action: AUTHORITY_ACTION.SETTLE_INVOICE, limits: { maxAmountMinor: 50000, currency: 'USD' }, channel: null })
  const result = evaluate(store, { request: request({ action: AUTHORITY_ACTION.SETTLE_INVOICE, amountMinor: 50001, currency: 'USD' }) })
  assert.equal(result.reason, AUTHORITY_REASON.AMOUNT_LIMIT_EXCEEDED)
})

test('G5-19 missing amount for an amount-bearing action fails closed', () => {
  const result = evaluate(new AuthorityDelegationStore(), { request: request({ action: AUTHORITY_ACTION.SETTLE_INVOICE }) })
  assert.equal(result.reason, AUTHORITY_REASON.AMOUNT_REQUIRED)
})

test('G5-20 channel-limited grant accepts its configured channel', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  assert.equal(evaluate(store).channelEvaluation, 'MATCH')
})

test('G5-21 channel-limited grant rejects a different channel', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  const result = evaluate(store, { request: request({ channel: 'SMS' }) })
  assert.equal(result.reason, AUTHORITY_REASON.CHANNEL_MISMATCH)
})

test('G5-22 time-limited grant governs inside its exact effective interval', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  assert.equal(evaluate(store, { asOf: '2026-09-30T23:59:59.999Z' }).decision, AUTHORITY_DECISION.ALLOWED)
})

test('G5-23 expired authority fails closed', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  const result = evaluate(store, { asOf: '2026-10-01T00:00:00.000Z' })
  assert.equal(result.decision, AUTHORITY_DECISION.DENIED)
  assert.equal(result.reason, AUTHORITY_REASON.EXPIRED)
})

test('G5-24 not-yet-effective authority fails closed', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  const result = evaluate(store, { asOf: '2026-08-31T23:59:59.999Z' })
  assert.equal(result.reason, AUTHORITY_REASON.NOT_YET_EFFECTIVE)
})

test('G5-25 conditional authority accepts exact condition satisfaction', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  assert.equal(evaluate(store).conditionEvaluation, 'MATCH')
})

test('G5-26 conditional authority rejects missing or different conditions', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  const result = evaluate(store, { request: request({ conditions: {} }) })
  assert.equal(result.reason, AUTHORITY_REASON.CONDITION_MISMATCH)
})

test('G5-27 ambiguous client identity fails closed', () => {
  const state = currentState()
  state.references[0] = { ...state.references[0], resolutionState: 'AMBIGUOUS' }
  const result = evaluate(new AuthorityDelegationStore(), { currentState: state })
  assert.equal(result.reason, AUTHORITY_REASON.ENTITY_AMBIGUOUS)
})

test('G5-28 unresolved client identity fails closed', () => {
  const state = currentState()
  state.references = state.references.filter((row) => !(row.kind === 'CLIENT' && row.id === 'atlas'))
  const result = evaluate(new AuthorityDelegationStore(), { currentState: state })
  assert.equal(result.reason, AUTHORITY_REASON.ENTITY_UNRESOLVED)
})

test('G5-29 malformed persisted grant is invalidated and cannot govern', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const grant = createGrant(store)
  const malformed = { ...grant, grantee: { type: 'DW', id: 'OTHER' } }
  const state = deriveAuthorityState({ actor: founderA, tenantId: tenantA, grants: [malformed], currentState: currentState(), asOf: '2026-09-15T00:00:00.000Z' })
  assert.equal(state.currentGrants.length, 0)
  assert.equal(state.invalidatedGrants[0].derivedReason, AUTHORITY_REASON.MALFORMED_GRANT)
})

test('G5-30 unknown action fails closed', () => {
  const result = evaluate(new AuthorityDelegationStore(), { request: request({ action: 'DO_ANYTHING' }) })
  assert.equal(result.decision, AUTHORITY_DECISION.UNKNOWN)
  assert.equal(result.reason, AUTHORITY_REASON.UNKNOWN_ACTION)
})

test('G5-31 revocation removes authority immediately', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const grant = createGrant(store)
  store.revokeAuthority({ actor: founderA, tenantId: tenantA, grantId: grant.id, idempotencyKey: 'revoke-1', reason: 'Founder revoked' })
  assert.equal(evaluate(store).reason, AUTHORITY_REASON.AUTHORITY_REVOKED)
})

test('G5-32 revoked grant and revocation event remain auditable', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const grant = createGrant(store)
  store.revokeAuthority({ actor: founderA, tenantId: tenantA, grantId: grant.id, idempotencyKey: 'revoke-1', reason: 'Founder revoked' })
  const history = store.readHistory({ actor: founderA, tenantId: tenantA })
  assert.equal(history.grants.length, 1)
  assert.equal(history.grants[0].status, AUTHORITY_STATUS.REVOKED)
  assert.equal(history.revocations.length, 1)
})

test('G5-33 valid explicit successor governs and predecessor is superseded history', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const first = createGrant(store, { idempotencyKey: 'd1' })
  const second = createGrant(store, { idempotencyKey: 'd2', supersedesGrantId: first.id, conditions: { daysOverdue: 14 } })
  const state = deriveAuthorityState({ actor: founderA, tenantId: tenantA, grants: store.grants, currentState: currentState(), asOf: '2026-09-15T00:00:00.000Z' })
  assert.deepEqual(state.currentGrants.map((row) => row.id), [second.id])
  assert.deepEqual(state.supersededGrants.map((row) => row.grant.id), [first.id])
})

test('G5-34 invalid explicit successor never resurrects predecessor', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const first = createGrant(store, { idempotencyKey: 'd1' })
  const second = createGrant(store, { idempotencyKey: 'd2', supersedesGrantId: first.id })
  const invalidSecond = { ...second, reviewedState: null }
  const state = deriveAuthorityState({ actor: founderA, tenantId: tenantA, grants: [first, invalidSecond], currentState: currentState(), asOf: '2026-09-15T00:00:00.000Z' })
  assert.equal(state.currentGrants.length, 0)
  assert.equal(state.supersededGrants[0].grant.id, first.id)
  assert.equal(state.invalidatedGrants[0].grant.id, second.id)
})

test('G5-35 D1 to D2 to D3 leaves only valid chain tip current in deterministic order', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const d1 = createGrant(store, { idempotencyKey: 'd1' })
  const d2 = createGrant(store, { idempotencyKey: 'd2', supersedesGrantId: d1.id })
  const d3 = createGrant(store, { idempotencyKey: 'd3', supersedesGrantId: d2.id })
  const state = deriveAuthorityState({ actor: founderA, tenantId: tenantA, grants: [...store.grants].reverse(), currentState: currentState(), asOf: '2026-09-15T00:00:00.000Z' })
  assert.deepEqual(state.currentGrants.map((row) => row.id), [d3.id])
  assert.deepEqual(state.supersededGrants.map((row) => row.grant.id), [d1.id, d2.id])
})

test('G5-36 identical explicit grant retry is idempotent', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const first = createGrant(store, { idempotencyKey: 'retry' })
  const replay = createGrant(store, { idempotencyKey: 'retry' })
  assert.equal(replay, first)
  assert.equal(store.grants.length, 1)
})

test('G5-37 idempotency-key reuse with different semantics is rejected and audited', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store, { idempotencyKey: 'retry' })
  assert.throws(() => createGrant(store, { idempotencyKey: 'retry', channel: 'SMS' }), /idempotency conflict/)
  assert.equal(store.attempts.at(-1).outcome, 'REJECTED_IDEMPOTENCY_CONFLICT')
})

test('G5-38 distinct explicit founder revision remains a distinct audit record', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const first = createGrant(store, { idempotencyKey: 'd1' })
  const second = createGrant(store, { idempotencyKey: 'd2', supersedesGrantId: first.id })
  assert.equal(store.grants.length, 2)
  assert.equal(second.revision, 2)
})

test('G5-39 provenance survives the durable-store round trip', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const grant = createGrant(store)
  assert.deepEqual(store.readHistory({ actor: founderA, tenantId: tenantA }).grants[0].provenance, grant.provenance)
})

test('G5-40 reviewed G3/G4 fingerprints survive the durable-store round trip', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const grant = createGrant(store, { reviewedState: { reviewedAt: '2026-09-01T11:00:00.000Z', dependencies: [
    { tenantId: tenantA, kind: 'POLICY', id: 'reminder-policy:atlas', fingerprint: fingerprintA },
    { tenantId: tenantA, kind: 'OPERATING_MODEL', id: 'operating-model-a', fingerprint: fingerprintA },
  ] } })
  assert.deepEqual(store.readHistory({ actor: founderA, tenantId: tenantA }).grants[0].reviewedState, grant.reviewedState)
})

test('G5-41 material relevant policy fingerprint change makes authority stale', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  const state = currentState()
  state.references = state.references.map((row) => row.kind === 'POLICY' ? { ...row, fingerprint: fingerprintB } : row)
  const result = evaluate(store, { currentState: state })
  assert.equal(result.decision, AUTHORITY_DECISION.STALE)
  assert.equal(result.reason, AUTHORITY_REASON.REVIEWED_DEPENDENCY_CHANGED)
})

test('G5-42 material relevant operating-model change makes authority stale', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store, { reviewedState: { reviewedAt: '2026-09-01T11:00:00.000Z', dependencies: [
    { tenantId: tenantA, kind: 'OPERATING_MODEL', id: 'operating-model-a', fingerprint: fingerprintA },
  ] } })
  const state = currentState()
  state.references = state.references.map((row) => row.kind === 'OPERATING_MODEL' ? { ...row, fingerprint: fingerprintB } : row)
  assert.equal(evaluate(store, { currentState: state }).decision, AUTHORITY_DECISION.STALE)
})

test('G5-43 unrelated Company Brain change neither widens nor invalidates authority', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  const state = currentState(tenantA, { unrelatedKnowledgeVersion: 999 })
  state.references.push({ tenantId: tenantA, kind: 'SOURCE_VERSION', id: 'unrelated', active: false, resolutionState: 'RESOLVED' })
  assert.equal(evaluate(store, { currentState: state }).decision, AUTHORITY_DECISION.ALLOWED)
})

test('G5-44 materially required source revocation makes authority stale', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store, { provenance: [{ tenantId: tenantA, kind: 'SOURCE_VERSION', id: 'source-reminder', requiredCurrent: true }] })
  const state = currentState()
  state.references = state.references.map((row) => row.kind === 'SOURCE_VERSION' && row.id === 'source-reminder' ? { ...row, active: false } : row)
  assert.equal(evaluate(store, { currentState: state }).reason, AUTHORITY_REASON.REVIEWED_DEPENDENCY_REVOKED)
})

test('G5-45 Tenant B cannot read Tenant A grants', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  assert.equal(store.readHistory({ actor: founderB, tenantId: tenantB }).grants.length, 0)
})

test('G5-46 Tenant B cannot create a Tenant A grant', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  assert.throws(() => createGrant(store, { actor: founderB, tenantId: tenantA }), /actor tenant mismatch/)
})

test('G5-47 Tenant A cannot revoke Tenant B grant', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const grantB = createGrant(store, { actor: founderB, tenantId: tenantB, state: currentState(tenantB) })
  assert.throws(() => store.revokeAuthority({ actor: founderA, tenantId: tenantA, grantId: grantB.id, idempotencyKey: 'cross-revoke', reason: 'No' }), /tenant mismatch/)
})

test('G5-48 cross-tenant client scope is rejected', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const state = currentState(tenantA)
  state.references = state.references.filter((row) => !(row.kind === 'CLIENT' && row.id === 'atlas'))
  state.references.push({ tenantId: tenantB, kind: 'CLIENT', id: 'atlas', active: true, resolutionState: 'RESOLVED' })
  assert.throws(() => createGrant(store, { state }), /ENTITY_UNRESOLVED/)
})

test('G5-49 cross-tenant provenance is rejected', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  assert.throws(() => createGrant(store, { provenance: [{ tenantId: tenantB, kind: 'CLAIM', id: 'claim-reminder' }] }), /provenance tenant mismatch/)
})

test('G5-50 provider capability never implies DW authority', () => {
  const result = evaluate(new AuthorityDelegationStore(), { providerCapabilities: [{ provider: 'GMAIL', canSend: true }] })
  assert.equal(result.decision, AUTHORITY_DECISION.NEEDS_APPROVAL)
})

test('G5-51 Ask DW authority seam is deeply frozen and read-only', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  const context = toAskDwAuthorityContext({ actor: founderA, tenantId: tenantA, store, currentState: currentState(), asOf: '2026-09-15T00:00:00.000Z' })
  assert.equal(context.consumer, 'ASK_DW')
  assert.equal(context.boundaries.canGrant, false)
  assert.throws(() => context.currentAuthorityGrants.push({}))
})

test('G5-52 DW Intelligence seam cannot self-grant', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const context = toDwIntelligenceAuthorityContext({ actor: founderA, tenantId: tenantA, store, currentState: currentState(), asOf: '2026-09-15T00:00:00.000Z' })
  assert.equal(context.consumer, 'DW_INTELLIGENCE')
  assert.equal(context.boundaries.modelOutputCanGrant, false)
  assert.equal(Object.hasOwn(context, 'grantAuthority'), false)
})

test('G5-53 evaluator is deterministic for the same exact state', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  assert.deepEqual(evaluate(store), evaluate(store))
})

test('G5-54 authority evaluation has no financial mutation side effects', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  const canonicalMoney = { invoiceBalanceMinor: 10000, paid: false }
  const before = structuredClone(canonicalMoney)
  const result = evaluate(store)
  assert.deepEqual(canonicalMoney, before)
  assert.equal(result.canonicalMoneyMutated, false)
})

test('G5-55 grant and revoke operations do not mutate canonical money truth', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const canonicalMoney = Object.freeze({ balance: 100 })
  const grant = createGrant(store)
  store.revokeAuthority({ actor: founderA, tenantId: tenantA, grantId: grant.id, idempotencyKey: 'revoke', reason: 'Stop' })
  assert.deepEqual(canonicalMoney, { balance: 100 })
})

test('G5-56 ALLOWED result still performs no execution', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store)
  const result = evaluate(store)
  assert.equal(result.decision, AUTHORITY_DECISION.ALLOWED)
  assert.equal(result.executed, false)
})

test('G5-57 revoked successor never falls back to predecessor, repetition, or confidence', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const first = createGrant(store, { idempotencyKey: 'd1' })
  const second = createGrant(store, { idempotencyKey: 'd2', supersedesGrantId: first.id })
  store.revokeAuthority({ actor: founderA, tenantId: tenantA, grantId: second.id, idempotencyKey: 'revoke-d2', reason: 'Stop chain' })
  const result = evaluate(store, { approvalHistory: Array(100).fill({}), modelOutput: { confidence: 1 } })
  assert.equal(result.reason, AUTHORITY_REASON.AUTHORITY_REVOKED)
})

test('G5-58 missing material scope dimension is not treated as a wildcard', () => {
  const result = evaluate(new AuthorityDelegationStore(), { request: request({ scope: { level: 'CLIENT' } }) })
  assert.equal(result.decision, AUTHORITY_DECISION.UNKNOWN)
  assert.equal(result.reason, AUTHORITY_REASON.SCOPE_MALFORMED)
})

test('G5-59 policy applicability and authority result remain independently observable', () => {
  const policy = { status: 'RESOLVED', value: '2%' }
  const authority = evaluate(new AuthorityDelegationStore(), { resolvedPolicy: policy })
  assert.equal(policy.value, '2%')
  assert.equal(authority.decision, AUTHORITY_DECISION.NEEDS_APPROVAL)
})

test('G5-60 ALLOWED exposes exact grant lineage, revision, provenance, and reason', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const grant = createGrant(store)
  const result = evaluate(store)
  assert.equal(result.reason, AUTHORITY_REASON.EXPLICIT_GRANT_MATCHED)
  assert.equal(result.grant.id, grant.id)
  assert.equal(result.grantRevision, 1)
  assert.deepEqual(result.provenance, grant.provenance)
})

test('G5-61 negative outcomes include deterministic reason codes', () => {
  const result = evaluate(new AuthorityDelegationStore())
  assert.equal(result.decision, AUTHORITY_DECISION.NEEDS_APPROVAL)
  assert.equal(result.reason, AUTHORITY_REASON.AUTHORITY_UNCONFIGURED)
})

test('G5-62 historical revoked and superseded records are never deleted', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const first = createGrant(store, { idempotencyKey: 'd1' })
  const second = createGrant(store, { idempotencyKey: 'd2', supersedesGrantId: first.id })
  store.revokeAuthority({ actor: founderA, tenantId: tenantA, grantId: second.id, idempotencyKey: 'revoke-d2', reason: 'Stop' })
  assert.deepEqual(store.grants.map((row) => row.id), [first.id, second.id])
  assert.equal(store.revocations.length, 1)
})

test('G5-63 authority proposal remains inert until the distinct grant path is invoked', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const proposal = createG5AuthorityProposal({ actor: founderA, tenantId: tenantA, action: AUTHORITY_ACTION.SEND_REMINDER, scope: { level: 'CLIENT', clientId: 'atlas' }, proposedConfiguration: { channel: 'EMAIL' }, evidence: { approvals: 100 }, createdAt: '2026-09-01T10:00:00.000Z' })
  store.recordProposal({ actor: founderA, tenantId: tenantA, proposal })
  const result = evaluate(store, { proposals: store.proposals })
  assert.equal(proposal.authorityGranted, false)
  assert.equal(result.decision, AUTHORITY_DECISION.NEEDS_APPROVAL)
})

test('G5-64 authenticated external agent may request but cannot grant authority', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  assert.throws(() => createGrant(store, { actor: externalA }), /founder role required/)
})

test('G5-65 explicit grant retaining founder approval requirement returns NEEDS_APPROVAL', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store, { approvalRequirement: APPROVAL_REQUIREMENT.FOUNDER })
  const result = evaluate(store)
  assert.equal(result.decision, AUTHORITY_DECISION.NEEDS_APPROVAL)
  assert.equal(result.reason, AUTHORITY_REASON.EXPLICIT_APPROVAL_REQUIRED)
})

test('G5-66 amount currency must match exactly', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store, { action: AUTHORITY_ACTION.ISSUE_REFUND, limits: { maxAmountMinor: 1000, currency: 'USD' }, channel: null })
  const result = evaluate(store, { request: request({ action: AUTHORITY_ACTION.ISSUE_REFUND, amountMinor: 1000, currency: 'EUR' }) })
  assert.equal(result.reason, AUTHORITY_REASON.CURRENCY_MISMATCH)
})

test('G5-67 overlapping independent current grants fail closed as ambiguous', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store, { idempotencyKey: 'parallel-1' })
  createGrant(store, { idempotencyKey: 'parallel-2' })
  const result = evaluate(store)
  assert.equal(result.decision, AUTHORITY_DECISION.DENIED)
  assert.equal(result.reason, AUTHORITY_REASON.AMBIGUOUS_CURRENT_GRANTS)
})

test('G5-68 read model exposes current and historical states without mutation capabilities', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const first = createGrant(store, { idempotencyKey: 'd1' })
  createGrant(store, { idempotencyKey: 'd2', supersedesGrantId: first.id })
  const model = buildAuthorityReadModel({ actor: founderA, tenantId: tenantA, store, currentState: currentState(), asOf: '2026-09-15T00:00:00.000Z' })
  assert.equal(model.currentAuthorityGrants.length, 1)
  assert.equal(model.supersededAuthority.length, 1)
  assert.equal(model.boundaries.canExecute, false)
})

test('G5-69 entity-specific grant matches only the exact resolved entity', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  createGrant(store, { scope: { level: 'ENTITY', entityType: 'INVOICE', entityId: 'invoice-1' } })
  const exact = evaluate(store, { request: request({ scope: { level: 'ENTITY', entityType: 'INVOICE', entityId: 'invoice-1' } }) })
  assert.equal(exact.decision, AUTHORITY_DECISION.ALLOWED)
  const other = evaluate(store, { request: request({ scope: { level: 'CLIENT', clientId: 'atlas' } }) })
  assert.equal(other.reason, AUTHORITY_REASON.SCOPE_MISMATCH)
})

test('G5-70 grant store refuses any call that is not the explicit grant operation', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  assert.throws(() => createGrant(store, { explicitGrant: false }), /explicit authority-grant operation required/)
  assert.equal(store.grants.length, 0)
})

test('G5-71 unknown same-tenant provenance fails closed before persistence', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  assert.throws(() => createGrant(store, { provenance: [{ tenantId: tenantA, kind: 'CLAIM', id: 'unknown-claim' }] }), /REVIEWED_DEPENDENCY_MISSING/)
})

test('G5-72 revocation idempotency key cannot be reused for different semantics', () => {
  const store = new AuthorityDelegationStore({ clock: clock() })
  const grant = createGrant(store)
  store.revokeAuthority({ actor: founderA, tenantId: tenantA, grantId: grant.id, idempotencyKey: 'revoke-once', reason: 'First reason' })
  assert.throws(() => store.revokeAuthority({ actor: founderA, tenantId: tenantA, grantId: grant.id, idempotencyKey: 'revoke-once', reason: 'Different reason' }), /revocation idempotency conflict/)
})

test('G5-73 cross-tenant evidence cannot enter even an inert authority proposal', () => {
  assert.throws(() => createG5AuthorityProposal({
    actor: founderA,
    tenantId: tenantA,
    action: AUTHORITY_ACTION.SEND_REMINDER,
    scope: { level: 'CLIENT', clientId: 'atlas' },
    evidence: { references: [{ tenantId: tenantB, kind: 'CLAIM', id: 'foreign-claim' }] },
    createdAt: '2026-09-01T10:00:00.000Z',
  }), /proposal evidence tenant mismatch/)
})
