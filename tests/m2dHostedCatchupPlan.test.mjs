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

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

test('M2D catch-up plan hash-locks every authoritative replay source', async () => {
  const verified = await verifyM2dHostedCatchupPlan()
  assert.equal(verified.hosted_write_performed, false)
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
    remoteHistoryPrecondition: 'EMPTY_OR_STOP_AND_REAUDIT',
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

  assert.ok(
    config.includes('[db.migrations]\nenabled = false\nschema_paths = []'),
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
