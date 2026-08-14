import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SEND_OUTCOME,
  executeAutoSend,
  executeApprovalSend,
  deriveFactualBasis,
  factualBasisMatches,
  ruleSnapshotsMatch,
} from '../supabase/functions/_shared/autopilotExecutionCore.js'
import { ACTION_TYPE_SEND_REMINDER, buildExecutionIdentity, buildIdempotencyKey } from '../supabase/functions/_shared/executionClaim.js'
import { evaluateNextActionAuthority, buildRuleSnapshot } from '../supabase/functions/_shared/nextActionAuthority.js'
import { fetchHandledState, fetchAuthorityInputs } from '../supabase/functions/_shared/autopilotAuthorityInputs.js'

// Post-2A.1 execution safety checkpoint, second review-fix pass: the
// BEHAVIORAL TEST GAP list, exercised against the real orchestration
// (autopilotExecutionCore.js) via an injected in-memory `io` fake, AND
// against the real fetch-layer helpers (autopilotAuthorityInputs.js) via a
// fake Supabase-query-builder `admin` — never against Deno or a real
// Resend/Supabase connection.

const USER_A = '11111111-1111-4111-8111-111111111111'
const INVOICE_X = '33333333-3333-4333-8333-333333333333'
const INVOICE_Y = '44444444-4444-4444-8444-444444444444'
const RULE_A = '55555555-5555-4555-8555-555555555555'
const RULE_B = '66666666-6666-4666-8666-666666666666'
const NOW = new Date('2026-08-13T12:00:00.000Z')

const CLIENT_A = '77777777-7777-4777-8777-777777777777'
const CLIENT_B = '88888888-8888-4888-8888-888888888888'

function baseInvoice(overrides = {}) {
  return {
    id: INVOICE_X,
    user_id: USER_A,
    client_id: CLIENT_A,
    amount: 100,
    amount_paid: 0,
    due_date: '2026-08-01', // 12 days before NOW
    paid: false,
    autopilot_paused: false,
    last_reminder: null,
    inv_num: 'INV-1',
    clients: { email: 'client@example.test', name: 'Acme' },
    ...overrides,
  }
}

function baseRule(overrides = {}) {
  return {
    id: RULE_A,
    user_id: USER_A,
    name: 'First follow-up',
    trigger_type: 'after_due',
    trigger_days: 5,
    tone: 'friendly',
    enabled: true,
    sort_order: 0,
    ...overrides,
  }
}

function autopilotSettings(overrides = {}) {
  return { id: 'settings-1', user_id: USER_A, enabled: true, approval_required: false, ...overrides }
}

function buildMessage(invoice, rule, factualBasis) {
  return {
    subject: `Regarding invoice ${factualBasis.invNum || ''}`.trim(),
    text: `Hi ${factualBasis.clientName}, invoice ${factualBasis.invNum} for ${factualBasis.balance} (${rule.tone}) due ${factualBasis.dueDate}.`,
  }
}

// Real, in-memory atomic claim store -- single JS thread, but each
// acquireClaim call is a synchronous check-and-set with no `await` in
// between the check and the set, which is exactly what proves "at most
// one winner" for the ORCHESTRATION logic under Promise.all (genuine
// multi-process concurrency is proven separately, at the SQL layer, by
// autopilot_execution_claims_concurrency_proof.sh against the real
// deployed Postgres function).
function makeClaimStore() {
  const claims = new Map()
  let n = 0
  return {
    claims,
    async acquireClaim({ userId, invoiceId, ruleId, actionType, receipt }) {
      const key = `${userId}:${invoiceId}:${ruleId}:${actionType}`
      const existing = claims.get(key)
      if (existing) return { claimId: existing.claimId, acquired: false, existingStatus: existing.status }
      n += 1
      const claimId = `claim-${n}`
      // Mirrors resolve_autopilot_execution_claim's real jsonb-merge
      // semantics: the receipt written here at acquire time must survive
      // resolveClaim's later evidence write, not be overwritten by it.
      claims.set(key, { claimId, status: 'in_flight', receipt: receipt ?? null, evidence: {} })
      return { claimId, acquired: true }
    },
    async resolveClaim({ claimId, status, evidence }) {
      for (const v of claims.values()) {
        if (v.claimId === claimId) {
          v.status = status
          v.evidence = { ...v.evidence, ...(evidence ?? {}) }
        }
      }
    },
  }
}

function makeIo(overrides = {}) {
  const sendEmailCalls = []
  const queueForReviewCalls = []
  const recordSentCalls = []
  const recordFailureCalls = []
  const recordUncertainCalls = []
  const store = overrides.claimStore || makeClaimStore()

  const io = {
    async fetchAuthorityInputs({ invoiceId }) {
      const fetcher = overrides.fetchAuthorityInputs
      if (fetcher) return fetcher({ invoiceId })
      return {
        invoice: baseInvoice({ id: invoiceId }),
        rules: [baseRule()],
        autopilotSettings: autopilotSettings(),
        handledKeys: new Set(),
        pendingInvoiceIds: new Set(),
      }
    },
    isProviderConfigured: overrides.isProviderConfigured || (() => true),
    acquireClaim: overrides.acquireClaim || store.acquireClaim,
    resolveClaim: overrides.resolveClaim || store.resolveClaim,
    sendEmail: async (args) => {
      sendEmailCalls.push(args)
      if (overrides.sendEmail) return overrides.sendEmail(args)
      return { id: 'resend-id-1' }
    },
    queueForReview: async (args) => {
      queueForReviewCalls.push(args)
    },
    recordSentEvidence: async (args) => {
      recordSentCalls.push(args)
    },
    recordFailureEvidence: async (args) => {
      recordFailureCalls.push(args)
    },
    recordUncertainEvidence: async (args) => {
      recordUncertainCalls.push(args)
    },
  }
  return { io, sendEmailCalls, queueForReviewCalls, recordSentCalls, recordFailureCalls, recordUncertainCalls, store }
}

// A valid, internally-consistent approval fixture: authority + factual
// basis + rule snapshot all derived from the SAME base invoice/rule, the
// way actOnMatch now persists them together.
function validApprovalFixture(overrides = {}) {
  const invoice = baseInvoice()
  const rule = baseRule()
  const evaluation = evaluateNextActionAuthority({
    userId: USER_A,
    invoice,
    rules: [rule],
    autopilotSettings: autopilotSettings({ approval_required: true }),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
    now: NOW,
  })
  assert.ok(evaluation.authority.authorized, 'test fixture setup: expected the base fixture to be authorized')
  return {
    priorAuthority: evaluation.authority,
    priorFactualBasis: deriveFactualBasis(invoice),
    priorRuleSnapshot: buildRuleSnapshot(rule),
    ...overrides,
  }
}

function approvalFetchInputs(overrides = {}) {
  return () => ({
    invoice: baseInvoice(),
    rules: [baseRule()],
    autopilotSettings: autopilotSettings({ approval_required: true }),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
    ...overrides,
  })
}

// ---------------------------------------------------------------------
// 1. first auto execution -> claim winner -> one provider call
test('1: first auto execution acquires the claim and sends exactly once', async () => {
  const { io, sendEmailCalls } = makeIo()
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.SENT)
  assert.equal(sendEmailCalls.length, 1)
})

// 2. same action later -> zero new provider calls
test('2: a later call for the same identity makes zero new provider calls', async () => {
  const store = makeClaimStore()
  const { io: io1, sendEmailCalls: calls1 } = makeIo({ claimStore: store })
  const first = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io: io1 })
  assert.equal(first.outcome, SEND_OUTCOME.SENT)

  const { io: io2, sendEmailCalls: calls2 } = makeIo({ claimStore: store })
  const second = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io: io2 })
  assert.equal(second.outcome, SEND_OUTCOME.CLAIM_LOST)
  assert.equal(second.existingStatus, 'sent')
  assert.equal(calls2.length, 0)
  assert.equal(calls1.length, 1)
})

// 3. concurrent claim loser -> zero provider calls
test('3: two concurrent auto-send attempts result in exactly one send', async () => {
  const store = makeClaimStore()
  let sharedSendCount = 0
  const { io: io1 } = makeIo({ claimStore: store, sendEmail: async () => { sharedSendCount += 1; return { id: 'a' } } })
  const { io: io2 } = makeIo({ claimStore: store, sendEmail: async () => { sharedSendCount += 1; return { id: 'b' } } })

  const [r1, r2] = await Promise.all([
    executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io: io1 }),
    executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io: io2 }),
  ])

  const outcomes = [r1.outcome, r2.outcome].sort()
  assert.deepEqual(outcomes, [SEND_OUTCOME.CLAIM_LOST, SEND_OUTCOME.SENT].sort())
  assert.equal(sharedSendCount, 1)
})

// 4. manual approval double-submit -> at most one provider call
test('4: two concurrent manual-approval attempts for the same awaiting_signature identity send at most once', async () => {
  const store = makeClaimStore()
  const { priorAuthority, priorFactualBasis, priorRuleSnapshot } = validApprovalFixture()
  let sharedSendCount = 0
  const fetchAuthorityInputs = approvalFetchInputs()
  const { io: io1 } = makeIo({ claimStore: store, fetchAuthorityInputs, sendEmail: async () => { sharedSendCount += 1; return { id: 'a' } } })
  const { io: io2 } = makeIo({ claimStore: store, fetchAuthorityInputs, sendEmail: async () => { sharedSendCount += 1; return { id: 'b' } } })

  const [r1, r2] = await Promise.all([
    executeApprovalSend({ userId: USER_A, priorAuthority, priorFactualBasis, priorRuleSnapshot, invoiceId: INVOICE_X, text: 't', now: NOW, io: io1 }),
    executeApprovalSend({ userId: USER_A, priorAuthority, priorFactualBasis, priorRuleSnapshot, invoiceId: INVOICE_X, text: 't', now: NOW, io: io2 }),
  ])

  const outcomes = [r1.outcome, r2.outcome].sort()
  assert.deepEqual(outcomes, [SEND_OUTCOME.CLAIM_LOST, SEND_OUTCOME.SENT].sort())
  assert.equal(sharedSendCount, 1)
})

// "Edit First" concurrency: same as 4, but with founder-EDITED wording per
// caller -- proves the identity/claim is untouched by differing text.
test('4b: rapid concurrent Edit First submits (different edited wording) make at most one provider call', async () => {
  const store = makeClaimStore()
  const { priorAuthority, priorFactualBasis, priorRuleSnapshot } = validApprovalFixture()
  const fetchAuthorityInputs = approvalFetchInputs()
  const sentTexts = []
  const { io: io1 } = makeIo({ claimStore: store, fetchAuthorityInputs, sendEmail: async (args) => { sentTexts.push(args.text); return { id: 'a' } } })
  const { io: io2 } = makeIo({ claimStore: store, fetchAuthorityInputs, sendEmail: async (args) => { sentTexts.push(args.text); return { id: 'b' } } })

  const [r1, r2] = await Promise.all([
    executeApprovalSend({ userId: USER_A, priorAuthority, priorFactualBasis, priorRuleSnapshot, invoiceId: INVOICE_X, text: 'edited wording A', now: NOW, io: io1 }),
    executeApprovalSend({ userId: USER_A, priorAuthority, priorFactualBasis, priorRuleSnapshot, invoiceId: INVOICE_X, text: 'edited wording B', now: NOW, io: io2 }),
  ])
  const outcomes = [r1.outcome, r2.outcome].sort()
  assert.deepEqual(outcomes, [SEND_OUTCOME.CLAIM_LOST, SEND_OUTCOME.SENT].sort())
  assert.equal(sentTexts.length, 1, 'exactly one of the two edited variants must ever reach the provider')
})

// 5. no-email fallback -> zero provider calls, truthful review queue, real provenance
test('5: no email on file makes zero provider calls and queues for review with real authority + factual provenance', async () => {
  const invoice = baseInvoice({ clients: { email: null, name: 'Acme' } })
  const fetchAuthorityInputs = () => ({
    invoice,
    rules: [baseRule()],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls, queueForReviewCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.NO_EMAIL_FALLBACK)
  assert.equal(sendEmailCalls.length, 0)
  assert.equal(queueForReviewCalls.length, 1)
  assert.equal(queueForReviewCalls[0].reason, 'no_email_on_file')
  assert.equal(queueForReviewCalls[0].authority.authorized, true)
  assert.equal(queueForReviewCalls[0].authority.basis.ruleId, RULE_A)
  assert.deepEqual(queueForReviewCalls[0].factualBasis, deriveFactualBasis(invoice))
})

// 6. missing provider configuration before claim -> safely retryable
test('6: missing provider configuration makes zero provider calls and acquires no claim', async () => {
  const { io, sendEmailCalls, store } = makeIo({ isProviderConfigured: () => false })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.PROVIDER_NOT_CONFIGURED)
  assert.equal(sendEmailCalls.length, 0)
  assert.equal(store.claims.size, 0, 'no durable claim should exist -- this must remain retryable next run')
})

// 7. exception after request may have begun -> uncertain + no automatic retry
test('7: an exception during send resolves the claim as uncertain, leaves visible evidence, and blocks a later retry with a truthful outcome', async () => {
  const store = makeClaimStore()
  const { io: io1, recordUncertainCalls } = makeIo({ claimStore: store, sendEmail: async () => { throw new Error('network timeout') } })
  await assert.rejects(
    () => executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io: io1 }),
    /network timeout/
  )
  const claim = [...store.claims.values()][0]
  assert.equal(claim.status, 'uncertain')
  assert.equal(recordUncertainCalls.length, 1, 'an uncertain outcome must leave visible durable evidence, not just a claim-table status')
  assert.match(recordUncertainCalls[0].error, /network timeout/)

  const { io: io2, sendEmailCalls: calls2 } = makeIo({ claimStore: store })
  const retry = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io: io2 })
  assert.equal(retry.outcome, SEND_OUTCOME.CLAIM_LOST)
  // MEDIUM: the blocked outcome must expose what's actually known -- an
  // uncertain prior claim must never look identical to a confirmed send.
  assert.equal(retry.existingStatus, 'uncertain')
  assert.equal(calls2.length, 0, 'an uncertain outcome must never be auto-retried into a second client contact')
})

// 8. confirmed provider failure -> truthful failure evidence
test('8: a clean provider error response resolves the claim as send_failed with truthful evidence', async () => {
  const store = makeClaimStore()
  const { io, recordFailureCalls } = makeIo({ claimStore: store, sendEmail: async () => ({ error: 'invalid recipient' }) })
  await assert.rejects(
    () => executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io }),
    /invalid recipient/
  )
  const claim = [...store.claims.values()][0]
  assert.equal(claim.status, 'send_failed')
  assert.equal(recordFailureCalls.length, 1)
  assert.equal(recordFailureCalls[0].error, 'invalid recipient')

  const { io: io2, sendEmailCalls: calls2 } = makeIo({ claimStore: store })
  const retry = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io: io2 })
  assert.equal(retry.existingStatus, 'send_failed')
  assert.equal(calls2.length, 0)
})

// 9. successful send -> claim + receipt + reminder/last_reminder truth
test('9: a successful send resolves the claim as sent and records truthful evidence (including authority) exactly once', async () => {
  const store = makeClaimStore()
  const { io, recordSentCalls } = makeIo({ claimStore: store, sendEmail: async () => ({ id: 'resend-xyz' }) })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.SENT)
  assert.equal(result.providerMessageId, 'resend-xyz')
  const claim = [...store.claims.values()][0]
  assert.equal(claim.status, 'sent')
  assert.equal(recordSentCalls.length, 1)
  assert.equal(recordSentCalls[0].sendResult.id, 'resend-xyz')
  // MEDIUM (persisted rule snapshot integrity): the receipt must carry
  // what policy actually authorized the action, not just a bare rule id.
  assert.equal(recordSentCalls[0].authority.authorized, true)
  assert.equal(recordSentCalls[0].authority.basis.ruleId, RULE_A)
  assert.ok(recordSentCalls[0].authority.ruleSnapshotHash)
})

// 10. later different rule can become eligible after earlier handled
test('10a: a stale (already-handled) rule fails closed even though it still technically matches', async () => {
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice(),
    rules: [baseRule({ id: RULE_A, sort_order: 0 }), baseRule({ id: RULE_B, sort_order: 1, name: 'Firm reminder', tone: 'firm', trigger_days: 15 })],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set([`${INVOICE_X}:${RULE_A}`]),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(sendEmailCalls.length, 0)
})

test('10b: the later rule becomes the real winner once the earlier one is durably handled, and the fresh (not plan-time) rule/invoice build the message', async () => {
  const invoice = baseInvoice({ amount: 500, amount_paid: 0 }) // fresh balance $500.00
  const fetchAuthorityInputs = () => ({
    invoice,
    rules: [baseRule({ id: RULE_A, sort_order: 0 }), baseRule({ id: RULE_B, sort_order: 1, name: 'Firm reminder', tone: 'firm', trigger_days: 10 })],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set([`${INVOICE_X}:${RULE_A}`]),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_B, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.SENT)
  assert.equal(sendEmailCalls.length, 1)
  assert.match(sendEmailCalls[0].text, /\$500\.00/)
  assert.match(sendEmailCalls[0].text, /firm/) // RULE_B's tone, not RULE_A's "friendly"
})

// second review-fix pass, BLOCKER 3: fresh authority paired with a fresh
// draft, never a plan-time snapshot -- a partial payment between planning
// and send must change the sent balance.
test('fresh auto-send draft reflects a CURRENT balance/tone the caller could not have known at plan-time', async () => {
  const invoice = baseInvoice({ amount: 5000, amount_paid: 2000 }) // now $3,000.00 outstanding
  const fetchAuthorityInputs = () => ({
    invoice,
    rules: [baseRule({ tone: 'firm' })], // tone changed Friendly -> Firm since planning
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.SENT)
  assert.match(sendEmailCalls[0].text, /\$3,000\.00/)
  assert.doesNotMatch(sendEmailCalls[0].text, /\$5,000\.00/)
  assert.match(sendEmailCalls[0].text, /firm/)
})

// 11. stale authority cases listed under BLOCKER 2
test('11a: rule disabled immediately before send -> zero provider calls', async () => {
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice(),
    rules: [baseRule({ enabled: false })],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(sendEmailCalls.length, 0)
})

test('11b: invoice paid before send -> zero provider calls', async () => {
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice({ paid: true }),
    rules: [baseRule()],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(sendEmailCalls.length, 0)
})

test('11c: invoice paused before send -> zero provider calls', async () => {
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice({ autopilot_paused: true }),
    rules: [baseRule()],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(sendEmailCalls.length, 0)
})

test('11d: due date no longer matches before send -> zero provider calls', async () => {
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice({ due_date: '2026-08-12' }), // 1 day overdue, rule needs 5
    rules: [baseRule()],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(sendEmailCalls.length, 0)
})

test('11e: approval_required becomes true before send -> zero automatic provider calls', async () => {
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice(),
    rules: [baseRule()],
    autopilotSettings: autopilotSettings({ approval_required: true }),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(result.detail, 'permission_denied')
  assert.equal(sendEmailCalls.length, 0)
})

test('11f: Autopilot disabled entirely before send -> zero automatic provider calls', async () => {
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice(),
    rules: [baseRule()],
    autopilotSettings: autopilotSettings({ enabled: false }),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(sendEmailCalls.length, 0)
})

test('11g: current policy precedence changed to a different rule -> zero execution of the stale rule', async () => {
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice(),
    rules: [baseRule({ id: RULE_A, sort_order: 1 }), baseRule({ id: RULE_B, sort_order: 0, name: 'Newly enabled', trigger_days: 3 })],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(sendEmailCalls.length, 0)
})

// Approval-path (revalidateAuthority-based) equivalents of the BLOCKER 2 races
test('11h: manual approval fails closed when the rule was disabled since the draft was queued', async () => {
  const { priorAuthority, priorFactualBasis, priorRuleSnapshot } = validApprovalFixture()
  const fetchAuthorityInputs = approvalFetchInputs({ rules: [baseRule({ enabled: false })] })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeApprovalSend({ userId: USER_A, priorAuthority, priorFactualBasis, priorRuleSnapshot, invoiceId: INVOICE_X, text: 't', now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(sendEmailCalls.length, 0)
})

test('11i: manual approval fails closed when the rule changed since the draft was queued', async () => {
  const { priorAuthority, priorFactualBasis, priorRuleSnapshot } = validApprovalFixture()
  const fetchAuthorityInputs = approvalFetchInputs({ rules: [baseRule({ trigger_days: 999 })] }) // same id, changed content
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeApprovalSend({ userId: USER_A, priorAuthority, priorFactualBasis, priorRuleSnapshot, invoiceId: INVOICE_X, text: 't', now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(result.detail, 'rule_changed')
  assert.equal(sendEmailCalls.length, 0)
})

test('11j: manual approval fails closed on a malformed/legacy priorAuthority rather than inventing one', async () => {
  const { io, sendEmailCalls } = makeIo()
  const result = await executeApprovalSend({ userId: USER_A, priorAuthority: null, priorFactualBasis: null, priorRuleSnapshot: null, invoiceId: INVOICE_X, text: 't', now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(result.detail, 'prior_authority_invalid')
  assert.equal(sendEmailCalls.length, 0)
})

// second review-fix pass, BLOCKER 3: changed material invoice facts stale
// a queued approval even when authority/rule are otherwise unchanged.
test('11k: manual approval fails closed when the invoice balance changed (partial payment) since the draft was queued', async () => {
  const { priorAuthority, priorRuleSnapshot } = validApprovalFixture()
  const priorFactualBasis = deriveFactualBasis(baseInvoice()) // original $100.00
  const fetchAuthorityInputs = approvalFetchInputs({ invoice: baseInvoice({ amount_paid: 40 }) }) // now $60.00 outstanding
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeApprovalSend({ userId: USER_A, priorAuthority, priorFactualBasis, priorRuleSnapshot, invoiceId: INVOICE_X, text: 't', now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(result.detail, 'material_facts_changed')
  assert.equal(sendEmailCalls.length, 0)
})

test('11l: manual approval fails closed on a legacy row missing factualBasis/ruleSnapshot even with valid priorAuthority', async () => {
  const { priorAuthority } = validApprovalFixture()
  const fetchAuthorityInputs = approvalFetchInputs()
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeApprovalSend({ userId: USER_A, priorAuthority, priorFactualBasis: undefined, priorRuleSnapshot: undefined, invoiceId: INVOICE_X, text: 't', now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(sendEmailCalls.length, 0)
})

test('same rule, different invoice remains independent under the execution boundary', async () => {
  const store = makeClaimStore()
  const fetchAuthorityInputsFor = (invoiceId) => () => ({
    invoice: baseInvoice({ id: invoiceId }),
    rules: [baseRule()],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io: ioX } = makeIo({ claimStore: store, fetchAuthorityInputs: fetchAuthorityInputsFor(INVOICE_X) })
  const { io: ioY } = makeIo({ claimStore: store, fetchAuthorityInputs: fetchAuthorityInputsFor(INVOICE_Y) })
  const rX = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io: ioX })
  const rY = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_Y, ruleId: RULE_A, buildMessage, now: NOW, io: ioY })
  assert.equal(rX.outcome, SEND_OUTCOME.SENT)
  assert.equal(rY.outcome, SEND_OUTCOME.SENT)
})

test('deterministic idempotency key is identical across two evaluations of the same identity (used as the Resend header)', () => {
  const identity = { userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, actionType: ACTION_TYPE_SEND_REMINDER }
  assert.equal(buildIdempotencyKey(identity), buildIdempotencyKey({ ...identity }))
})

// ---------------------------------------------------------------------
// deriveFactualBasis / factualBasisMatches / ruleSnapshotsMatch unit coverage
test('deriveFactualBasis captures balance/due date/client name as the exact strings a draft would use', () => {
  const basis = deriveFactualBasis(baseInvoice({ amount: 250.5, amount_paid: 50.5 }))
  assert.equal(basis.balance, '$200.00')
  assert.equal(basis.clientName, 'Acme')
})

test('factualBasisMatches is false when either side is missing', () => {
  const basis = deriveFactualBasis(baseInvoice())
  assert.equal(factualBasisMatches(null, basis), false)
  assert.equal(factualBasisMatches(basis, null), false)
})

test('ruleSnapshotsMatch ignores non-policy fields (name) but catches policy fields (tone)', () => {
  const a = buildRuleSnapshot(baseRule({ name: 'Old name' }))
  const bSameName = buildRuleSnapshot(baseRule({ name: 'Old name' }))
  const bDifferentName = buildRuleSnapshot(baseRule({ name: 'New name' })) // buildRuleSnapshot excludes name anyway
  const bDifferentTone = buildRuleSnapshot(baseRule({ tone: 'firm' }))
  assert.equal(ruleSnapshotsMatch(a, bSameName), true)
  assert.equal(ruleSnapshotsMatch(a, bDifferentName), true)
  assert.equal(ruleSnapshotsMatch(a, bDifferentTone), false)
})

// ---------------------------------------------------------------------
// Real fetch-layer tests (autopilotAuthorityInputs.js) against a fake
// Supabase query-builder `admin` -- these are what the pure `io` fakes
// above could never catch, since they exercised the fetch layer itself,
// not a stand-in for it.

function fakeAdmin(tables) {
  return {
    from(table) {
      const spec = tables[table]
      const filters = []
      let single = false
      const builder = {
        select() {
          return builder
        },
        eq(col, val) {
          filters.push([col, val])
          return builder
        },
        maybeSingle() {
          single = true
          return builder
        },
        then(resolve, reject) {
          try {
            if (spec && spec.__error) {
              resolve({ data: null, error: spec.__error })
              return
            }
            const rows = Array.isArray(spec) ? spec : []
            let data = rows.filter((r) => filters.every(([c, v]) => r[c] === v))
            if (single) data = data[0] ?? null
            resolve({ data, error: null })
          } catch (err) {
            reject(err)
          }
        },
      }
      return builder
    },
  }
}

function baseTables(overrides = {}) {
  return {
    invoices: [baseInvoice()],
    autopilot_rules: [baseRule()],
    autopilot_settings: [autopilotSettings()],
    awaiting_signature: [],
    autopilot_execution_claims: [],
    ...overrides,
  }
}

// BLOCKER 1 required test: current pending row = self -> approval can revalidate
test('real fetchHandledState/fetchAuthorityInputs: the row being approved excludes only itself from pending/handled', async () => {
  const selfRow = { id: 'sig-self', user_id: USER_A, invoice_id: INVOICE_X, status: 'pending', ai_context: { rule_id: RULE_A } }
  const admin = fakeAdmin(baseTables({ awaiting_signature: [selfRow] }))

  const excluded = await fetchAuthorityInputs(admin, { userId: USER_A, invoiceId: INVOICE_X, excludeAwaitingSignatureId: 'sig-self' })
  assert.equal(excluded.pendingInvoiceIds.has(INVOICE_X), false)
  assert.equal(excluded.handledKeys.has(`${INVOICE_X}:${RULE_A}`), false)

  // Without exclusion, the row genuinely does self-block (proves the fix
  // is doing real work, not a no-op).
  const notExcluded = await fetchAuthorityInputs(admin, { userId: USER_A, invoiceId: INVOICE_X })
  assert.equal(notExcluded.pendingInvoiceIds.has(INVOICE_X), true)
  assert.equal(notExcluded.handledKeys.has(`${INVOICE_X}:${RULE_A}`), true)
})

test('real fetchHandledState: a DIFFERENT pending row for the same invoice still blocks', async () => {
  const selfRow = { id: 'sig-self', user_id: USER_A, invoice_id: INVOICE_X, status: 'pending', ai_context: { rule_id: RULE_A } }
  const otherPendingRow = { id: 'sig-other', user_id: USER_A, invoice_id: INVOICE_X, status: 'pending', ai_context: { rule_id: RULE_B } }
  const admin = fakeAdmin(baseTables({ awaiting_signature: [selfRow, otherPendingRow] }))

  const { pendingInvoiceIds, handledKeys } = await fetchHandledState(admin, USER_A, { excludeAwaitingSignatureId: 'sig-self' })
  assert.equal(pendingInvoiceIds.has(INVOICE_X), true, 'a different pending row for the same invoice must still block')
  assert.equal(handledKeys.has(`${INVOICE_X}:${RULE_B}`), true)
  assert.equal(handledKeys.has(`${INVOICE_X}:${RULE_A}`), false, 'only the excluded row itself is omitted')
})

test('real fetchHandledState: a prior historical execution claim still blocks regardless of exclusion', async () => {
  const selfRow = { id: 'sig-self', user_id: USER_A, invoice_id: INVOICE_X, status: 'pending', ai_context: { rule_id: RULE_A } }
  const admin = fakeAdmin(
    baseTables({
      awaiting_signature: [selfRow],
      autopilot_execution_claims: [{ user_id: USER_A, invoice_id: INVOICE_X, rule_id: RULE_B, action_type: 'send_reminder' }],
    })
  )
  const { handledKeys } = await fetchHandledState(admin, USER_A, { excludeAwaitingSignatureId: 'sig-self' })
  assert.equal(handledKeys.has(`${INVOICE_X}:${RULE_B}`), true, 'a prior claim for a DIFFERENT rule must still block that rule')
})

// HIGH: query errors must never become empty history
test('real fetchHandledState: an awaiting_signature read error fails closed (throws), never becomes an empty Set', async () => {
  const admin = fakeAdmin(baseTables({ awaiting_signature: { __error: { message: 'boom' } } }))
  await assert.rejects(() => fetchHandledState(admin, USER_A))
})

test('real fetchHandledState: an execution-claims read error fails closed (throws)', async () => {
  const admin = fakeAdmin(baseTables({ autopilot_execution_claims: { __error: { message: 'boom' } } }))
  await assert.rejects(() => fetchHandledState(admin, USER_A))
})

test('real fetchAuthorityInputs: a rules read error fails closed (throws)', async () => {
  const admin = fakeAdmin(baseTables({ autopilot_rules: { __error: { message: 'boom' } } }))
  await assert.rejects(() => fetchAuthorityInputs(admin, { userId: USER_A, invoiceId: INVOICE_X }))
})

test('real fetchAuthorityInputs: a settings read error fails closed (throws)', async () => {
  const admin = fakeAdmin(baseTables({ autopilot_settings: { __error: { message: 'boom' } } }))
  await assert.rejects(() => fetchAuthorityInputs(admin, { userId: USER_A, invoiceId: INVOICE_X }))
})

test('real fetchAuthorityInputs: an invoice read error fails closed (throws)', async () => {
  const admin = fakeAdmin(baseTables({ invoices: { __error: { message: 'boom' } } }))
  await assert.rejects(() => fetchAuthorityInputs(admin, { userId: USER_A, invoiceId: INVOICE_X }))
})

test('a fetchAuthorityInputs error means zero provider calls end to end through executeAutoSend', async () => {
  const admin = fakeAdmin(baseTables({ autopilot_rules: { __error: { message: 'boom' } } }))
  const { sendEmailCalls } = makeIo()
  const sendEmailCallsReal = []
  const io = {
    fetchAuthorityInputs: ({ invoiceId }) => fetchAuthorityInputs(admin, { userId: USER_A, invoiceId }),
    isProviderConfigured: () => true,
    acquireClaim: async () => ({ claimId: 'x', acquired: true }),
    resolveClaim: async () => {},
    sendEmail: async (args) => { sendEmailCallsReal.push(args); return { id: '1' } },
    queueForReview: async () => {},
    recordSentEvidence: async () => {},
    recordFailureEvidence: async () => {},
    recordUncertainEvidence: async () => {},
  }
  await assert.rejects(() => executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io }))
  assert.equal(sendEmailCallsReal.length, 0)
})

// ---------------------------------------------------------------------
// Third execution-safety review-fix pass, focused tests.

import { resolveExistingClaimStatus, claimLostMessage, EXISTING_CLAIM_STATUS_UNKNOWN } from '../supabase/functions/_shared/executionClaim.js'

// 1. same invoice/client facts -> approval remains valid
test('T1: an approval with unchanged client_id/recipientEmail (and every other fact) remains valid', async () => {
  const { priorAuthority, priorFactualBasis, priorRuleSnapshot } = validApprovalFixture()
  const fetchAuthorityInputs = approvalFetchInputs() // baseInvoice(): same client_id/email as the fixture
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeApprovalSend({ userId: USER_A, priorAuthority, priorFactualBasis, priorRuleSnapshot, invoiceId: INVOICE_X, text: 't', now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.SENT)
  assert.equal(sendEmailCalls.length, 1)
})

// 2. changed client_id -> stale, zero provider calls
test('T2: a reassigned client_id stales a queued approval even though every displayed fact still matches', async () => {
  const { priorAuthority, priorRuleSnapshot } = validApprovalFixture()
  const priorFactualBasis = deriveFactualBasis(baseInvoice()) // originally CLIENT_A
  // Same balance/due date/name (clients.name unchanged) but reassigned to a
  // different client id and a different mailbox behind that same name.
  const reassigned = baseInvoice({ client_id: CLIENT_B, clients: { email: 'other-inbox@example.test', name: 'Acme' } })
  const fetchAuthorityInputs = approvalFetchInputs({ invoice: reassigned })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeApprovalSend({ userId: USER_A, priorAuthority, priorFactualBasis, priorRuleSnapshot, invoiceId: INVOICE_X, text: 't', now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(result.detail, 'material_facts_changed')
  assert.equal(sendEmailCalls.length, 0)
})

// 3. changed recipient email -> stale, zero provider calls
test('T3: a changed recipient email on the SAME client stales a queued approval', async () => {
  const { priorAuthority, priorRuleSnapshot } = validApprovalFixture()
  const priorFactualBasis = deriveFactualBasis(baseInvoice())
  const emailChanged = baseInvoice({ clients: { email: 'new-address@example.test', name: 'Acme' } })
  const fetchAuthorityInputs = approvalFetchInputs({ invoice: emailChanged })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeApprovalSend({ userId: USER_A, priorAuthority, priorFactualBasis, priorRuleSnapshot, invoiceId: INVOICE_X, text: 't', now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(result.detail, 'material_facts_changed')
  assert.equal(sendEmailCalls.length, 0)
})

// 4. no-email queue contains authority + factualBasis + ruleSnapshot
test('T4: the no-email review queue payload carries authority, factualBasis, AND ruleSnapshot', async () => {
  const invoice = baseInvoice({ clients: { email: null, name: 'Acme' } })
  const rule = baseRule()
  const fetchAuthorityInputs = () => ({
    invoice,
    rules: [rule],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, queueForReviewCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.NO_EMAIL_FALLBACK)
  assert.equal(queueForReviewCalls.length, 1)
  const payload = queueForReviewCalls[0]
  assert.ok(payload.authority, 'payload must carry authority')
  assert.ok(payload.factualBasis, 'payload must carry factualBasis')
  assert.deepEqual(payload.ruleSnapshot, buildRuleSnapshot(rule), 'payload must carry the canonical ruleSnapshot')
})

// 5. claim/receipt provenance exists before sendEmail is called
test('T5: the durable claim/receipt is written BEFORE sendEmail is ever invoked', async () => {
  const store = makeClaimStore()
  const observed = []
  const { io } = makeIo({
    claimStore: store,
    sendEmail: async (args) => {
      // At the moment sendEmail is invoked, exactly one claim must already
      // exist and already carry a full receipt -- acquireClaim (and its
      // receipt write) strictly precedes the provider call.
      observed.push([...store.claims.values()].map((v) => v.receipt))
      return { id: 'resend-id' }
    },
  })
  await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(observed.length, 1)
  const [receipts] = observed
  assert.equal(receipts.length, 1)
  const receipt = receipts[0]
  assert.ok(receipt, 'a receipt must exist before the provider call')
  assert.equal(receipt.userId, USER_A)
  assert.equal(receipt.invoiceId, INVOICE_X)
  assert.equal(receipt.ruleId, RULE_A)
  assert.equal(receipt.actionType, ACTION_TYPE_SEND_REMINDER)
  assert.ok(receipt.idempotencyKey)
  assert.ok(receipt.ruleSnapshot, 'receipt must carry the canonical rule snapshot')
  assert.ok(receipt.ruleSnapshotHash, 'receipt must carry ruleSnapshotHash')
  assert.ok(receipt.factualBasis, 'receipt must carry the factual basis')
  assert.ok(receipt.authorizedAt, 'receipt must carry the authorization evaluatedAt')
  assert.ok(receipt.claimedAt, 'receipt must carry the claimed-at time')
})

// 6/7/8. successful/uncertain/failed sends resolve the SAME receipt, never a
// fresh or different one -- and the pre-send fields survive resolution.
test('T6: a successful send resolves the SAME receipt to sent, without losing its pre-send fields', async () => {
  const store = makeClaimStore()
  const { io } = makeIo({ claimStore: store, sendEmail: async () => ({ id: 'resend-1' }) })
  const result = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io })
  assert.equal(result.outcome, SEND_OUTCOME.SENT)
  const claim = [...store.claims.values()][0]
  assert.equal(claim.status, 'sent')
  assert.ok(claim.receipt.ruleSnapshot, 'pre-send receipt fields must still be present after resolution')
  assert.equal(claim.evidence.resend_id, 'resend-1')
})

test('T7: an uncertain send resolves the SAME receipt to uncertain, without losing its pre-send fields', async () => {
  const store = makeClaimStore()
  const { io } = makeIo({ claimStore: store, sendEmail: async () => { throw new Error('timeout') } })
  await assert.rejects(() => executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io }))
  const claim = [...store.claims.values()][0]
  assert.equal(claim.status, 'uncertain')
  assert.ok(claim.receipt.factualBasis, 'pre-send receipt fields must still be present after resolution')
})

test('T8: a failed send resolves the SAME receipt to send_failed, without losing its pre-send fields', async () => {
  const store = makeClaimStore()
  const { io } = makeIo({ claimStore: store, sendEmail: async () => ({ error: 'bounced' }) })
  await assert.rejects(() => executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io }))
  const claim = [...store.claims.values()][0]
  assert.equal(claim.status, 'send_failed')
  assert.ok(claim.receipt.ruleSnapshotHash, 'pre-send receipt fields must still be present after resolution')
})

// 9. Activity/event projection failure cannot remove the canonical receipt
test('T9: an Activity/events projection failure (recordSentEvidence throwing) cannot erase the already-resolved canonical receipt', async () => {
  const store = makeClaimStore()
  const { io } = makeIo({
    claimStore: store,
    sendEmail: async () => ({ id: 'resend-9' }),
    // Simulate the founder-facing Activity/events write failing AFTER the
    // claim itself was already durably resolved.
  })
  io.recordSentEvidence = async () => {
    throw new Error('events insert failed')
  }
  await assert.rejects(
    () => executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, buildMessage, now: NOW, io }),
    /events insert failed/
  )
  const claim = [...store.claims.values()][0]
  assert.equal(claim.status, 'sent', 'the canonical receipt must still say sent even though the Activity projection failed')
  assert.equal(claim.evidence.resend_id, 'resend-9')
})

// 10. existing-status query unavailable -> truthful unknown state, zero send
test('T10a: resolveExistingClaimStatus never collapses a query error into null/"no status"', () => {
  assert.equal(resolveExistingClaimStatus({ error: { message: 'boom' }, status: null }), EXISTING_CLAIM_STATUS_UNKNOWN)
  assert.equal(resolveExistingClaimStatus({ error: { message: 'boom' }, status: 'sent' }), EXISTING_CLAIM_STATUS_UNKNOWN, 'an error always wins, regardless of any stale status also present')
  assert.equal(resolveExistingClaimStatus({ error: null, status: 'sent' }), 'sent')
  assert.equal(resolveExistingClaimStatus({ error: null, status: null }), null)
  assert.equal(resolveExistingClaimStatus({}), null)
})

test('T10b: claimLostMessage gives a truthful "couldn\'t verify" copy for the unknown state, never a generic "in progress"', () => {
  const unknownMessage = claimLostMessage(EXISTING_CLAIM_STATUS_UNKNOWN)
  assert.match(unknownMessage, /couldn't verify its status/)
  assert.doesNotMatch(unknownMessage, /already in progress/)
  // Contrast: genuinely unknown (no error, no status at all) still falls
  // back to the pre-existing generic "in progress" copy -- only an actual
  // query ERROR gets the new "unknown" outcome.
  assert.match(claimLostMessage(null), /already in progress/)
})

test('T10c: acquireClaim adapters route a real query error through resolveExistingClaimStatus, making zero provider calls', () => {
  // This proves the pure decision function both real Deno adapters
  // (autopilot-scheduler, send-reminder-email) now call: a query error
  // must never be silently mapped to "in progress" -- it is exercised here
  // exactly as those adapters call it, id est with a real error object.
  const outcome = resolveExistingClaimStatus({ error: { message: 'connection reset' }, status: undefined })
  assert.equal(outcome, EXISTING_CLAIM_STATUS_UNKNOWN)
  assert.equal(claimLostMessage(outcome), "Duewatch found an existing execution record but couldn't verify its status. No new reminder was sent.")
})
