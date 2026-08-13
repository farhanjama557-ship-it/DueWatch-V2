import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SEND_OUTCOME,
  executeAutoSend,
  executeApprovalSend,
} from '../supabase/functions/_shared/autopilotExecutionCore.js'
import { ACTION_TYPE_SEND_REMINDER, buildExecutionIdentity, buildIdempotencyKey } from '../supabase/functions/_shared/executionClaim.js'
import { evaluateNextActionAuthority } from '../supabase/functions/_shared/nextActionAuthority.js'

// Post-2A.1 execution safety checkpoint, review-fix pass: the BEHAVIORAL
// TEST GAP list, exercised against the real orchestration
// (autopilotExecutionCore.js) via an injected in-memory `io` fake — never
// against Deno or a real Resend/Supabase connection. This is what
// "dependency injection / extraction ... to test the execution boundary
// without actually calling Resend" means concretely.

const USER_A = '11111111-1111-4111-8111-111111111111'
const INVOICE_X = '33333333-3333-4333-8333-333333333333'
const INVOICE_Y = '44444444-4444-4444-8444-444444444444'
const RULE_A = '55555555-5555-4555-8555-555555555555'
const RULE_B = '66666666-6666-4666-8666-666666666666'
const NOW = new Date('2026-08-13T12:00:00.000Z')

function baseInvoice(overrides = {}) {
  return {
    id: INVOICE_X,
    user_id: USER_A,
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
    async acquireClaim({ userId, invoiceId, ruleId, actionType }) {
      const key = `${userId}:${invoiceId}:${ruleId}:${actionType}`
      const existing = claims.get(key)
      if (existing) return { claimId: existing.claimId, acquired: false }
      n += 1
      const claimId = `claim-${n}`
      claims.set(key, { claimId, status: 'in_flight' })
      return { claimId, acquired: true }
    },
    async resolveClaim({ claimId, status }) {
      for (const v of claims.values()) {
        if (v.claimId === claimId) v.status = status
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

function validPriorAuthority(overrides = {}) {
  const evaluation = evaluateNextActionAuthority({
    userId: USER_A,
    invoice: baseInvoice(),
    rules: [baseRule()],
    autopilotSettings: autopilotSettings({ approval_required: true }),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
    now: NOW,
  })
  assert.ok(evaluation.authority.authorized, 'test fixture setup: expected the base fixture to be authorized')
  return { ...evaluation.authority, ...overrides }
}

// 1. first auto execution -> claim winner -> one provider call
test('1: first auto execution acquires the claim and sends exactly once', async () => {
  const { io, sendEmailCalls } = makeIo()
  const result = await executeAutoSend({
    userId: USER_A,
    invoiceId: INVOICE_X,
    ruleId: RULE_A,
    subject: 'Regarding invoice INV-1',
    text: 'draft',
    now: NOW,
    io,
  })
  assert.equal(result.outcome, SEND_OUTCOME.SENT)
  assert.equal(sendEmailCalls.length, 1)
})

// 2. same action later -> zero new provider calls
test('2: a later call for the same identity makes zero new provider calls', async () => {
  const store = makeClaimStore()
  const { io: io1, sendEmailCalls: calls1 } = makeIo({ claimStore: store })
  const first = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io: io1,
  })
  assert.equal(first.outcome, SEND_OUTCOME.SENT)

  const { io: io2, sendEmailCalls: calls2 } = makeIo({ claimStore: store })
  const second = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io: io2,
  })
  assert.equal(second.outcome, SEND_OUTCOME.CLAIM_LOST)
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
    executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io: io1 }),
    executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io: io2 }),
  ])

  const outcomes = [r1.outcome, r2.outcome].sort()
  assert.deepEqual(outcomes, [SEND_OUTCOME.CLAIM_LOST, SEND_OUTCOME.SENT].sort())
  assert.equal(sharedSendCount, 1)
})

// 4. manual approval double-submit -> at most one provider call
test('4: two concurrent manual-approval attempts for the same awaiting_signature identity send at most once', async () => {
  const store = makeClaimStore()
  const priorAuthority = validPriorAuthority()
  let sharedSendCount = 0
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice(),
    rules: [baseRule()],
    autopilotSettings: autopilotSettings({ approval_required: true }),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io: io1 } = makeIo({ claimStore: store, fetchAuthorityInputs, sendEmail: async () => { sharedSendCount += 1; return { id: 'a' } } })
  const { io: io2 } = makeIo({ claimStore: store, fetchAuthorityInputs, sendEmail: async () => { sharedSendCount += 1; return { id: 'b' } } })

  const [r1, r2] = await Promise.all([
    executeApprovalSend({ userId: USER_A, priorAuthority, invoiceId: INVOICE_X, subject: 's', text: 't', now: NOW, io: io1 }),
    executeApprovalSend({ userId: USER_A, priorAuthority, invoiceId: INVOICE_X, subject: 's', text: 't', now: NOW, io: io2 }),
  ])

  const outcomes = [r1.outcome, r2.outcome].sort()
  assert.deepEqual(outcomes, [SEND_OUTCOME.CLAIM_LOST, SEND_OUTCOME.SENT].sort())
  assert.equal(sharedSendCount, 1)
})

// 5. no-email fallback -> zero provider calls, truthful review queue
test('5: no email on file makes zero provider calls and queues for review', async () => {
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice({ clients: { email: null, name: 'Acme' } }),
    rules: [baseRule()],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls, queueForReviewCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io,
  })
  assert.equal(result.outcome, SEND_OUTCOME.NO_EMAIL_FALLBACK)
  assert.equal(sendEmailCalls.length, 0)
  assert.equal(queueForReviewCalls.length, 1)
  assert.equal(queueForReviewCalls[0].reason, 'no_email_on_file')
})

// 6. missing provider configuration before claim -> safely retryable
test('6: missing provider configuration makes zero provider calls and acquires no claim', async () => {
  const { io, sendEmailCalls, store } = makeIo({ isProviderConfigured: () => false })
  const result = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io,
  })
  assert.equal(result.outcome, SEND_OUTCOME.PROVIDER_NOT_CONFIGURED)
  assert.equal(sendEmailCalls.length, 0)
  assert.equal(store.claims.size, 0, 'no durable claim should exist -- this must remain retryable next run')
})

// 7. exception after request may have begun -> uncertain + no automatic retry
test('7: an exception during send resolves the claim as uncertain, leaves visible evidence, and blocks a later retry', async () => {
  const store = makeClaimStore()
  const { io: io1, recordUncertainCalls } = makeIo({ claimStore: store, sendEmail: async () => { throw new Error('network timeout') } })
  await assert.rejects(
    () => executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io: io1 }),
    /network timeout/
  )
  const claim = [...store.claims.values()][0]
  assert.equal(claim.status, 'uncertain')
  assert.equal(recordUncertainCalls.length, 1, 'an uncertain outcome must leave visible durable evidence, not just a claim-table status')
  assert.match(recordUncertainCalls[0].error, /network timeout/)

  const { io: io2, sendEmailCalls: calls2 } = makeIo({ claimStore: store })
  const retry = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io: io2,
  })
  assert.equal(retry.outcome, SEND_OUTCOME.CLAIM_LOST)
  assert.equal(calls2.length, 0, 'an uncertain outcome must never be auto-retried into a second client contact')
})

// 8. confirmed provider failure -> truthful failure evidence
test('8: a clean provider error response resolves the claim as send_failed with truthful evidence', async () => {
  const store = makeClaimStore()
  const { io, recordFailureCalls } = makeIo({ claimStore: store, sendEmail: async () => ({ error: 'invalid recipient' }) })
  await assert.rejects(
    () => executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io }),
    /invalid recipient/
  )
  const claim = [...store.claims.values()][0]
  assert.equal(claim.status, 'send_failed')
  assert.equal(recordFailureCalls.length, 1)
  assert.equal(recordFailureCalls[0].error, 'invalid recipient')
})

// 9. successful send -> claim + receipt + reminder/last_reminder truth
test('9: a successful send resolves the claim as sent and records truthful evidence exactly once', async () => {
  const store = makeClaimStore()
  const { io, recordSentCalls } = makeIo({ claimStore: store, sendEmail: async () => ({ id: 'resend-xyz' }) })
  const result = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io,
  })
  assert.equal(result.outcome, SEND_OUTCOME.SENT)
  assert.equal(result.providerMessageId, 'resend-xyz')
  const claim = [...store.claims.values()][0]
  assert.equal(claim.status, 'sent')
  assert.equal(recordSentCalls.length, 1)
  assert.equal(recordSentCalls[0].sendResult.id, 'resend-xyz')
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
  const result = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io,
  })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(sendEmailCalls.length, 0)
})

test('10b: the later rule becomes the real winner once the earlier one is durably handled', async () => {
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice(),
    rules: [baseRule({ id: RULE_A, sort_order: 0 }), baseRule({ id: RULE_B, sort_order: 1, name: 'Firm reminder', tone: 'firm', trigger_days: 10 })],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set([`${INVOICE_X}:${RULE_A}`]),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_B, subject: 's', text: 't', now: NOW, io,
  })
  assert.equal(result.outcome, SEND_OUTCOME.SENT)
  assert.equal(sendEmailCalls.length, 1)
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
  const result = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io,
  })
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
  const result = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io,
  })
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
  const result = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io,
  })
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
  const result = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io,
  })
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
  const result = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io,
  })
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
  const result = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io,
  })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(sendEmailCalls.length, 0)
})

test('11g: current policy precedence changed to a different rule -> zero execution of the stale rule', async () => {
  // RULE_B now has an EARLIER sort_order than RULE_A and also matches --
  // current policy as a whole now picks RULE_B, so RULE_A is stale even
  // though it still individually matches.
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice(),
    rules: [baseRule({ id: RULE_A, sort_order: 1 }), baseRule({ id: RULE_B, sort_order: 0, name: 'Newly enabled', trigger_days: 3 })],
    autopilotSettings: autopilotSettings(),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeAutoSend({
    userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io,
  })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(sendEmailCalls.length, 0)
})

// Approval-path (revalidateAuthority-based) equivalents of the BLOCKER 2 races
test('11h: manual approval fails closed when the rule was disabled since the draft was queued', async () => {
  const priorAuthority = validPriorAuthority()
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice(),
    rules: [baseRule({ enabled: false })],
    autopilotSettings: autopilotSettings({ approval_required: true }),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeApprovalSend({
    userId: USER_A, priorAuthority, invoiceId: INVOICE_X, subject: 's', text: 't', now: NOW, io,
  })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(sendEmailCalls.length, 0)
})

test('11i: manual approval fails closed when the rule changed since the draft was queued', async () => {
  const priorAuthority = validPriorAuthority()
  const fetchAuthorityInputs = () => ({
    invoice: baseInvoice(),
    rules: [baseRule({ trigger_days: 999 })], // same id, changed content -> different snapshot hash
    autopilotSettings: autopilotSettings({ approval_required: true }),
    handledKeys: new Set(),
    pendingInvoiceIds: new Set(),
  })
  const { io, sendEmailCalls } = makeIo({ fetchAuthorityInputs })
  const result = await executeApprovalSend({
    userId: USER_A, priorAuthority, invoiceId: INVOICE_X, subject: 's', text: 't', now: NOW, io,
  })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(result.detail, 'rule_changed')
  assert.equal(sendEmailCalls.length, 0)
})

test('11j: manual approval fails closed on a malformed/legacy priorAuthority rather than inventing one', async () => {
  const { io, sendEmailCalls } = makeIo()
  const result = await executeApprovalSend({
    userId: USER_A, priorAuthority: null, invoiceId: INVOICE_X, subject: 's', text: 't', now: NOW, io,
  })
  assert.equal(result.outcome, SEND_OUTCOME.STALE_AUTHORITY)
  assert.equal(result.detail, 'prior_authority_invalid')
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
  const rX = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io: ioX })
  const rY = await executeAutoSend({ userId: USER_A, invoiceId: INVOICE_Y, ruleId: RULE_A, subject: 's', text: 't', now: NOW, io: ioY })
  assert.equal(rX.outcome, SEND_OUTCOME.SENT)
  assert.equal(rY.outcome, SEND_OUTCOME.SENT)
})

test('deterministic idempotency key is identical across two evaluations of the same identity (used as the Resend header)', () => {
  const identity = { userId: USER_A, invoiceId: INVOICE_X, ruleId: RULE_A, actionType: ACTION_TYPE_SEND_REMINDER }
  assert.equal(buildIdempotencyKey(identity), buildIdempotencyKey({ ...identity }))
})
