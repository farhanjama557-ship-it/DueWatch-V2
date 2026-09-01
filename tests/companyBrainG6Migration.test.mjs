import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'pgsql-parser'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const migrationPath = path.join(repoRoot, 'supabase/migrations/20260901220000_company_brain_founder_review_g6.sql')
const sqlText = fs.readFileSync(migrationPath, 'utf8')
const sql = sqlText.toLowerCase()

const tables = [
  'company_brain_founder_review_items_g6',
  'company_brain_founder_review_revisions_g6',
  'company_brain_founder_review_evidence_g6',
  'company_brain_founder_review_attempts_g6',
]

function tableBody(table) {
  const start = sql.indexOf(`create table public.${table}`)
  assert.ok(start >= 0, `${table} must exist`)
  return sql.slice(start, sql.indexOf('\n);', start))
}

const reviewRpc = sql.slice(
  sql.indexOf('create or replace function public.record_company_brain_founder_review_g6'),
)

test('G6-M1 migration parses with the real PostgreSQL parser', async () => {
  await assert.doesNotReject(parse(sqlText))
  await assert.rejects(parse(`${sqlText}\ncreate table broken (`))
})

test('G6-M2 durable review item, revision, evidence and attempt tables exist', () => {
  for (const table of tables) assert.match(sql, new RegExp(`create table public\\.${table}\\s*\\(`))
})

test('G6-M3 every G6 table has tenant ownership and RLS', () => {
  for (const table of tables) {
    assert.match(tableBody(table), /user_id uuid not null references auth\.users/)
    assert.ok(sql.includes(`alter table public.${table} enable row level security;`))
  }
})

test('G6-M4 Data API access to G6 tables is explicit owner-read-only', () => {
  for (const table of tables) {
    assert.match(sql, new RegExp(`${table}_owner_read[\\s\\S]+?auth\\.uid\\(\\)\\) = user_id`))
  }
  assert.match(sql, /revoke all on public\.company_brain_founder_review_items_g6[\s\S]+from public, anon, authenticated;/)
  assert.match(sql, /grant select on public\.company_brain_founder_review_items_g6[\s\S]+to authenticated;/)
  assert.doesNotMatch(sql, /grant\s+(?:all|insert|update|delete)[\s\S]*?to\s+(?:anon|authenticated)\s*;/)
})

test('G6-M5 the anti-escalation invariant is enforced by the database itself', () => {
  const body = tableBody('company_brain_founder_review_revisions_g6')
  assert.match(body, /authority_granted boolean not null default false check \(authority_granted = false\)/)
  assert.match(body, /authority_impact text not null default 'none' check \(authority_impact = 'none'\)/)
  assert.match(body, /asserts_inverse_proposition boolean not null default false check \(asserts_inverse_proposition = false\)/)
  assert.match(body, /resolves_conflict boolean not null default false check \(resolves_conflict = false\)/)
  assert.match(body, /canonical_money_mutated boolean not null default false check \(canonical_money_mutated = false\)/)
  assert.match(body, /executed boolean not null default false check \(executed = false\)/)
})

test('G6-M6 review understanding is never stored as canonical financial truth', () => {
  assert.match(
    tableBody('company_brain_founder_review_items_g6'),
    /canonical_financial_truth boolean not null default false check \(canonical_financial_truth = false\)/,
  )
})

test('G6-M7 review actions and statuses are structurally constrained and consistent', () => {
  const body = tableBody('company_brain_founder_review_revisions_g6')
  assert.match(body, /review_action text not null check \(review_action in \('approve','edit','reject','hold','defer'\)\)/)
  assert.match(body, /review_status text not null check \(review_status in \(/)
  assert.match(body, /review_action = 'approve' and review_status = 'approved'/)
  assert.match(body, /review_action = 'edit' and reviewed_value is not null/)
  assert.match(body, /review_action <> 'edit' and reviewed_value is null/)
})

test('G6-M8 revision lineage, supersession and idempotency are enforced', () => {
  const body = tableBody('company_brain_founder_review_revisions_g6')
  assert.match(body, /revision integer not null check \(revision > 0\)/)
  assert.match(body, /unique \(user_id, review_item_id, revision\)/)
  assert.match(body, /unique \(user_id, idempotency_key\)/)
  assert.match(body, /request_fingerprint text not null check \(request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/)
  assert.match(body, /foreign key \(user_id, supersedes_revision_id\)[\s\S]+references public\.company_brain_founder_review_revisions_g6\(user_id, id\)/)
})

test('G6-M9 review references use tenant-composite foreign keys to canonical objects', () => {
  const body = tableBody('company_brain_founder_review_items_g6')
  assert.match(body, /foreign key \(user_id, client_id\)[\s\S]+references public\.clients\(user_id, id\)/)
  assert.match(body, /foreign key \(user_id, conflict_id\)[\s\S]+references public\.company_brain_conflicts\(user_id, id\)/)
  assert.match(body, /foreign key \(user_id, operating_model_id\)[\s\S]+references public\.company_operating_model_proposals\(user_id, id\)/)
  assert.match(body, /foreign key \(user_id, authority_grant_id\)[\s\S]+references public\.company_brain_authority_grants_g5\(user_id, id\)/)
  assert.match(
    tableBody('company_brain_founder_review_evidence_g6'),
    /foreign key \(user_id, claim_id, source_version_id\)[\s\S]+references public\.company_brain_claim_roots\(user_id, claim_id, source_version_id\)/,
  )
})

test('G6-M10 the review RPC is authenticated, tenant-derived and server validated', () => {
  assert.match(reviewRpc, /security definer\s+set search_path = ''/)
  assert.match(reviewRpc, /v_user_id uuid := \(select auth\.uid\(\)\)/)
  assert.match(reviewRpc, /if v_user_id is null then raise exception 'company_brain_founder_review_auth_required'/)
  assert.match(reviewRpc, /'founder'/)
  // The tenant and the actor come from the session, never from a parameter.
  assert.doesNotMatch(reviewRpc, /p_user_id|p_tenant_id|p_actor_id|p_is_founder/)
})

test('G6-M11 the review RPC fails closed on a stale revision', () => {
  assert.match(reviewRpc, /p_expected_revision <> v_actual_revision/)
  assert.match(reviewRpc, /'rejected_stale_revision'/)
  assert.match(reviewRpc, /raise exception 'company_brain_founder_review_stale_revision'/)
})

test('G6-M12 the review RPC refuses actions that belong to G3 or G5', () => {
  assert.match(reviewRpc, /p_item_type in \('conflict','authority_state'\) and p_review_action in \('approve','edit','reject'\)/)
  assert.match(reviewRpc, /p_item_type = 'authority_proposal' and p_review_action = 'approve'/)
  assert.match(reviewRpc, /company_brain_founder_review_action_unavailable/)
})

test('G6-M12b the action guard re-checks the stored item type, not the caller claim', () => {
  // A caller must not be able to reclassify a stored conflict or authority
  // item into an approvable one by passing a different p_item_type.
  assert.match(reviewRpc, /returning id, item_type into v_item_id, v_stored_item_type/)
  assert.match(reviewRpc, /v_stored_item_type in \('conflict','authority_state'\) and p_review_action in \('approve','edit','reject'\)/)
  assert.match(reviewRpc, /v_stored_item_type = 'authority_proposal' and p_review_action = 'approve'/)
})

test('G6-M13 the review RPC creates no authority and mutates no canonical money', () => {
  assert.match(reviewRpc, /'authority_granted', false/)
  for (const forbidden of [
    /company_brain_authority_grants_g5/, /grant_company_brain_authority_g5/,
    /update public\.invoices/, /update public\.payments/, /amount_paid/,
  ]) {
    assert.doesNotMatch(reviewRpc, forbidden)
  }
})

test('G6-M14 the migration introduces no unrestricted write grant or destructive statement', () => {
  assert.doesNotMatch(sql, /drop table/)
  assert.doesNotMatch(sql, /truncate/)
  assert.doesNotMatch(sql, /delete from public\./)
  assert.doesNotMatch(sql, /for (insert|update|delete) to (anon|authenticated)/)
  assert.match(sql, /revoke all on function public\.record_company_brain_founder_review_g6\(/)
  assert.match(sql, /grant execute on function public\.record_company_brain_founder_review_g6\([\s\S]+?\) to authenticated;/)
})

test('G6-M15 evidence rows can only cite this tenant real claim roots', () => {
  assert.match(reviewRpc, /jsonb_to_recordset\(coalesce\(p_evidence, '\[\]'::jsonb\)\)/)
  assert.match(reviewRpc, /root\.user_id = v_user_id/)
})
