/**
 * G8-CP2 final integration repair.
 *
 * Three findings from end-to-end review of 20ae2ef.
 *
 *   1  projectNeedsYouCommandReadModel COMPUTED the shared attention result and
 *      then returned the old recency-ordered `items` array. The primitive ran;
 *      its answer was not load-bearing.
 *   2  receiptProves compared user, invoice and action but never ruleId, and
 *      accepted any non-empty idempotency key rather than the deterministic key
 *      for that identity. It also let any action be "proved", including actions
 *      no execution contract exists for.
 *   3  The production composition never builds a g5Request, so the G5
 *      missing-grant reason is unreachable there.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildAskDwCompanyBrainContext } from '../src/lib/dwIntelligence/askDwCompanyBrainContext.js'
import { buildDwGovernanceContext } from '../src/lib/dwIntelligence/dwGovernanceContext.js'
import {
  DW_ATTENTION_REASON,
  buildDwAttention,
} from '../src/lib/dwIntelligence/dwAttentionPriority.js'
import {
  DW_PROACTIVE_ISSUE,
  DW_PROVABLE_EXECUTION_ACTIONS,
  enforceDwProactiveGrounding,
} from '../src/lib/dwIntelligence/dwProactiveGrounding.js'
import { projectNeedsYouCommandReadModel } from '../src/lib/dwIntelligence/phase2bCommandModels.js'
import { buildIdempotencyKey } from '../supabase/functions/_shared/executionClaim.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const A = 'tenant-a'
const AS_OF = '2026-08-24T12:00:00Z'

// Real uuid-shaped ids: buildIdempotencyKey refuses anything else.
const USER = '11111111-1111-4111-8111-111111111111'
const INVOICE = '22222222-2222-4222-8222-222222222222'
const RULE_A = '33333333-3333-4333-8333-333333333333'
const RULE_B = '44444444-4444-4444-8444-444444444444'

function brainReadModel({ items = [], grants = [] } = {}) {
  return {
    kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_READ_MODEL_V0',
    tenantId: A, generatedAt: AS_OF, items,
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

const brainContext = (model = brainReadModel()) =>
  buildAskDwCompanyBrainContext({ readModel: model, tenantId: A })

/**
 * A case in the shape projectCaseReadModel consumes: invoice, client, run and
 * proof event. This is the REAL production input, not the read model's output.
 */
function caseInput({
  runId, invoiceId = 'inv-a', clientId = 'client-a', state = 'APPROVAL',
  createdAt = '2026-08-24T00:00:00Z', founderQuestion = null,
} = {}) {
  return {
    invoice: { id: invoiceId, user_id: A, client_id: clientId, amount: 10000, amount_paid: 0, due_date: '2026-06-10', paid: false },
    client: { id: clientId, user_id: A, name: 'Atlas' },
    run: { id: runId, user_id: A, status: 'completed', transport: 'sandbox', production_execution_authorized: false, summary: { hard_violations: [] } },
    proofEvent: {
      id: `pe-${runId}`, user_id: A, run_id: runId, invoice_id: invoiceId, client_id: clientId,
      operational_state: state, created_at: createdAt, real_side_effect: false,
      proof: {
        scope: { tenantId: A, invoiceId, clientId },
        canonicalFacts: { canonicalStatus: 'OPEN', balance: 10000, daysOverdue: 60 },
        evidence: { records: [], independentStrongRoots: [] },
        memory: { active: [], blocked: [] },
        precedent: { checked: [], applicable: [] },
        execution: { mode: 'none', sideEffect: false },
        founderQuestion: founderQuestion
          ? { asked: true, question: founderQuestion }
          : { asked: false, question: null },
        authority: { policyAuthorized: true, actual: 'REQUIRES_APPROVAL', canActAutomatically: false },
        verifier: { passed: true },
      },
    },
  }
}

const project = (cases, extra = {}) => projectNeedsYouCommandReadModel({
  userId: A, cases, companyBrainContext: brainContext(), ...extra,
})

// ── 1 · the shared answer must control the real queue ───────────────────────

test('CP2F-1 duplicate proof events produce ONE row in the command model', () => {
  const model = project([
    caseInput({ runId: 'run-old', createdAt: '2026-08-20T00:00:00Z' }),
    caseInput({ runId: 'run-new', createdAt: '2026-08-24T00:00:00Z' }),
  ])
  assert.equal(model.items.length, 1, 'one invoice is one row in the founder queue')
  assert.equal(model.count, 1, 'the count the UI renders agrees with the rows')
})

test('CP2F-1b the newer state wins even when the older reason ranks higher', () => {
  // run-old is APPROVAL (FOUNDER_DECISION_REQUIRED, rank 0); run-new is
  // UNCERTAIN with a founder question (NEEDS_FOUNDER_ANSWER, rank 6). Severity
  // must not resurrect the stale event.
  const model = project([
    caseInput({ runId: 'run-old', state: 'APPROVAL', createdAt: '2026-08-20T00:00:00Z' }),
    caseInput({ runId: 'run-new', state: 'UNCERTAIN', createdAt: '2026-08-24T00:00:00Z', founderQuestion: 'Is Atlas disputing?' }),
  ])
  assert.equal(model.items.length, 1)
  assert.equal(model.items[0].runId, 'run-new', 'the current event is the one shown')
  assert.equal(model.items[0].state, 'UNCERTAIN')
})

test('CP2F-1c queue order comes from shared attention, not recency', () => {
  // Recency would put the older founder-decision case LAST. Shared attention
  // ranks a founder decision above a founder answer regardless of timestamp.
  const model = project([
    caseInput({ runId: 'run-q', invoiceId: 'inv-question', clientId: 'client-q', state: 'UNCERTAIN', createdAt: '2026-08-24T00:00:00Z', founderQuestion: 'Which invoice?' }),
    caseInput({ runId: 'run-d', invoiceId: 'inv-decision', clientId: 'client-d', state: 'APPROVAL', createdAt: '2026-08-20T00:00:00Z' }),
  ])
  assert.equal(model.items.length, 2)
  assert.equal(model.items[0].invoiceId, 'inv-decision',
    'the founder decision ranks first even though it is older')
  assert.equal(model.items[0].attentionReason, DW_ATTENTION_REASON.FOUNDER_DECISION_REQUIRED)
  assert.equal(model.items[1].attentionReason, DW_ATTENTION_REASON.NEEDS_FOUNDER_ANSWER)
})

test('CP2F-1d the attention primitive names which observation is current', () => {
  // The surviving case is identified by a stable field the primitive sets, not
  // guessed from supportingRefs after merging.
  const attention = buildDwAttention({
    tenantId: A,
    needsYouReadModel: {
      userId: A, count: 2,
      items: [
        { runId: 'run-old', invoiceId: 'inv-a', clientId: 'client-a', state: 'APPROVAL', at: '2026-08-20T00:00:00Z' },
        { runId: 'run-new', invoiceId: 'inv-a', clientId: 'client-a', state: 'UNCERTAIN', at: '2026-08-24T00:00:00Z' },
      ],
    },
    companyBrainContext: brainContext(), limit: 10,
  })
  const entry = attention.items.find((i) => i.invoiceId === 'inv-a')
  assert.equal(entry.currentRef, 'run-new', 'the winning observation is named explicitly')
  assert.deepEqual([...entry.supportingRefs].sort(), ['run-new', 'run-old'],
    'every observation stays inspectable')
})

// ── 2 · a receipt must match the canonical execution identity ───────────────

const TRUTH = { canonicalFacts: { balance: 10000, daysOverdue: 60, paid: false } }

function realReceipt(overrides = {}) {
  const identity = {
    userId: USER, invoiceId: INVOICE, ruleId: RULE_A, actionType: 'send_reminder',
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

const CLAIM = Object.freeze({
  tenantId: USER, invoiceId: INVOICE, ruleId: RULE_A, action: 'send_reminder',
})

function ground(narrative, extra = {}) {
  return enforceDwProactiveGrounding({
    narrative, truthLock: TRUTH,
    governance: buildDwGovernanceContext({ tenantId: A, companyBrainContext: brainContext() }),
    executionReceipts: [], executionClaim: CLAIM,
    attention: buildDwAttention({
      tenantId: A, needsYouReadModel: { userId: A, count: 0, items: [] },
      companyBrainContext: brainContext(), limit: 10,
    }),
    ...extra,
  })
}

test('CP2F-2 a receipt for another rule cannot prove the claim', () => {
  const wrongRule = ground({ headline: 'DW sent the reminder.' },
    { executionReceipts: [realReceipt({ ruleId: RULE_B })] })
  assert.equal(wrongRule.blocked, true, 'the rule is part of the execution identity')
  assert.ok(wrongRule.issues.some((i) => i.code === DW_PROACTIVE_ISSUE.EXECUTION_WITHOUT_RECEIPT))
})

test('CP2F-2b the idempotency key must be the derived key for that identity', () => {
  for (const [label, key] of [
    ['a nonblank but arbitrary key', 'not-the-derived-key'],
    ['the key for another rule', buildIdempotencyKey({ userId: USER, invoiceId: INVOICE, ruleId: RULE_B, actionType: 'send_reminder' })],
    ['a missing key', undefined],
  ]) {
    const result = ground({ headline: 'DW sent the reminder.' },
      { executionReceipts: [realReceipt({ idempotencyKey: key })] })
    assert.equal(result.blocked, true, label)
  }
})

test('CP2F-2c the structured claim action participates in the check', () => {
  // The claim says send_reminder; the narrative and the receipt both say
  // refund. The receipt must not prove an action the claim never covered.
  const result = ground({ headline: 'DW refunded the balance.' },
    { executionReceipts: [realReceipt({ actionType: 'issue_refund' })] })
  assert.equal(result.blocked, true)
})

test('CP2F-2d only actions with a real execution contract are provable', () => {
  // Detection stays broad; PROOF stays closed. Only send_reminder has a
  // canonical execution-receipt contract today, so a fabricated receipt for a
  // hypothetical action can never license completed language about it.
  assert.deepEqual([...DW_PROVABLE_EXECUTION_ACTIONS], ['send_reminder'])
  for (const action of ['issue_refund', 'waive_late_fee', 'apply_late_fee', 'settle_invoice', 'write_off_invoice']) {
    const claim = { ...CLAIM, action }
    const result = enforceDwProactiveGrounding({
      narrative: { headline: `DW ${action === 'issue_refund' ? 'refunded the balance' : 'waived the fee'}.` },
      truthLock: TRUTH,
      governance: buildDwGovernanceContext({ tenantId: A, companyBrainContext: brainContext() }),
      executionClaim: claim,
      executionReceipts: [realReceipt({ actionType: action })],
    })
    assert.equal(result.blocked, true, `${action} has no execution contract and must fail closed`)
  }
})

test('CP2F-2f a valid receipt cannot prove an action the claim never covered', () => {
  // The structured claim says this case is a refund. The narrative asserts a
  // send, and a genuinely valid send receipt for the same invoice and rule is
  // offered. The claim is what says which operation was actually in flight, so
  // the receipt cannot be borrowed to license a different sentence.
  const result = enforceDwProactiveGrounding({
    narrative: { headline: 'DW sent the reminder.' },
    truthLock: TRUTH,
    governance: buildDwGovernanceContext({ tenantId: A, companyBrainContext: brainContext() }),
    executionClaim: { ...CLAIM, action: 'issue_refund' },
    executionReceipts: [realReceipt()],
  })
  assert.equal(result.blocked, true)
  assert.ok(result.issues.some((i) => i.code === DW_PROACTIVE_ISSUE.EXECUTION_WITHOUT_RECEIPT))
})

test('CP2F-2e the exact real send identity with status sent is allowed', () => {
  const ok = ground({ headline: 'DW sent the reminder.' }, { executionReceipts: [realReceipt()] })
  assert.equal(ok.blocked, false, 'a receipt matching the full identity proves its own claim')
})

// ── 3 · the G5 missing-grant reason is honestly accounted for ───────────────

test('CP2F-3 production cannot claim a missing G5 grant it never resolved', () => {
  // The production composition carries no typed action/scope/channel, so no
  // g5Request can be built without inventing one. The queue therefore reports
  // OPERATIONAL policy and never asserts G5 absence.
  const model = projectNeedsYouCommandReadModel({
    userId: A,
    cases: [caseInput({ runId: 'run-1' })],
    companyBrainContext: brainContext(),
  })
  assert.equal(model.g5AuthorityResolved, false,
    'the command model states plainly that it resolved no G5 authority')
  for (const item of model.attention.items) {
    assert.notEqual(item.reason, DW_ATTENTION_REASON.BLOCKED_ON_MISSING_AUTHORITY,
      'a reason that requires G5 resolution must be unreachable without one')
  }

  // The primitive still supports the reason when a caller CAN supply a typed
  // request — that path is real, it is simply not reachable from production.
  const withRequest = buildDwAttention({
    tenantId: A,
    needsYouReadModel: {
      userId: A, count: 1,
      items: [{
        runId: 'run-1', invoiceId: 'inv-a', clientId: 'client-a', state: 'UNCERTAIN',
        authority: { policyAuthorized: false, actual: 'NOT_GRANTED', canActAutomatically: false },
        g5Request: { canonicalAction: 'SEND_REMINDER', scopeType: 'CLIENT', clientId: 'client-a', channel: 'EMAIL' },
      }],
    },
    companyBrainContext: brainContext(),
    authorityProjection: { evaluatedAt: AS_OF, currentGrants: [] },
    limit: 10,
  })
  assert.equal(withRequest.items[0].reason, DW_ATTENTION_REASON.BLOCKED_ON_MISSING_AUTHORITY)
})

// ── 4 · proactive grounding has no live caller, and that is stated ──────────

test('CP2F-4 no production surface currently emits free-form proactive narrative', () => {
  // Verified fact, locked so it cannot change silently: nothing outside the
  // library and the tests builds a proactive read model, DataContext never
  // provides dwIntelligence, and no production module calls the grounding
  // boundary. If any of that changes, this test fails and forces the decision
  // about routing that narrative through enforceDwProactiveGrounding.
  const productionFiles = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(js|jsx)$/.test(entry.name)) productionFiles.push(full)
    }
  }
  walk(path.join(repoRoot, 'src'))

  const libraryOwned = new Set([
    'dwProactiveGrounding.js', 'dwAttentionPriority.js', 'phase2bCommandModels.js',
    'phase2bReadModel.js', 'phase2bOperationalSimulation.js', 'askDwDailyPriorities.js',
  ])
  const callers = productionFiles.filter((file) => {
    if (libraryOwned.has(path.basename(file))) return false
    return /enforceDwProactiveGrounding/.test(fs.readFileSync(file, 'utf8'))
  })
  assert.deepEqual(callers, [],
    'a new proactive narrative caller appeared — route it through the grounding boundary and update this lock')
})
