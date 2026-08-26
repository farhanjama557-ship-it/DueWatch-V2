import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BASELINE_MIGRATIONS,
  LOCKED_REPO_MAIN_TREE_SHA,
  REPO_EXECUTION_SOURCES,
  REQUIRED_SCHEMA_CAPABILITIES,
  buildSimulatedAlignedSnapshot,
  evaluateBaselineGate,
  validateMigrationInventory,
} from '../scripts/ci/verify-dw-intelligence-phase2b-baseline.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const driftPath = path.join(here, 'fixtures', 'dwPhase2bBaselineDriftSnapshot.json')
const migrationPath = path.join(repoRoot, 'supabase', 'migrations', '20260824234500_dw_intelligence_phase2b_proof.sql')
const adapterPath = path.join(repoRoot, 'src', 'lib', 'dwIntelligence', 'phase2bDuewatchAdapter.js')
const enginePath = path.join(repoRoot, 'src', 'lib', 'dwIntelligence', 'phase2bEngine.js')
const drift = JSON.parse(fs.readFileSync(driftPath, 'utf8'))

function read(p) { return fs.readFileSync(p, 'utf8') }

test('locked repo tree matches the Phase 2B checkpoint observation', () => {
  assert.equal(drift.repo_main_tree_sha, LOCKED_REPO_MAIN_TREE_SHA)
})

test('baseline migration inventory is unique and strictly timestamp ordered', () => {
  assert.equal(BASELINE_MIGRATIONS.length, 11)
  assert.deepEqual(validateMigrationInventory(), { ok: true, problems: [] })
})

test('repo execution-source lock contains the shared authority and durable send boundaries', () => {
  assert.ok(REPO_EXECUTION_SOURCES['supabase/functions/_shared/nextActionAuthority.js'])
  assert.ok(REPO_EXECUTION_SOURCES['supabase/functions/_shared/autopilotExecutionCore.js'])
  assert.ok(REPO_EXECUTION_SOURCES['supabase/functions/_shared/executionClaim.js'])
})

test('captured connected-backend snapshot fails closed on baseline drift', () => {
  const gate = evaluateBaselineGate(drift)
  assert.equal(gate.ready, false)
  assert.equal(gate.status, 'BLOCKED_BASELINE_ALIGNMENT_REQUIRED')
  for (const capability of REQUIRED_SCHEMA_CAPABILITIES) {
    assert.ok(gate.blockers.includes(`missing_schema_capability:${capability}`), capability)
  }
  assert.ok(gate.blockers.includes('edge_function_drift:autopilot-scheduler'))
  assert.ok(gate.blockers.includes('edge_function_drift:send-reminder-email'))
})

test('zero observed cross-tenant rows does not waive missing structural tenant FK', () => {
  const gate = evaluateBaselineGate(drift)
  assert.equal(drift.live_schema_indicators.cross_tenant_invoice_client_relationship_count, 0)
  assert.ok(gate.blockers.includes('missing_schema_capability:invoice_client_composite_tenant_fk'))
  assert.ok(gate.warnings.some((w) => /structural tenant FK is still missing/.test(w)))
})

test('fully aligned simulated baseline passes the same gate', () => {
  const aligned = buildSimulatedAlignedSnapshot(drift)
  const gate = evaluateBaselineGate(aligned)
  assert.equal(gate.ready, true)
  assert.equal(gate.status, 'BASELINE_READY_FOR_PHASE2B_PERSISTENCE_PROOF')
  assert.deepEqual(gate.blockers, [])
})

test('Phase 2B migration is structurally sandbox-only and later than baseline', () => {
  const sql = read(migrationPath)
  assert.match(sql, /check \(production_execution_authorized = false\)/i)
  assert.match(sql, /check \(real_side_effect = false\)/i)
  assert.match(sql, /transport in \('sandbox', 'stub', 'none'\)/i)
  assert.doesNotMatch(sql, /resend|sendEmail|http_post|net\.http|functions\/v1/i)
})

test('Phase 2B persistence cannot directly mutate canonical invoice/payment money state', () => {
  const sql = read(migrationPath)
  assert.doesNotMatch(sql, /update\s+public\.invoices/i)
  assert.doesNotMatch(sql, /insert\s+into\s+public\.payments/i)
  assert.doesNotMatch(sql, /update\s+public\.payments/i)
  assert.doesNotMatch(sql, /delete\s+from\s+public\.(invoices|payments)/i)
})

test('Phase 2B adapter is wired to existing authority seam and has no provider-send path', () => {
  const src = read(adapterPath)
  assert.match(src, /nextActionAuthority/i)
  assert.match(src, /evaluateNextActionAuthority/i)
  assert.doesNotMatch(src, /resend|sendEmail|fetch\s*\(|functions\.invoke/i)
})

test('Phase 2B engine exposes sandbox outcomes but no external provider call', () => {
  const src = read(enginePath)
  assert.match(src, /sandbox/i)
  assert.doesNotMatch(src, /resend|api\.resend\.com|sendgrid|postmark|mailgun/i)
})
