/**
 * G8-CP3 shared fixtures.
 *
 * Not a test file — the name deliberately avoids the *.test.mjs pattern so the
 * runner does not execute it. It exists so the hostile, property and lock
 * suites attack the SAME construction of reality rather than three subtly
 * different ones, which is how a suite quietly stops testing what it claims.
 *
 * Everything here is deterministic. The generators take an explicit seed.
 */

import { buildAskDwCompanyBrainContext } from '../src/lib/dwIntelligence/askDwCompanyBrainContext.js'
import { buildDwGovernanceContext } from '../src/lib/dwIntelligence/dwGovernanceContext.js'
import { buildIdempotencyKey } from '../supabase/functions/_shared/executionClaim.js'

/** The documented CP3 seed. Printed by the property suite so runs are reproducible. */
export const DW_G8_SEED = 20260903

export const TENANT_A = 'tenant-a'
export const TENANT_B = 'tenant-b'
export const AS_OF = '2026-08-24T12:00:00Z'

/** uuid-shaped ids: buildIdempotencyKey refuses anything else. */
export const IDS = Object.freeze({
  userA: '11111111-1111-4111-8111-111111111111',
  userB: 'aaaaaaaa-1111-4111-8111-111111111111',
  invoiceA: '22222222-2222-4222-8222-222222222222',
  invoiceB: 'bbbbbbbb-2222-4222-8222-222222222222',
  ruleA: '33333333-3333-4333-8333-333333333333',
  ruleB: 'cccccccc-3333-4333-8333-333333333333',
})

/** A tiny deterministic PRNG (mulberry32). No dependency, fully reproducible. */
export function seededRandom(seed = DW_G8_SEED) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick(random, values) {
  return values[Math.floor(random() * values.length) % values.length]
}

/** Every permutation of a small array, deterministically ordered. */
export function permutations(values) {
  if (values.length <= 1) return [values]
  const out = []
  for (let index = 0; index < values.length; index += 1) {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)]
    for (const tail of permutations(rest)) out.push([values[index], ...tail])
  }
  return out
}

// ── Company Brain ────────────────────────────────────────────────────────────

export function brainItem(overrides = {}) {
  return {
    reviewKey: 'u-1', category: 'POLICY', itemType: 'UNDERSTANDING', subject: 'late fees',
    scope: { level: 'COMPANY' }, clientId: null, reviewStatus: 'APPROVED',
    conflictStatus: 'NONE', changedSinceReview: false, supportingSourceRevoked: false,
    why: 'founder stated', evidence: [], proposedValue: { graceDays: 30 },
    ...overrides,
  }
}

export function grantRow(overrides = {}) {
  return {
    id: 'g-1', action: 'SEND_REMINDER', scope: { level: 'CLIENT', clientId: 'client-a' },
    channel: 'EMAIL', approvalRequirement: 'NONE', conditions: {},
    effectiveWindow: { effectiveFrom: '2026-08-01T00:00:00Z', expiresAt: null },
    status: 'GRANTED', revision: 1, decidedAt: '2026-08-01T00:00:00Z',
    ...overrides,
  }
}

export function brainReadModel({
  items = [], grants = [], tenantId = TENANT_A, generatedAt = AS_OF,
  revoked = [], stale = [],
} = {}) {
  return {
    kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_READ_MODEL_V0',
    tenantId, generatedAt, items,
    summary: {
      understandingReviewed: items.length, needsReview: 0,
      conflictsUnresolved: items.filter((i) => i.conflictStatus === 'CONFLICTED').length,
      changedSinceReview: items.filter((i) => i.changedSinceReview).length,
    },
    authority: {
      evaluatedAt: generatedAt, activeGrantCount: grants.length, proposalCount: 0,
      noStandingAuthorityConfigured: grants.length === 0,
      currentAuthorityGrants: grants, proposedAuthority: [],
      revokedAuthority: revoked, staleAuthority: stale,
      supersededAuthority: [], invalidatedAuthority: [],
    },
    readiness: null,
  }
}

export const brainContext = (model = brainReadModel(), tenantId = TENANT_A) =>
  buildAskDwCompanyBrainContext({ readModel: model, tenantId })

export const governanceOf = (model = brainReadModel(), tenantId = TENANT_A) =>
  buildDwGovernanceContext({ tenantId, companyBrainContext: brainContext(model, tenantId) })

// ── needs-you projection ─────────────────────────────────────────────────────

export function needsYouItem(overrides = {}) {
  return {
    runId: 'run-1', invoiceId: 'inv-a', clientId: 'client-a', state: 'APPROVAL',
    balance: 10000, daysOverdue: 60, why: [], at: '2026-08-24T00:00:00Z',
    authority: { policyAuthorized: true, actual: 'REQUIRES_APPROVAL', canActAutomatically: false },
    ...overrides,
  }
}

export const needsYouModel = (items, userId = TENANT_A) =>
  ({ userId, count: items.length, items })

// ── real production case input (invoice / client / run / proof event) ────────

export function caseInput({
  runId, invoiceId = 'inv-a', clientId = 'client-a', state = 'APPROVAL',
  createdAt = '2026-08-24T00:00:00Z', founderQuestion = null, tenantId = TENANT_A,
  balance = 10000, daysOverdue = 60, policyAuthorized = true,
} = {}) {
  return {
    invoice: { id: invoiceId, user_id: tenantId, client_id: clientId, amount: balance, amount_paid: 0, due_date: '2026-06-10', paid: false },
    client: { id: clientId, user_id: tenantId, name: 'Atlas' },
    run: { id: runId, user_id: tenantId, status: 'completed', transport: 'sandbox', production_execution_authorized: false, summary: { hard_violations: [] } },
    proofEvent: {
      id: `pe-${runId}`, user_id: tenantId, run_id: runId, invoice_id: invoiceId, client_id: clientId,
      operational_state: state, created_at: createdAt, real_side_effect: false,
      proof: {
        scope: { tenantId, invoiceId, clientId },
        canonicalFacts: { canonicalStatus: 'OPEN', balance, daysOverdue },
        evidence: { records: [], independentStrongRoots: [] },
        memory: { active: [], blocked: [] },
        precedent: { checked: [], applicable: [] },
        execution: { mode: 'none', sideEffect: false },
        founderQuestion: founderQuestion ? { asked: true, question: founderQuestion } : { asked: false, question: null },
        authority: { policyAuthorized, actual: 'REQUIRES_APPROVAL', canActAutomatically: false },
        verifier: { passed: true },
      },
    },
  }
}

// ── canonical truth and receipts ─────────────────────────────────────────────

export const truthLock = (overrides = {}) => ({
  canonicalFacts: { canonicalStatus: 'OPEN', balance: 10000, daysOverdue: 60, paid: false, ...overrides.canonicalFacts },
  arState: overrides.arState ?? null,
})

/** A genuine receipt: full identity plus the key that identity derives. */
export function realReceipt(overrides = {}) {
  const identity = {
    userId: IDS.userA, invoiceId: IDS.invoiceA, ruleId: IDS.ruleA,
    actionType: 'send_reminder',
    ...overrides,
  }
  return {
    ...identity,
    idempotencyKey: 'idempotencyKey' in overrides
      ? overrides.idempotencyKey
      : buildIdempotencyKey(identity),
    status: overrides.status ?? 'sent',
  }
}

export const REAL_CLAIM = Object.freeze({
  tenantId: IDS.userA, invoiceId: IDS.invoiceA, ruleId: IDS.ruleA, action: 'send_reminder',
})
