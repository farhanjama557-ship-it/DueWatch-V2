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
  ]) assert.ok(tables.has(table), `expected code dependency ${table}`)

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
    "const q = supabase.from('invoices').select('id,amount'); await supabase.rpc('rebuild_x')",
    'fixture.js',
  )
  assert.deepEqual(deps, [
    { kind: 'table', name: 'invoices', select: 'id,amount', source: 'fixture.js' },
    { kind: 'rpc', name: 'rebuild_x', select: null, source: 'fixture.js' },
  ])
})

test('code manifest contains no source code bodies or tenant examples', async () => {
  const manifest = await buildCodeCapabilityAudit({ repoRoot, generatedAt: '2026-01-01T00:00:00.000Z' })
  const serialized = JSON.stringify(manifest)

  assert.equal(serialized.includes('farhanjama557@gmail.com'), false, 'manifest must not include developer/account identity')
  assert.equal(serialized.includes('seed_demo'), false, 'manifest must not inspect seed tenant data')
})
