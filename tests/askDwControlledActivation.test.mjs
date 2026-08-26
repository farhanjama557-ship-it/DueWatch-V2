import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ASK_DW_CONTROLLED_ACTIVATION_PROFILE,
  createAskDwControlledActivationRuntime,
  createAskDwControlledReadTools,
  loadAskDwControlledActivationInput,
} from '../src/lib/dwIntelligence/askDwControlledActivation.js'

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

function makeSupabase({ userId = TENANT, data = dataset(), invokeImpl = null } = {}) {
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
        if (!invokeImpl) return { data: { ok: false, error: 'no provider configured' }, error: null }
        return invokeImpl(name, options)
      },
    },
  }
}

test('controlled activation exposes only canonical_state and activity_history', () => {
  const supabase = makeSupabase()
  const registry = createAskDwControlledReadTools({ supabase })
  assert.deepEqual(
    registry.list().map((item) => item.name),
    ['canonical_state', 'activity_history'],
  )
  assert.equal(ASK_DW_CONTROLLED_ACTIVATION_PROFILE.financialExecutionAuthorized, false)
  assert.equal(ASK_DW_CONTROLLED_ACTIVATION_PROFILE.modelPlanningEnabled, false)
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

test('first controlled live run performs deterministic PLAN plus real SYNTHESIZE and VERIFY only', async () => {
  const supabase = makeSupabase({
    invokeImpl: async (_name, options) => {
      const { role, stage, input } = options.body
      if (stage === 'SYNTHESIZE') {
        assert.equal(role, 'primary')
        assert.equal(input.activationPolicy.id, 'CANONICAL_READ_ONLY_V1')
        return {
          data: {
            ok: true,
            output: {
              executiveConclusion: 'The invoice is open with 750.00 outstanding.',
              evidenceBasis: ['tool-01-canonical_state'],
              uncertaintyAndLimitations: ['Currency and payment-ledger reconciliation are unavailable in controlled activation.'],
              recommendationOrNextStep: null,
              competingExplanations: [],
              citedToolRunIds: ['tool-01-canonical_state'],
            },
          },
          error: null,
        }
      }
      assert.equal(stage, 'VERIFY')
      assert.equal(role, 'verifier')
      assert.equal(input.activationPolicy.financialExecutionAuthorized, false)
      return {
        data: {
          ok: true,
          output: {
            verdict: 'PASS',
            issues: [],
            checkedClaims: ['canonical balance', 'authority non-escalation'],
          },
        },
        error: null,
      }
    },
  })

  const runtime = createAskDwControlledActivationRuntime({ supabase })
  const result = await runtime.runInvoiceQuestion({
    tenantId: TENANT,
    invoiceId: INVOICE,
    mode: 'normal',
    text: 'What is the current balance on this invoice?',
    now: new Date('2026-08-26T00:00:00Z'),
  })

  const providerCalls = supabase.calls.filter((call) => call.op === 'functions.invoke')
  assert.deepEqual(providerCalls.map((call) => [call.body.role, call.body.stage]), [
    ['primary', 'SYNTHESIZE'],
    ['verifier', 'VERIFY'],
  ])
  assert.deepEqual(result.plan.toolRequests.map((request) => request.name), [
    'canonical_state',
    'activity_history',
  ])
  assert.equal(result.verification.verdict, 'PASS')
  assert.equal(result.truthLock.authority.actual, 'NOT_GRANTED')
  assert.equal(result.provider.planProviderCalls, 0)
  assert.equal(result.provider.synthesizeProviderCalls, 1)
  assert.equal(result.provider.verifyProviderCalls, 1)
  assert.equal(result.safeguards.modelCanGrantAuthority, false)
})

test('controlled activation blocks ACT before any model call', async () => {
  const supabase = makeSupabase({
    invokeImpl: async () => {
      throw new Error('provider must not be called')
    },
  })
  const runtime = createAskDwControlledActivationRuntime({ supabase })
  await assert.rejects(
    () => runtime.runInvoiceQuestion({
      tenantId: TENANT,
      invoiceId: INVOICE,
      mode: 'normal',
      text: 'Send a reminder for this invoice',
      now: new Date('2026-08-26T00:00:00Z'),
    }),
    /blocks ACT questions before any model call/,
  )
  assert.equal(supabase.calls.some((call) => call.op === 'functions.invoke'), false)
})
