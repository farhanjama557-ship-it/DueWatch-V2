import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyM2dHostedCatchupPlan } from './m2d-hosted-catchup-plan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')

const EXPECTED_PROJECT_REF = 'llviufxoujmsnrlyptxg'
const APPLY_CONFIRMATION = 'YES_I_REVIEWED_THE_DRY_RUN'

const EXPECTED_MIGRATIONS = Object.freeze([
  '20260725000000_m2d_hosted_baseline_reconciliation.sql',
  '20260726000000_canonical_clients.sql',
  '20260803021842_enforce_invoice_client_tenant_ownership.sql',
  '20260803150000_import_persistence_core.sql',
  '20260810000000_client_source_identities_rls.sql',
  '20260811000000_client_source_identities_tenant_fk.sql',
  '20260811083005_phase15b_import_table_privilege_baseline.sql',
  '20260811092928_process_import_batch_hosted_compatibility.sql',
  '20260813161329_autopilot_execution_claims.sql',
  '20260814090000_awaiting_signature_pending_only_uniqueness.sql',
  '20260814100000_autopilot_execution_claims_canonical_receipt.sql',
  '20260816120000_payments_foundation.sql',
  '20260824234500_dw_intelligence_phase2b_proof.sql',
  '20260827173500_ask_dw_conversation_persistence.sql',
])

const EXPECTED_VERSIONS = Object.freeze(
  EXPECTED_MIGRATIONS.map((name) => name.slice(0, 14)),
)

const LOCAL_ONLY = '20260825003000_dw_intelligence_live_transitions_phase2b.sql'

function fail(message) {
  throw new Error(`M2D guarded hosted migration: ${message}`)
}

async function assertLinkedProject() {
  const refPath = path.join(repoRoot, 'supabase/.temp/project-ref')
  let ref
  try {
    ref = (await fs.readFile(refPath, 'utf8')).trim()
  } catch {
    fail('Supabase project is not linked; run supabase link first')
  }
  if (ref !== EXPECTED_PROJECT_REF) {
    fail(`refusing linked project ${ref || '(empty)'}; expected ${EXPECTED_PROJECT_REF}`)
  }
}

async function assertMigrationSet() {
  const migrationDir = path.join(repoRoot, 'supabase/migrations')
  const names = (await fs.readdir(migrationDir))
    .filter((name) => name.endsWith('.sql'))
    .sort()

  const expected = [...EXPECTED_MIGRATIONS].sort()
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(
      `migration set drifted.\nExpected:\n${expected.join('\n')}\nActual:\n${names.join('\n')}`,
    )
  }

  if (names.includes(LOCAL_ONLY)) {
    fail(`local-only proof migration is cloud-push eligible: ${LOCAL_ONLY}`)
  }

  const localOnlyPath = path.join(repoRoot, 'supabase/local-proof-migrations', LOCAL_ONLY)
  const localOnlyText = await fs.readFile(localOnlyPath, 'utf8')
  if (!/do not apply to a paid\/cloud environment/i.test(localOnlyText)) {
    fail('local-only proof migration lost its cloud-exclusion warning')
  }
}

function stripAnsi(value = '') {
  return String(value).replace(/\u001b\[[0-9;]*m/g, '')
}

export function parseMigrationListRemoteVersions(output = '') {
  const remote = []
  let parsedRows = 0
  const versionPattern = /(?<!\d)(\d{14})(?!\d)/

  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    // Supabase CLI versions have appeared both as bare values and as
    // decorated/backticked cell values. Parse by table columns first, then
    // extract the 14-digit version from each cell instead of requiring the
    // version to sit immediately next to the column separator.
    const cells = rawLine.split(/[│|]/)
    if (cells.length < 3) continue

    const localVersion = cells[0].match(versionPattern)?.[1] ?? null
    const remoteVersion = cells[1].match(versionPattern)?.[1] ?? null
    if (!localVersion && !remoteVersion) continue

    parsedRows += 1
    if (remoteVersion) remote.push(remoteVersion)
  }

  if (parsedRows === 0) {
    fail('could not parse any migration rows from `supabase migration list --linked`')
  }

  return remote
}

export function assertRemoteMigrationPrefix(remoteVersions = []) {
  if (!Array.isArray(remoteVersions)) {
    fail('remote migration history must be an array')
  }

  if (remoteVersions.length > EXPECTED_VERSIONS.length) {
    fail(
      `remote history has ${remoteVersions.length} versions; expected at most ${EXPECTED_VERSIONS.length}`,
    )
  }

  for (let i = 0; i < remoteVersions.length; i += 1) {
    if (remoteVersions[i] !== EXPECTED_VERSIONS[i]) {
      fail(
        `remote migration history is not the exact reviewed contiguous prefix at index ${i}: `
        + `expected ${EXPECTED_VERSIONS[i]}, got ${remoteVersions[i]}`,
      )
    }
  }

  return remoteVersions.length
}

function runSupabaseCapture(args) {
  const result = spawnSync('supabase', args, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  })

  if (result.error) throw result.error

  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)

  if (result.status !== 0) {
    fail(`supabase ${args.join(' ')} exited with status ${result.status}`)
  }

  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function runSupabaseInteractive(args) {
  const result = spawnSync('supabase', args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    fail(`supabase ${args.join(' ')} exited with status ${result.status}`)
  }
}

async function assertRemoteHistoryIsExpectedPrefix() {
  const output = runSupabaseCapture(['migration', 'list', '--linked'])
  const remoteVersions = parseMigrationListRemoteVersions(output)
  return assertRemoteMigrationPrefix(remoteVersions)
}

function enableMigrationsTemporarily(configText) {
  const oldBlock = `[db.migrations]
enabled = false
schema_paths = []
`
  const newBlock = `[db.migrations]
enabled = true
schema_paths = []
`
  const first = configText.indexOf(oldBlock)
  const last = configText.lastIndexOf(oldBlock)
  if (first < 0 || first !== last) {
    fail('expected exact disabled [db.migrations] block exactly once')
  }
  return configText.replace(oldBlock, newBlock)
}

export async function runM2dHostedMigrationCli(mode) {
  if (!['dry-run', 'apply'].includes(mode)) {
    fail('mode must be dry-run or apply')
  }
  if (!process.env.SUPABASE_DB_PASSWORD) {
    fail('SUPABASE_DB_PASSWORD must be loaded in the shell; the helper never prints it')
  }
  if (mode === 'apply' && process.env.DUEWATCH_M2D_APPLY !== APPLY_CONFIRMATION) {
    fail(`apply requires DUEWATCH_M2D_APPLY=${APPLY_CONFIRMATION}`)
  }

  await assertLinkedProject()
  await assertMigrationSet()
  await verifyM2dHostedCatchupPlan()

  const remoteAppliedCountBefore = await assertRemoteHistoryIsExpectedPrefix()

  const configPath = path.join(repoRoot, 'supabase/config.toml')
  const original = await fs.readFile(configPath, 'utf8')
  const enabled = enableMigrationsTemporarily(original)

  await fs.writeFile(configPath, enabled)

  let remoteAppliedCountAfter = remoteAppliedCountBefore

  try {
    const args = ['db', 'push', '--include-all']
    if (mode === 'dry-run') args.push('--dry-run')
    runSupabaseInteractive(args)

    if (mode === 'apply') {
      remoteAppliedCountAfter = await assertRemoteHistoryIsExpectedPrefix()
      if (remoteAppliedCountAfter !== EXPECTED_MIGRATIONS.length) {
        fail(
          `apply returned success but remote history contains ${remoteAppliedCountAfter}/`
          + `${EXPECTED_MIGRATIONS.length} reviewed migrations`,
        )
      }
    }
  } finally {
    await fs.writeFile(configPath, original)
    const restored = await fs.readFile(configPath, 'utf8')
    if (restored !== original) {
      fail('supabase/config.toml was not restored byte-for-byte')
    }
  }

  return {
    mode,
    project_ref: EXPECTED_PROJECT_REF,
    expected_migration_count: EXPECTED_MIGRATIONS.length,
    remote_applied_count_before: remoteAppliedCountBefore,
    remote_applied_count_after: remoteAppliedCountAfter,
    config_restored: true,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2]
  const mode = arg === '--dry-run' ? 'dry-run' : arg === '--apply' ? 'apply' : null
  if (!mode) fail('usage: node scripts/system-brain/m2d-hosted-migration-cli.mjs --dry-run|--apply')
  await runM2dHostedMigrationCli(mode)
}
