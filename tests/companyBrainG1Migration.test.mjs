import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../supabase/migrations/20260830055532_company_brain_durable_ingestion_g1.sql')
const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase()
const tables = [
  'ingestion_jobs', 'sources', 'source_versions', 'artifacts', 'claims',
  'claim_roots', 'conflicts', 'conflict_members', 'founder_decisions', 'founder_decision_attempts',
  'authority_proposals', 'source_tombstones', 'snapshots',
].map((name) => `company_brain_${name}`)

test('G1 migration declares every required durable table', () => {
  for (const table of tables) assert.match(sql, new RegExp(`create table public\\.${table}\\s*\\(`))
})

test('every durable table carries an explicit tenant key and RLS', () => {
  for (const table of tables) {
    const start = sql.indexOf(`create table public.${table}`)
    const end = sql.indexOf('\n);', start)
    assert.ok(start >= 0 && end > start, `${table} definition missing`)
    assert.match(sql.slice(start, end), /user_id uuid not null/)
    assert.ok(sql.includes(`alter table public.${table} enable row level security;`), `${table} RLS missing`)
  }
})

test('authenticated reads are tenant-bound and anonymous access is not granted', () => {
  for (const table of tables) {
    assert.match(sql, new RegExp(`policy company_brain_[a-z_]+_owner_read on public\\.${table} for select to authenticated using \\(\\(select auth\\.uid\\(\\)\\) = user_id\\)`))
  }
  assert.match(sql, /revoke all on[\s\S]+from anon, authenticated;/)
  assert.doesNotMatch(sql, /grant\s+(?:all|select|insert|update|delete)[\s\S]*?to\s+anon\s*;/)
})

test('browser clients receive read-only table grants', () => {
  assert.match(sql, /grant select on[\s\S]+company_brain_snapshots[\s\S]+to authenticated;/)
  assert.doesNotMatch(sql, /grant\s+(?:all|insert|update|delete)[\s\S]*?to\s+authenticated\s*;/)
})

test('cross-table provenance links use composite tenant foreign keys', () => {
  for (const fragment of [
    'foreign key (user_id, source_version_id)',
    'foreign key (user_id, artifact_id)',
    'foreign key (user_id, claim_id)',
    'foreign key (user_id, conflict_id)',
  ]) assert.ok(sql.includes(fragment), `${fragment} missing`)
})

test('Company Brain claims are structurally barred from canonical financial truth', () => {
  assert.match(sql, /canonical_financial_truth boolean not null default false check \(canonical_financial_truth = false\)/)
})

test('founder decision RPC is authenticated, tenant-scoped, idempotent, and optimistic', () => {
  const fn = sql.slice(sql.indexOf('create or replace function public.record_company_brain_founder_decision'), sql.indexOf('create or replace function public.revoke_company_brain_source'))
  assert.match(fn, /security definer\s+set search_path = ''/)
  assert.match(fn, /v_user_id uuid := \(select auth\.uid\(\)\)/)
  assert.match(fn, /user_id = v_user_id and idempotency_key = p_idempotency_key/)
  assert.match(fn, /for update/)
  assert.match(fn, /insert into public\.company_brain_founder_decision_attempts/)
  assert.match(fn, /'rejected_stale'/)
  assert.match(fn, /insert into public\.company_brain_founder_decisions/)
})

test('source revocation is persistent and invalidates dependent knowledge', () => {
  const fn = sql.slice(sql.indexOf('create or replace function public.revoke_company_brain_source'))
  assert.match(fn, /security definer\s+set search_path = ''/)
  assert.match(fn, /update public\.company_brain_source_versions set status = 'revoked'/)
  assert.match(fn, /update public\.company_brain_artifacts a set active = false/)
  assert.match(fn, /update public\.company_brain_claims c set active = false, status = 'invalidated'/)
  assert.match(fn, /insert into public\.company_brain_source_tombstones/)
})

test('privileged RPC execution is denied by default and granted only to authenticated', () => {
  for (const fn of ['record_company_brain_founder_decision', 'revoke_company_brain_source']) {
    assert.match(sql, new RegExp(`revoke execute on function public\\.${fn}\\([^)]+\\) from public, anon;`))
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]+\\) to authenticated;`))
  }
})

test('migration does not mutate DueWatch financial-ledger tables', () => {
  for (const verb of ['insert into', 'update', 'delete from', 'alter table']) {
    for (const table of ['invoices', 'payments', 'payment_attempts', 'payouts', 'bank_transactions']) {
      assert.doesNotMatch(sql, new RegExp(`${verb}\\s+public\\.${table}\\b`))
    }
  }
})
