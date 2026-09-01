import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'pgsql-parser'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationPath = path.resolve(here, '../supabase/migrations/20260901175714_company_brain_authority_delegation_g5.sql')
const sqlText = fs.readFileSync(migrationPath, 'utf8')
const sql = sqlText.toLowerCase()
const tables = [
  'company_brain_authority_grants_g5',
  'company_brain_authority_grant_provenance_g5',
  'company_brain_authority_revocations_g5',
  'company_brain_authority_attempts_g5',
]

test('G5-M1 migration parses with the real PostgreSQL parser', async () => {
  await assert.doesNotReject(parse(sqlText))
  await assert.rejects(parse(`${sqlText}\ncreate table broken (`))
})

test('G5-M2 durable authority, provenance, revocation, and attempt tables exist', () => {
  for (const table of tables) assert.match(sql, new RegExp(`create table public\\.${table}\\s*\\(`))
})

test('G5-M3 every public G5 table has tenant ownership and RLS', () => {
  for (const table of tables) {
    const start = sql.indexOf(`create table public.${table}`)
    const end = sql.indexOf('\n);', start)
    assert.match(sql.slice(start, end), /user_id uuid not null/)
    assert.ok(sql.includes(`alter table public.${table} enable row level security;`))
  }
})

test('G5-M4 Data API table access is explicit owner-read-only', () => {
  for (const table of tables) assert.match(sql, new RegExp(`${table}[_a-z]*_owner_read[\\s\\S]+?auth\\.uid\\(\\)\\) = user_id`))
  assert.match(sql, /revoke all on public\.company_brain_authority_grants_g5[\s\S]+from public, anon, authenticated;/)
  assert.match(sql, /grant select on public\.company_brain_authority_grants_g5[\s\S]+to authenticated;/)
  assert.doesNotMatch(sql, /grant\s+(?:all|insert|update|delete)[\s\S]*?to\s+(?:anon|authenticated)\s*;/)
})

test('G5-M5 grantor and revoker attribution preserve repository owner boundary', () => {
  assert.match(sql, /grantor_id uuid not null references auth\.users/)
  assert.match(sql, /grantor_id = user_id/)
  assert.match(sql, /revoked_by is null or revoked_by = user_id/)
  assert.match(sql, /v_user_id uuid := \(select auth\.uid\(\)\)/)
})

test('G5-M6 scope dimensions are independent and fail closed structurally', () => {
  for (const level of ['company', 'client', 'entity']) assert.ok(sql.includes(`'${level}'`))
  assert.match(sql, /scope_level = 'company' and client_id is null and graph_version_id is null and entity_node_id is null/)
  assert.match(sql, /scope_level = 'client' and client_id is not null and graph_version_id is null and entity_node_id is null/)
  assert.match(sql, /scope_level = 'entity' and client_id is null and graph_version_id is not null and entity_node_id is not null/)
})

test('G5-M7 client and entity scope use tenant-composite foreign keys', () => {
  assert.match(sql, /foreign key \(user_id, client_id\)[\s\S]+references public\.clients\(user_id, id\)/)
  assert.match(sql, /foreign key \(user_id, graph_version_id, entity_node_id\)[\s\S]+references public\.company_graph_nodes\(user_id, graph_version_id, id\)/)
})

test('G5-M8 provenance uses exact tenant claim-root pairs', () => {
  assert.match(sql, /foreign key \(user_id, claim_id, source_version_id\)[\s\S]+references public\.company_brain_claim_roots\(user_id, claim_id, source_version_id\)/)
  assert.match(sql, /jsonb_to_recordset\(p_provenance\)/)
  assert.match(sql, /root\.user_id = v_user_id/)
})

test('G5-M9 amount, currency, channel, condition, and time boundaries are constrained', () => {
  assert.match(sql, /amount_limit_minor bigint check \(amount_limit_minor is null or amount_limit_minor >= 0\)/)
  assert.match(sql, /currency text check \(currency is null or currency ~ '\^\[a-z\]\{3\}\$'\)/)
  assert.match(sql, /jsonb_typeof\(conditions\) = 'object'/)
  assert.match(sql, /expires_at is null or expires_at > effective_from/)
  assert.match(sql, /send_reminder','send_collection_message'\) and channel is not null/)
})

test('G5-M10 explicit grant RPC is authenticated, tenant-derived, and server validated', () => {
  const fn = sql.slice(sql.indexOf('create or replace function public.grant_company_brain_authority_g5'), sql.indexOf('create or replace function public.revoke_company_brain_authority_g5'))
  assert.match(fn, /security definer\s+set search_path = ''/)
  assert.match(fn, /if v_user_id is null then raise exception/)
  assert.match(fn, /p_grantee_type <> 'dw' or p_grantee_id <> 'duewatch'/)
  assert.match(fn, /company_brain_authority_grant_malformed/)
  assert.match(fn, /insert into public\.company_brain_authority_grants_g5/)
})

test('G5-M11 idempotent retries and conflicting key reuse are distinct audit outcomes', () => {
  assert.match(sql, /where user_id = v_user_id and idempotency_key = p_idempotency_key/)
  for (const outcome of ['idempotent_replay', 'rejected_idempotency_conflict', 'accepted']) assert.ok(sql.includes(`'${outcome}'`))
  assert.match(sql, /request_fingerprint text not null check \(request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/)
})

test('G5-M12 explicit supersession is tenant-composite and predecessor stays history', () => {
  assert.match(sql, /foreign key \(user_id, supersedes_grant_id\)[\s\S]+references public\.company_brain_authority_grants_g5\(user_id, id\)/)
  assert.match(sql, /where user_id = v_user_id and id = p_supersedes_grant_id\s+for update/)
  assert.match(sql, /set status = 'superseded'[\s\S]+id = p_supersedes_grant_id/)
  assert.doesNotMatch(sql, /delete from public\.company_brain_authority_grants_g5/)
})

test('G5-M13 revocation is immediate, attributable, idempotent, and non-destructive', () => {
  const fn = sql.slice(sql.indexOf('create or replace function public.revoke_company_brain_authority_g5'))
  assert.match(fn, /set status = 'revoked', revoked_by = v_user_id, revoked_at = now\(\)/)
  assert.match(fn, /insert into public\.company_brain_authority_revocations_g5/)
  assert.match(fn, /idempotent_replay/)
  assert.doesNotMatch(fn, /delete from/)
})

test('G5-M14 freshness triggers target only materially reviewed lineage', () => {
  assert.match(sql, /provenance\.source_version_id = new\.id[\s\S]+provenance\.required_current/)
  assert.match(sql, /operating_model_id = new\.id and status = 'granted'/)
  assert.match(sql, /brain_snapshot_id = new\.id and status = 'granted'/)
  assert.match(sql, /graph_fingerprint = new\.fingerprint or graph_version_id = new\.id/)
  assert.doesNotMatch(sql, /set status = 'stale'\s+where status = 'granted'\s*;/)
})

test('G5-M15 protected RPC execution is unavailable to PUBLIC and anon', () => {
  for (const fn of ['grant_company_brain_authority_g5', 'revoke_company_brain_authority_g5']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\([\\s\\S]+?\\)\\s+from public, anon, authenticated;`))
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([\\s\\S]+?\\)\\s+to authenticated;`))
  }
})

test('G5-M16 provider capability and external execution are absent', () => {
  for (const term of ['stripe', 'gmail', 'quickbooks', 'send email', 'send sms', 'http_request', 'net.http']) assert.doesNotMatch(sql, new RegExp(term))
})

test('G5-M17 migration cannot mutate canonical financial truth', () => {
  for (const verb of ['insert into', 'update', 'delete from', 'alter table']) {
    for (const table of ['invoices', 'payments', 'payment_attempts', 'payouts', 'bank_transactions', 'payment_receipts']) {
      assert.doesNotMatch(sql, new RegExp(`${verb}\\s+public\\.${table}\\b`))
    }
  }
})

test('G5-M18 G5 schema preserves proposal-vs-grant separation', () => {
  assert.match(sql, /proposal_id uuid/)
  assert.match(sql, /foreign key \(user_id, proposal_id\)[\s\S]+company_brain_authority_proposals/)
  assert.match(sql, /status text not null check \(status in \('granted','revoked','stale','invalidated','superseded'\)\)/)
  assert.doesNotMatch(sql, /status in \('proposed','granted'/)
})

test('G5-M19 rejected idempotency conflict is returned so its audit row can commit', () => {
  assert.match(sql, /'rejected_idempotency_conflict', v_existing_id\);[\s\S]+return jsonb_build_object\('outcome', 'rejected_idempotency_conflict'/)
  assert.doesNotMatch(sql, /insert into public\.company_brain_authority_attempts_g5[\s\S]{0,500}raise exception 'company_brain_authority_idempotency_conflict'/)
})

test('G5-M20 normalized scope columns and JSON references must agree exactly', () => {
  assert.match(sql, /authority_scope ->> 'clientid' = client_id::text/)
  assert.match(sql, /authority_scope ->> 'entitynodeid' = entity_node_id::text/)
  assert.match(sql, /company_brain_authority_scope_reference_mismatch/)
})

test('G5-M21 revocation retry detects materially conflicting reuse', () => {
  assert.match(sql, /select id, grant_id, request_fingerprint into v_event_id, v_existing_grant_id, v_existing_fingerprint/)
  assert.match(sql, /v_existing_grant_id is distinct from p_grant_id or v_existing_fingerprint is distinct from v_request_fingerprint/)
  assert.match(sql, /company_brain_authority_revocations_g5[\s\S]+request_fingerprint text not null/)
})

test('G5-M22 materially required source supersession also stales dependent authority', () => {
  assert.match(sql, /new\.status in \('superseded','revoked','invalidated','failed'\)/)
  assert.match(sql, /provenance\.required_current/)
})

test('G5-M23 reviewed state is stamped with the authenticated tenant', () => {
  assert.match(sql, /reviewed_state ->> 'tenantid'.+= user_id::text/)
  assert.match(sql, /jsonb_set\(p_reviewed_state, '\{tenantid\}', to_jsonb\(v_user_id::text\), true\)/)
})

test('G5-M24 semantic fingerprints preserve null dimensions with canonical keyed JSON', () => {
  assert.match(sql, /v_request_fingerprint := encode\(sha256\(convert_to\(jsonb_build_object\(/)
  assert.match(sql, /'supersedesgrantid', p_supersedes_grant_id/)
  assert.doesNotMatch(sql, /v_request_fingerprint := encode\(sha256\(convert_to\(concat_ws/)
})

test('G5-M25 reviewed graph fingerprint must identify current same-tenant graph state', () => {
  assert.match(sql, /where user_id = v_user_id and fingerprint = p_graph_fingerprint and active/)
  assert.match(sql, /company_brain_authority_graph_stale/)
})
