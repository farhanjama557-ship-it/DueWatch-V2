import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createAskDwControlledConversationRuntime,
  createAskDwControlledInvoiceCaseState,
} from '../src/lib/dwIntelligence/askDwControlledConversationRuntime.js'
import {
  buildAskDwCaseContext,
} from '../src/lib/dwIntelligence/askDwConversationRuntime.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

const TENANT = 'tenant-m2a-grounding'
const OTHER_TENANT = 'tenant-m2a-other'
const CLIENT = 'client-anthony'
const INVOICE_A = 'invoice-anthony-1844'
const INVOICE_B = 'invoice-anthony-1902'

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function dataset() {
  return {
    invoices: [
      {
        id: INVOICE_A,
        user_id: TENANT,
        client_id: CLIENT,
        inv_num: 'INV-1844',
        amount: '4500.00',
        amount_paid: '0.00',
        inv_date: '2026-07-01',
        due_date: '2026-07-31',
        paid: false,
        last_reminder: '2026-08-20T14:00:00Z',
        autopilot_paused: false,
        created_at: '2026-07-01T00:00:00Z',
      },
      {
        id: INVOICE_B,
        user_id: TENANT,
        client_id: CLIENT,
        inv_num: 'INV-1902',
        amount: '2200.00',
        amount_paid: '0.00',
        inv_date: '2026-08-15',
        due_date: '2026-09-15',
        paid: false,
        last_reminder: null,
        autopilot_paused: false,
        created_at: '2026-08-15T00:00:00Z',
      },
    ],
    clients: [{
      id: CLIENT,
      user_id: TENANT,
      name: 'Anthony Miller',
      created_at: '2026-06-01T00:00:00Z',
    }],
    autopilot_rules: [],
    autopilot_settings: [{
      id: 'settings-1',
      user_id: TENANT,
      enabled: false,
      approval_required: true,
    }],
    events: [
      {
        id: 'event-a',
        user_id: TENANT,
        event_type: 'reminder_sent',
        invoice_id: INVOICE_A,
        created_at: '2026-08-20T14:00:00Z',
        lifecycle_state: 'overdue',
        evidence: {},
      },
      {
        id: 'event-b',
        user_id: TENANT,
        event_type: 'invoice_created',
        invoice_id: INVOICE_B,
        created_at: '2026-08-15T00:00:00Z',
        lifecycle_state: null,
        evidence: {},
      },
    ],
  }
}

function makeQuery(table, rows, calls) {
  const state = { eq: [], limit: null, single: false }
  const builder = {
    select(columns) { calls.push({ op: 'select', table, columns }); return builder },
    eq(column, value) { state.eq.push([column, value]); calls.push({ op: 'eq', table, column, value }); return builder },
    order(column, options) { calls.push({ op: 'order', table, column, options }); return builder },
    limit(value) { state.limit = value; calls.push({ op: 'limit', table, value }); return builder },
    maybeSingle() { state.single = true; return Promise.resolve(resolve()) },
    then(resolvePromise, rejectPromise) { return Promise.resolve(resolve()).then(resolvePromise, rejectPromise) },
  }

  function resolve() {
    let result = clone(rows)
    for (const [column, value] of state.eq) {
      result = result.filter((row) => row?.[column] === value)
    }
    if (state.limit != null) result = result.slice(0, state.limit)
    return { data: state.single ? (result[0] ?? null) : result, error: null }
  }

  return builder
}

function makeSupabase({ userId = TENANT, data = dataset() } = {}) {
  const calls = []
  const allowedTables = new Set(Object.keys(data))

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
      if (!allowedTables.has(table)) throw new Error(`unexpected table read: ${table}`)
      return makeQuery(table, data[table], calls)
    },
    functions: {
      async invoke(name, options) {
        calls.push({ op: 'functions.invoke', name, body: clone(options?.body) })
        throw new Error('external model/provider invocation is forbidden in M2A')
      },
    },
  }
}

function bootstrap() {
  return createAskDwControlledInvoiceCaseState({
    tenantId: TENANT,
    invoiceId: INVOICE_A,
    invoiceIds: [INVOICE_A, INVOICE_B],
    conversationId: 'conversation-m2a-001',
    now: '2026-08-27T13:00:00.000Z',
  })
}

test('M2A durable bootstrap stores references only, never financial truth', () => {
  const state = bootstrap()
  const context = buildAskDwCaseContext(state)

  assert.equal(context.focus.invoiceRef.id, INVOICE_A)
  assert.deepEqual(context.candidates.invoiceRefs, [
    { kind: 'invoice', id: INVOICE_A },
    { kind: 'invoice', id: INVOICE_B },
  ])
  assert.equal(context.boundaries.referenceOnly, true)
  assert.equal(context.boundaries.canonicalFinancialTruthStored, false)
  assert.equal(context.boundaries.businessAuthorityStored, false)

  const serialized = JSON.stringify(state)
  for (const forbidden of ['"balance"', '"amount"', '"currency"', '"authority"', '"authorized"']) {
    assert.equal(serialized.includes(forbidden), false, `durable state contained ${forbidden}`)
  }
})

test('M2A controlled turn proves fresh zero-write live read with no provider call', async () => {
  const supabase = makeSupabase()
  const runtime = createAskDwControlledConversationRuntime({ supabase })

  const result = await runtime.runConversationTurn({
    tenantId: TENANT,
    caseState: bootstrap(),
    turnId: 'turn-1',
    text: 'What is the current balance and recent activity?',
    now: '2026-08-27T13:01:00.000Z',
  })

  assert.equal(result.status, 'ANSWERED')
  assert.equal(result.safeguards.liveTruthReadPerformed, true)
  assert.equal(result.safeguards.canonicalTruthPersistedToCaseState, false)
  assert.equal(result.safeguards.caseStateCanGrantAuthority, false)
  assert.equal(result.safeguards.directExecutionPerformed, false)
  assert.equal(result.askDw.liveReadReceipt.writesPerformed, false)
  assert.equal(result.askDw.liveReadReceipt.canonicalInvoiceRead, true)
  assert.equal(result.askDw.liveReadReceipt.executionHistoryRead, false)
  assert.equal(result.askDw.liveReadReceipt.authorityInputComplete, false)
  assert.equal(result.askDw.intelligenceReceipt.modelCalls, 0)
  assert.equal(result.askDw.intelligenceReceipt.providerCalls, 0)
  assert.equal(result.askDw.intelligenceReceipt.financialExecutionAuthorized, false)
  assert.equal(supabase.calls.some((call) => call.op === 'functions.invoke'), false)
  assert.match(result.askDw.answer.executiveConclusion, /4500\.00/)
})

test('"the other invoice" deterministically changes reference and fresh-reads the selected invoice', async () => {
  const supabase = makeSupabase()
  const runtime = createAskDwControlledConversationRuntime({ supabase })

  const first = await runtime.runConversationTurn({
    tenantId: TENANT,
    caseState: bootstrap(),
    turnId: 'turn-1',
    text: 'What is going on with this invoice?',
    now: '2026-08-27T13:01:00.000Z',
  })

  const second = await runtime.runConversationTurn({
    tenantId: TENANT,
    caseState: first.caseState,
    turnId: 'turn-2',
    text: 'the other invoice',
    now: '2026-08-27T13:02:00.000Z',
  })

  assert.equal(second.status, 'ANSWERED')
  assert.equal(second.control.classification, 'CORRECT_ACTIVE_INVOICE')
  assert.equal(second.caseContext.focus.invoiceRef.id, INVOICE_B)
  assert.equal(second.safeguards.liveTruthReadPerformed, true)
  assert.match(second.askDw.answer.executiveConclusion, /2200\.00/)

  const invoiceBReads = supabase.calls.filter(
    (call) => call.op === 'eq' && call.table === 'invoices' &&
      call.column === 'id' && call.value === INVOICE_B,
  )
  assert.ok(invoiceBReads.length > 0, 'selected alternate invoice must be fresh-read')
})

test('"make it shorter" changes presentation only and still refreshes live truth', async () => {
  const supabase = makeSupabase()
  const runtime = createAskDwControlledConversationRuntime({ supabase })

  const first = await runtime.runConversationTurn({
    tenantId: TENANT,
    caseState: bootstrap(),
    turnId: 'turn-1',
    text: 'What is going on with this invoice?',
    now: '2026-08-27T13:01:00.000Z',
  })

  const second = await runtime.runConversationTurn({
    tenantId: TENANT,
    caseState: first.caseState,
    turnId: 'turn-2',
    text: 'make it shorter',
    now: '2026-08-27T13:02:00.000Z',
  })

  assert.equal(second.control.classification, 'SET_PRESENTATION_BRIEF')
  assert.equal(second.caseContext.presentation.detail, 'BRIEF')
  assert.equal(second.caseContext.focus.invoiceRef.id, INVOICE_A)
  assert.equal(second.safeguards.liveTruthReadPerformed, true)
})

test('M2A rejects cross-tenant conversation turns before live reads', async () => {
  const supabase = makeSupabase()
  const runtime = createAskDwControlledConversationRuntime({ supabase })

  await assert.rejects(
    () => runtime.runConversationTurn({
      tenantId: OTHER_TENANT,
      caseState: bootstrap(),
      turnId: 'turn-cross-tenant',
      text: 'What is going on?',
      now: '2026-08-27T13:03:00.000Z',
    }),
    /cross-tenant turn blocked/i,
  )

  assert.equal(supabase.calls.filter((call) => call.op === 'from').length, 0)
})

test('M2A ACT and PREDICT remain blocked with zero provider calls', async () => {
  const supabase = makeSupabase()
  const runtime = createAskDwControlledConversationRuntime({ supabase })
  const state = bootstrap()

  await assert.rejects(
    () => runtime.runConversationTurn({
      tenantId: TENANT,
      caseState: state,
      turnId: 'turn-act',
      text: 'Send a reminder for this invoice',
      now: '2026-08-27T13:04:00.000Z',
    }),
    /read only and cannot execute actions/i,
  )

  await assert.rejects(
    () => runtime.runConversationTurn({
      tenantId: TENANT,
      caseState: state,
      turnId: 'turn-predict',
      text: 'When will this invoice be paid?',
      now: '2026-08-27T13:05:00.000Z',
    }),
    /cannot forecast payment timing/i,
  )

  assert.equal(supabase.calls.some((call) => call.op === 'functions.invoke'), false)
})

test('M2A composition remains provider-independent and does not implement M2B name resolution', () => {
  const source = fs.readFileSync(
    path.join(repo, 'src/lib/dwIntelligence/askDwControlledConversationRuntime.js'),
    'utf8',
  )

  assert.match(source, /createAskDwControlledActivationRuntime/)
  assert.match(source, /createAskDwCaseAwareRuntime/)
  assert.match(source, /liveReadReceipt/)
  assert.doesNotMatch(source, /GoogleGenAI|Gemini|GROQ_API_KEY|OPENAI_API_KEY|fetch\s*\(/i)
  assert.doesNotMatch(source, /find_invoices_by_client|ILIKE|portfolio_summary/i)
})

test('M2A strict contract forbids mental aggregation and authority inference', () => {
  const contract = fs.readFileSync(
    path.join(repo, 'docs/dw-intelligence/M2A_GROUNDED_CONVERSATION_V0.md'),
    'utf8',
  )

  assert.match(contract, /Never sum or infer a client\/portfolio total/i)
  assert.match(contract, /Financial state and action authority are separate/i)
  assert.match(contract, /missing capability stays explicit/i)
  assert.match(contract, /100% model accuracy/i)
})
