import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ASK_DW_CASE_EVENT,
  applyAskDwCaseEvent,
  createAskDwCaseState,
} from '../src/lib/dwIntelligence/askDwCaseState.js'
import {
  createAskDwCaseAwareRuntime,
} from '../src/lib/dwIntelligence/askDwConversationRuntime.js'
import {
  ASK_DW_ENTITY_RESOLUTION_STATUS,
  ASK_DW_ENTITY_RESOLVER_PROFILE,
  createAskDwEntityResolver,
} from '../src/lib/dwIntelligence/askDwEntityResolver.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

const TENANT = 'tenant-m2b'
const OTHER_TENANT = 'tenant-m2b-other'

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function baseData() {
  return {
    clients: [
      { id: 'client-anthony', user_id: TENANT, name: 'Anthony Miller', created_at: '2026-01-01T00:00:00Z' },
      { id: 'client-sarah', user_id: TENANT, name: 'Sarah Jenkins', created_at: '2026-01-02T00:00:00Z' },
      { id: 'client-foreign', user_id: OTHER_TENANT, name: 'Anthony Foreign', created_at: '2026-01-03T00:00:00Z' },
    ],
    invoices: [
      { id: 'invoice-anthony-1844', user_id: TENANT, client_id: 'client-anthony', inv_num: 'INV-1844', created_at: '2026-02-01T00:00:00Z' },
      { id: 'invoice-anthony-1902', user_id: TENANT, client_id: 'client-anthony', inv_num: 'INV-1902', created_at: '2026-03-01T00:00:00Z' },
      { id: 'invoice-sarah-2030', user_id: TENANT, client_id: 'client-sarah', inv_num: 'INV-2030', created_at: '2026-02-15T00:00:00Z' },
      { id: 'invoice-foreign-1902', user_id: OTHER_TENANT, client_id: 'client-foreign', inv_num: 'INV-1902', created_at: '2026-02-20T00:00:00Z' },
    ],
  }
}

function escapeRegexChar(char) {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ilikeMatches(value, pattern) {
  let regex = '^'
  let escaped = false
  for (const char of String(pattern)) {
    if (escaped) {
      regex += escapeRegexChar(char)
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === '%') {
      regex += '.*'
    } else if (char === '_') {
      regex += '.'
    } else {
      regex += escapeRegexChar(char)
    }
  }
  if (escaped) regex += '\\\\'
  return new RegExp(`${regex}$`, 'i').test(String(value ?? ''))
}

function makeQuery(table, rows, calls) {
  const state = {
    eq: [],
    ilike: [],
    order: null,
    limit: null,
    single: false,
  }

  const builder = {
    select(columns) {
      calls.push({ op: 'select', table, columns })
      return builder
    },
    eq(column, value) {
      state.eq.push([column, value])
      calls.push({ op: 'eq', table, column, value })
      return builder
    },
    ilike(column, pattern) {
      state.ilike.push([column, pattern])
      calls.push({ op: 'ilike', table, column, pattern })
      return builder
    },
    order(column, options) {
      state.order = [column, options]
      calls.push({ op: 'order', table, column, options })
      return builder
    },
    limit(value) {
      state.limit = value
      calls.push({ op: 'limit', table, value })
      return builder
    },
    maybeSingle() {
      state.single = true
      return Promise.resolve(resolve())
    },
    then(resolvePromise, rejectPromise) {
      return Promise.resolve(resolve()).then(resolvePromise, rejectPromise)
    },
  }

  function resolve() {
    let result = clone(rows)
    for (const [column, value] of state.eq) {
      result = result.filter((row) => row?.[column] === value)
    }
    for (const [column, pattern] of state.ilike) {
      result = result.filter((row) => ilikeMatches(row?.[column], pattern))
    }
    if (state.order) {
      const [column, options] = state.order
      const direction = options?.ascending === false ? -1 : 1
      result.sort((left, right) => String(left?.[column] ?? '').localeCompare(String(right?.[column] ?? '')) * direction)
    }
    if (state.limit != null) result = result.slice(0, state.limit)
    return { data: state.single ? (result[0] ?? null) : result, error: null }
  }

  return builder
}

function makeSupabase({
  userId = TENANT,
  data = baseData(),
} = {}) {
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
      if (!Object.prototype.hasOwnProperty.call(data, table)) {
        throw new Error(`unexpected table: ${table}`)
      }
      return makeQuery(table, data[table], calls)
    },
  }
}

function initialState() {
  return createAskDwCaseState({
    tenantId: TENANT,
    conversationId: 'conversation-m2b',
    caseId: 'case-m2b',
    turnId: 'turn-bootstrap',
    now: '2026-08-27T13:00:00.000Z',
  })
}

function fakeInvoiceRunner(log) {
  return async (args) => {
    log.push(clone(args))
    return {
      answer: { executiveConclusion: `Fresh answer for ${args.invoiceId}` },
      truthLock: { authority: { actual: 'NOT_GRANTED' } },
      liveReadReceipt: { writesPerformed: false },
      intelligence: { execution: { sideEffect: false } },
    }
  }
}

function runtimeFor(supabase, liveCalls) {
  const resolver = createAskDwEntityResolver({ supabase })
  return {
    resolver,
    runtime: createAskDwCaseAwareRuntime({
      runInvoiceQuestion: fakeInvoiceRunner(liveCalls),
      resolveCaseEvents: resolver.resolveCaseEvents,
    }),
  }
}

function clientOnlyAnthonyData() {
  const data = baseData()
  data.invoices = data.invoices.filter((row) => row.id !== 'invoice-anthony-1902')
  return data
}

test('M2B resolver profile is authenticated, read-only, provider-independent and non-authoritative', () => {
  assert.equal(ASK_DW_ENTITY_RESOLVER_PROFILE.authenticatedTenantRequired, true)
  assert.equal(ASK_DW_ENTITY_RESOLVER_PROFILE.readsOnly, true)
  assert.equal(ASK_DW_ENTITY_RESOLVER_PROFILE.clientCreationAllowed, false)
  assert.equal(ASK_DW_ENTITY_RESOLVER_PROFILE.canonicalMutationAllowed, false)
  assert.equal(ASK_DW_ENTITY_RESOLVER_PROFILE.authorityGranted, false)
  assert.equal(ASK_DW_ENTITY_RESOLVER_PROFILE.modelDependency, false)
})

test('"What is going on with Anthony?" resolves a unique real tenant client and sole invoice', async () => {
  const supabase = makeSupabase({ data: clientOnlyAnthonyData() })
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)

  const result = await runtime.runTurn({
    tenantId: TENANT,
    caseState: initialState(),
    turnId: 'turn-anthony',
    text: "What's going on with Anthony?",
    now: new Date('2026-08-27T13:01:00.000Z'),
  })

  assert.equal(result.status, 'ANSWERED')
  assert.equal(result.resolver.status, ASK_DW_ENTITY_RESOLUTION_STATUS.RESOLVED)
  assert.equal(result.caseContext.focus.clientRef.id, 'client-anthony')
  assert.equal(result.caseContext.focus.invoiceRef.id, 'invoice-anthony-1844')
  assert.deepEqual(result.caseContext.candidates.invoiceRefs, [
    { kind: 'invoice', id: 'invoice-anthony-1844' },
  ])
  assert.equal(liveCalls.length, 1)
  assert.equal(liveCalls[0].invoiceId, 'invoice-anthony-1844')

  const serialized = JSON.stringify(result.caseContext)
  assert.equal(serialized.includes('amount'), false)
  assert.equal(serialized.includes('balance'), false)
  assert.equal(serialized.includes('currency'), false)
  assert.equal(result.caseContext.boundaries.businessAuthorityStored, false)
  assert.equal(result.caseContext.boundaries.authorityRecheckRequiredBeforeExecution, true)
  assert.equal(serialized.includes('"authorityActual"'), false)
  assert.equal(serialized.includes('"financialExecutionAuthorized"'), false)
  assert.equal(serialized.includes('"permissions"'), false)
})

test('client-only Anthony with two invoices fails closed after establishing reference-only candidates', async () => {
  const supabase = makeSupabase()
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)

  const result = await runtime.runTurn({
    tenantId: TENANT,
    caseState: initialState(),
    turnId: 'turn-anthony-two',
    text: "What's going on with Anthony?",
    now: new Date('2026-08-27T13:02:00.000Z'),
  })

  assert.equal(result.status, ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_INVOICE_RESOLUTION)
  assert.match(result.reason, /more than one resolved invoice/i)
  assert.equal(result.caseContext.focus.clientRef.id, 'client-anthony')
  assert.equal(result.caseContext.focus.invoiceRef, null)
  assert.deepEqual(result.caseContext.candidates.invoiceRefs, [
    { kind: 'invoice', id: 'invoice-anthony-1844' },
    { kind: 'invoice', id: 'invoice-anthony-1902' },
  ])
  assert.equal(liveCalls.length, 0)
})

test('bare Anthony is ambiguous when two tenant clients share the same first name', async () => {
  const data = baseData()
  data.clients.push({
    id: 'client-anthony-davis',
    user_id: TENANT,
    name: 'Anthony Davis',
    created_at: '2026-01-04T00:00:00Z',
  })
  data.invoices.push({
    id: 'invoice-anthony-davis',
    user_id: TENANT,
    client_id: 'client-anthony-davis',
    inv_num: 'INV-3000',
    created_at: '2026-04-01T00:00:00Z',
  })

  const supabase = makeSupabase({ data })
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)
  const result = await runtime.runTurn({
    tenantId: TENANT,
    caseState: initialState(),
    turnId: 'turn-ambiguous',
    text: 'What is happening with Anthony?',
    now: new Date('2026-08-27T13:03:00.000Z'),
  })

  assert.equal(result.status, ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_CLIENT_RESOLUTION)
  assert.match(result.reason, /more than one client/i)
  assert.equal(result.caseContext.focus.clientRef, null)
  assert.equal(result.caseContext.focus.invoiceRef, null)
  assert.equal(liveCalls.length, 0)
})

test('full Anthony Miller wins deterministically over another Anthony', async () => {
  const data = clientOnlyAnthonyData()
  data.clients.push({
    id: 'client-anthony-davis',
    user_id: TENANT,
    name: 'Anthony Davis',
    created_at: '2026-01-04T00:00:00Z',
  })
  data.invoices.push({
    id: 'invoice-anthony-davis',
    user_id: TENANT,
    client_id: 'client-anthony-davis',
    inv_num: 'INV-3000',
    created_at: '2026-04-01T00:00:00Z',
  })

  const supabase = makeSupabase({ data })
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)
  const result = await runtime.runTurn({
    tenantId: TENANT,
    caseState: initialState(),
    turnId: 'turn-full-name',
    text: 'What is happening with Anthony Miller?',
    now: new Date('2026-08-27T13:04:00.000Z'),
  })

  assert.equal(result.status, 'ANSWERED')
  assert.equal(result.caseContext.focus.clientRef.id, 'client-anthony')
  assert.equal(result.caseContext.focus.invoiceRef.id, 'invoice-anthony-1844')
  assert.equal(liveCalls.length, 1)
})

test('full name can resolve safely even when a broad first-name query exceeds the bounded client window', async () => {
  const data = clientOnlyAnthonyData()

  for (let index = 0; index < 25; index += 1) {
    data.clients.push({
      id: `client-anthony-${index}`,
      user_id: TENANT,
      name: `Anthony Person ${index}`,
      created_at: `2026-01-${String((index % 20) + 5).padStart(2, '0')}T00:00:00Z`,
    })
  }

  const supabase = makeSupabase({ data })
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)

  const result = await runtime.runTurn({
    tenantId: TENANT,
    caseState: initialState(),
    turnId: 'turn-full-name-bounded',
    text: 'What is happening with Anthony Miller?',
    now: new Date('2026-08-27T13:04:30.000Z'),
  })

  assert.equal(result.status, 'ANSWERED')
  assert.equal(result.caseContext.focus.clientRef.id, 'client-anthony')
  assert.equal(result.caseContext.focus.invoiceRef.id, 'invoice-anthony-1844')
  assert.equal(liveCalls.length, 1)
})

test('explicit INV-1902 resolves the exact tenant invoice, owner client and candidate set', async () => {
  const supabase = makeSupabase()
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)

  const result = await runtime.runTurn({
    tenantId: TENANT,
    caseState: initialState(),
    turnId: 'turn-inv-1902',
    text: 'What is happening with INV-1902?',
    now: new Date('2026-08-27T13:05:00.000Z'),
  })

  assert.equal(result.status, 'ANSWERED')
  assert.equal(result.caseContext.focus.clientRef.id, 'client-anthony')
  assert.equal(result.caseContext.focus.invoiceRef.id, 'invoice-anthony-1902')
  assert.deepEqual(result.caseContext.candidates.invoiceRefs, [
    { kind: 'invoice', id: 'invoice-anthony-1844' },
    { kind: 'invoice', id: 'invoice-anthony-1902' },
  ])
  assert.equal(liveCalls.length, 1)
  assert.equal(liveCalls[0].invoiceId, 'invoice-anthony-1902')
})

test('explicit invoice lookup treats ILIKE metacharacters as literals and never guesses', async () => {
  const data = baseData()
  data.invoices.push({
    id: 'invoice-near-match',
    user_id: TENANT,
    client_id: 'client-sarah',
    inv_num: 'INV-A1B',
    created_at: '2026-04-10T00:00:00Z',
  })

  const supabase = makeSupabase({ data })
  const resolver = createAskDwEntityResolver({ supabase })
  const result = await resolver.resolveCaseEvents({
    tenantId: TENANT,
    text: 'Check INV-A_B',
    caseContext: { focus: { clientRef: null, invoiceRef: null } },
  })

  assert.equal(result.status, ASK_DW_ENTITY_RESOLUTION_STATUS.INVOICE_NOT_FOUND)
  assert.equal(result.blocked, true)
  assert.deepEqual(result.events, [])
})

test('real resolver plus M1E makes "the other invoice" deterministic after exact invoice resolution', async () => {
  const supabase = makeSupabase()
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)

  const first = await runtime.runTurn({
    tenantId: TENANT,
    caseState: initialState(),
    turnId: 'turn-first',
    text: 'Check INV-1902',
    now: new Date('2026-08-27T13:06:00.000Z'),
  })
  const second = await runtime.runTurn({
    tenantId: TENANT,
    caseState: first.caseState,
    turnId: 'turn-other',
    text: 'the other invoice',
    now: new Date('2026-08-27T13:07:00.000Z'),
  })

  assert.equal(second.status, 'ANSWERED')
  assert.equal(second.control.classification, 'CORRECT_ACTIVE_INVOICE')
  assert.equal(second.caseContext.focus.invoiceRef.id, 'invoice-anthony-1844')
  assert.equal(liveCalls.length, 2)
  assert.equal(liveCalls[1].invoiceId, 'invoice-anthony-1844')
})

test('active invoice is re-verified exactly when the client invoice set exceeds the case bound', async () => {
  const data = baseData()

  for (let index = 0; index < 21; index += 1) {
    data.invoices.push({
      id: `invoice-anthony-extra-${index}`,
      user_id: TENANT,
      client_id: 'client-anthony',
      inv_num: `INV-X${index}`,
      created_at: `2026-04-${String((index % 20) + 1).padStart(2, '0')}T00:00:00Z`,
    })
  }

  const supabase = makeSupabase({ data })
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)

  const first = await runtime.runTurn({
    tenantId: TENANT,
    caseState: initialState(),
    turnId: 'turn-bounded-first',
    text: 'Check INV-1902',
    now: new Date('2026-08-27T13:07:30.000Z'),
  })

  const second = await runtime.runTurn({
    tenantId: TENANT,
    caseState: first.caseState,
    turnId: 'turn-bounded-client',
    text: 'What is happening with Anthony Miller?',
    now: new Date('2026-08-27T13:08:00.000Z'),
  })

  assert.equal(second.status, 'ANSWERED')
  assert.equal(
    second.resolver.status,
    ASK_DW_ENTITY_RESOLUTION_STATUS.RESOLVED_WITH_LIMITATION,
  )
  assert.equal(second.caseContext.focus.invoiceRef.id, 'invoice-anthony-1902')
  assert.deepEqual(second.caseContext.candidates.invoiceRefs, [
    { kind: 'invoice', id: 'invoice-anthony-1902' },
  ])
  assert.equal(liveCalls.length, 2)
})

test('stale active invoice cannot survive a truncated client resolution without exact ownership proof', async () => {
  const data = baseData()

  for (let index = 0; index < 21; index += 1) {
    data.invoices.push({
      id: `invoice-anthony-extra-stale-${index}`,
      user_id: TENANT,
      client_id: 'client-anthony',
      inv_num: `INV-S${index}`,
      created_at: `2026-05-${String((index % 20) + 1).padStart(2, '0')}T00:00:00Z`,
    })
  }

  const supabase = makeSupabase({ data })
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)

  const first = await runtime.runTurn({
    tenantId: TENANT,
    caseState: initialState(),
    turnId: 'turn-stale-first',
    text: 'Check INV-1902',
    now: new Date('2026-08-27T13:08:10.000Z'),
  })

  const target = data.invoices.find(
    (invoice) => invoice.id === 'invoice-anthony-1902',
  )
  target.client_id = 'client-sarah'

  const second = await runtime.runTurn({
    tenantId: TENANT,
    caseState: first.caseState,
    turnId: 'turn-stale-client',
    text: 'What is happening with Anthony Miller?',
    now: new Date('2026-08-27T13:08:20.000Z'),
  })

  assert.equal(
    second.status,
    ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_INVOICE_RESOLUTION,
  )
  assert.deepEqual(second.caseContext.candidates.invoiceRefs, [])
  assert.equal(liveCalls.length, 1)
})

test('unknown cued client fails closed instead of silently staying on an old client', async () => {
  const supabase = makeSupabase()
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)

  const first = await runtime.runTurn({
    tenantId: TENANT,
    caseState: initialState(),
    turnId: 'turn-known',
    text: 'Check INV-1902',
    now: new Date('2026-08-27T13:08:00.000Z'),
  })
  const second = await runtime.runTurn({
    tenantId: TENANT,
    caseState: first.caseState,
    turnId: 'turn-unknown',
    text: 'What about Bob?',
    now: new Date('2026-08-27T13:09:00.000Z'),
  })

  assert.equal(second.status, ASK_DW_ENTITY_RESOLUTION_STATUS.CLIENT_NOT_FOUND)
  assert.equal(second.caseContext.focus.clientRef.id, 'client-anthony')
  assert.equal(second.caseContext.focus.invoiceRef.id, 'invoice-anthony-1902')
  assert.equal(liveCalls.length, 1)
})

test('cross-tenant resolver turn is rejected after auth and before any table read', async () => {
  const supabase = makeSupabase({ userId: OTHER_TENANT })
  const resolver = createAskDwEntityResolver({ supabase })

  await assert.rejects(() => resolver.resolveCaseEvents({
    tenantId: TENANT,
    text: 'What is happening with Anthony?',
    caseContext: { focus: { clientRef: null, invoiceRef: null } },
  }), /tenant mismatch/)

  assert.deepEqual(supabase.calls.map((call) => call.op), ['auth.getUser'])
})

test('resolver source is structurally read-only and never selects canonical money or authority fields', () => {
  const source = fs.readFileSync(
    path.join(repo, 'src/lib/dwIntelligence/askDwEntityResolver.js'),
    'utf8',
  )

  assert.doesNotMatch(source, /\.insert\s*\(/)
  assert.doesNotMatch(source, /\.update\s*\(/)
  assert.doesNotMatch(source, /\.delete\s*\(/)
  assert.doesNotMatch(source, /\.upsert\s*\(/)
  assert.doesNotMatch(source, /\.rpc\s*\(/)
  const selectedColumns = [...source.matchAll(/\.select\('([^']+)'\)/g)]
    .map((match) => match[1])
    .join(',')
  assert.doesNotMatch(selectedColumns, /amount_paid|\bbalance\b|\bcurrency\b|due_date|\bauthority\b/i)
  assert.match(source, /select\('id,user_id,name,created_at'\)/)
  assert.match(source, /select\('id,user_id,client_id,inv_num,created_at'\)/)
})

test('M1E rejects arbitrary resolver outcome statuses instead of exposing fake execution semantics', async () => {
  const liveCalls = []

  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: fakeInvoiceRunner(liveCalls),
    resolveCaseEvents: async () => ({
      status: 'EXECUTED',
      blocked: true,
      events: [],
      reason: 'untrusted status',
    }),
  })

  await assert.rejects(() => runtime.runTurn({
    tenantId: TENANT,
    caseState: initialState(),
    turnId: 'turn-malicious-status',
    text: 'What is happening?',
    now: new Date('2026-08-27T13:10:00.000Z'),
  }), /resolver outcome status not allowed/i)

  assert.equal(liveCalls.length, 0)
})

test('M2B runtime patch lets blocked resolver outcomes surface without granting action-control authority', () => {
  const source = fs.readFileSync(
    path.join(repo, 'src/lib/dwIntelligence/askDwConversationRuntime.js'),
    'utf8',
  )
  assert.match(source, /validateResolverOutcome/)
  assert.match(source, /resolverOutcome\?\.blocked && control\.classification === 'NONE'/)
  assert.match(source, /Ask DW case resolver event not allowed/)
  const safeBlock = /const SAFE_RESOLVER_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/.exec(source)
  assert.ok(safeBlock)
  assert.doesNotMatch(safeBlock[1], /CONFIRM_ACTION_REFERENCE/)
})

test('G7-CP5 explicit client switches, return, and ordinal correction preserve deterministic focus', async () => {
  const data = baseData()
  const supabase = makeSupabase({ data })
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)

  const anthony = await runtime.runTurn({
    tenantId: TENANT, caseState: initialState(), turnId: 'cp5-anthony',
    text: 'Check INV-1902', now: new Date('2026-08-27T14:00:00.000Z'),
  })
  const sarah = await runtime.runTurn({
    tenantId: TENANT, caseState: anthony.caseState, turnId: 'cp5-sarah',
    text: 'what about Sarah?', now: new Date('2026-08-27T14:01:00.000Z'),
  })
  const back = await runtime.runTurn({
    tenantId: TENANT, caseState: sarah.caseState, turnId: 'cp5-back',
    text: 'back to Anthony Miller', now: new Date('2026-08-27T14:02:00.000Z'),
  })
  const corrected = await runtime.runTurn({
    tenantId: TENANT, caseState: back.caseState, turnId: 'cp5-second',
    text: 'I meant the second invoice', now: new Date('2026-08-27T14:03:00.000Z'),
  })

  assert.equal(anthony.caseContext.focus.invoiceRef.id, 'invoice-anthony-1902')
  assert.equal(sarah.caseContext.focus.clientRef.id, 'client-sarah')
  assert.equal(sarah.caseContext.focus.invoiceRef.id, 'invoice-sarah-2030')
  assert.equal(back.status, ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_INVOICE_RESOLUTION)
  assert.equal(back.caseContext.focus.clientRef.id, 'client-anthony')
  assert.equal(back.caseContext.focus.invoiceRef, null)
  assert.equal(corrected.status, 'ANSWERED')
  assert.equal(corrected.control.classification, 'CORRECT_ACTIVE_INVOICE')
  assert.equal(corrected.caseContext.focus.invoiceRef.id, 'invoice-anthony-1902')
  assert.deepEqual(liveCalls.map((call) => call.invoiceId), [
    'invoice-anthony-1902', 'invoice-sarah-2030', 'invoice-anthony-1902',
  ])
})

test('G7-CP5 pronoun and one-word follow-ups reverify and retain only current valid focus', async () => {
  const supabase = makeSupabase()
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)
  const first = await runtime.runTurn({
    tenantId: TENANT, caseState: initialState(), turnId: 'cp5-focus',
    text: 'Check INV-1902', now: new Date('2026-08-27T14:10:00.000Z'),
  })
  const why = await runtime.runTurn({
    tenantId: TENANT, caseState: first.caseState, turnId: 'cp5-why',
    text: 'why?', mode: 'deep', now: new Date('2026-08-27T14:11:00.000Z'),
  })
  const them = await runtime.runTurn({
    tenantId: TENANT, caseState: why.caseState, turnId: 'cp5-them',
    text: 'what about them?', now: new Date('2026-08-27T14:12:00.000Z'),
  })

  assert.equal(why.caseContext.focus.invoiceRef.id, 'invoice-anthony-1902')
  assert.equal(them.caseContext.focus.clientRef.id, 'client-anthony')
  assert.equal(them.caseContext.focus.invoiceRef.id, 'invoice-anthony-1902')
  assert.equal(why.resolver.status, ASK_DW_ENTITY_RESOLUTION_STATUS.RESOLVED)
  assert.equal(liveCalls[1].mode, 'deep')
  assert.equal(liveCalls[2].invoiceId, 'invoice-anthony-1902')
})

test('G7-CP5 an invoice-only UI anchor is tenant-reverified and gains its real client focus', async () => {
  let state = initialState()
  for (const event of [
    {
      type: ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES,
      payload: { invoiceRefs: [{ kind: 'invoice', id: 'invoice-anthony-1902' }] },
    },
    {
      type: ASK_DW_CASE_EVENT.SELECT_INVOICE,
      payload: { invoiceRef: { kind: 'invoice', id: 'invoice-anthony-1902' } },
    },
  ]) {
    state = applyAskDwCaseEvent(state, {
      ...event, tenantId: TENANT, expectedVersion: state.version,
      turnId: `cp5-anchor-${state.version}`, at: '2026-08-27T14:15:00.000Z',
    })
  }
  const supabase = makeSupabase()
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)
  const result = await runtime.runTurn({
    tenantId: TENANT, caseState: state, turnId: 'cp5-anchor-follow-up',
    text: 'that one', now: new Date('2026-08-27T14:16:00.000Z'),
  })

  assert.equal(result.status, 'ANSWERED')
  assert.equal(result.caseContext.focus.clientRef.id, 'client-anthony')
  assert.equal(result.caseContext.focus.invoiceRef.id, 'invoice-anthony-1902')
  assert.equal(liveCalls[0].invoiceId, 'invoice-anthony-1902')
})

test('G7-CP5 deleted invoice is cleared on a follow-up instead of silently surviving', async () => {
  const data = baseData()
  const supabase = makeSupabase({ data })
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)
  const first = await runtime.runTurn({
    tenantId: TENANT, caseState: initialState(), turnId: 'cp5-before-delete',
    text: 'Check INV-1902', now: new Date('2026-08-27T14:20:00.000Z'),
  })
  data.invoices = data.invoices.filter((row) => row.id !== 'invoice-anthony-1902')
  const followUp = await runtime.runTurn({
    tenantId: TENANT, caseState: first.caseState, turnId: 'cp5-after-delete',
    text: 'why?', now: new Date('2026-08-27T14:21:00.000Z'),
  })

  assert.equal(followUp.status, ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_INVOICE_RESOLUTION)
  assert.equal(followUp.caseContext.focus.clientRef.id, 'client-anthony')
  assert.equal(followUp.caseContext.focus.invoiceRef, null)
  assert.equal(liveCalls.length, 1)
})

test('G7-CP5 deleted client clears all conversational focus on a pronoun turn', async () => {
  const data = baseData()
  const supabase = makeSupabase({ data })
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)
  const first = await runtime.runTurn({
    tenantId: TENANT, caseState: initialState(), turnId: 'cp5-client-before',
    text: 'Check INV-1902', now: new Date('2026-08-27T14:30:00.000Z'),
  })
  data.clients = data.clients.filter((row) => row.id !== 'client-anthony')
  const followUp = await runtime.runTurn({
    tenantId: TENANT, caseState: first.caseState, turnId: 'cp5-client-after',
    text: 'what about them?', now: new Date('2026-08-27T14:31:00.000Z'),
  })

  assert.equal(followUp.status, ASK_DW_ENTITY_RESOLUTION_STATUS.CLIENT_NOT_FOUND)
  assert.equal(followUp.caseContext.focus.clientRef, null)
  assert.equal(followUp.caseContext.focus.invoiceRef, null)
  assert.equal(liveCalls.length, 1)
})

test('G7-CP5 first and second invoice operate only over the verified ordered candidate set', async () => {
  const supabase = makeSupabase()
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)
  const second = await runtime.runTurn({
    tenantId: TENANT, caseState: initialState(), turnId: 'cp5-ordinal-base',
    text: 'Check INV-1902', now: new Date('2026-08-27T14:40:00.000Z'),
  })
  const first = await runtime.runTurn({
    tenantId: TENANT, caseState: second.caseState, turnId: 'cp5-first',
    text: 'the first invoice', now: new Date('2026-08-27T14:41:00.000Z'),
  })
  const backToSecond = await runtime.runTurn({
    tenantId: TENANT, caseState: first.caseState, turnId: 'cp5-second-again',
    text: 'the second one', now: new Date('2026-08-27T14:42:00.000Z'),
  })

  assert.equal(first.caseContext.focus.invoiceRef.id, 'invoice-anthony-1844')
  assert.equal(backToSecond.caseContext.focus.invoiceRef.id, 'invoice-anthony-1902')
  assert.deepEqual(backToSecond.caseContext.candidates.invoiceRefs.map((ref) => ref.id), [
    'invoice-anthony-1844', 'invoice-anthony-1902',
  ])
})

test('G7-CP5 missing ordinal and ambiguous other-invoice references fail closed', async () => {
  const data = baseData()
  data.invoices.push({
    id: 'invoice-anthony-2001', user_id: TENANT, client_id: 'client-anthony',
    inv_num: 'INV-2001', created_at: '2026-04-01T00:00:00Z',
  })
  const supabase = makeSupabase({ data })
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)
  const first = await runtime.runTurn({
    tenantId: TENANT, caseState: initialState(), turnId: 'cp5-three',
    text: 'Check INV-1902', now: new Date('2026-08-27T14:50:00.000Z'),
  })
  const other = await runtime.runTurn({
    tenantId: TENANT, caseState: first.caseState, turnId: 'cp5-other-ambiguous',
    text: 'no, the other one', now: new Date('2026-08-27T14:51:00.000Z'),
  })

  assert.equal(other.status, ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_REFERENCE_RESOLUTION)
  assert.match(other.reason, /more than one alternate/i)
  assert.equal(other.caseContext.focus.invoiceRef.id, 'invoice-anthony-1902')

  const sarah = await runtime.runTurn({
    tenantId: TENANT, caseState: initialState(), turnId: 'cp5-sarah-one',
    text: 'Check INV-2030', now: new Date('2026-08-27T14:52:00.000Z'),
  })
  const missingSecond = await runtime.runTurn({
    tenantId: TENANT, caseState: sarah.caseState, turnId: 'cp5-missing-second',
    text: 'the second invoice', now: new Date('2026-08-27T14:53:00.000Z'),
  })
  assert.equal(missingSecond.status, ASK_DW_ENTITY_RESOLUTION_STATUS.NEEDS_REFERENCE_RESOLUTION)
  assert.equal(missingSecond.caseContext.focus.invoiceRef.id, 'invoice-sarah-2030')
})

test('G7-CP5 contract follow-up uses verified focus without treating contract as a client', async () => {
  const supabase = makeSupabase()
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)
  const first = await runtime.runTurn({
    tenantId: TENANT, caseState: initialState(), turnId: 'cp5-contract-base',
    text: 'Check INV-1902', now: new Date('2026-08-27T15:00:00.000Z'),
  })
  const contract = await runtime.runTurn({
    tenantId: TENANT, caseState: first.caseState, turnId: 'cp5-contract',
    text: 'what about the contract?', now: new Date('2026-08-27T15:01:00.000Z'),
  })
  assert.equal(contract.status, 'ANSWERED')
  assert.equal(contract.caseContext.focus.invoiceRef.id, 'invoice-anthony-1902')
  assert.equal(contract.resolver.status, ASK_DW_ENTITY_RESOLUTION_STATUS.RESOLVED)
})

test('G7-CP5 new-evidence and Company Brain corrections change neither focus nor durable truth', async () => {
  const supabase = makeSupabase()
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)
  const first = await runtime.runTurn({
    tenantId: TENANT, caseState: initialState(), turnId: 'cp5-correction-base',
    text: 'Check INV-1902', now: new Date('2026-08-27T15:10:00.000Z'),
  })
  const evidenceAssertion = await runtime.runTurn({
    tenantId: TENANT, caseState: first.caseState, turnId: 'cp5-new-evidence',
    text: 'they paid yesterday', now: new Date('2026-08-27T15:11:00.000Z'),
  })
  const policyCorrection = await runtime.runTurn({
    tenantId: TENANT, caseState: evidenceAssertion.caseState, turnId: 'cp5-policy-correction',
    text: 'no, our policy is different', now: new Date('2026-08-27T15:12:00.000Z'),
  })
  const serialized = JSON.stringify(policyCorrection.caseState)

  assert.equal(evidenceAssertion.caseContext.focus.invoiceRef.id, 'invoice-anthony-1902')
  assert.equal(policyCorrection.caseContext.focus.invoiceRef.id, 'invoice-anthony-1902')
  assert.doesNotMatch(serialized, /paid|balance|canonicalFacts|companyBrain|authoritySnapshot/i)
  assert.equal(policyCorrection.caseContext.boundaries.businessAuthorityStored, false)
})

test('G7-CP5 every follow-up rechecks authenticated tenant scope before reference reads', async () => {
  const supabase = makeSupabase()
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)
  const first = await runtime.runTurn({
    tenantId: TENANT, caseState: initialState(), turnId: 'cp5-tenant-base',
    text: 'Check INV-1902', now: new Date('2026-08-27T15:20:00.000Z'),
  })
  supabase.auth.getUser = async () => ({ data: { user: { id: OTHER_TENANT } }, error: null })

  await assert.rejects(() => runtime.runTurn({
    tenantId: TENANT, caseState: first.caseState, turnId: 'cp5-tenant-follow-up',
    text: 'why?', now: new Date('2026-08-27T15:21:00.000Z'),
  }), /tenant mismatch/)
  assert.equal(liveCalls.length, 1)
})

test('G7-CP5 proposed resolver event cannot invent an invoice outside verified candidates', async () => {
  const supabase = makeSupabase()
  const liveCalls = []
  const { runtime } = runtimeFor(supabase, liveCalls)
  const first = await runtime.runTurn({
    tenantId: TENANT, caseState: initialState(), turnId: 'cp5-model-base',
    text: 'Check INV-1902', now: new Date('2026-08-27T15:30:00.000Z'),
  })

  await assert.rejects(() => runtime.runTurn({
    tenantId: TENANT, caseState: first.caseState, turnId: 'cp5-model-invented',
    text: 'that one', now: new Date('2026-08-27T15:31:00.000Z'),
    proposedResolverEvents: [{
      type: ASK_DW_CASE_EVENT.CORRECT_ACTIVE_INVOICE,
      payload: { invoiceRef: { kind: 'invoice', id: 'invoice-invented' } },
    }],
  }), /resolver proposal was not independently verified/)
  assert.equal(liveCalls.length, 1)
})
