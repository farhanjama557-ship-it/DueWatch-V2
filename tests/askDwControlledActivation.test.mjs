import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { classifyAskDwIntent } from '../src/lib/dwIntelligence/askDwIntent.js'

import {
  ASK_DW_CONTROLLED_ACTIVATION_PROFILE,
  createAskDwControlledActivationRuntime,
  createAskDwControlledReadTools,
  loadAskDwControlledActivationInput,
} from '../src/lib/dwIntelligence/askDwControlledActivation.js'

const source = fs.readFileSync(
  new URL('../src/lib/dwIntelligence/askDwControlledActivation.js', import.meta.url),
  'utf8',
)

const TENANT = 'tenant-1'
const CLIENT = 'client-1'
const INVOICE = 'invoice-1'

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function dataset() {
  return {
    invoices: [{
      id: INVOICE,
      user_id: TENANT,
      client_id: CLIENT,
      inv_num: 'INV-100',
      amount: '1000.00',
      amount_paid: '250.00',
      inv_date: '2026-07-01',
      due_date: '2026-08-01',
      paid: false,
      last_reminder: null,
      autopilot_paused: false,
      created_at: '2026-07-01T00:00:00Z',
    }],
    clients: [{
      id: CLIENT,
      user_id: TENANT,
      name: 'Acme',
      created_at: '2026-06-01T00:00:00Z',
    }],
    autopilot_rules: [],
    autopilot_settings: [{
      id: 'settings-1',
      user_id: TENANT,
      enabled: false,
      approval_required: true,
    }],
    events: [{
      id: 'event-1',
      user_id: TENANT,
      event_type: 'invoice_created',
      invoice_id: INVOICE,
      created_at: '2026-07-01T00:00:00Z',
      lifecycle_state: null,
      evidence: {},
    }],
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
    for (const [column, value] of state.eq) result = result.filter((row) => row?.[column] === value)
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
        throw new Error('external model/provider invocation is forbidden in deterministic Ask DW')
      },
    },
  }
}

test('controlled activation is DW Intelligence only and exposes read-only tools', () => {
  const supabase = makeSupabase()
  const registry = createAskDwControlledReadTools({ supabase })
  assert.deepEqual(
    registry.list().map((item) => item.name),
    ['canonical_state', 'activity_history'],
  )
  assert.equal(ASK_DW_CONTROLLED_ACTIVATION_PROFILE.financialExecutionAuthorized, false)
  assert.equal(ASK_DW_CONTROLLED_ACTIVATION_PROFILE.modelPlanningEnabled, false)
  assert.equal(ASK_DW_CONTROLLED_ACTIVATION_PROFILE.externalAiEnabled, false)
  assert.equal(ASK_DW_CONTROLLED_ACTIVATION_PROFILE.modelDependency, false)
  assert.equal(ASK_DW_CONTROLLED_ACTIVATION_PROFILE.allowedJobs.includes('DECIDE'), true)
})

test('controlled Ask DW active path contains no model provider dependency', () => {
  assert.doesNotMatch(source, /createAskDwLiveModels/)
  assert.doesNotMatch(source, /ask-dw-model/)
  assert.doesNotMatch(source, /functions\.invoke/)
  assert.doesNotMatch(source, /GPT-OSS|Groq/i)
  assert.match(source, /runAskDwDeterministicCore/)
})

test('controlled loader never reads missing payment, DW, or execution-history tables', async () => {
  const supabase = makeSupabase()
  const loaded = await loadAskDwControlledActivationInput({
    supabase,
    tenantId: TENANT,
    invoiceId: INVOICE,
    now: new Date('2026-08-26T00:00:00Z'),
  })

  const tables = supabase.calls.filter((call) => call.op === 'from').map((call) => call.table)
  for (const forbidden of [
    'payments',
    'payment_allocations',
    'autopilot_execution_claims',
    'dw_evidence_items',
    'dw_memory_claims',
    'dw_proof_events',
  ]) {
    assert.equal(tables.includes(forbidden), false, `must not read ${forbidden}`)
  }
  assert.equal(loaded.activationReceipt.writesPerformed, false)
  assert.equal(loaded.activationReceipt.executionHistoryRead, false)
  assert.equal(loaded.activationReceipt.paymentLedgerRead, false)
  assert.equal(loaded.intelligenceInput.authorityEvaluation.authority.authorized, false)
})

test('controlled canonical tool treats hosted currency as unknown rather than defaulting it', async () => {
  const supabase = makeSupabase()
  const registry = createAskDwControlledReadTools({ supabase })
  const run = await registry.execute({
    name: 'canonical_state',
    scope: 'INVOICE',
    context: { tenantId: TENANT, invoiceId: INVOICE, clientId: CLIENT, asOf: '2026-08-26T00:00:00Z' },
  })
  assert.equal(run.result.invoice.balance, '750.00')
  assert.equal(run.result.invoice.currency, null)
  assert.equal(run.result.invoice.currencyKnown, false)
  assert.match(run.result.limitation, /unknown, never defaulted/i)
  assert.equal(run.sideEffect, false)
})

test('Ask DW answers balance + activity through DW Intelligence with zero model/provider calls', async () => {
  const supabase = makeSupabase()
  const runtime = createAskDwControlledActivationRuntime({ supabase })
  const result = await runtime.runInvoiceQuestion({
    tenantId: TENANT,
    invoiceId: INVOICE,
    mode: 'normal',
    text: 'What is the current balance on this invoice? Summarize its recent activity.',
    now: new Date('2026-08-26T00:00:00Z'),
  })

  assert.equal(supabase.calls.some((call) => call.op === 'functions.invoke'), false)
  assert.deepEqual(result.plan.toolRequests.map((request) => request.name), [
    'canonical_state',
    'activity_history',
  ])
  assert.match(result.answer.executiveConclusion, /750\.00/)
  assert.match(result.answer.executiveConclusion, /Invoice created on 2026-07-01/i)
  assert.equal(result.verification.verdict, 'PASS')
  assert.equal(result.verification.method, 'DETERMINISTIC_INVARIANTS_V1')
  assert.equal(result.intelligenceReceipt.externalAi, false)
  assert.equal(result.intelligenceReceipt.modelCalls, 0)
  assert.equal(result.intelligenceReceipt.providerCalls, 0)
  assert.equal(result.intelligenceReceipt.writesPerformed, false)
  assert.equal(result.safeguards.modelCanGrantAuthority, false)
})

test('canonical paid/balance conflict is surfaced without invented causes', async () => {
  const data = dataset()
  data.invoices[0].paid = true
  const supabase = makeSupabase({ data })
  const runtime = createAskDwControlledActivationRuntime({ supabase })

  const result = await runtime.runInvoiceQuestion({
    tenantId: TENANT,
    invoiceId: INVOICE,
    text: 'Why is this invoice marked paid?',
    now: new Date('2026-08-26T00:00:00Z'),
  })

  assert.match(result.answer.executiveConclusion, /marked Paid/i)
  assert.match(result.answer.executiveConclusion, /canonical data conflict/i)
  assert.match(result.answer.executiveConclusion, /does not infer the cause/i)
  assert.deepEqual(result.answer.competingExplanations, [])
  assert.equal(
    result.answer.uncertaintyAndLimitations.some((item) => /payment-ledger and reconciliation data are unavailable/i.test(item)),
    true,
  )
  assert.equal(supabase.calls.some((call) => call.op === 'functions.invoke'), false)
})

test('read-only DECIDE question returns an authority limitation, not an action', async () => {
  const supabase = makeSupabase()
  const runtime = createAskDwControlledActivationRuntime({ supabase })

  const result = await runtime.runInvoiceQuestion({
    tenantId: TENANT,
    invoiceId: INVOICE,
    text: 'What should happen next?',
    now: new Date('2026-08-26T00:00:00Z'),
  })

  assert.equal(result.intent.job, 'DECIDE')
  assert.match(result.answer.recommendationOrNextStep, /cannot safely recommend an executable next action/i)
  assert.equal(result.intelligenceReceipt.modelCalls, 0)
  assert.equal(result.intelligenceReceipt.providerCalls, 0)
  assert.equal(result.intelligenceReceipt.financialExecutionAuthorized, false)
})

test('ACT stays blocked with no provider/model call', async () => {
  const supabase = makeSupabase()
  const runtime = createAskDwControlledActivationRuntime({ supabase })
  await assert.rejects(
    () => runtime.runInvoiceQuestion({
      tenantId: TENANT,
      invoiceId: INVOICE,
      mode: 'normal',
      text: 'Send a reminder for this invoice',
      now: new Date('2026-08-26T00:00:00Z'),
    }),
    /read only and cannot execute actions/i,
  )
  assert.equal(supabase.calls.some((call) => call.op === 'functions.invoke'), false)
})

test('PREDICT stays blocked because deterministic prediction data is unavailable', async () => {
  const supabase = makeSupabase()
  const runtime = createAskDwControlledActivationRuntime({ supabase })
  await assert.rejects(
    () => runtime.runInvoiceQuestion({
      tenantId: TENANT,
      invoiceId: INVOICE,
      mode: 'normal',
      text: 'When will this invoice be paid?',
      now: new Date('2026-08-26T00:00:00Z'),
    }),
    /cannot forecast payment timing/i,
  )
  assert.equal(supabase.calls.some((call) => call.op === 'functions.invoke'), false)
})

test('marked-paid status questions are INVESTIGATE while mark-paid commands remain ACT', () => {
  const statusQuestion = classifyAskDwIntent({
    text: 'Why is this invoice marked paid?',
    context: { invoiceId: INVOICE },
  })
  const actionCommand = classifyAskDwIntent({
    text: 'Mark this invoice paid',
    context: { invoiceId: INVOICE },
  })

  assert.equal(statusQuestion.job, 'INVESTIGATE')
  assert.equal(actionCommand.job, 'ACT')
})