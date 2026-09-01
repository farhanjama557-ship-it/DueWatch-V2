/**
 * M2G-G7 checkpoint 2: the conversation layer inside the real orchestrator,
 * and the deterministic daily-priorities projection.
 *
 * The orchestrator is the canonical Ask DW path. These tests exercise it
 * directly rather than a parallel copy, so what they prove is what runs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAskDwOrchestrator } from '../src/lib/dwIntelligence/askDwOrchestrator.js'
import {
  ASK_DW_PRIORITY_REASON,
  askDwCanSayNothingNeedsYou,
  buildAskDwDailyPriorities,
} from '../src/lib/dwIntelligence/askDwDailyPriorities.js'
import { buildAskDwCompanyBrainContext } from '../src/lib/dwIntelligence/askDwCompanyBrainContext.js'
import { ASK_DW_TURN } from '../src/lib/dwIntelligence/askDwConversationalTurn.js'
import { projectNeedsYouReadModel } from '../src/lib/dwIntelligence/phase2bReadModel.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const orchestratorSource = fs.readFileSync(
  path.join(repoRoot, 'src/lib/dwIntelligence/askDwOrchestrator.js'), 'utf8')

const tenantA = 'tenant-a'
const tenantB = 'tenant-b'

/** A minimal but structurally real G6 read model for conversation tests. */
function companyBrainReadModel({
  tenantId = tenantA, conflicts = 1, changed = 0, grants = 0, pending = 1,
} = {}) {
  const items = []
  for (let index = 0; index < conflicts; index += 1) {
    items.push({
      reviewKey: `review-conflict-${index}`, category: 'CONFLICTS', itemType: 'CONFLICT',
      subject: 'late_fee_policy', scope: { level: 'CLIENT', clientId: 'atlas' }, clientId: 'atlas',
      reviewStatus: 'REVIEW_REQUIRED', reviewRequiredReason: 'CONFLICT_UNRESOLVED',
      changedSinceReview: false, supportingSourceRevoked: false, conflictStatus: 'CONFLICTED',
      why: 'Contract says 2%, company policy says 5%, and nothing says which governs.',
      proposedValue: null, evidence: [{ sourceVersionId: 'src-1' }], claims: [],
      proposition: {
        competingPositions: [
          { claimId: 'c1', scope: { level: 'CLIENT', clientId: 'atlas' }, value: { ratePercent: 2 } },
          { claimId: 'c2', scope: { level: 'COMPANY' }, value: { ratePercent: 5 } },
        ],
        currentResult: 'NO_SAFE_CURRENT_INSTRUCTION',
      },
    })
  }
  for (let index = 0; index < changed; index += 1) {
    items.push({
      reviewKey: `review-changed-${index}`, category: 'COMPANY_UNDERSTANDING', itemType: 'UNDERSTANDING',
      subject: 'reminder_cadence', scope: { level: 'COMPANY' }, clientId: null,
      reviewStatus: 'REVIEW_REQUIRED', reviewRequiredReason: 'SUBJECT_CHANGED_SINCE_REVIEW',
      changedSinceReview: true, supportingSourceRevoked: false, conflictStatus: 'NONE',
      why: 'The collections SOP changed after your review.',
      proposedValue: { days: 7 }, evidence: [{ sourceVersionId: 'src-2' }], claims: [],
    })
  }
  for (let index = 0; index < pending; index += 1) {
    items.push({
      reviewKey: `review-pending-${index}`, category: 'COMPANY_UNDERSTANDING', itemType: 'UNDERSTANDING',
      subject: 'escalation_flow', scope: { level: 'COMPANY' }, clientId: null,
      reviewStatus: 'PENDING', reviewRequiredReason: 'NEVER_REVIEWED',
      changedSinceReview: false, supportingSourceRevoked: false, conflictStatus: 'NONE',
      why: 'Derived from the collections workflow.', proposedValue: { days: 30 },
      evidence: [{ sourceVersionId: 'src-3' }], claims: [],
    })
  }
  return {
    kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_READ_MODEL_V0',
    tenantId, generatedAt: '2026-09-01T13:00:00.000Z', items,
    summary: {
      understandingReviewed: 0, needsReview: items.length,
      conflictsUnresolved: conflicts, changedSinceReview: changed,
    },
    authority: {
      evaluatedAt: '2026-09-01T13:00:00.000Z',
      activeGrantCount: grants, proposalCount: 0,
      noStandingAuthorityConfigured: grants === 0,
      currentAuthorityGrants: grants > 0 ? [{
        id: 'grant-1', action: 'SEND_REMINDER', scope: { level: 'CLIENT', clientId: 'atlas' },
        channel: 'EMAIL', approvalRequirement: 'NONE', conditions: { daysOverdue: 7 },
        effectiveWindow: { effectiveFrom: '2026-09-01T00:00:00.000Z', expiresAt: null },
        status: 'GRANTED', revision: 1, decidedAt: '2026-09-01T00:00:00.000Z',
      }] : [],
      proposedAuthority: [], revokedAuthority: [], staleAuthority: [],
      supersededAuthority: [], invalidatedAuthority: [],
    },
    readiness: {
      companyBrainReviewComplete: false, dwStandingAuthorityConfigured: grants > 0,
      itemsAwaitingReview: items.length, conflictsRemaining: conflicts,
    },
  }
}

function harness({ captured = {} } = {}) {
  const deterministicCore = async () => ({
    intent: { job: 'EXPLAIN', scope: 'PORTFOLIO' },
    policy: { requestedMode: 'normal', internalDepth: 'standard' },
    packet: {
      executiveState: 'WATCH',
      canonicalFacts: { invoiceId: 'inv-1', balance: '601.00' },
      arState: null, evidenceRefs: [], claims: [], uncertainty: null, constraints: null,
      authority: { actual: 'NOT_GRANTED' },
      hardSafetyOutcome: 'NO_UNAUTHORIZED_SIDE_EFFECT',
      needsYou: { required: false, question: null },
    },
    reasoningTrail: [], workManifest: { requiredModelOrToolWork: [], completedModelOrToolWork: [], truthfullyPending: false },
  })
  const primaryModel = {
    async plan(input) { captured.plan = input; return { toolRequests: [], hypotheses: [], answerIntent: 'x' } },
    async synthesize(input) {
      captured.synthesize = input
      return {
        executiveConclusion: 'Atlas first.', evidenceBasis: [], uncertaintyAndLimitations: [],
        recommendationOrNextStep: null, competingExplanations: [], citedToolRunIds: [],
      }
    },
  }
  const verifierModel = {
    async verify(input) { captured.verify = input; return { verdict: 'PASS', issues: [], checkedClaims: [] } },
  }
  const toolRegistry = { async execute() { throw new Error('no tools expected') } }
  return createAskDwOrchestrator({ deterministicCore, primaryModel, verifierModel, toolRegistry })
}

// ── orchestrator integration ─────────────────────────────────────────────────

test('G7-O1 every model stage receives the conversational turn and Company Brain', async () => {
  const captured = {}
  const result = await harness({ captured }).run({
    mode: 'normal', text: 'what should i do today?',
    context: { tenantId: tenantA, companyBrainReadModel: companyBrainReadModel() },
  })
  for (const stage of ['plan', 'synthesize']) {
    assert.equal(captured[stage].conversationalTurn.turnType, ASK_DW_TURN.DAILY_PRIORITIES, stage)
    assert.equal(captured[stage].companyBrainContext.available, true, stage)
    assert.ok(captured[stage].dailyPriorities.total > 0, stage)
  }
  assert.equal(captured.verify.companyBrainContext.available, true)
  assert.equal(result.conversation.turn.turnType, ASK_DW_TURN.DAILY_PRIORITIES)
})

test('G7-O2 the Company Brain travels beside caseContext, never inside it', async () => {
  const captured = {}
  await harness({ captured }).run({
    mode: 'normal', text: 'what does our policy say?',
    context: {
      tenantId: tenantA,
      companyBrainReadModel: companyBrainReadModel(),
      caseContext: { focus: { clientRef: { kind: 'client', id: 'atlas' } } },
    },
  })
  // The existing caseContext safety split is untouched.
  assert.equal(captured.synthesize.caseContext.companyBrainContext, undefined)
  assert.equal(captured.synthesize.caseContext.dailyPriorities, undefined)
  assert.ok(captured.synthesize.companyBrainContext)
  assert.notEqual(captured.synthesize.companyBrainContext, captured.synthesize.caseContext)
})

test('G7-O3 the verifier is asked to check Company Brain claims and founder pressure', async () => {
  const captured = {}
  await harness({ captured }).run({
    mode: 'normal', text: 'are you sure?',
    context: { tenantId: tenantA, companyBrainReadModel: companyBrainReadModel() },
  })
  assert.ok(captured.verify.requiredChecks.includes('company_brain_claims_supported'))
  assert.ok(captured.verify.requiredChecks.includes('founder_pressure_did_not_change_truth'))
  assert.equal(captured.verify.conversationalTurn.turnType, ASK_DW_TURN.CHALLENGE)
  assert.equal(captured.verify.conversationalTurn.founderPressure, true)
})

test('G7-O4 conversation never becomes permission in the orchestrator result', async () => {
  const result = await harness().run({
    mode: 'normal', text: 'go ahead and handle it',
    context: { tenantId: tenantA, companyBrainReadModel: companyBrainReadModel({ grants: 1 }) },
  })
  assert.equal(result.safeguards.conversationCanGrantAuthority, false)
  assert.equal(result.safeguards.companyBrainMutableFromConversation, false)
  assert.equal(result.safeguards.modelCanGrantAuthority, false)
  assert.equal(result.safeguards.companyBrainReadOnly, true)
  assert.equal(result.conversation.turn.grantsAuthority, false)
})

test('G7-O5 a Company Brain read model from another tenant is refused', async () => {
  await assert.rejects(() => harness().run({
    mode: 'normal', text: 'hi',
    context: { tenantId: tenantA, companyBrainReadModel: companyBrainReadModel({ tenantId: tenantB }) },
  }), /tenant mismatch/)
})

test('G7-O6 a missing Company Brain read is unavailable, not silently empty', async () => {
  const captured = {}
  await harness({ captured }).run({
    mode: 'normal', text: 'what conflicts are unresolved?', context: { tenantId: tenantA },
  })
  assert.equal(captured.synthesize.companyBrainContext.available, false)
  assert.equal(captured.synthesize.companyBrainContext.unavailableReason, 'COMPANY_BRAIN_READ_UNAVAILABLE')
})

test('G7-O7 a greeting still carries no invented AR subject', async () => {
  const captured = {}
  await harness({ captured }).run({
    mode: 'normal', text: 'hi', context: { tenantId: tenantA },
  })
  assert.equal(captured.plan.conversationalTurn.turnType, ASK_DW_TURN.GREETING)
  assert.equal(captured.plan.scopedContext.invoiceId, null)
  assert.equal(captured.plan.scopedContext.clientId, null)
})

// ── daily priorities ─────────────────────────────────────────────────────────

test('G7-P1 priorities are ordered by a fixed reviewable policy, not by a model', () => {
  const priorities = buildAskDwDailyPriorities({
    tenantId: tenantA,
    needsYouReadModel: { userId: tenantA, count: 0, items: [] },
    companyBrainContext: buildAskDwCompanyBrainContext({
      readModel: companyBrainReadModel({ conflicts: 1, changed: 1, pending: 1 }), tenantId: tenantA,
    }),
  })
  const reasons = priorities.items.map((item) => item.reason)
  assert.equal(reasons[0], ASK_DW_PRIORITY_REASON.UNRESOLVED_CONFLICT)
  assert.ok(reasons.indexOf(ASK_DW_PRIORITY_REASON.CHANGED_SINCE_REVIEW) <
    reasons.indexOf(ASK_DW_PRIORITY_REASON.AWAITING_REVIEW))
  assert.equal(priorities.boundaries.modelChoseOrder, false)
})

test('G7-P2 every priority states why it ranked, inspectably', () => {
  const priorities = buildAskDwDailyPriorities({
    tenantId: tenantA,
    needsYouReadModel: { userId: tenantA, count: 0, items: [] },
    companyBrainContext: buildAskDwCompanyBrainContext({
      readModel: companyBrainReadModel(), tenantId: tenantA,
    }),
  })
  for (const item of priorities.items) {
    assert.ok(typeof item.why === 'string' && item.why.length > 0)
    assert.ok(item.refs.length > 0)
    assert.equal(item.authorityImpact, 'NONE')
    assert.equal(item.directlyExecutable, false)
  }
})

test('G7-P3 a degraded read is never reported as "nothing needs you"', () => {
  const degraded = buildAskDwDailyPriorities({ tenantId: tenantA, needsYouReadModel: null })
  assert.equal(degraded.complete, false)
  assert.ok(degraded.degradedInputs.includes('DW_INTELLIGENCE_NEEDS_YOU_UNAVAILABLE'))
  assert.equal(askDwCanSayNothingNeedsYou(degraded), false)

  const brainDown = buildAskDwDailyPriorities({
    tenantId: tenantA,
    needsYouReadModel: { userId: tenantA, count: 0, items: [] },
    companyBrainContext: buildAskDwCompanyBrainContext({ readModel: null, tenantId: tenantA }),
  })
  assert.equal(brainDown.complete, false)
  assert.ok(brainDown.degradedInputs.includes('COMPANY_BRAIN_UNAVAILABLE'))
  assert.equal(askDwCanSayNothingNeedsYou(brainDown), false)
})

test('G7-P4 a genuinely quiet portfolio may be reported as quiet', () => {
  const quiet = buildAskDwDailyPriorities({
    tenantId: tenantA,
    needsYouReadModel: { userId: tenantA, count: 0, items: [] },
    companyBrainContext: buildAskDwCompanyBrainContext({
      readModel: companyBrainReadModel({ conflicts: 0, changed: 0, pending: 0 }), tenantId: tenantA,
    }),
  })
  assert.equal(quiet.complete, true)
  assert.equal(quiet.total, 0)
  assert.equal(askDwCanSayNothingNeedsYou(quiet), true)
})

test('G7-P5 canonical needs-you cases keep their own ranking ownership', () => {
  const needsYou = projectNeedsYouReadModel({ userId: tenantA, cases: [] })
  const priorities = buildAskDwDailyPriorities({
    tenantId: tenantA, needsYouReadModel: needsYou,
    companyBrainContext: buildAskDwCompanyBrainContext({
      readModel: companyBrainReadModel({ conflicts: 0, changed: 0, pending: 0 }), tenantId: tenantA,
    }),
  })
  assert.equal(priorities.total, 0)
  assert.equal(priorities.boundaries.derivedFromExistingProjections, true)
})

test('G7-P6 priorities carry no execution or money capability', () => {
  const priorities = buildAskDwDailyPriorities({ tenantId: tenantA })
  assert.equal(priorities.boundaries.canGrantAuthority, false)
  assert.equal(priorities.boundaries.canExecute, false)
  assert.equal(priorities.boundaries.canonicalMoneyWritable, false)
  assert.throws(() => buildAskDwDailyPriorities({}), /tenantId required/)
})

test('G7-P7 the orchestrator did not gain a mutation or execution path', () => {
  for (const pattern of [/\.rpc\(/, /supabase/, /\bfetch\(/, /grantAuthority\(/, /sendReminder/]) {
    assert.doesNotMatch(orchestratorSource, pattern)
  }
  // The Company Brain is built inside the orchestrator from the caller's read
  // model; it is never assembled from model output.
  assert.match(orchestratorSource, /buildAskDwCompanyBrainContext\(\{\s*\n\s*readModel: context\.companyBrainReadModel/)
})
