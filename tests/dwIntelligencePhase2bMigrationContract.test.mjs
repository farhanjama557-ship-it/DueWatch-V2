import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.join(here, '..', 'supabase', 'migrations', '20260824234500_dw_intelligence_phase2b_proof.sql')
const sql = fs.readFileSync(migrationPath, 'utf8')

test('Phase 2B persistence is structurally sandbox-only', () => {
  assert.match(sql, /check \(transport in \('sandbox', 'stub', 'none'\)\)/)
  assert.match(sql, /check \(production_execution_authorized = false\)/)
  assert.match(sql, /check \(real_side_effect = false\)/)
})

test('Phase 2B persistence structurally binds invoice and client to the same tenant', () => {
  const invoiceScopeFks = sql.match(/foreign key \(user_id, invoice_id, client_id\)[\s\S]*?references public\.invoices\(user_id, id, client_id\)/g) || []
  assert.ok(invoiceScopeFks.length >= 4)
})

test('Phase 2B persistence keeps memory and tombstone provenance explicit', () => {
  assert.match(sql, /create table if not exists public\.dw_memory_evidence_links/)
  assert.match(sql, /create table if not exists public\.dw_memory_tombstones/)
  assert.match(sql, /create table if not exists public\.dw_tombstone_evidence_links/)
})

test('authenticated browser access is read-only for proof tables', () => {
  assert.match(sql, /grant select on public\.dw_proof_events to authenticated;/)
  assert.doesNotMatch(sql, /grant (insert|update|delete).*authenticated/)
})


test('run rows are structurally scoped to the same tenant/client/invoice they describe', () => {
  assert.match(sql, /constraint dw_intelligence_runs_invoice_scope_fk[\s\S]*?foreign key \(user_id, invoice_id, client_id\)[\s\S]*?references public\.invoices\(user_id, id, client_id\)/)
})

test('evidence lineage uses run-scoped source keys and rejected evidence has a redaction constraint', () => {
  assert.match(sql, /evidence_key text not null/)
  assert.match(sql, /foreign key \(user_id, run_id, derived_from_key\)[\s\S]*?references public\.dw_evidence_items\(user_id, run_id, evidence_key\)/)
  assert.match(sql, /dw_evidence_rejected_redaction_check/)
})
