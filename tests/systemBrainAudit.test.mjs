import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildCodeCapabilityAudit,
  extractRoutes,
  extractSupabaseDependencies,
} from '../scripts/system-brain/code-audit-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

test('System Brain code audit discovers real DueWatch routes', async () => {
  const manifest = await buildCodeCapabilityAudit({ repoRoot, generatedAt: '2026-01-01T00:00:00.000Z' })
  for (const route of ['/invoices', '/clients', '/cash-flow', '/activity', '/autopilot', '/settings']) {
    assert.ok(manifest.routes.includes(route), route)
  }
})

test('System Brain code audit treats Ask DW registered read tools as a closed-world list', async () => {
  const manifest = await buildCodeCapabilityAudit({ repoRoot, generatedAt: '2026-01-01T00:00:00.000Z' })
  const ids = manifest.ask_dw_tools.map((tool) => tool.id)

  for (const tool of [
    'canonical_state',
    'evidence_search',
    'payment_reconciliation',
    'dispute_context',
    'precedent_search',
    'activity_history',
    'portfolio_summary',
  ]) assert.ok(ids.includes(tool), tool)

  assert.equal(manifest.boundaries.closed_world_ask_dw_read_tools, true)
  assert.ok(manifest.ask_dw_tools.every((tool) => tool.read_only && tool.side_effect_class === 'NONE'))
})

test('System Brain code audit exposes code-level data dependencies without querying tenant rows', async () => {
  const manifest = await buildCodeCapabilityAudit({ repoRoot, generatedAt: '2026-01-01T00:00:00.000Z' })
  const tables = new Set(manifest.data_dependencies.filter((item) => item.kind === 'table').map((item) => item.name))

  for (const table of [
    'invoices',
    'clients',
    'autopilot_rules',
    'autopilot_settings',
    'payments',
    'payment_allocations',
    'dw_evidence_items',
    'dw_memory_claims',
    'ask_dw_conversations',
  ]) assert.ok(tables.has(table), `expected code dependency ${table}`)

  const rpcs = new Set(manifest.data_dependencies.filter((item) => item.kind === 'rpc').map((item) => item.name))
  assert.ok(rpcs.has('persist_ask_dw_conversation_state'))

  const edgeFunctions = new Set(manifest.data_dependencies.filter((item) => item.kind === 'edge_function').map((item) => item.name))
  assert.ok(edgeFunctions.has('ask-dw-g7-model'))
  assert.equal(edgeFunctions.has('ask-dw-model'), false, 'historical M2D provider is not the active G7 browser dependency')

  assert.equal(manifest.meta.tenant_row_data_read, false)
  assert.equal(manifest.boundaries.live_tenant_state_included, false)
})

test('System Brain hashes are deterministic and generated_at is outside section hashes', async () => {
  const a = await buildCodeCapabilityAudit({ repoRoot, generatedAt: '2026-01-01T00:00:00.000Z' })
  const b = await buildCodeCapabilityAudit({ repoRoot, generatedAt: '2026-02-01T00:00:00.000Z' })

  assert.notEqual(a.meta.generated_at, b.meta.generated_at)
  assert.deepEqual(a.meta.section_hashes, b.meta.section_hashes)
  assert.equal(a.meta.aggregate_hash, b.meta.aggregate_hash)
})

test('route and database extraction are structural rather than prose-driven', () => {
  assert.deepEqual(
    extractRoutes('<Route path="/a" element={<A />} /><Route path="/b" element={<B />} />'),
    ['/a', '/b'],
  )

  const deps = extractSupabaseDependencies(
    `const TABLE = 'invoices'
     const RPC = 'rebuild_x'
     const EDGE = 'ask-dw-model'
     const q = supabase.from(TABLE).select('id,amount')
     await supabase.rpc(RPC)
     await supabase.functions.invoke(EDGE, { body: {} })`,
    'fixture.js',
  )
  assert.deepEqual(deps, [
    { kind: 'table', name: 'invoices', select: 'id,amount', source: 'fixture.js' },
    { kind: 'rpc', name: 'rebuild_x', select: null, source: 'fixture.js' },
    { kind: 'edge_function', name: 'ask-dw-model', select: null, source: 'fixture.js', requires_verify_jwt: true },
  ])
})

test('System Brain ignores dynamic or ambiguous Supabase dependency identifiers', () => {
  const deps = extractSupabaseDependencies(`
    const TABLE = 'invoices'
    {
      const TABLE = 'clients'
      supabase.from(TABLE)
    }
    const runtimeRpc = chooseRpc()
    supabase.rpc(runtimeRpc)
    supabase.functions.invoke(runtimeFunction)
  `, 'fixture.js')
  assert.deepEqual(deps, [])
})

test('Supabase select attribution stays attached to the immediate from() chain', () => {
  const source = `
    const awaiting = supabase
      .from('awaiting_signature')
      .select('*, invoices(*, clients(name))')
      .order('created_at')

    const unrelated = object.select(
      'autopilotSettingsResult, awaitingHistory, handledKeys, pendingInvoiceIds'
    )

    const writer = supabase
      .from('events')
      .insert({ event_type: 'x' })

    const later = something.select('not_an_events_column')
  `

  const deps = extractSupabaseDependencies(source, 'fixture.js')
  const awaiting = deps.find((item) => item.name === 'awaiting_signature')
  const events = deps.find((item) => item.name === 'events')

  assert.equal(awaiting.select, '*, invoices(*, clients(name))')
  assert.equal(events.select, null)
})
test('code manifest contains no source code bodies or tenant examples', async () => {
  const manifest = await buildCodeCapabilityAudit({ repoRoot, generatedAt: '2026-01-01T00:00:00.000Z' })
  const serialized = JSON.stringify(manifest)

  assert.equal(serialized.includes('farhanjama557@gmail.com'), false, 'manifest must not include developer/account identity')
  assert.equal(serialized.includes('seed_demo'), false, 'manifest must not inspect seed tenant data')
})
