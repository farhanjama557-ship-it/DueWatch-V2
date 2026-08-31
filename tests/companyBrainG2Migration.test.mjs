import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'pgsql-parser'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../supabase/migrations/20260831005949_company_brain_company_graph_g2.sql')
const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase()
const tables = ['company_graph_versions', 'company_graph_nodes', 'company_graph_edges', 'company_graph_entity_resolutions', 'company_graph_resolution_candidates', 'company_graph_node_provenance', 'company_graph_edge_provenance']

test('G1 and G2 migrations parse with the real PostgreSQL parser', async () => {
  const g1 = fs.readFileSync(path.resolve(here, '../supabase/migrations/20260830055532_company_brain_durable_ingestion_g1.sql'), 'utf8')
  await assert.doesNotReject(parse(g1))
  await assert.doesNotReject(parse(sql))
  await assert.rejects(parse(`+${sql}`))
  await assert.rejects(parse(`${sql}\ncreate table broken (`))
})

test('G2 migration declares normalized graph persistence tables', () => {
  for (const table of tables) assert.match(sql, new RegExp(`create table public\\.${table}\\s*\\(`))
})

test('every graph table has tenant ownership, RLS, and owner-only read policy', () => {
  for (const table of tables) {
    const start = sql.indexOf(`create table public.${table}`)
    const end = sql.indexOf('\n);', start)
    assert.match(sql.slice(start, end), /user_id uuid not null/)
    assert.ok(sql.includes(`alter table public.${table} enable row level security;`))
    assert.match(sql, new RegExp(`policy company_graph_[a-z_]+_owner_read on public\\.${table}[\\s\\S]*?for select to authenticated using \\(\\(select auth\\.uid\\(\\)\\) = user_id\\)`))
  }
})

test('graph Data API exposure is explicit read-only and anonymous access is absent', () => {
  assert.match(sql, /revoke all on public\.company_graph_versions[\s\S]+from anon, authenticated;/)
  assert.match(sql, /grant select on public\.company_graph_versions[\s\S]+to authenticated;/)
  assert.doesNotMatch(sql, /grant\s+(?:all|insert|update|delete)[\s\S]*?to\s+(?:anon|authenticated)\s*;/)
})

test('node, edge, resolution, and provenance links are tenant-composite', () => {
  for (const fragment of [
    'foreign key (user_id, graph_version_id)', 'foreign key (user_id, claim_id)',
    'foreign key (user_id, source_version_id)',
  ]) assert.ok(sql.includes(fragment), `${fragment} missing`)
  assert.match(sql, /foreign key \(user_id, graph_version_id, from_node_id\)/)
  assert.match(sql, /foreign key \(user_id, graph_version_id, to_node_id\)/)
  assert.match(sql, /foreign key \(user_id, graph_version_id, selected_node_id\)/)
})

test('every normalized provenance row is an exact tenant claim-root pair', () => {
  assert.equal((sql.match(/provenance_claim_root_fk foreign key \(user_id, claim_id, source_version_id\)/g) || []).length, 2)
  assert.equal((sql.match(/references public\.company_brain_claim_roots\(user_id, claim_id, source_version_id\)/g) || []).length, 4)
})

test('resolution candidates are normalized and tenant-version constrained', () => {
  assert.match(sql, /create table public\.company_graph_resolution_candidates/)
  assert.match(sql, /foreign key \(user_id, graph_version_id, resolution_id\)[\s\S]+references public\.company_graph_entity_resolutions\(user_id, graph_version_id, id\)/)
  assert.match(sql, /foreign key \(user_id, graph_version_id, candidate_node_id\)[\s\S]+references public\.company_graph_nodes\(user_id, graph_version_id, id\)/)
  assert.match(sql, /create constraint trigger company_graph_resolution_candidates_complete[\s\S]+deferrable initially deferred/)
  assert.match(sql, /create constraint trigger company_graph_resolution_candidate_link_consistent[\s\S]+deferrable initially deferred/)
  assert.match(sql, /company_graph_resolution_candidate_projection_mismatch/)
  assert.match(sql, /company_graph_selected_node_not_a_candidate/)
})

test('graph nodes and edges require non-empty claim and root provenance', () => {
  assert.equal((sql.match(/jsonb_array_length\(provenance_claim_ids\) > 0/g) || []).length, 2)
  assert.equal((sql.match(/jsonb_array_length\(root_source_version_ids\) > 0/g) || []).length, 2)
  assert.equal((sql.match(/primary_claim_id uuid not null/g) || []).length, 2)
  assert.equal((sql.match(/primary_source_version_id uuid not null/g) || []).length, 2)
  assert.equal((sql.match(/primary_claim_fk foreign key \(user_id, primary_claim_id\)/g) || []).length, 2)
  assert.equal((sql.match(/primary_source_fk foreign key \(user_id, primary_source_version_id\)/g) || []).length, 2)
  assert.equal((sql.match(/primary_root_fk foreign key \(user_id, primary_claim_id, primary_source_version_id\)/g) || []).length, 2)
})

test('graph schema encodes all required node, edge, scope-resolution states', () => {
  for (const type of ['company', 'client', 'person', 'role', 'contract', 'policy_candidate', 'workflow', 'client_exception', 'precedent', 'source', 'artifact', 'claim', 'conflict']) assert.ok(sql.includes(`'${type}'`))
  for (const type of ['belongs_to_company', 'client_of', 'has_contract', 'applies_to_client', 'applies_to_company', 'has_role', 'role_in_company', 'observed_delegation', 'references_policy', 'exception_for', 'supported_by', 'derived_from', 'conflicts_with', 'precedent_for', 'historical_to', 'alias_of', 'supersedes']) assert.ok(sql.includes(`'${type}'`))
  for (const state of ['resolved', 'ambiguous', 'unresolved', 'conflicted']) assert.ok(sql.includes(`'${state}'`))
})

test('derived graph evidence cannot be independent and override edges require explicit evidence', () => {
  assert.equal((sql.match(/check \(not \(derived and independent\)\)/g) || []).length, 2)
  assert.match(sql, /check \(edge_type <> 'supersedes' or explicit\)/)
})

test('graph persistence is barred from canonical money truth and DW authority', () => {
  assert.equal((sql.match(/canonical_financial_truth boolean not null default false check \(canonical_financial_truth = false\)/g) || []).length, 2)
  assert.equal((sql.match(/dw_authority boolean not null default false check \(dw_authority = false\)/g) || []).length, 2)
})

test('root revocation trigger invalidates dependent nodes, edges, and active graph version', () => {
  assert.match(sql, /create trigger company_graph_source_version_revocation/)
  assert.match(sql, /update public\.company_graph_nodes n[\s\S]+set active = false, revoked = true/)
  assert.match(sql, /update public\.company_graph_edges e[\s\S]+set active = false, revoked = true/)
  assert.match(sql, /update public\.company_graph_versions v[\s\S]+set active = false/)
  assert.match(sql, /security definer\s+set search_path = ''/)
  assert.match(sql, /revoke execute on function private\.invalidate_company_graph_for_source_version\(\) from public, anon, authenticated;/)
  assert.match(sql, /root_source_version_ids @> jsonb_build_array\(new\.id::text\)/)
})

test('Brain snapshot invalidation propagates to every referenced active graph version', () => {
  assert.match(sql, /create or replace function private\.invalidate_company_graph_for_brain_snapshot\(\)/)
  assert.match(sql, /update public\.company_graph_versions v[\s\S]+where v\.user_id = new\.user_id and v\.brain_snapshot_id = new\.id and v\.active/)
  assert.match(sql, /create trigger company_graph_stale_on_brain_snapshot_invalidation[\s\S]+after update of active on public\.company_brain_snapshots/)
  assert.match(sql, /when \(old\.active = true and new\.active = false\)/)
  assert.match(sql, /revoke execute on function private\.invalidate_company_graph_for_brain_snapshot\(\) from public, anon, authenticated;/)
})

test('deferred integrity triggers make normalized provenance authoritative', () => {
  assert.match(sql, /create constraint trigger company_graph_node_provenance_complete[\s\S]+deferrable initially deferred/)
  assert.match(sql, /create constraint trigger company_graph_edge_provenance_complete[\s\S]+deferrable initially deferred/)
  assert.match(sql, /company_graph_node_provenance_projection_mismatch/)
  assert.match(sql, /company_graph_edge_provenance_projection_mismatch/)
  assert.match(sql, /create constraint trigger company_graph_node_provenance_link_consistent[\s\S]+deferrable initially deferred/)
  assert.match(sql, /create constraint trigger company_graph_edge_provenance_link_consistent[\s\S]+deferrable initially deferred/)
  for (const fn of [
    'validate_company_graph_node_provenance',
    'validate_company_graph_edge_provenance',
    'validate_company_graph_node_provenance_link_change',
    'validate_company_graph_edge_provenance_link_change',
  ]) assert.ok(sql.includes(`revoke execute on function private.${fn}() from public, anon, authenticated;`))
})

test('G2 migration does not mutate canonical financial tables', () => {
  for (const verb of ['insert into', 'update', 'delete from', 'alter table']) {
    for (const table of ['invoices', 'payments', 'payment_attempts', 'payouts', 'bank_transactions']) assert.doesNotMatch(sql, new RegExp(`${verb}\\s+public\\.${table}\\b`))
  }
})
