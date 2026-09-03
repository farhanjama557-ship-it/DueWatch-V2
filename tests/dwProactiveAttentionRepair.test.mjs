/**
 * G8-CP2 repair — scoped attention and receipt-grounded proactive output.
 *
 * Eight load-bearing gaps found by independent review of bd9a424. Each is
 * reproduced here first; the assertions describe the required behaviour, so
 * they fail against the pre-repair tree.
 *
 * The two that matter most are not subtle:
 *
 *   - buildDwAttention validated only that tenantId was non-empty, so a
 *     projection belonging to one tenant could be labelled as another's.
 *   - hasValidReceipt accepted any object with status 'succeeded' — a value
 *     the real execution claim vocabulary (in_flight | sent | send_failed |
 *     uncertain) never produces — and then treated EVERY completed-action
 *     sentence in the narrative as proven by that one receipt.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAskDwCompanyBrainContext } from '../src/lib/dwIntelligence/askDwCompanyBrainContext.js'
import { buildDwGovernanceContext } from '../src/lib/dwIntelligence/dwGovernanceContext.js'
import {
  DW_ATTENTION_REASON,
  buildDwAttention,
  dwCanSayNothingNeedsAttention,
} from '../src/lib/dwIntelligence/dwAttentionPriority.js'
import {
  DW_PROACTIVE_ISSUE,
  enforceDwProactiveGrounding,
} from '../src/lib/dwIntelligence/dwProactiveGrounding.js'
import { projectNeedsYouCommandReadModel } from '../src/lib/dwIntelligence/phase2bCommandModels.js'
import { buildIdempotencyKey } from '../supabase/functions/_shared/executionClaim.js'

const A = 'tenant-a'
const B = 'tenant-b'
const AS_OF = '2026-08-24T12:00:00Z'

function needsYouItem(overrides = {}) {
  return {
    runId: 'run-1', invoiceId: 'inv-a', clientId: 'client-a', state: 'APPROVAL',
    balance: 10000, daysOverdue: 60, why: [],
    authority: { policyAuthorized: true, actual: 'REQUIRES_APPROVAL', canActAutomatically: false },
    ...overrides,
  }
}

const needsYou = (items, userId = A) => ({ userId, count: items.length, items })

function brainReadModel({ items = [], grants = [], tenantId = A } = {}) {
  return {
    kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_READ_MODEL_V0',
    tenantId, generatedAt: AS_OF, items,
    summary: { understandingReviewed: items.length, needsReview: 0, conflictsUnresolved: 0, changedSinceReview: 0 },
    authority: {
      evaluatedAt: AS_OF, activeGrantCount: grants.length, proposalCount: 0,
      noStandingAuthorityConfigured: grants.length === 0,
      currentAuthorityGrants: grants, proposedAuthority: [],
      revokedAuthority: [], staleAuthority: [], supersededAuthority: [], invalidatedAuthority: [],
    },
    readiness: null,
  }
}

const brainContext = (model, tenantId = A) =>
  buildAskDwCompanyBrainContext({ readModel: model, tenantId })

const grant = (o = {}) => ({
  id: 'g-1', action: 'SEND_REMINDER', scope: { level: 'CLIENT', clientId: 'client-a' },
  channel: 'EMAIL', approvalRequirement: 'NONE', conditions: {},
  effectiveWindow: { effectiveFrom: '2026-08-01T00:00:00Z', expiresAt: null },
  status: 'GRANTED', revision: 1, decidedAt: '2026-08-01T00:00:00Z', ...o,
})

// ── 1 · tenant isolation is nested, not just a label ────────────────────────

test('CP2R-1 attention fails closed when any nested input belongs to another tenant', () => {
  const ctxA = brainContext(brainReadModel())
  const ctxB = brainContext(brainReadModel({ tenantId: B }), B)
  const govA = buildDwGovernanceContext({ tenantId: A, companyBrainContext: ctxA })
  const govB = buildDwGovernanceContext({ tenantId: B, companyBrainContext: ctxB })

  const cases = [
    ['A · foreign needs-you projection', {
      tenantId: A, needsYouReadModel: needsYou([needsYouItem()], B), companyBrainContext: ctxA, governance: govA,
    }],
    ['B · foreign Company Brain context', {
      tenantId: A, needsYouReadModel: needsYou([needsYouItem()]), companyBrainContext: ctxB, governance: govA,
    }],
    ['C · foreign governance envelope', {
      tenantId: A, needsYouReadModel: needsYou([needsYouItem()]), companyBrainContext: ctxA, governance: govB,
    }],
    ['E · valid A read model + foreign Brain', {
      tenantId: A, needsYouReadModel: needsYou([needsYouItem()]), companyBrainContext: ctxB, governance: null,
    }],
    ['F · valid A Brain + foreign needs-you', {
      tenantId: A, needsYouReadModel: needsYou([needsYouItem()], B), companyBrainContext: ctxA, governance: null,
    }],
  ]
  for (const [label, args] of cases) {
    assert.throws(() => buildDwAttention({ ...args, limit: 10 }), /tenant/i, label)
  }
})

test('CP2R-1b same client and invoice ids in two tenants never merge', () => {
  // D · identical names across tenants. Each tenant's own call succeeds and
  // sees only its own rows; neither can be fed the other's.
  const forA = buildDwAttention({
    tenantId: A, needsYouReadModel: needsYou([needsYouItem({ clientId: 'atlas', invoiceId: 'inv-1' })]),
    companyBrainContext: brainContext(brainReadModel()), limit: 10,
  })
  const forB = buildDwAttention({
    tenantId: B, needsYouReadModel: needsYou([needsYouItem({ clientId: 'atlas', invoiceId: 'inv-1' })], B),
    companyBrainContext: brainContext(brainReadModel({ tenantId: B }), B), limit: 10,
  })
  assert.equal(forA.tenantId, A)
  assert.equal(forB.tenantId, B)
  assert.equal(forA.items.length, 1)
  assert.equal(forB.items.length, 1)
  // Crossing them is refused rather than relabelled.
  assert.throws(() => buildDwAttention({
    tenantId: A, needsYouReadModel: needsYou([needsYouItem({ clientId: 'atlas' })], B),
    companyBrainContext: brainContext(brainReadModel()), limit: 10,
  }), /tenant/i)
})

// ── 2 · a receipt must prove the exact claim ────────────────────────────────

const TRUTH = { canonicalFacts: { balance: 10000, daysOverdue: 60, paid: false } }

/**
 * The real receipt shape: userId, invoiceId, ruleId, actionType, and the
 * idempotency key that exact identity derives. Ids must be uuid-shaped because
 * buildIdempotencyKey refuses anything else.
 */
const IDS = {
  userId: '11111111-1111-4111-8111-111111111111',
  invoiceId: '22222222-2222-4222-8222-222222222222',
  ruleId: '33333333-3333-4333-8333-333333333333',
}
const receipt = (o = {}) => {
  const identity = { ...IDS, actionType: 'send_reminder', ...o }
  return { ...identity, idempotencyKey: buildIdempotencyKey(identity), status: 'sent', ...o }
}

function ground(narrative, extra = {}) {
  return enforceDwProactiveGrounding({
    narrative, truthLock: TRUTH,
    governance: buildDwGovernanceContext({ tenantId: A, companyBrainContext: brainContext(brainReadModel()) }),
    executionReceipts: [],
    attention: buildDwAttention({
      tenantId: A, needsYouReadModel: needsYou([needsYouItem()]),
      companyBrainContext: brainContext(brainReadModel()), limit: 10,
    }),
    ...extra,
  })
}

test('CP2R-2 a receipt only proves its own tenant, invoice, client and action', () => {
  const claim = { tenantId: IDS.userId, invoiceId: IDS.invoiceId, ruleId: IDS.ruleId, action: 'send_reminder' }
  const mismatches = [
    ['another invoice', receipt({ invoiceId: '55555555-5555-4555-8555-555555555555' })],
    ['another tenant', receipt({ userId: '66666666-6666-4666-8666-666666666666' })],
    ['another rule', receipt({ ruleId: '77777777-7777-4777-8777-777777777777' })],
    ['another action', receipt({ actionType: 'issue_refund' })],
    ['an in-flight claim', receipt({ status: 'in_flight' })],
    ['a failed send', receipt({ status: 'send_failed' })],
    ['an uncertain send', receipt({ status: 'uncertain' })],
  ]
  for (const [label, bad] of mismatches) {
    const result = ground({ headline: 'DW sent the reminder to Atlas.' },
      { executionReceipts: [bad], executionClaim: claim })
    assert.equal(result.blocked, true, label)
    assert.ok(result.issues.some((i) => i.code === DW_PROACTIVE_ISSUE.EXECUTION_WITHOUT_RECEIPT), label)
  }
  // The exactly matching receipt, in the real vocabulary, is accepted.
  const ok = ground({ headline: 'DW sent the reminder to Atlas.' },
    { executionReceipts: [receipt()], executionClaim: claim })
  assert.equal(ok.blocked, false, 'a matching sent receipt proves its own claim')
})

test('CP2R-2b one receipt never covers a second, different execution claim', () => {
  const claim = { tenantId: IDS.userId, invoiceId: IDS.invoiceId, ruleId: IDS.ruleId, action: 'send_reminder' }
  const result = ground(
    { headline: 'DW sent the reminder to Atlas.', summary: 'DW refunded the balance.' },
    { executionReceipts: [receipt()], executionClaim: claim },
  )
  assert.equal(result.blocked, true, 'a send receipt cannot prove a refund')
  assert.ok(result.issues.some((i) => i.code === DW_PROACTIVE_ISSUE.EXECUTION_WITHOUT_RECEIPT))

  // And within ONE sentence asserting two actions, every action must be
  // covered — a send receipt does not license the refund riding alongside it.
  const combined = ground(
    { headline: 'DW sent the reminder and refunded the balance.' },
    { executionReceipts: [receipt()], executionClaim: claim },
  )
  assert.equal(combined.blocked, true,
    'one receipt cannot cover two different actions in the same sentence')
  assert.ok(combined.issues.some((i) => i.code === DW_PROACTIVE_ISSUE.EXECUTION_WITHOUT_RECEIPT))
})

test('CP2R-2c impostors are still refused, and succeeded is not a real status', () => {
  const claim = { tenantId: IDS.userId, invoiceId: IDS.invoiceId, ruleId: IDS.ruleId, action: 'send_reminder' }
  const impostors = [
    ['a recommendation', { action: 'send_reminder', ruleId: 'rule-1' }],
    ['a staged action', { action: 'send_reminder', status: 'STAGED' }],
    ['a grant', { grantId: 'g-1', action: 'SEND_REMINDER', status: 'GRANTED' }],
    ['provider capability', { provider: 'resend', capability: 'send', supported: true }],
    // 'succeeded' is not in the real claim vocabulary at all.
    ['an invented succeeded status', { userId: A, invoiceId: 'inv-a', actionType: 'send_reminder', status: 'succeeded' }],
  ]
  for (const [label, impostor] of impostors) {
    const result = ground({ headline: 'DW sent the reminder.' },
      { executionReceipts: [impostor], executionClaim: claim })
    assert.equal(result.blocked, true, label)
  }
})

// ── 3 · operational policy is not G5 authority ──────────────────────────────

test('CP2R-3 Phase 2B operational policy is never reported as a missing G5 grant', () => {
  // CASE A — operational policy says no, but a real G5 grant exists. Saying
  // "DW cannot act without an explicit grant" would be false.
  const withGrant = brainContext(brainReadModel({ grants: [grant()] }))
  const caseA = buildDwAttention({
    tenantId: A,
    needsYouReadModel: needsYou([needsYouItem({
      state: 'UNCERTAIN',
      authority: { policyAuthorized: false, actual: 'NOT_GRANTED', canActAutomatically: false },
    })]),
    companyBrainContext: withGrant,
    governance: buildDwGovernanceContext({ tenantId: A, companyBrainContext: withGrant }),
    limit: 10,
  })
  assert.ok(
    !caseA.items.some((i) => i.reason === DW_ATTENTION_REASON.BLOCKED_ON_MISSING_AUTHORITY),
    'operational policy denial is not evidence that a standing grant is missing',
  )

  // CASE B — an operational recommendation exists but no G5 grant does. The
  // operational rule must not read as permission.
  const noGrant = brainContext(brainReadModel({ grants: [] }))
  const caseB = buildDwAttention({
    tenantId: A,
    needsYouReadModel: needsYou([needsYouItem({
      state: 'UNCERTAIN',
      recommendation: { action: 'send_reminder', ruleId: 'rule-1' },
      authority: { policyAuthorized: true, actual: 'REQUIRES_APPROVAL', canActAutomatically: false },
    })]),
    companyBrainContext: noGrant,
    governance: buildDwGovernanceContext({ tenantId: A, companyBrainContext: noGrant }),
    limit: 10,
  })
  for (const item of caseB.items) {
    assert.equal(item.authorityImpact, 'NONE')
    assert.notEqual(item.blockedBy, 'MISSING_AUTHORITY',
      'an operational recommendation is not a G5 permission and its absence is not a missing grant')
  }
})

// ── 4 · absence is degraded, never complete ────────────────────────────────

test('CP2R-4 a missing Company Brain is unknown, not complete', () => {
  const omitted = buildDwAttention({ tenantId: A, needsYouReadModel: needsYou([]), limit: 10 })
  assert.equal(omitted.complete, false, 'an absent Brain read is not a complete read')
  assert.ok(omitted.degradedInputs.includes('COMPANY_BRAIN_UNAVAILABLE'))
  assert.equal(dwCanSayNothingNeedsAttention(omitted), false)

  const explicitNull = buildDwAttention({
    tenantId: A, needsYouReadModel: needsYou([]), companyBrainContext: null, limit: 10,
  })
  assert.equal(explicitNull.complete, false)
  assert.equal(dwCanSayNothingNeedsAttention(explicitNull), false)
})

test('CP2R-4b all-clear fails closed when governance or attention is missing', () => {
  const quiet = buildDwAttention({
    tenantId: A, needsYouReadModel: needsYou([]),
    companyBrainContext: brainContext(brainReadModel()), limit: 10,
  })
  const gov = buildDwGovernanceContext({ tenantId: A, companyBrainContext: brainContext(brainReadModel()) })
  const narrative = { headline: 'Nothing needs your attention.' }

  for (const [label, extra] of [
    ['governance missing', { governance: null, attention: quiet }],
    ['attention missing', { governance: gov, attention: null }],
    ['both missing', { governance: null, attention: null }],
  ]) {
    const result = enforceDwProactiveGrounding({ narrative, truthLock: TRUTH, executionReceipts: [], ...extra })
    assert.equal(result.blocked, true, label)
    assert.ok(result.issues.some((i) => i.code === DW_PROACTIVE_ISSUE.ALL_CLEAR_WHILE_DEGRADED), label)
  }

  // Complete inputs with an empty queue may say it.
  const allowed = enforceDwProactiveGrounding({
    narrative, truthLock: TRUTH, governance: gov, attention: quiet, executionReceipts: [],
  })
  assert.equal(allowed.blocked, false)
})

// ── 5 · wired into the real proactive path ─────────────────────────────────

test('CP2R-5 the proactive command read model consumes the shared primitive', () => {
  const ctx = brainContext(brainReadModel())
  const model = projectNeedsYouCommandReadModel({
    userId: A,
    cases: [],
    companyBrainContext: ctx,
    governance: buildDwGovernanceContext({ tenantId: A, companyBrainContext: ctx }),
  })
  assert.ok(model.attention, 'the proactive read model carries the shared attention result')
  assert.equal(model.attention.schemaVersion, 'DW_ATTENTION_V0')
  assert.equal(model.attention.tenantId, A)
  assert.equal(model.executionAvailable, false)
  assert.equal(model.authorityCanBeGrantedHere, false)

  // Without a Company Brain read it degrades rather than claiming completeness.
  const degraded = projectNeedsYouCommandReadModel({ userId: A, cases: [] })
  assert.equal(degraded.attention.complete, false)
})

// ── 6 · urgency needs a typed severity, not any attention item ──────────────

test('CP2R-6 an ordinary attention reason cannot justify emergency language', () => {
  const model = brainReadModel({
    items: [{
      reviewKey: 'u-1', category: 'POLICY', itemType: 'UNDERSTANDING', subject: 'late fees',
      scope: { level: 'COMPANY' }, clientId: null, reviewStatus: 'PENDING',
      conflictStatus: 'NONE', changedSinceReview: false, supportingSourceRevoked: false,
      why: 'x', evidence: [], proposedValue: {},
    }],
  })
  const ctx = brainContext(model)
  const awaiting = buildDwAttention({
    tenantId: A, needsYouReadModel: needsYou([]), companyBrainContext: ctx,
    governance: buildDwGovernanceContext({ tenantId: A, companyBrainContext: ctx }), limit: 10,
  })
  assert.equal(awaiting.items[0].reason, DW_ATTENTION_REASON.AWAITING_REVIEW)

  for (const headline of ['EMERGENCY - act immediately.', 'This is critical.', 'Urgent: act right away.']) {
    const result = enforceDwProactiveGrounding({
      narrative: { headline }, truthLock: TRUTH,
      governance: buildDwGovernanceContext({ tenantId: A, companyBrainContext: ctx }),
      attention: awaiting, executionReceipts: [],
    })
    assert.equal(result.blocked, true, headline)
    assert.ok(result.issues.some((i) => i.code === DW_PROACTIVE_ISSUE.UNSUPPORTED_URGENCY), headline)
  }

  // The deterministic alternative is always sayable.
  const plain = enforceDwProactiveGrounding({
    narrative: { headline: 'This needs your attention.' }, truthLock: TRUTH,
    governance: buildDwGovernanceContext({ tenantId: A, companyBrainContext: ctx }),
    attention: awaiting, executionReceipts: [],
  })
  assert.equal(plain.blocked, false)
})

// ── 7 · a promise claim must match the admitted promise state ──────────────

test('CP2R-7 promise language must match the admitted promise status', () => {
  const gov = buildDwGovernanceContext({ tenantId: A, companyBrainContext: brainContext(brainReadModel()) })
  const withPromise = (status) => ({
    canonicalFacts: { balance: 10000, daysOverdue: 60, paid: false },
    arState: { promise: { status } },
  })
  const attn = buildDwAttention({
    tenantId: A, needsYouReadModel: needsYou([needsYouItem()]),
    companyBrainContext: brainContext(brainReadModel()), limit: 10,
  })
  const check = (headline, truthLock) => enforceDwProactiveGrounding({
    narrative: { headline }, truthLock, governance: gov, attention: attn, executionReceipts: [],
  })

  // A kept promise cannot be narrated as broken.
  assert.equal(check('Atlas broke its promise.', withPromise('FULFILLED')).blocked, true)
  // Nor can an active one.
  assert.equal(check('Their promise was broken.', withPromise('CONFIRMED')).blocked, true)
  assert.equal(check('Their promise was broken.', withPromise('PROPOSED')).blocked, true)
  // An unverified claim is not an admitted promise.
  assert.equal(check('Atlas promised to pay.', withPromise('CLAIMED_UNVERIFIED')).blocked, true)
  // A genuinely broken promise may be described.
  assert.equal(check('Atlas broke its promise.', withPromise('BROKEN')).blocked, false)
  // And a confirmed promise may be described as a promise.
  assert.equal(check('Atlas promised to pay.', withPromise('CONFIRMED')).blocked, false)
})

// ── 8 · dedupe on current state, not merely on the same reason ──────────────

test('CP2R-8 one case interrupts the founder once, at its current state', () => {
  const older = needsYouItem({ runId: 'run-1', state: 'APPROVAL', at: '2026-08-20T00:00:00Z' })
  const newer = needsYouItem({ runId: 'run-2', state: 'UNCERTAIN', at: '2026-08-24T00:00:00Z' })
  const result = buildDwAttention({
    tenantId: A, needsYouReadModel: needsYou([older, newer]),
    companyBrainContext: brainContext(brainReadModel()), limit: 10,
  })
  const forInvoice = result.items.filter((i) => i.invoiceId === 'inv-a')
  assert.equal(forInvoice.length, 1,
    'a case whose reason changed between proof events is still one interruption')
  // The NEWER state wins: an older approval must not outrank a newer state.
  assert.equal(forInvoice[0].reason, DW_ATTENTION_REASON.NEEDS_FOUNDER_ANSWER)
  // Every observed event stays inspectable.
  assert.deepEqual([...forInvoice[0].supportingRefs].sort(), ['run-1', 'run-2'])
})

test('CP2R-8b ambiguous currentness is flagged, never guessed', () => {
  // Two events for one invoice with different reasons and NO timestamps: which
  // is current cannot be proven, so the ambiguity is reported.
  const result = buildDwAttention({
    tenantId: A,
    needsYouReadModel: needsYou([
      needsYouItem({ runId: 'run-1', state: 'APPROVAL' }),
      needsYouItem({ runId: 'run-2', state: 'UNCERTAIN' }),
    ]),
    companyBrainContext: brainContext(brainReadModel()), limit: 10,
  })
  assert.equal(result.items.filter((i) => i.invoiceId === 'inv-a').length, 1)
  assert.ok(result.degradedInputs.includes('CASE_CURRENTNESS_AMBIGUOUS'),
    'when currentness cannot be proven the queue says so rather than picking')
  assert.equal(result.complete, false)
})

test('CP2R-8c a pure replay of the same event is not ambiguous', () => {
  const result = buildDwAttention({
    tenantId: A,
    needsYouReadModel: needsYou([
      needsYouItem({ runId: 'run-1', state: 'APPROVAL', at: '2026-08-24T00:00:00Z' }),
      needsYouItem({ runId: 'run-1', state: 'APPROVAL', at: '2026-08-24T00:00:00Z' }),
    ]),
    companyBrainContext: brainContext(brainReadModel()), limit: 10,
  })
  assert.equal(result.items.length, 1)
  assert.equal(result.duplicatesSuppressed, 1)
  assert.ok(!result.degradedInputs.includes('CASE_CURRENTNESS_AMBIGUOUS'))
  assert.equal(result.complete, true)
})

test('CP2R-8d two distinct Company Brain items on one subject stay distinct', () => {
  // Case identity for a Brain item is its REVIEW KEY, not its subject. An
  // unresolved conflict and a changed-since-review item can share a subject
  // while being two genuinely different things the founder must look at;
  // collapsing them would hide one and falsely flag the pair as ambiguous.
  const shared = (overrides) => ({
    reviewKey: 'x', category: 'POLICY', itemType: 'UNDERSTANDING', subject: 'grace period',
    scope: { level: 'COMPANY' }, clientId: null, reviewStatus: 'APPROVED',
    conflictStatus: 'NONE', changedSinceReview: false, supportingSourceRevoked: false,
    why: 'x', evidence: [], proposedValue: {}, ...overrides,
  })
  const model = brainReadModel({
    items: [
      shared({ reviewKey: 'c-1', itemType: 'CONFLICT', conflictStatus: 'CONFLICTED' }),
      shared({ reviewKey: 'u-9', changedSinceReview: true }),
    ],
  })
  const result = buildDwAttention({
    tenantId: A, needsYouReadModel: needsYou([]),
    companyBrainContext: brainContext(model), limit: 10,
  })
  assert.equal(result.items.length, 2, 'two review keys are two items')
  assert.deepEqual(result.items.map((i) => i.reason).sort(),
    [DW_ATTENTION_REASON.CHANGED_SINCE_REVIEW, DW_ATTENTION_REASON.UNRESOLVED_CONFLICT].sort())
  assert.ok(!result.degradedInputs.includes('CASE_CURRENTNESS_AMBIGUOUS'))
  assert.equal(result.complete, true)
})
