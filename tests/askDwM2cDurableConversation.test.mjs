import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ASK_DW_ACTION_STATUS,
  ASK_DW_CASE_EVENT,
  applyAskDwCaseEvent,
  assertAskDwActionReadyForExecutionBoundary,
  createAskDwCaseState,
} from '../src/lib/dwIntelligence/askDwCaseState.js'
import { createAskDwCaseAwareRuntime } from '../src/lib/dwIntelligence/askDwConversationRuntime.js'
import {
  ASK_DW_CONVERSATION_PERSISTENCE_PROFILE,
  AskDwConversationExpiredError,
  AskDwConversationPersistenceConflictError,
  createAskDwConversationPersistence,
} from '../src/lib/dwIntelligence/askDwConversationPersistence.js'
import {
  ASK_DW_DURABLE_CONVERSATION_PROFILE,
  createAskDwDurableConversationRuntime,
} from '../src/lib/dwIntelligence/askDwDurableConversationRuntime.js'

const TENANT = 'tenant-m2c'
const OTHER = 'tenant-m2c-other'

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function initialState({
  conversationId = 'conversation-m2c',
  now = '2026-08-27T17:30:00.000Z',
  expiresAt = null,
} = {}) {
  return createAskDwCaseState({
    tenantId: TENANT,
    conversationId,
    caseId: 'case-m2c',
    turnId: 'bootstrap',
    now,
    expiresAt,
  })
}

function apply(state, type, payload, turnId, at) {
  return applyAskDwCaseEvent(state, {
    type,
    payload,
    tenantId: TENANT,
    expectedVersion: state.version,
    turnId,
    at,
  })
}

function withInvoices(state) {
  let next = apply(
    state,
    ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT,
    { clientRef: { kind: 'client', id: 'client-anthony' } },
    't1',
    '2026-08-27T17:31:00.000Z',
  )
  next = apply(
    next,
    ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES,
    {
      invoiceRefs: [
        { kind: 'invoice', id: 'invoice-1844' },
        { kind: 'invoice', id: 'invoice-1902' },
      ],
    },
    't1',
    '2026-08-27T17:31:00.000Z',
  )
  next = apply(
    next,
    ASK_DW_CASE_EVENT.SELECT_INVOICE,
    { invoiceRef: { kind: 'invoice', id: 'invoice-1844' } },
    't1',
    '2026-08-27T17:31:00.000Z',
  )
  return next
}

function makeSupabase({
  userId = TENANT,
  row = null,
  rpcResult = null,
  rpcError = null,
} = {}) {
  const calls = []

  const query = {
    select(fields) {
      calls.push({ op: 'select', fields })
      return query
    },
    eq(column, value) {
      calls.push({ op: 'eq', column, value })
      return query
    },
    async maybeSingle() {
      calls.push({ op: 'maybeSingle' })
      return { data: clone(row), error: null }
    },
  }

  return {
    calls,
    auth: {
      async getUser() {
        calls.push({ op: 'auth.getUser' })
        return { data: { user: { id: userId } }, error: null }
      },
    },
    from(table) {
      calls.push({ op: 'from', table })
      return query
    },
    async rpc(name, args) {
      calls.push({ op: 'rpc', name, args: clone(args) })
      return { data: clone(rpcResult), error: rpcError }
    },
  }
}

function rowFor(state) {
  return {
    user_id: state.tenantId,
    conversation_id: state.conversationId,
    schema_version: state.schemaVersion,
    state_version: state.version,
    status: state.status,
    state: clone(state),
    expires_at: state.expiresAt,
    created_at: '2026-08-27T17:30:00.000Z',
    updated_at: '2026-08-27T17:31:00.000Z',
  }
}

function makeMemoryPersistence(seed = null) {
  let state = seed ? clone(seed) : null

  return {
    profile: ASK_DW_CONVERSATION_PERSISTENCE_PROFILE,
    async load({ tenantId, conversationId }) {
      if (!state) return null
      if (state.tenantId !== tenantId || state.conversationId !== conversationId) return null
      return { state: clone(state), receipt: { source: 'MEMORY_TEST', stateVersion: state.version } }
    },
    async persist({ tenantId, expectedVersion, state: next }) {
      if (next.tenantId !== tenantId) throw new Error('tenant mismatch')
      if (state) {
        if (state.version !== expectedVersion) throw new AskDwConversationPersistenceConflictError()
      } else if (expectedVersion != null) {
        throw new AskDwConversationPersistenceConflictError()
      }
      state = clone(next)
      return { conversationId: next.conversationId, stateVersion: next.version, outcome: 'TEST_PERSISTED' }
    },
    snapshot() {
      return clone(state)
    },
  }
}

test('M2C persistence and durable runtime profiles add no truth, authority, provider, or execution capability', () => {
  assert.equal(ASK_DW_CONVERSATION_PERSISTENCE_PROFILE.directBrowserTableWrites, false)
  assert.equal(ASK_DW_CONVERSATION_PERSISTENCE_PROFILE.canonicalFinancialTruthStored, false)
  assert.equal(ASK_DW_CONVERSATION_PERSISTENCE_PROFILE.businessAuthorityStored, false)
  assert.equal(ASK_DW_CONVERSATION_PERSISTENCE_PROFILE.financialExecutionAuthorized, false)
  assert.equal(ASK_DW_DURABLE_CONVERSATION_PROFILE.storesTranscript, false)
  assert.equal(ASK_DW_DURABLE_CONVERSATION_PROFILE.canonicalFinancialTruthStored, false)
  assert.equal(ASK_DW_DURABLE_CONVERSATION_PROFILE.businessAuthorityStored, false)
  assert.equal(ASK_DW_DURABLE_CONVERSATION_PROFILE.freshLiveReadStillRequired, true)
  assert.equal(ASK_DW_DURABLE_CONVERSATION_PROFILE.authorityRecheckStillRequired, true)
})

test('authenticated owner can load durable reference-only case state and the adapter revalidates it', async () => {
  const state = withInvoices(initialState())
  const supabase = makeSupabase({ row: rowFor(state) })
  const persistence = createAskDwConversationPersistence({ supabase })
  const loaded = await persistence.load({ tenantId: TENANT, conversationId: state.conversationId })

  assert.equal(loaded.state.version, state.version)
  assert.equal(loaded.state.cases['case-m2c'].focus.clientRef.id, 'client-anthony')
  assert.equal(loaded.state.cases['case-m2c'].focus.invoiceRef.id, 'invoice-1844')
  assert.equal(loaded.receipt.canonicalFinancialTruthLoaded, false)
  assert.equal(loaded.receipt.businessAuthorityLoaded, false)
  assert.deepEqual(supabase.calls.map((call) => call.op).slice(0, 2), ['auth.getUser', 'from'])
})

test('cross-tenant load is rejected after auth and before the conversation table read', async () => {
  const supabase = makeSupabase({ userId: OTHER })
  const persistence = createAskDwConversationPersistence({ supabase })

  await assert.rejects(
    () => persistence.load({ tenantId: TENANT, conversationId: 'conversation-m2c' }),
    /tenant mismatch/i,
  )
  assert.deepEqual(supabase.calls.map((call) => call.op), ['auth.getUser'])
})

test('persist uses the guarded RPC and performs no direct table mutation', async () => {
  const state = withInvoices(initialState())
  const next = apply(
    state,
    ASK_DW_CASE_EVENT.SET_PRESENTATION,
    { detail: 'BRIEF' },
    't2',
    '2026-08-27T17:32:00.000Z',
  )

  const supabase = makeSupabase({
    rpcResult: {
      conversation_id: next.conversationId,
      state_version: next.version,
      outcome: 'UPDATED',
      idempotent_replay: false,
      persisted_at: '2026-08-27T17:32:01.000Z',
    },
  })
  const persistence = createAskDwConversationPersistence({ supabase })
  const receipt = await persistence.persist({
    tenantId: TENANT,
    expectedVersion: state.version,
    state: next,
  })

  assert.equal(receipt.stateVersion, next.version)
  assert.equal(receipt.canonicalFinancialTruthStored, false)
  assert.equal(receipt.businessAuthorityStored, false)
  const rpc = supabase.calls.find((call) => call.op === 'rpc')
  assert.equal(rpc.name, 'persist_ask_dw_conversation_state')
  assert.equal(rpc.args.p_expected_version, state.version)
  assert.equal(rpc.args.p_state.version, next.version)
  assert.equal(supabase.calls.some((call) => ['insert', 'update', 'upsert', 'delete'].includes(call.op)), false)
})

test('financial truth smuggled into durable state is rejected before persistence RPC', async () => {
  const state = clone(initialState())
  state.cases['case-m2c'].focus.amount = '4500.00'
  const supabase = makeSupabase()
  const persistence = createAskDwConversationPersistence({ supabase })

  await assert.rejects(
    () => persistence.persist({ tenantId: TENANT, expectedVersion: null, state }),
    /forbidden live\/canonical field/i,
  )
  assert.equal(supabase.calls.some((call) => call.op === 'rpc'), false)
})

test('persistence rejects injected execution-capability fields before auth or RPC', async () => {
  const state = clone(initialState())
  state.financialExecutionAuthorized = true
  const supabase = makeSupabase()
  const persistence = createAskDwConversationPersistence({ supabase })

  await assert.rejects(
    () => persistence.persist({ tenantId: TENANT, expectedVersion: null, state }),
    /forbidden persistence capability field/i,
  )
  assert.deepEqual(supabase.calls, [])
})

test('persistence rejects executionAuthorized true even though false guard values are durable', async () => {
  let state = withInvoices(initialState())
  state = apply(
    state,
    ASK_DW_CASE_EVENT.OFFER_ACTION,
    {
      actionId: 'action-capability-test',
      actionType: 'SEND_REMINDER',
      targetRefs: [{ kind: 'invoice', id: 'invoice-1844' }],
      scope: 'invoice',
    },
    't2-capability',
    '2026-08-27T17:31:30.000Z',
  )
  state = clone(state)
  state.cases['case-m2c'].actions[0].executionAuthorized = true

  const supabase = makeSupabase()
  const persistence = createAskDwConversationPersistence({ supabase })

  await assert.rejects(
    () => persistence.persist({ tenantId: TENANT, expectedVersion: state.version - 1, state }),
    /execution authority is not persistable/i,
  )
  assert.deepEqual(supabase.calls, [])
})

test('persistence receipt outcome is allowlisted so storage cannot surface fake execution semantics', async () => {
  const state = initialState()
  const supabase = makeSupabase({
    rpcResult: {
      conversation_id: state.conversationId,
      state_version: state.version,
      outcome: 'EXECUTED',
      idempotent_replay: false,
      persisted_at: '2026-08-27T17:32:01.000Z',
    },
  })
  const persistence = createAskDwConversationPersistence({ supabase })

  await assert.rejects(
    () => persistence.persist({ tenantId: TENANT, expectedVersion: null, state }),
    /receipt outcome not allowed/i,
  )
})

test('RPC serialization conflict becomes the bounded M2C stale-conversation error', async () => {
  const state = withInvoices(initialState())
  const supabase = makeSupabase({
    rpcError: { code: '40001', message: 'ASK_DW_CONVERSATION_STALE' },
  })
  const persistence = createAskDwConversationPersistence({ supabase })

  await assert.rejects(
    () => persistence.persist({ tenantId: TENANT, expectedVersion: state.version - 1, state }),
    (error) => error instanceof AskDwConversationPersistenceConflictError &&
      error.code === 'ASK_DW_CONVERSATION_STALE',
  )
})

test('durable wrapper round-trips presentation continuity but recomputes fresh answer truth every turn', async () => {
  const persistence = makeMemoryPersistence()
  let freshTruth = 'truth-v1'
  let runtimeCalls = 0

  const runtime = {
    async runConversationTurn({ caseState, turnId, text, now }) {
      runtimeCalls += 1
      let next = caseState
      if (text === 'make it shorter') {
        next = applyAskDwCaseEvent(next, {
          type: ASK_DW_CASE_EVENT.SET_PRESENTATION,
          payload: { detail: 'BRIEF' },
          tenantId: TENANT,
          expectedVersion: next.version,
          turnId,
          at: now.toISOString(),
        })
      }
      return {
        status: 'ANSWERED',
        caseState: next,
        caseContext: { presentation: clone(next.presentation) },
        appliedEvents: [],
        control: null,
        resolver: null,
        askDw: { freshTruth },
        executionBoundary: null,
        reason: null,
      }
    },
  }

  const durable = createAskDwDurableConversationRuntime({ conversationRuntime: runtime, persistence })

  const first = await durable.runConversationTurn({
    tenantId: TENANT,
    conversationId: 'conversation-roundtrip',
    caseId: 'case-m2c',
    turnId: 'turn-1',
    text: 'status',
    now: new Date('2026-08-27T17:33:00.000Z'),
  })
  assert.equal(first.askDw.freshTruth, 'truth-v1')
  assert.equal(first.durability.persisted, true)

  freshTruth = 'truth-v2'
  const second = await durable.runConversationTurn({
    tenantId: TENANT,
    conversationId: 'conversation-roundtrip',
    turnId: 'turn-2',
    text: 'make it shorter',
    now: new Date('2026-08-27T17:34:00.000Z'),
  })

  assert.equal(second.askDw.freshTruth, 'truth-v2')
  assert.equal(second.caseState.presentation.detail, 'BRIEF')
  assert.equal(second.durability.loaded, true)
  assert.equal(runtimeCalls, 2)
  const persisted = JSON.stringify(persistence.snapshot())
  assert.equal(persisted.includes('truth-v1'), false)
  assert.equal(persisted.includes('truth-v2'), false)
})

test('reloaded invoice candidates preserve deterministic "the other invoice" continuity and fresh-read alternate', async () => {
  const seeded = withInvoices(initialState({ conversationId: 'conversation-other' }))
  const persistence = makeMemoryPersistence(seeded)
  const liveCalls = []

  const conversationRuntime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: async (args) => {
      liveCalls.push(clone(args))
      return {
        answer: { executiveConclusion: `fresh:${args.invoiceId}` },
        truthLock: { authority: { actual: 'NOT_GRANTED' } },
        liveReadReceipt: { writesPerformed: false },
        intelligence: { execution: { sideEffect: false } },
      }
    },
  })

  const durable = createAskDwDurableConversationRuntime({ conversationRuntime, persistence })
  const result = await durable.runConversationTurn({
    tenantId: TENANT,
    conversationId: 'conversation-other',
    turnId: 'turn-other',
    text: 'the other invoice',
    now: new Date('2026-08-27T17:35:00.000Z'),
  })

  assert.equal(result.status, 'ANSWERED')
  assert.equal(result.caseContext.focus.invoiceRef.id, 'invoice-1902')
  assert.equal(liveCalls.length, 1)
  assert.equal(liveCalls[0].invoiceId, 'invoice-1902')
})

test('confirmed action survives reload only as pending revalidation, never execution authority', async () => {
  let state = withInvoices(initialState({ conversationId: 'conversation-action' }))
  state = apply(
    state,
    ASK_DW_CASE_EVENT.OFFER_ACTION,
    {
      actionId: 'action-1',
      actionType: 'SEND_REMINDER',
      targetRefs: [{ kind: 'invoice', id: 'invoice-1844' }],
      scope: 'invoice',
    },
    't2',
    '2026-08-27T17:36:00.000Z',
  )
  state = apply(
    state,
    ASK_DW_CASE_EVENT.REQUEST_ACTION_CONFIRMATION,
    { actionId: 'action-1' },
    't2',
    '2026-08-27T17:36:00.000Z',
  )
  state = apply(
    state,
    ASK_DW_CASE_EVENT.CONFIRM_ACTION_REFERENCE,
    { actionId: 'action-1', offeredAtTurnId: 't2' },
    't3',
    '2026-08-27T17:37:00.000Z',
  )

  const supabase = makeSupabase({ row: rowFor(state) })
  const persistence = createAskDwConversationPersistence({ supabase })
  const loaded = await persistence.load({ tenantId: TENANT, conversationId: 'conversation-action' })
  const action = loaded.state.cases['case-m2c'].actions.find((item) => item.actionId === 'action-1')

  assert.equal(action.status, ASK_DW_ACTION_STATUS.CONFIRMED_PENDING_REVALIDATION)
  assert.equal(action.executionAuthorized, false)
  assert.equal(action.requiresFreshState, true)
  assert.equal(action.requiresAuthorityRecheck, true)

  const boundary = assertAskDwActionReadyForExecutionBoundary(loaded.state, 'action-1')
  assert.equal(boundary.executionAuthorized, false)
  assert.equal(boundary.requiresFreshState, true)
  assert.equal(boundary.requiresAuthorityRecheck, true)
})

test('expired durable conversation cannot revive and does not invoke conversation runtime', async () => {
  const state = initialState({
    conversationId: 'conversation-expired',
    expiresAt: '2026-08-27T17:39:00.000Z',
  })
  const persistence = makeMemoryPersistence(state)
  let calls = 0

  const durable = createAskDwDurableConversationRuntime({
    persistence,
    conversationRuntime: {
      async runConversationTurn() {
        calls += 1
        throw new Error('should not run')
      },
    },
  })

  const result = await durable.runConversationTurn({
    tenantId: TENANT,
    conversationId: 'conversation-expired',
    turnId: 'turn-expired',
    text: 'continue',
    now: new Date('2026-08-27T17:40:00.000Z'),
  })

  assert.equal(result.status, 'CONVERSATION_EXPIRED')
  assert.equal(result.askDw, null)
  assert.equal(calls, 0)
})

test('expiry racing persistence withholds the computed answer and returns expired', async () => {
  const state = initialState({
    conversationId: 'conversation-expiry-race',
    expiresAt: '2026-08-27T17:42:30.000Z',
  })
  const persistence = {
    async load() {
      return { state: clone(state), receipt: { source: 'TEST' } }
    },
    async persist() {
      throw new AskDwConversationExpiredError()
    },
  }

  const durable = createAskDwDurableConversationRuntime({
    persistence,
    conversationRuntime: {
      async runConversationTurn({ caseState, turnId, now }) {
        const next = applyAskDwCaseEvent(caseState, {
          type: ASK_DW_CASE_EVENT.SET_PRESENTATION,
          payload: { detail: 'BRIEF' },
          tenantId: TENANT,
          expectedVersion: caseState.version,
          turnId,
          at: now.toISOString(),
        })
        return {
          status: 'ANSWERED',
          caseState: next,
          askDw: { executiveConclusion: 'do not surface me after expiry' },
        }
      },
    },
  })

  const result = await durable.runConversationTurn({
    tenantId: TENANT,
    conversationId: 'conversation-expiry-race',
    turnId: 'turn-expiry-race',
    text: 'make it shorter',
    now: new Date('2026-08-27T17:42:00.000Z'),
  })

  assert.equal(result.status, 'CONVERSATION_EXPIRED')
  assert.equal(result.askDw, null)
  assert.equal(result.durability.persistenceRaceExpired, true)
})

test('stale persistence after computed turn withholds answer and requires reload', async () => {
  const state = initialState({ conversationId: 'conversation-stale' })
  const persistence = {
    async load() {
      return { state: clone(state), receipt: { source: 'TEST' } }
    },
    async persist() {
      throw new AskDwConversationPersistenceConflictError()
    },
  }

  const durable = createAskDwDurableConversationRuntime({
    persistence,
    conversationRuntime: {
      async runConversationTurn({ caseState, turnId, now }) {
        const next = applyAskDwCaseEvent(caseState, {
          type: ASK_DW_CASE_EVENT.SET_PRESENTATION,
          payload: { detail: 'BRIEF' },
          tenantId: TENANT,
          expectedVersion: caseState.version,
          turnId,
          at: now.toISOString(),
        })
        return {
          status: 'ANSWERED',
          caseState: next,
          askDw: { executiveConclusion: 'do not surface me' },
        }
      },
    },
  })

  const result = await durable.runConversationTurn({
    tenantId: TENANT,
    conversationId: 'conversation-stale',
    turnId: 'turn-stale',
    text: 'make it shorter',
    now: new Date('2026-08-27T17:41:00.000Z'),
  })

  assert.equal(result.status, 'CONVERSATION_STALE_RELOAD_REQUIRED')
  assert.equal(result.askDw, null)
  assert.equal(result.caseState, null)
  assert.equal(result.durability.staleWriteRejected, true)
})
