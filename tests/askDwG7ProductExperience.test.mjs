import test from 'node:test'
import assert from 'node:assert/strict'

import { createAskDwCaseState } from '../src/lib/dwIntelligence/askDwCaseState.js'
import { createAskDwCaseAwareRuntime } from '../src/lib/dwIntelligence/askDwConversationRuntime.js'

const NOW = new Date('2026-09-01T20:00:00.000Z')

function state() {
  return createAskDwCaseState({
    tenantId: 'tenant-a',
    conversationId: 'conversation-a',
    caseId: 'primary',
    turnId: 'bootstrap',
    now: NOW.toISOString(),
  })
}

function liveResult(scope) {
  return {
    truthLock: { canonicalFacts: { scope }, authority: { actual: 'NOT_GRANTED' } },
    intelligence: { execution: { sideEffect: false } },
    liveReadReceipt: { source: 'TEST_READ', writesPerformed: false },
    answer: { executiveConclusion: `${scope} answer` },
    verification: { verdict: 'PASS', issues: [], checkedClaims: [] },
  }
}

function atlasWithTwoInvoices() {
  return {
    status: 'NEEDS_INVOICE_RESOLUTION',
    blocked: true,
    reason: 'The client has more than one resolved invoice; explicit invoice selection is required.',
    events: [
      { type: 'SET_ACTIVE_CLIENT', payload: { clientRef: { kind: 'client', id: 'atlas' } } },
      {
        type: 'SET_INVOICE_CANDIDATES',
        payload: { invoiceRefs: [{ kind: 'invoice', id: 'inv-a' }, { kind: 'invoice', id: 'inv-b' }] },
      },
    ],
  }
}

test('G7-CP7 client-level Atlas question does not force invoice selection', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    async runInvoiceQuestion(args) { calls.push({ kind: 'invoice', args }); return liveResult('INVOICE') },
    async runScopedQuestion(args) { calls.push({ kind: 'scoped', args }); return liveResult(args.scope) },
    async resolveCaseEvents() { return atlasWithTwoInvoices() },
  })

  const result = await runtime.runTurn({
    tenantId: 'tenant-a', caseState: state(), turnId: 't1',
    text: 'what about Atlas?', mode: 'normal', now: NOW,
  })

  assert.equal(result.status, 'ANSWERED')
  assert.equal(result.caseContext.focus.clientRef.id, 'atlas')
  assert.equal(result.caseContext.focus.invoiceRef, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'scoped')
  assert.equal(calls[0].args.scope, 'CLIENT')
  assert.equal(calls[0].args.clientId, 'atlas')
  assert.equal(result.safeguards.scopedAnswerDidNotRequireInvoice, true)
})

test('G7-CP7 a specific ordinal still uses the deterministic invoice candidate', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    async runInvoiceQuestion(args) { calls.push({ kind: 'invoice', args }); return liveResult('INVOICE') },
    async runScopedQuestion(args) { calls.push({ kind: 'scoped', args }); return liveResult(args.scope) },
    async resolveCaseEvents() { return atlasWithTwoInvoices() },
  })

  const result = await runtime.runTurn({
    tenantId: 'tenant-a', caseState: state(), turnId: 't1',
    text: 'the second invoice', mode: 'deep', now: NOW,
  })

  assert.equal(result.status, 'ANSWERED')
  assert.equal(result.caseContext.focus.invoiceRef.id, 'inv-b')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'invoice')
  assert.equal(calls[0].args.invoiceId, 'inv-b')
  assert.equal(calls[0].args.mode, 'deep')
})

test('G7-CP7 portfolio conversation does not require a client or invoice', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    async runInvoiceQuestion(args) { calls.push({ kind: 'invoice', args }); return liveResult('INVOICE') },
    async runScopedQuestion(args) { calls.push({ kind: 'scoped', args }); return liveResult(args.scope) },
    async resolveCaseEvents() {
      return {
        status: 'NEEDS_CLIENT_RESOLUTION', blocked: true, events: [],
        reason: 'No client reference could be resolved.',
      }
    },
  })

  const result = await runtime.runTurn({
    tenantId: 'tenant-a', caseState: state(), turnId: 't1',
    text: 'good morning', mode: 'normal', now: NOW,
  })

  assert.equal(result.status, 'ANSWERED')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'scoped')
  assert.equal(calls[0].args.scope, 'PORTFOLIO')
  assert.equal(calls[0].args.clientId, null)
})

test('G7-CP7 ambiguous client identity still fails closed', async () => {
  let called = false
  const runtime = createAskDwCaseAwareRuntime({
    async runInvoiceQuestion() { called = true; return liveResult('INVOICE') },
    async runScopedQuestion() { called = true; return liveResult('CLIENT') },
    async resolveCaseEvents() {
      return {
        status: 'NEEDS_CLIENT_RESOLUTION', blocked: true, events: [],
        reason: 'More than one client matches this reference.',
      }
    },
  })

  const result = await runtime.runTurn({
    tenantId: 'tenant-a', caseState: state(), turnId: 't1',
    text: 'what about Atlas?', mode: 'normal', now: NOW,
  })

  assert.equal(result.status, 'NEEDS_CLIENT_RESOLUTION')
  assert.equal(called, false)
  assert.match(result.reason, /More than one client/)
})

test('G7-CP7 Company Brain and needs-you context pass through without persistence', async () => {
  const seen = []
  const runtime = createAskDwCaseAwareRuntime({
    async runInvoiceQuestion(args) { seen.push(args); return liveResult('INVOICE') },
    async runScopedQuestion(args) { seen.push(args); return liveResult(args.scope) },
    async resolveCaseEvents() {
      return {
        status: 'NEEDS_CLIENT_RESOLUTION', blocked: true, events: [], reason: 'No subject.',
      }
    },
  })
  const companyBrainReadModel = { kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_READ_MODEL_V0' }
  const needsYouReadModel = { count: 0, items: [] }
  await runtime.runTurn({
    tenantId: 'tenant-a', caseState: state(), turnId: 't1', text: 'anything urgent?', now: NOW,
    companyBrainReadModel, needsYouReadModel,
  })
  assert.equal(seen[0].companyBrainReadModel, companyBrainReadModel)
  assert.equal(seen[0].needsYouReadModel, needsYouReadModel)
})
