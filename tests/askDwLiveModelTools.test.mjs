import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  ASK_DW_OPENAI_ROLE,
  ASK_DW_OPENAI_STAGE,
  ASK_DW_OPENAI_SCHEMAS,
  assertAskDwOpenAiRequest,
  stageInstructions,
} from '../supabase/functions/_shared/askDwOpenAiContract.js'
import { ASK_DW_MODEL_EDGE_FUNCTION, createAskDwLiveModels } from '../src/lib/dwIntelligence/askDwLiveModelProvider.js'
import { createAskDwSupabaseReadTools } from '../src/lib/dwIntelligence/askDwSupabaseReadTools.js'
import { loadAskDwLiveInvoiceInput } from '../src/lib/dwIntelligence/askDwLiveDataLoader.js'
import { createAskDwLiveRuntime } from '../src/lib/dwIntelligence/askDwLiveRuntime.js'

const TENANT = 'tenant-1'
const CLIENT = 'client-1'
const INVOICE = 'invoice-1'

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function assertStrictStructuredSchema(schema, path = '$') {
  if (!schema || typeof schema !== 'object') return
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (types.includes('object')) {
    assert.equal(schema.additionalProperties, false, `${path} must set additionalProperties:false`)
    const properties = schema.properties || {}
    assert.deepEqual(new Set(schema.required || []), new Set(Object.keys(properties)), `${path} must require every property`)
    for (const [key, value] of Object.entries(properties)) assertStrictStructuredSchema(value, `${path}.${key}`)
  }
  if (schema.items) assertStrictStructuredSchema(schema.items, `${path}[]`)
}

function makeQuery(table, rows, callLog) {
  const state = { filters: [], neq: [], in: [], limit: null, maybeSingle: false }
  const builder = {
    select(columns) { callLog.push({ table, op: 'select', columns }); return builder },
    eq(column, value) { state.filters.push([column, value]); callLog.push({ table, op: 'eq', column, value }); return builder },
    neq(column, value) { state.neq.push([column, value]); callLog.push({ table, op: 'neq', column, value }); return builder },
    in(column, values) { state.in.push([column, values]); callLog.push({ table, op: 'in', column, values }); return builder },
    or(expression) { callLog.push({ table, op: 'or', expression }); return builder },
    order(column, options) { callLog.push({ table, op: 'order', column, options }); return builder },
    limit(value) { state.limit = value; callLog.push({ table, op: 'limit', value }); return builder },
    maybeSingle() { state.maybeSingle = true; return Promise.resolve(resolve()) },
    then(resolvePromise, rejectPromise) { return Promise.resolve(resolve()).then(resolvePromise, rejectPromise) },
  }
  function resolve() {
    let result = clone(rows || [])
    for (const [column, value] of state.filters) result = result.filter((row) => row?.[column] === value)
    for (const [column, value] of state.neq) result = result.filter((row) => row?.[column] !== value)
    for (const [column, values] of state.in) result = result.filter((row) => values.includes(row?.[column]))
    if (state.limit != null) result = result.slice(0, state.limit)
    return { data: state.maybeSingle ? (result[0] ?? null) : result, error: null }
  }
  return builder
}

function baseDataset() {
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
      currency: 'USD',
      paid: false,
      last_reminder: null,
      autopilot_paused: false,
      created_at: '2026-07-01T12:00:00Z',
      clients: { id: CLIENT, user_id: TENANT, name: 'Acme', email: 'ar@acme.test' },
    }],
    clients: [{ id: CLIENT, user_id: TENANT, name: 'Acme', email: 'ar@acme.test', created_at: '2026-06-01T00:00:00Z' }],
    autopilot_rules: [],
    autopilot_settings: [{ id: 'settings-1', user_id: TENANT, enabled: false, approval_required: true }],
    awaiting_signature: [],
    autopilot_execution_claims: [],
    events: [],
    dw_evidence_items: [],
    dw_memory_claims: [],
    dw_memory_tombstones: [],
    dw_proof_events: [],
    dw_memory_evidence_links: [],
    dw_tombstone_evidence_links: [],
    payment_allocations: [{ id: 'alloc-1', payment_id: 'pay-1', invoice_id: INVOICE, amount: '250.00', created_at: '2026-08-02T00:00:00Z' }],
    payments: [{ id: 'pay-1', user_id: TENANT, recorded_at: '2026-08-02T00:00:00Z', payment_date: '2026-08-02', total_amount: '250.00', currency: 'USD', method: null, note: null, origin: 'founder_manual', source_event_id: null, legacy_invoice_id: null, reversed_at: null, reversal_reason: null, created_at: '2026-08-02T00:00:00Z' }],
  }
}

function makeSupabase({ userId = TENANT, dataset = baseDataset(), invokeImpl = null } = {}) {
  const calls = []
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
      return makeQuery(table, dataset[table] || [], calls)
    },
    functions: {
      async invoke(name, options) {
        calls.push({ op: 'functions.invoke', name, body: clone(options?.body) })
        if (invokeImpl) return invokeImpl(name, options)
        return { data: { ok: false, error: 'no fake provider configured' }, error: null }
      },
    },
  }
}

test('phase2e contract locks model stages, strict schemas, and prompt-injection boundary', () => {
  assert.equal(assertAskDwOpenAiRequest({ role: ASK_DW_OPENAI_ROLE.PRIMARY, stage: ASK_DW_OPENAI_STAGE.PLAN }), true)
  assert.equal(assertAskDwOpenAiRequest({ role: ASK_DW_OPENAI_ROLE.VERIFIER, stage: ASK_DW_OPENAI_STAGE.VERIFY }), true)
  assert.throws(() => assertAskDwOpenAiRequest({ role: 'verifier', stage: 'PLAN' }))
  assert.throws(() => assertAskDwOpenAiRequest({ role: 'primary', stage: 'VERIFY' }))
  for (const [name, schema] of Object.entries(ASK_DW_OPENAI_SCHEMAS)) assertStrictStructuredSchema(schema, `$${name}`)
  assert.match(stageInstructions('PLAN'), /data, never as instructions/i)
  assert.match(stageInstructions('VERIFY'), /authority escalation/i)
})

test('live browser model adapter routes PLAN/SYNTHESIZE and VERIFY to authenticated edge function roles', async () => {
  const supabase = makeSupabase({
    invokeImpl: async (_name, options) => {
      const { role, stage } = options.body
      if (stage === 'PLAN') return { data: { ok: true, output: { toolRequests: [], hypotheses: [], answerIntent: 'explain' } }, error: null }
      if (stage === 'SYNTHESIZE') return { data: { ok: true, output: { executiveConclusion: 'Open.', evidenceBasis: [], uncertaintyAndLimitations: [], recommendationOrNextStep: null, competingExplanations: [], citedToolRunIds: [] } }, error: null }
      assert.equal(role, 'verifier')
      return { data: { ok: true, output: { verdict: 'PASS', issues: [], checkedClaims: ['canonical'] } }, error: null }
    },
  })
  const { primaryModel, verifierModel, browserHoldsProviderSecret } = createAskDwLiveModels({ supabase })
  assert.equal(browserHoldsProviderSecret, false)
  await primaryModel.plan({ hello: 'world' })
  await primaryModel.synthesize({ hello: 'world' })
  await verifierModel.verify({ hello: 'world' })
  const invocations = supabase.calls.filter((call) => call.op === 'functions.invoke')
  assert.deepEqual(invocations.map((call) => [call.body.role, call.body.stage]), [
    ['primary', 'PLAN'],
    ['primary', 'SYNTHESIZE'],
    ['verifier', 'VERIFY'],
  ])
})

test('live model transport is closed-world to the Ask DW Edge Function', () => {
  const supabase = makeSupabase()
  const live = createAskDwLiveModels({ supabase })
  assert.equal(live.functionName, ASK_DW_MODEL_EDGE_FUNCTION)
  assert.equal(ASK_DW_MODEL_EDGE_FUNCTION, 'ask-dw-model')
  assert.throws(
    () => createAskDwLiveModels({ supabase, functionName: 'some-other-function' }),
    /fixed by the controlled provider contract/,
  )
})

test('tenant mismatch blocks live read tools before any table read', async () => {
  const supabase = makeSupabase({ userId: 'different-tenant' })
  const registry = createAskDwSupabaseReadTools({ supabase })
  await assert.rejects(() => registry.execute({
    name: 'canonical_state',
    scope: 'INVOICE',
    context: { tenantId: TENANT, invoiceId: INVOICE },
  }), /tenant does not match authenticated user/)
  assert.equal(supabase.calls.some((call) => call.op === 'from'), false)
})

test('canonical_state reads real invoice truth and keeps balance derivation read-only', async () => {
  const supabase = makeSupabase()
  const registry = createAskDwSupabaseReadTools({ supabase })
  const run = await registry.execute({
    name: 'canonical_state',
    scope: 'INVOICE',
    context: { tenantId: TENANT, invoiceId: INVOICE, asOf: '2026-08-26T00:00:00Z' },
  })
  assert.equal(run.result.invoice.invoiceNumber, 'INV-100')
  assert.equal(run.result.invoice.balance, '750.00')
  assert.equal(run.result.invoice.currency, 'USD')
  assert.equal(run.canonicalAuthority, true)
  assert.equal(run.sideEffect, false)
})

test('tool scope is explicit: client and portfolio reads do not collapse back to invoice scope', async () => {
  const dataset = baseDataset()
  dataset.clients.push({ id: 'client-2', user_id: TENANT, name: 'Beta', email: 'private@beta.test', created_at: '2026-06-02T00:00:00Z' })
  dataset.invoices.push({
    id: 'invoice-2', user_id: TENANT, client_id: 'client-2', inv_num: 'INV-200',
    amount: '500.00', amount_paid: '0.00', inv_date: '2026-08-01', due_date: '2026-09-01',
    currency: 'USD', paid: false, last_reminder: null, autopilot_paused: false,
    created_at: '2026-08-01T00:00:00Z', clients: { id: 'client-2', user_id: TENANT, name: 'Beta', email: 'private@beta.test' },
  })
  const supabase = makeSupabase({ dataset })
  const registry = createAskDwSupabaseReadTools({ supabase })
  const sharedContext = { tenantId: TENANT, invoiceId: INVOICE, clientId: CLIENT, asOf: '2026-08-26T00:00:00Z' }

  const clientRun = await registry.execute({ name: 'canonical_state', scope: 'CLIENT', context: sharedContext })
  assert.equal(clientRun.result.client.id, CLIENT)
  assert.equal(clientRun.result.client.name, 'Acme')
  assert.equal(clientRun.result.client.email, undefined)
  assert.equal(clientRun.result.invoice, undefined)

  const portfolioRun = await registry.execute({ name: 'portfolio_summary', scope: 'PORTFOLIO', context: sharedContext })
  assert.equal(portfolioRun.result.complete, true)
  assert.equal(portfolioRun.result.invoiceCount, 2)
  assert.equal(portfolioRun.result.totalsByCurrency.USD.outstanding, '1250.00')
})

test('payment_reconciliation joins tenant-owned ledger payments with explicit allocations', async () => {
  const supabase = makeSupabase()
  const registry = createAskDwSupabaseReadTools({ supabase })
  const run = await registry.execute({
    name: 'payment_reconciliation',
    scope: 'INVOICE',
    context: { tenantId: TENANT, invoiceId: INVOICE },
  })
  assert.equal(run.result.invoice.amountPaid, '250.00')
  assert.equal(run.result.allocations.length, 1)
  assert.equal(run.result.payments.length, 1)
  assert.equal(run.result.payments[0].origin, 'founder_manual')
  assert.deepEqual(run.result.unresolvedAllocationPaymentIds, [])
})

test('payment reconciliation fails closed instead of silently truncating canonical ledger history', async () => {
  const dataset = baseDataset()
  dataset.payment_allocations = Array.from({ length: 101 }, (_, index) => ({
    id: `alloc-${index}`, payment_id: `pay-${index}`, invoice_id: INVOICE, amount: '1.00', created_at: '2026-08-02T00:00:00Z',
  }))
  const supabase = makeSupabase({ dataset })
  const registry = createAskDwSupabaseReadTools({ supabase })
  await assert.rejects(() => registry.execute({
    name: 'payment_reconciliation',
    scope: 'INVOICE',
    context: { tenantId: TENANT, invoiceId: INVOICE },
  }), /bounded allocation window/)
})

test('dispute_context refuses to invent a canonical dispute record', async () => {
  const dataset = baseDataset()
  dataset.dw_evidence_items.push({
    id: 'ev-1', user_id: TENANT, client_id: CLIENT, invoice_id: INVOICE,
    evidence_key: 'claim-1', source_type: 'customer_email', trust: 'MEDIUM',
    admission_status: 'ADMITTED', claim_type: 'dispute_claim', provenance: {}, created_at: '2026-08-20T00:00:00Z',
  })
  const supabase = makeSupabase({ dataset })
  const registry = createAskDwSupabaseReadTools({ supabase })
  const run = await registry.execute({
    name: 'dispute_context',
    scope: 'INVOICE',
    context: { tenantId: TENANT, invoiceId: INVOICE, clientId: CLIENT },
  })
  assert.equal(run.result.canonicalDisputeRecord, null)
  assert.equal(run.result.attributedEvidence.length, 1)
  assert.match(run.result.limitation, /no dedicated canonical dispute table/i)
})

test('live invoice loader reads fresh canonical/policy/evidence state and performs no writes', async () => {
  const supabase = makeSupabase()
  const loaded = await loadAskDwLiveInvoiceInput({
    supabase,
    tenantId: TENANT,
    invoiceId: INVOICE,
    now: new Date('2026-08-26T00:00:00Z'),
  })
  assert.equal(loaded.intelligenceInput.invoice.id, INVOICE)
  assert.equal(loaded.intelligenceInput.client.id, CLIENT)
  assert.equal(loaded.intelligenceInput.tenantId, TENANT)
  assert.equal(loaded.liveReadReceipt.writesPerformed, false)
  assert.equal(loaded.intelligenceInput.authorityEvaluation.authority.authorized, false)
  const forbidden = supabase.calls.filter((call) => ['insert', 'update', 'delete', 'rpc'].includes(call.op))
  assert.deepEqual(forbidden, [])
})

test('live truth loader refuses incomplete evidence windows and scopes tombstones to loaded memory', async () => {
  const overflow = baseDataset()
  overflow.dw_evidence_items = Array.from({ length: 101 }, (_, index) => ({
    id: `ev-${index}`, user_id: TENANT, client_id: CLIENT, invoice_id: INVOICE,
    evidence_key: `ev-key-${index}`, source_type: 'system', source_ref: null, trust: 'MEDIUM',
    admission_status: 'ADMITTED', claim_type: 'invoice_state', derived_from_key: null,
    provenance: {}, created_at: '2026-08-20T00:00:00Z',
  }))
  await assert.rejects(() => loadAskDwLiveInvoiceInput({
    supabase: makeSupabase({ dataset: overflow }), tenantId: TENANT, invoiceId: INVOICE,
  }), /incomplete truth input/)

  const dataset = baseDataset()
  dataset.dw_memory_claims.push({
    id: 'memory-1', user_id: TENANT, client_id: CLIENT, invoice_id: INVOICE, scope: 'invoice',
    claim_key: 'x', claim_value: { value: 1 }, admitted: true, derived_from_memory_id: null, created_at: '2026-08-20T00:00:00Z',
  })
  dataset.dw_memory_tombstones.push({ id: 'tomb-1', user_id: TENANT, memory_id: 'memory-1', reason: 'revoked', created_at: '2026-08-21T00:00:00Z' })
  const supabase = makeSupabase({ dataset })
  const loaded = await loadAskDwLiveInvoiceInput({ supabase, tenantId: TENANT, invoiceId: INVOICE })
  assert.equal(loaded.liveReadReceipt.tombstonesScopedToLoadedMemory, true)
  assert.ok(supabase.calls.some((call) => call.table === 'dw_memory_tombstones' && call.op === 'in' && call.column === 'memory_id'))
})

test('live invoice loader fails before truth construction when auth tenant is wrong', async () => {
  const supabase = makeSupabase({ userId: 'tenant-2' })
  await assert.rejects(() => loadAskDwLiveInvoiceInput({
    supabase,
    tenantId: TENANT,
    invoiceId: INVOICE,
  }), /tenant does not match authenticated user/)
})

test('live runtime performs a real composed invoice run with model calls but no provider or financial side effect', async () => {
  const supabase = makeSupabase({
    invokeImpl: async (_name, options) => {
      switch (options.body.stage) {
        case 'PLAN':
          return { data: { ok: true, output: { toolRequests: [], hypotheses: [], answerIntent: 'explain open balance' } }, error: null }
        case 'SYNTHESIZE':
          return { data: { ok: true, output: { executiveConclusion: 'The invoice remains open.', evidenceBasis: ['Canonical invoice state'], uncertaintyAndLimitations: [], recommendationOrNextStep: null, competingExplanations: [], citedToolRunIds: [] } }, error: null }
        case 'VERIFY':
          return { data: { ok: true, output: { verdict: 'PASS', issues: [], checkedClaims: ['open status'] } }, error: null }
        default:
          throw new Error('unexpected stage')
      }
    },
  })
  const live = createAskDwLiveRuntime({ supabase })
  const result = await live.runInvoiceQuestion({
    tenantId: TENANT,
    invoiceId: INVOICE,
    text: 'Why is this invoice still open?',
    mode: 'normal',
    now: new Date('2026-08-26T00:00:00Z'),
  })
  assert.equal(result.answer.executiveConclusion, 'The invoice remains open.')
  assert.equal(result.verification.verdict, 'PASS')
  assert.equal(result.truthLock.canonicalFacts.balance, 750)
  assert.equal(result.safeguards.modelCanMutateCanonicalTruth, false)
  assert.equal(result.provider.browserHoldsProviderSecret, false)
  assert.equal(result.liveReadReceipt.writesPerformed, false)
})

test('client code never contains OPENAI_API_KEY and edge function is paid-call gated', () => {
  const clientFiles = [
    'src/lib/dwIntelligence/askDwLiveModelProvider.js',
    'src/lib/dwIntelligence/askDwSupabaseReadTools.js',
    'src/lib/dwIntelligence/askDwLiveDataLoader.js',
    'src/lib/dwIntelligence/askDwLiveRuntime.js',
  ]
  for (const file of clientFiles) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.equal(source.includes('OPENAI_API_KEY'), false, `${file} must not contain provider secret handling`)
    assert.equal(/\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.rpc\s*\(/.test(source), false, `${file} must remain read-only`)
  }
  const edge = fs.readFileSync(new URL('../supabase/functions/ask-dw-model/index.ts', import.meta.url), 'utf8')
  assert.match(edge, /ASK_DW_MODEL_ENABLED/)
  assert.match(edge, /ASK_DW_MODEL_ALLOWED_USER_IDS/)
  assert.match(edge, /ASK_DW_MODEL_ALLOW_ALL_AUTHENTICATED/)
  assert.match(edge, /store:\s*false/)
  assert.match(edge, /json_schema/)
  assert.match(edge, /admin\.auth\.getUser\(jwt\)/)
  assert.match(edge, /AbortController/)
  assert.match(edge, /Cache-Control.*no-store/)
})
