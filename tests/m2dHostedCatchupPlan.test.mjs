import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  M2D_AUTHORITATIVE_MIGRATIONS,
  M2D_BASELINE_RECONCILIATION,
  M2D_EDGE_FUNCTION_FILES,
  M2D_LOCAL_ONLY_ARTIFACTS,
  M2D_NATIVE_MIGRATION_DEPLOYMENT,
  verifyM2dHostedCatchupPlan,
} from '../scripts/system-brain/m2d-hosted-catchup-plan.mjs'
import {
  assertRemoteMigrationPrefix,
  parseMigrationListRemoteVersions,
} from '../scripts/system-brain/m2d-hosted-migration-cli.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

test('M2D catch-up plan hash-locks every authoritative replay source', async () => {
  const verified = await verifyM2dHostedCatchupPlan()
  assert.equal(verified.verifier_performs_hosted_write, false)
  assert.equal(verified.hosted_deployment_state, 'NOT_INFERRED_BY_STATIC_PLAN')
  assert.equal(
    verified.verified_sources.length,
    M2D_AUTHORITATIVE_MIGRATIONS.length + M2D_EDGE_FUNCTION_FILES.length,
  )
  assert.deepEqual(
    verified.authoritative_migrations.map((item) => item.path),
    M2D_AUTHORITATIVE_MIGRATIONS.map(([name]) => name),
  )
})

test('M2D baseline is a native migration that sorts before canonical-client catch-up', async () => {
  const verified = await verifyM2dHostedCatchupPlan()
  assert.equal(M2D_BASELINE_RECONCILIATION, 'supabase/migrations/20260725000000_m2d_hosted_baseline_reconciliation.sql')
  assert.equal(verified.baseline_reconciliation.version, '20260725000000')
  assert.equal(verified.authoritative_migrations[0].version, '20260726000000')
  assert.equal(verified.baseline_reconciliation.sorts_before_first_authoritative, true)
})

test('M2D keeps cloud-prohibited proof SQL outside the Supabase migration directory', async () => {
  assert.deepEqual(M2D_LOCAL_ONLY_ARTIFACTS, [
    'supabase/local-proof-migrations/20260825003000_dw_intelligence_live_transitions_phase2b.sql',
  ])
  for (const relative of M2D_LOCAL_ONLY_ARTIFACTS) {
    assert.equal(relative.startsWith('supabase/migrations/'), false)
    const text = fs.readFileSync(path.join(repoRoot, relative), 'utf8')
    assert.match(text, /do not apply to a paid\/cloud environment/i)
  }

  // verifyM2dHostedCatchupPlan additionally scans every real migration and
  // fails if a future local-only marker is accidentally reintroduced there.
  await verifyM2dHostedCatchupPlan()
})

test('M2D uses guarded native Supabase migration history instead of untracked manual SQL replay', () => {
  assert.deepEqual(M2D_NATIVE_MIGRATION_DEPLOYMENT, {
    mode: 'GUARDED_SUPABASE_DB_PUSH_INCLUDE_ALL',
    remoteHistoryPrecondition: 'EXACT_CONTIGUOUS_PREFIX_OR_STOP_AND_REAUDIT',
    resumePolicy: 'ONLY_REVIEWED_PREFIX_MAY_RESUME',
    configPolicy: 'TEMPORARILY_ENABLE_AND_RESTORE_BYTE_FOR_BYTE',
    linkedProjectRef: 'llviufxoujmsnrlyptxg',
    migrationCount: 14,
    dryRunCommand: 'node scripts/system-brain/m2d-hosted-migration-cli.mjs --dry-run',
    applyCommand: 'DUEWATCH_M2D_APPLY=YES_I_REVIEWED_THE_DRY_RUN node scripts/system-brain/m2d-hosted-migration-cli.mjs --apply',
    verifyCommand: 'supabase migration list --linked',
  })
})

test('M2D guarded migration helper keeps local CI migration config disabled at rest', () => {
  const helper = fs.readFileSync(
    path.join(repoRoot, 'scripts/system-brain/m2d-hosted-migration-cli.mjs'),
    'utf8',
  )
  const config = fs.readFileSync(path.join(repoRoot, 'supabase/config.toml'), 'utf8')

  assert.match(
    config,
    /\[db\.migrations\]\r?\nenabled = false\r?\nschema_paths = \[\]/,
  )
  assert.match(helper, /enableMigrationsTemporarily/)
  assert.match(helper, /finally/)
  assert.match(helper, /restored !== original/)
  assert.match(helper, /YES_I_REVIEWED_THE_DRY_RUN/)
  assert.match(helper, /llviufxoujmsnrlyptxg/)
  assert.match(helper, /EXPECTED_MIGRATIONS/)
  assert.match(helper, /SUPABASE_DB_PASSWORD/)
  assert.doesNotMatch(helper, /--password/)
})

test('M2D guarded helper accepts only an exact contiguous remote migration prefix', () => {
  const output = `
   Local          | Remote         | Time (UTC)
  ----------------|----------------|---------------------
   20260725000000 | 20260725000000 | 2026-07-25 00:00:00
   20260726000000 | 20260726000000 | 2026-07-26 00:00:00
   20260803021842 | 20260803021842 | 2026-08-03 02:18:42
   20260803150000 | 20260803150000 | 2026-08-03 15:00:00
   20260810000000 | 20260810000000 | 2026-08-10 00:00:00
   20260811000000 |                | 2026-08-11 00:00:00
  `
  const remote = parseMigrationListRemoteVersions(output)
  assert.deepEqual(remote, [
    '20260725000000',
    '20260726000000',
    '20260803021842',
    '20260803150000',
    '20260810000000',
  ])
  assert.equal(assertRemoteMigrationPrefix(remote), 5)

  assert.throws(
    () => assertRemoteMigrationPrefix([
      '20260725000000',
      '20260803021842',
    ]),
    /not the exact reviewed contiguous prefix/,
  )
  assert.throws(
    () => assertRemoteMigrationPrefix([
      '20260725000000',
      '99999999999999',
    ]),
    /not the exact reviewed contiguous prefix/,
  )
})

test('M2D migration-list parser accepts decorated cells and preserves remote-only drift', () => {
  const decorated = `
   Local            | Remote           | Time (UTC)
  ------------------|------------------|-----------------------
   \`20260725000000\` | \`20260725000000\` | \`2026-07-25 00:00:00\`
   \`20260726000000\` | \`20260726000000\` | \`2026-07-26 00:00:00\`
   \`20260803021842\` | \` \`              | \`2026-08-03 02:18:42\`
  `
  assert.deepEqual(parseMigrationListRemoteVersions(decorated), [
    '20260725000000',
    '20260726000000',
  ])

  const remoteOnlyDrift = `
   Local            | Remote           | Time (UTC)
  ------------------|------------------|-----------------------
   \`20260725000000\` | \`20260725000000\` | \`2026-07-25 00:00:00\`
   \` \`              | \`99999999999999\` | \`2026-08-28 00:00:00\`
  `
  const remote = parseMigrationListRemoteVersions(remoteOnlyDrift)
  assert.deepEqual(remote, ['20260725000000', '99999999999999'])
  assert.throws(
    () => assertRemoteMigrationPrefix(remote),
    /not the exact reviewed contiguous prefix/,
  )
})

test('M2D client-source tenant migration scopes completion to its own FK while dedup stays fail-closed', () => {
  const tenantFkSql = fs.readFileSync(
    path.join(repoRoot, 'supabase/migrations/20260811000000_client_source_identities_tenant_fk.sql'),
    'utf8',
  )
  const canonicalSql = fs.readFileSync(
    path.join(repoRoot, 'supabase/migrations/20260726000000_canonical_clients.sql'),
    'utf8',
  )

  assert.match(
    tenantFkSql,
    /client_source_identities tenant constraint does not match the required definition/,
  )
  assert.match(
    tenantFkSql,
    /client_source_identities tenant migration left the superseded single-column FK in place/,
  )
  assert.doesNotMatch(
    tenantFkSql,
    /client_source_identities tenant migration left an unknown client\/invoice FK/,
  )
  assert.match(tenantFkSql, /unknown_client_foreign_keys/)
  assert.match(tenantFkSql, /Canonical dedup execution must remain disabled/)

  assert.match(
    canonicalSql,
    /Unknown client\/invoice foreign keys exist; execution blocked/,
  )
})

test('M2D baseline reconciliation does not invent financial truth or perform tenant DML', () => {
  const sql = fs.readFileSync(path.join(repoRoot, M2D_BASELINE_RECONCILIATION), 'utf8')
  assert.match(sql, /add column if not exists phone text/i)
  assert.match(sql, /add column if not exists company text/i)
  assert.match(sql, /add column if not exists notes text/i)
  assert.match(sql, /alter column due_date drop not null/i)
  assert.match(sql, /alter column client_id drop not null/i)
  assert.match(sql, /last_reminder type timestamptz/i)
  assert.match(sql, /at time zone 'UTC'/i)
  assert.doesNotMatch(sql, /default\s+'USD'/i)
  assert.doesNotMatch(sql, /\btruncate\b/i)
  assert.doesNotMatch(sql, /\bupdate\s+public\.(clients|invoices)\b/i)
  assert.doesNotMatch(sql, /\bdelete\s+from\s+public\.(clients|invoices)\b/i)
  assert.doesNotMatch(sql, /\binsert\s+into\s+public\.(clients|invoices)\b/i)
})

test('M2D baseline drops only the verified legacy same-name uniqueness constraint', () => {
  const sql = fs.readFileSync(path.join(repoRoot, M2D_BASELINE_RECONCILIATION), 'utf8')
  assert.match(sql, /clients_user_id_name_key:UNIQUE \(user_id, name\)/)
  assert.match(sql, /drop constraint if exists clients_user_id_name_key/i)
  assert.match(sql, /multiple UNIQUE\(user_id,name\) constraints/i)
})

test('M2D Edge Function deployment contract is closed-world and JWT-required', async () => {
  const verified = await verifyM2dHostedCatchupPlan()
  assert.equal(verified.edge_function.slug, 'ask-dw-model')
  assert.equal(verified.edge_function.verify_jwt_required, true)
  assert.deepEqual(
    verified.edge_function.files,
    M2D_EDGE_FUNCTION_FILES.map(([name]) => name),
  )
})
