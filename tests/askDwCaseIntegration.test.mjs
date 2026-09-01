import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  ASK_DW_ACTION_STATUS,
  ASK_DW_CASE_EVENT,
  applyAskDwCaseEvent,
  createAskDwCaseState,
  getAskDwActiveAction,
  getAskDwActiveCase,
} from '../src/lib/dwIntelligence/askDwCaseState.js'
import {
  buildAskDwCaseContext,
  createAskDwCaseAwareRuntime,
  resolveAskDwDeterministicCaseControl,
} from '../src/lib/dwIntelligence/askDwConversationRuntime.js'
import { createAskDwOrchestrator } from '../src/lib/dwIntelligence/askDwOrchestrator.js'
import { createAskDwLiveRuntime } from '../src/lib/dwIntelligence/askDwLiveRuntime.js'

const T = 'tenant-a'
const at = (n) => `2026-08-26T20:${String(n).padStart(2, '0')}:00.000Z`

function initial(overrides = {}) {
  return createAskDwCaseState({
    tenantId: T,
    conversationId: 'conv-1',
    caseId: 'case-anthony',
    turnId: 'turn-0',
    now: at(0),
    ...overrides,
  })
}

function event(state, type, payload = {}, {
  turnId = `setup-${state.version + 1}`,
  time = state.version + 1,
  tenantId = T,
} = {}) {
  return applyAskDwCaseEvent(state, {
    type,
    payload,
    tenantId,
    expectedVersion: state.version,
    turnId,
    at: at(time),
  })
}

function invoiceCase({ twoInvoices = false } = {}) {
  let state = initial()
  state = event(state, ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT, {
    clientRef: { kind: 'client', id: 'client-anthony' },
  })
  const invoiceRefs = [
    { kind: 'invoice', id: 'inv-1844' },
    ...(twoInvoices ? [{ kind: 'invoice', id: 'inv-1902' }] : []),
  ]
  state = event(state, ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES, { invoiceRefs })
  state = event(state, ASK_DW_CASE_EVENT.SELECT_INVOICE, {
    invoiceRef: invoiceRefs[0],
  })
  return state
}

function actionCase({ suspended = false } = {}) {
  let state = invoiceCase()
  state = event(state, ASK_DW_CASE_EVENT.OFFER_ACTION, {
    actionId: 'action-1844',
    actionType: 'ATTACH_EVIDENCE_TO_REMINDER',
    targetRefs: [{ kind: 'invoice', id: 'inv-1844' }],
    scope: 'INVOICE',
  }, { turnId: 'turn-offer', time: 5 })
  state = event(state, ASK_DW_CASE_EVENT.REQUEST_ACTION_CONFIRMATION, {
    actionId: 'action-1844',
  }, { turnId: 'turn-confirm-request', time: 6 })
  if (suspended) {
    state = event(state, ASK_DW_CASE_EVENT.SUSPEND_ACTION, {
      actionId: 'action-1844',
    }, { turnId: 'turn-suspend', time: 7 })
  }
  return state
}

function fakeInvoiceRunner(log, {
  sideEffect = false,
  writesPerformed = false,
  authorityActual = 'NOT_GRANTED',
} = {}) {
  return async (args) => {
    log.push(args)
    return {
      core: {
        intelligence: {
          execution: {
            sideEffect,
          },
        },
      },
      truthLock: {
        canonicalFacts: {
          invoiceId: args.invoiceId,
          balance: 750,
        },
        authority: {
          actual: authorityActual,
        },
      },
      liveReadReceipt: {
        writesPerformed,
      },
      answer: {
        executiveConclusion: 'Fresh answer.',
      },
    }
  }
}

test('M1E case context is reference-only and carries presentation continuity', () => {
  let state = invoiceCase()
  state = event(state, ASK_DW_CASE_EVENT.SET_EVIDENCE_REFS, {
    evidenceRefs: [{ kind: 'evidence', id: 'ev-1' }],
  })
  state = event(state, ASK_DW_CASE_EVENT.SET_PRESENTATION, {
    tone: 'EXECUTIVE',
    detail: 'BRIEF',
  })

  const context = buildAskDwCaseContext(state)
  assert.equal(context.focus.clientRef.id, 'client-anthony')
  assert.equal(context.focus.invoiceRef.id, 'inv-1844')
  assert.equal(context.presentation.detail, 'BRIEF')
  assert.deepEqual(context.evidenceRefs, [{ kind: 'evidence', id: 'ev-1' }])

  const serialized = JSON.stringify(context)
  assert.equal(serialized.includes('"balance"'), false)
  assert.equal(serialized.includes('"amount"'), false)
  assert.equal(serialized.includes('"canonicalFacts"'), false)
  assert.equal(serialized.includes('"permissions"'), false)
})

test('M1E blocks cross-tenant turns before any live read', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(calls),
  })

  await assert.rejects(() => runtime.runTurn({
    tenantId: 'tenant-b',
    caseState: invoiceCase(),
    turnId: 'turn-1',
    text: 'What is going on?',
    now: new Date(at(10)),
  }), /cross-tenant turn blocked/)

  assert.equal(calls.length, 0)
})

test('"nah the other invoice" deterministically switches the unique alternate before the fresh read', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(calls),
  })

  const result = await runtime.runTurn({
    tenantId: T,
    caseState: invoiceCase({ twoInvoices: true }),
    turnId: 'turn-other',
    text: 'nah the other invoice',
    now: new Date(at(10)),
  })

  assert.equal(result.status, 'ANSWERED')
  assert.equal(result.control.classification, 'CORRECT_ACTIVE_INVOICE')
  assert.equal(result.caseContext.focus.invoiceRef.id, 'inv-1902')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].invoiceId, 'inv-1902')
})

test('"the other invoice" fails closed when more than one alternate is possible', async () => {
  let state = invoiceCase({ twoInvoices: true })
  state = event(state, ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES, {
    invoiceRefs: [
      { kind: 'invoice', id: 'inv-1844' },
      { kind: 'invoice', id: 'inv-1902' },
      { kind: 'invoice', id: 'inv-2001' },
    ],
  })

  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(calls),
  })
  const result = await runtime.runTurn({
    tenantId: T,
    caseState: state,
    turnId: 'turn-other',
    text: 'the other invoice',
    now: new Date(at(12)),
  })

  assert.equal(result.status, 'NEEDS_REFERENCE_RESOLUTION')
  assert.match(result.reason, /more than one alternate/i)
  assert.equal(calls.length, 0)
  assert.equal(result.caseContext.focus.invoiceRef.id, 'inv-1844')
})

test('"make it shorter" changes rendering context without changing the invoice reference', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(calls),
  })

  const result = await runtime.runTurn({
    tenantId: T,
    caseState: invoiceCase(),
    turnId: 'turn-short',
    text: 'make it shorter',
    now: new Date(at(10)),
  })

  assert.equal(result.status, 'ANSWERED')
  assert.equal(result.caseState.presentation.detail, 'BRIEF')
  assert.equal(result.caseContext.focus.invoiceRef.id, 'inv-1844')
  assert.equal(calls[0].caseContext.presentation.detail, 'BRIEF')
  assert.equal(calls[0].invoiceId, 'inv-1844')
})

test('"dont do it yet" suspends the exact active action and performs no execution', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(calls),
  })

  const result = await runtime.runTurn({
    tenantId: T,
    caseState: actionCase(),
    turnId: 'turn-not-yet',
    text: "don't do it yet",
    now: new Date(at(10)),
  })

  const action = getAskDwActiveAction(result.caseState)
  assert.equal(action.status, ASK_DW_ACTION_STATUS.SUSPENDED)
  assert.equal(result.executionBoundary, null)
  assert.equal(result.safeguards.directExecutionPerformed, false)
  assert.equal(calls.length, 1)
})

test('"actually do it" only confirms the anchored action, then forces a fresh read and authority recheck', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(calls, {
      authorityActual: 'FOUNDER_CONFIRMATION_REQUIRED',
    }),
  })

  const result = await runtime.runTurn({
    tenantId: T,
    caseState: actionCase({ suspended: true }),
    turnId: 'turn-actually',
    text: 'actually do it',
    now: new Date(at(11)),
  })

  const action = getAskDwActiveAction(result.caseState)
  assert.equal(action.status, ASK_DW_ACTION_STATUS.CONFIRMED_PENDING_REVALIDATION)
  assert.equal(action.executionAuthorized, false)
  assert.equal(result.executionBoundary.executionAuthorized, false)
  assert.equal(result.executionBoundary.requiresFreshState, true)
  assert.equal(result.executionBoundary.requiresAuthorityRecheck, true)
  assert.equal(result.executionBoundary.revalidation.freshStateRefetched, true)
  assert.equal(result.executionBoundary.revalidation.freshAuthorityRechecked, true)
  assert.equal(result.executionBoundary.revalidation.directExecutionPerformed, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].invoiceId, 'inv-1844')
})

test('ordinary prose containing "do it" is not treated as action confirmation', () => {
  const state = actionCase()
  const control = resolveAskDwDeterministicCaseControl({
    state,
    text: 'Why did the customer do it yesterday?',
  })
  assert.equal(control.classification, 'NONE')
  assert.equal(control.event, null)
})

test('"do it" with no active action fails closed instead of inventing an action', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(calls),
  })
  const result = await runtime.runTurn({
    tenantId: T,
    caseState: invoiceCase(),
    turnId: 'turn-do-it',
    text: 'do it',
    now: new Date(at(10)),
  })
  assert.equal(result.status, 'NEEDS_ACTION_REFERENCE')
  assert.equal(result.executionBoundary, null)
  assert.equal(calls.length, 0)
})

test('untrusted resolver output cannot emit action-control events', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(calls),
  })

  await assert.rejects(() => runtime.runTurn({
    tenantId: T,
    caseState: actionCase(),
    turnId: 'turn-malicious',
    text: 'hello',
    now: new Date(at(10)),
    proposedResolverEvents: [{
      type: ASK_DW_CASE_EVENT.CONFIRM_ACTION_REFERENCE,
      payload: {
        actionId: 'action-1844',
        offeredAtTurnId: 'turn-offer',
      },
    }],
  }), /resolver event not allowed/)

  assert.equal(calls.length, 0)
})

test('safe resolver events can establish client, candidates and selected invoice in one turn', async () => {
  const calls = []
  const verifiedEvents = [
    {
      type: ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT,
      payload: { clientRef: { kind: 'client', id: 'client-anthony' } },
    },
    {
      type: ASK_DW_CASE_EVENT.RESOLVE_REFERENCE,
      payload: {
        term: 'anthony',
        ref: { kind: 'client', id: 'client-anthony' },
      },
    },
    {
      type: ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES,
      payload: { invoiceRefs: [{ kind: 'invoice', id: 'inv-1844' }] },
    },
    {
      type: ASK_DW_CASE_EVENT.SELECT_INVOICE,
      payload: { invoiceRef: { kind: 'invoice', id: 'inv-1844' } },
    },
  ]
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(calls),
    resolveCaseEvents: async () => verifiedEvents,
  })

  const result = await runtime.runTurn({
    tenantId: T,
    caseState: initial(),
    turnId: 'turn-resolve',
    text: 'What is going on with Anthony?',
    now: new Date(at(10)),
    proposedResolverEvents: verifiedEvents,
  })

  assert.equal(result.status, 'ANSWERED')
  assert.equal(result.appliedEvents.length, 4)
  assert.equal(result.caseContext.focus.clientRef.id, 'client-anthony')
  assert.equal(result.caseContext.focus.invoiceRef.id, 'inv-1844')
  assert.equal(calls[0].invoiceId, 'inv-1844')
})

test('missing invoice focus returns a bounded resolution state without invoking Ask DW live models', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(calls),
  })

  const result = await runtime.runTurn({
    tenantId: T,
    caseState: initial(),
    turnId: 'turn-no-invoice',
    text: 'What is going on?',
    now: new Date(at(10)),
  })

  assert.equal(result.status, 'NEEDS_INVOICE_RESOLUTION')
  assert.equal(result.askDw, null)
  assert.equal(calls.length, 0)
})

test('case TTL is enforced before a no-event live read can bypass M1D transition checks', async () => {
  const state = invoiceCase()
  const expiring = {
    ...JSON.parse(JSON.stringify(state)),
    expiresAt: at(9),
  }
  Object.freeze(expiring)

  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(calls),
  })

  await assert.rejects(() => runtime.runTurn({
    tenantId: T,
    caseState: expiring,
    turnId: 'turn-after-ttl',
    text: 'show me',
    now: new Date(at(10)),
  }), /expired by TTL/)

  assert.equal(calls.length, 0)
})

test('expired case conversations cannot be revived by the M1E runtime', async () => {
  let state = invoiceCase()
  state = event(state, ASK_DW_CASE_EVENT.EXPIRE_CONVERSATION, {}, {
    turnId: 'turn-expire',
    time: 10,
  })

  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner([]),
  })

  await assert.rejects(() => runtime.runTurn({
    tenantId: T,
    caseState: state,
    turnId: 'turn-after-expire',
    text: 'show me',
    now: new Date(at(11)),
  }), /conversation is not active/)
})

test('M1E blocks any composed runtime that reports a direct side effect', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(calls, { sideEffect: true }),
  })

  await assert.rejects(() => runtime.runTurn({
    tenantId: T,
    caseState: invoiceCase(),
    turnId: 'turn-side-effect',
    text: 'What is going on?',
    now: new Date(at(10)),
  }), /blocked a direct side effect/)

  assert.equal(calls.length, 1)
})

test('fresh canonical balance and authority are returned by Ask DW but never persisted into case state', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(calls),
  })

  const result = await runtime.runTurn({
    tenantId: T,
    caseState: invoiceCase(),
    turnId: 'turn-fresh',
    text: 'What is the latest?',
    now: new Date(at(10)),
  })

  assert.equal(result.askDw.truthLock.canonicalFacts.balance, 750)
  assert.equal(result.askDw.truthLock.authority.actual, 'NOT_GRANTED')
  const durable = JSON.stringify(result.caseState)
  assert.equal(durable.includes('"balance"'), false)
  assert.equal(durable.includes('"authority"'), false)
})

test('orchestrator sends reference-only case context to PLAN, SYNTHESIZE and VERIFY while tools keep scoped live context', async () => {
  const seen = {
    plan: null,
    synthesize: null,
    verify: null,
    toolContexts: [],
  }

  const deterministicCore = async () => ({
    policy: { requestedMode: 'normal', internalDepth: 'normal' },
    intent: { job: 'EXPLAIN', scope: 'INVOICE' },
    intelligence: { state: 'READY' },
    packet: {
      canonicalFacts: { balance: 750 },
      arState: null,
      claims: [],
      evidenceRefs: [],
      precedent: null,
      uncertainty: null,
      constraints: null,
      authority: { actual: 'NOT_GRANTED' },
      safeguards: {},
      needsYou: { required: false, question: null },
      executiveState: 'READY',
      hardSafetyOutcome: 'NO_UNAUTHORIZED_SIDE_EFFECT',
    },
    reasoningTrail: [],
    workManifest: {
      requiredModelOrToolWork: [],
    },
  })

  const primaryModel = {
    async plan(input) {
      seen.plan = input
      return {
        toolRequests: [{
          name: 'canonical_state',
          scope: 'INVOICE',
          input: {},
        }],
        hypotheses: [],
      }
    },
    async synthesize(input) {
      seen.synthesize = input
      return {
        executiveConclusion: 'Fresh.',
        evidenceBasis: [],
        uncertaintyAndLimitations: [],
        recommendationOrNextStep: null,
        competingExplanations: [],
        citedToolRunIds: [],
      }
    },
  }

  const verifierModel = {
    async verify(input) {
      seen.verify = input
      return {
        verdict: 'PASS',
        issues: [],
        checkedClaims: [],
      }
    },
  }

  const toolRegistry = {
    async execute({ name, scope, context }) {
      seen.toolContexts.push(context)
      return {
        name,
        scope,
        sourceClass: 'CANONICAL',
        canonicalAuthority: true,
        result: {},
      }
    },
  }

  const orchestrator = createAskDwOrchestrator({
    deterministicCore,
    primaryModel,
    verifierModel,
    toolRegistry,
  })

  const caseContext = buildAskDwCaseContext(invoiceCase())
  await orchestrator.run({
    mode: 'normal',
    text: 'make it shorter',
    context: {
      tenantId: T,
      invoiceId: 'inv-1844',
      clientId: 'client-anthony',
      asOf: at(10),
      caseContext,
    },
    intelligenceInput: {
      tenantId: T,
      invoice: { id: 'inv-1844' },
      client: { id: 'client-anthony' },
    },
  })

  assert.deepEqual(seen.plan.caseContext, caseContext)
  assert.deepEqual(seen.synthesize.caseContext, caseContext)
  assert.deepEqual(seen.verify.caseContext, caseContext)
  assert.equal(Object.hasOwn(seen.toolContexts[0], 'caseContext'), false)
})

test('orchestrator rejects financial truth smuggled into case context before model planning', async () => {
  let planCalled = false
  const orchestrator = createAskDwOrchestrator({
    deterministicCore: async () => ({
      policy: {},
      intent: {},
      intelligence: { state: 'READY' },
      packet: {},
      reasoningTrail: [],
      workManifest: {},
    }),
    primaryModel: {
      async plan() {
        planCalled = true
        return { toolRequests: [], hypotheses: [] }
      },
      async synthesize() {
        return {
          executiveConclusion: '',
          evidenceBasis: [],
          uncertaintyAndLimitations: [],
          recommendationOrNextStep: null,
          competingExplanations: [],
          citedToolRunIds: [],
        }
      },
    },
    verifierModel: {
      async verify() {
        return { verdict: 'PASS', issues: [], checkedClaims: [] }
      },
    },
    toolRegistry: {
      async execute() {
        throw new Error('should not run')
      },
    },
  })

  await assert.rejects(() => orchestrator.run({
    text: 'hello',
    context: {
      tenantId: T,
      invoiceId: 'inv-1844',
      caseContext: {
        schemaVersion: 'ASK_DW_CASE_CONTEXT_V0',
        balance: 750,
      },
    },
    intelligenceInput: {
      tenantId: T,
      invoice: { id: 'inv-1844' },
    },
  }), /forbidden case context field/i)

  assert.equal(planCalled, false)
})

test('live runtime exposes the M1E conversation turn surface without removing invoice mode', () => {
  const supabase = {
    functions: {
      async invoke() {
        throw new Error('not invoked in constructor test')
      },
    },
    auth: {
      async getUser() {
        return { data: { user: { id: T } }, error: null }
      },
    },
    from() {
      throw new Error('not invoked in constructor test')
    },
  }

  const live = createAskDwLiveRuntime({ supabase })
  assert.equal(typeof live.runInvoiceQuestion, 'function')
  assert.equal(typeof live.runConversationTurn, 'function')
  assert.equal(live.scope, 'INVOICE_LIVE_V1')
  assert.equal(live.conversationScope, 'INVOICE_LIVE_V1_CASE_STATE_V0')
})

test('M1E client integration source remains read-only and contains no provider secret handling', () => {
  const files = [
    'src/lib/dwIntelligence/askDwConversationRuntime.js',
    'src/lib/dwIntelligence/askDwLiveRuntime.js',
  ]

  for (const file of files) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.equal(source.includes('OPENAI_API_KEY'), false, `${file} must not contain provider secret handling`)
    assert.equal(
      /\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.rpc\s*\(/.test(source),
      false,
      `${file} must remain read-only`,
    )
  }
})
