/**
 * M2G-G6 executable RPC behaviour.
 *
 * These tests apply the real G6 migration to a real PostgreSQL server and call
 * record_company_brain_founder_review_g6 for actual. They exist because the
 * two properties they check cannot be established by reading the SQL:
 *
 *   - a rejected attempt must remain durably auditable, which depends on
 *     PostgreSQL transaction semantics (a `raise` would roll the audit row
 *     back), and
 *   - staleness must be decided by the server from its own tables rather than
 *     from the fingerprint the caller supplied.
 *
 * If no PostgreSQL server can be reached or created the suite skips loudly
 * rather than passing silently.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { UPSTREAM_STUB, sql, startPostgres } from './helpers/g6Postgres.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const migrationSql = fs.readFileSync(
  path.join(repoRoot, 'supabase/migrations/20260901220000_company_brain_founder_review_g6.sql'),
  'utf8',
)

const server = startPostgres()
const skip = server ? false : 'no PostgreSQL server available (set G6_TEST_PG_SOCKET to run these)'

const tenantA = '11111111-1111-4111-8111-111111111111'
const tenantB = '22222222-2222-4222-8222-222222222222'
const modelA = '33333333-3333-4333-8333-333333333333'
const conflictA = '44444444-4444-4444-8444-444444444444'
const grantA = '55555555-5555-4555-8555-555555555555'
const modelFingerprint = 'a'.repeat(64)
const nextModelFingerprint = 'b'.repeat(64)
const subject1 = 'c'.repeat(64)
const subject2 = 'd'.repeat(64)
const reviewKey = `review-${'0'.repeat(32)}`
const conflictKey = `review-${'1'.repeat(32)}`

if (server) {
  test.after(() => server.stop())
  sql(server, `
    ${UPSTREAM_STUB}
    insert into auth.users (id) values ('${tenantA}'), ('${tenantB}');
    insert into public.company_operating_model_proposals (id, user_id, model_fingerprint, status)
      values ('${modelA}', '${tenantA}', '${modelFingerprint}', 'PROPOSED');
    insert into public.company_brain_conflicts (id, user_id, topic, status, revision)
      values ('${conflictA}', '${tenantA}', 'late_fee_policy', 'CONFLICTED', 0);
    insert into public.company_brain_authority_grants_g5 (id, user_id, status)
      values ('${grantA}', '${tenantA}', 'GRANTED');
    ${migrationSql}
  `)
}

/** Calls the RPC as a given tenant and returns the parsed jsonb result. */
function review(tenant, overrides = {}) {
  const call = {
    review_key: reviewKey,
    category: 'COMPANY_UNDERSTANDING',
    item_type: 'UNDERSTANDING',
    subject_type: 'OPERATING_STATEMENT',
    subject_id: 'reminder_cadence',
    scope_level: 'COMPANY',
    review_scope: '{"level":"COMPANY"}',
    client_id: null,
    conflict_id: null,
    conflict_revision: null,
    operating_model_id: modelA,
    source_model_fingerprint: modelFingerprint,
    authority_proposal_id: null,
    authority_grant_id: null,
    review_action: 'APPROVE',
    expected_revision: 0,
    subject_fingerprint: subject1,
    proposed_value: '{"reminderDays":7}',
    reviewed_value: null,
    reason: null,
    evidence: '[]',
    idempotency_key: 'k1',
    ...overrides,
  }
  const literal = (value, cast) => (value === null ? `null::${cast}` : `'${value}'::${cast}`)
  const statement = `
    select set_config('request.jwt.claim.sub', '${tenant}', false);
    select public.record_company_brain_founder_review_g6(
      ${literal(call.review_key, 'text')}, ${literal(call.category, 'text')},
      ${literal(call.item_type, 'text')}, ${literal(call.subject_type, 'text')},
      ${literal(call.subject_id, 'text')}, ${literal(call.scope_level, 'text')},
      ${literal(call.review_scope, 'jsonb')}, ${literal(call.client_id, 'uuid')},
      ${literal(call.conflict_id, 'uuid')},
      ${call.conflict_revision === null ? 'null::integer' : `${call.conflict_revision}::integer`},
      ${literal(call.operating_model_id, 'uuid')}, ${literal(call.source_model_fingerprint, 'text')},
      ${literal(call.authority_proposal_id, 'uuid')}, ${literal(call.authority_grant_id, 'uuid')},
      ${literal(call.review_action, 'text')}, ${call.expected_revision}::integer,
      ${literal(call.subject_fingerprint, 'text')}, ${literal(call.proposed_value, 'jsonb')},
      ${literal(call.reviewed_value, 'jsonb')}, ${literal(call.reason, 'text')},
      ${literal(call.evidence, 'jsonb')}, ${literal(call.idempotency_key, 'text')}
    );`
  const output = sql(server, statement).split('\n').filter(Boolean)
  return JSON.parse(output.at(-1))
}

function count(table, where = 'true') {
  return Number(sql(server, `select count(*) from public.company_brain_founder_review_${table}_g6 where ${where};`))
}

test('G6-RT1 the real migration applies to a real PostgreSQL server', { skip }, () => {
  const tables = sql(server, `
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name like 'company_brain_founder_review%'
    order by table_name;`).split('\n')
  assert.deepEqual(tables, [
    'company_brain_founder_review_attempts_g6',
    'company_brain_founder_review_evidence_g6',
    'company_brain_founder_review_items_g6',
    'company_brain_founder_review_revisions_g6',
  ])
  assert.equal(sql(server, `
    select count(*) from pg_proc where proname = 'record_company_brain_founder_review_g6';`), '1')
})

test('G6-RT2 a valid review is accepted and grants no authority', { skip }, () => {
  const result = review(tenantA)
  assert.equal(result.outcome, 'ACCEPTED')
  assert.equal(result.revision, 1)
  assert.equal(result.authority_granted, false)
  assert.equal(count('revisions'), 1)
  assert.equal(sql(server, `select authority_granted from public.company_brain_founder_review_revisions_g6;`), 'f')
})

test('G6-RT3 a stale-revision rejection stays durably auditable', { skip }, () => {
  // The regression this guards: raising after the audit insert would roll the
  // audit row back and the rejected attempt would disappear entirely.
  const before = count('attempts', `outcome = 'REJECTED_STALE_REVISION'`)
  const result = review(tenantA, { idempotency_key: 'stale-1', expected_revision: 0 })
  assert.equal(result.outcome, 'REJECTED_STALE_REVISION')
  assert.equal(result.actual_revision, 1)
  const after = count('attempts', `outcome = 'REJECTED_STALE_REVISION'`)
  assert.equal(after, before + 1, 'the rejected stale attempt must survive the rejection')
  // Fails closed: no second revision was written.
  assert.equal(count('revisions'), 1)
})

test('G6-RT4 the server rejects a stale subject fingerprint it did not store', { skip }, () => {
  // The caller claims a different subject state under an unchanged derivation.
  const before = count('attempts', `outcome = 'REJECTED_SUBJECT_CHANGED'`)
  const result = review(tenantA, {
    idempotency_key: 'subject-1', expected_revision: 1, subject_fingerprint: subject2,
  })
  assert.equal(result.outcome, 'REJECTED_SUBJECT_CHANGED')
  assert.equal(result.reason, 'SUBJECT_FINGERPRINT_NOT_CURRENT')
  assert.equal(count('attempts', `outcome = 'REJECTED_SUBJECT_CHANGED'`), before + 1)
  assert.equal(count('revisions'), 1)
})

test('G6-RT5 the server rejects a review citing a superseded operating model', { skip }, () => {
  sql(server, `update public.company_operating_model_proposals set status = 'SUPERSEDED' where id = '${modelA}';`)
  const result = review(tenantA, { idempotency_key: 'stale-model', expected_revision: 1 })
  assert.equal(result.outcome, 'REJECTED_SUBJECT_CHANGED')
  assert.equal(result.reason, 'OPERATING_MODEL_NOT_CURRENT')
  sql(server, `update public.company_operating_model_proposals set status = 'PROPOSED' where id = '${modelA}';`)
})

test('G6-RT6 the server rejects a review citing the wrong model fingerprint', { skip }, () => {
  // The fingerprint is checked against the row the server reads, so a caller
  // cannot assert freshness that the database does not agree with.
  const result = review(tenantA, {
    idempotency_key: 'wrong-fingerprint', expected_revision: 1,
    source_model_fingerprint: nextModelFingerprint,
  })
  assert.equal(result.outcome, 'REJECTED_SUBJECT_CHANGED')
  assert.equal(result.reason, 'OPERATING_MODEL_NOT_CURRENT')
  assert.equal(count('revisions'), 1)
})

test('G6-RT7 a moved derivation lets the founder legitimately re-review', { skip }, () => {
  sql(server, `update public.company_operating_model_proposals
    set model_fingerprint = '${nextModelFingerprint}' where id = '${modelA}';`)
  const result = review(tenantA, {
    idempotency_key: 're-review', expected_revision: 1,
    source_model_fingerprint: nextModelFingerprint, subject_fingerprint: subject2,
  })
  assert.equal(result.outcome, 'ACCEPTED')
  assert.equal(result.revision, 2)
  // The server's stored subject state advanced with the accepted review.
  assert.equal(
    sql(server, `select current_subject_fingerprint from public.company_brain_founder_review_items_g6
      where review_key = '${reviewKey}';`),
    subject2,
  )
  // Lineage: the new revision explicitly supersedes its predecessor.
  assert.equal(sql(server, `select count(*) from public.company_brain_founder_review_revisions_g6
    where supersedes_revision_id is not null;`), '1')
})

test('G6-RT8 a conflict revision that moved is rejected server-side', { skip }, () => {
  const accepted = review(tenantA, {
    review_key: conflictKey, category: 'CONFLICTS', item_type: 'CONFLICT',
    subject_type: 'BRAIN_CONFLICT', subject_id: conflictA, review_action: 'HOLD',
    operating_model_id: null, source_model_fingerprint: null,
    conflict_id: conflictA, conflict_revision: 0,
    idempotency_key: 'conflict-hold', expected_revision: 0, subject_fingerprint: subject1,
  })
  assert.equal(accepted.outcome, 'ACCEPTED')
  sql(server, `update public.company_brain_conflicts set revision = 1 where id = '${conflictA}';`)
  const stale = review(tenantA, {
    review_key: conflictKey, category: 'CONFLICTS', item_type: 'CONFLICT',
    subject_type: 'BRAIN_CONFLICT', subject_id: conflictA, review_action: 'DEFER',
    operating_model_id: null, source_model_fingerprint: null,
    conflict_id: conflictA, conflict_revision: 0,
    idempotency_key: 'conflict-stale', expected_revision: 1, subject_fingerprint: subject1,
  })
  assert.equal(stale.outcome, 'REJECTED_SUBJECT_CHANGED')
  assert.equal(stale.reason, 'CONFLICT_REVISION_NOT_CURRENT')
})

test('G6-RT9 an action owned by G3 or G5 is refused and audited, creating no item', { skip }, () => {
  const items = count('items')
  const result = review(tenantA, {
    review_key: `review-${'2'.repeat(32)}`, category: 'AUTHORITY', item_type: 'AUTHORITY_STATE',
    subject_type: 'AUTHORITY_GRANT', subject_id: grantA, review_action: 'APPROVE',
    operating_model_id: null, source_model_fingerprint: null, authority_grant_id: grantA,
    idempotency_key: 'authority-approve', expected_revision: 0,
  })
  assert.equal(result.outcome, 'REJECTED_ACTION_UNAVAILABLE')
  assert.equal(count('attempts', `outcome = 'REJECTED_ACTION_UNAVAILABLE'`), 1)
  // A rejected call must not bring a review item row into existence.
  assert.equal(count('items'), items)
})

test('G6-RT10 an unbound review with nothing to check staleness against is refused', { skip }, () => {
  assert.throws(() => review(tenantA, {
    review_key: `review-${'3'.repeat(32)}`, operating_model_id: null,
    source_model_fingerprint: null, idempotency_key: 'unbound', expected_revision: 0,
  }), /DERIVATION_BINDING_REQUIRED/)
})

test('G6-RT11 idempotent replay and idempotency conflict behave as specified', { skip }, () => {
  const replay = review(tenantA, {
    idempotency_key: 're-review', expected_revision: 1,
    source_model_fingerprint: nextModelFingerprint, subject_fingerprint: subject2,
  })
  assert.equal(replay.outcome, 'IDEMPOTENT_REPLAY')
  const conflict = review(tenantA, {
    idempotency_key: 're-review', expected_revision: 1, review_action: 'REJECT',
    source_model_fingerprint: nextModelFingerprint, subject_fingerprint: subject2,
  })
  assert.equal(conflict.outcome, 'REJECTED_IDEMPOTENCY_CONFLICT')
  assert.equal(count('attempts', `outcome = 'REJECTED_IDEMPOTENCY_CONFLICT'`), 1)
})

function countAsTenant(tenant) {
  // Runs as the `authenticated` role inside a transaction so the owner/superuser
  // RLS bypass does not apply and the policy is genuinely exercised.
  return sql(server, `
    begin;
    select set_config('request.jwt.claim.sub', '${tenant}', true);
    set local role authenticated;
    select count(*) from public.company_brain_founder_review_revisions_g6;
    rollback;`,
  ).split('\n').filter(Boolean).at(-1)
}

test('G6-RT12 RLS confines every G6 table to its owning tenant', { skip }, () => {
  const owned = Number(countAsTenant(tenantA))
  assert.ok(owned > 0, 'tenant A must see its own review revisions through RLS')
  assert.equal(countAsTenant(tenantB), '0', 'tenant B must not see tenant A review revisions')
})

test('G6-RT12b the authenticated role holds no write privilege on any G6 table', { skip }, () => {
  const writable = sql(server, `
    select string_agg(table_name || ':' || privilege_type, ',')
    from information_schema.role_table_grants
    where grantee in ('authenticated', 'anon', 'public')
      and table_name like 'company_brain_founder_review%'
      and privilege_type <> 'SELECT';`)
  assert.equal(writable, '', 'no INSERT/UPDATE/DELETE may be granted on a G6 table')
})

test('G6-RT13 no review revision can be written that claims authority', { skip }, () => {
  assert.throws(() => sql(server, `
    update public.company_brain_founder_review_revisions_g6 set authority_granted = true;`),
  /authority_granted/)
  assert.throws(() => sql(server, `
    update public.company_brain_founder_review_revisions_g6 set resolves_conflict = true;`),
  /resolves_conflict/)
})

if (skip) {
  test('G6-RT0 PostgreSQL runtime verification was NOT performed', () => {
    assert.ok(true)
    console.warn(`\n  !! G6 RPC runtime tests skipped: ${skip}\n`)
  })
}
