import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

function runSupabase(args) {
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

  const configPath = path.join(repoRoot, 'supabase/config.toml')
  const original = await fs.readFile(configPath, 'utf8')
  const enabled = enableMigrationsTemporarily(original)

  await fs.writeFile(configPath, enabled)

  try {
    const args = ['db', 'push', '--include-all']
    if (mode === 'dry-run') args.push('--dry-run')
    runSupabase(args)
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
    config_restored: true,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2]
  const mode = arg === '--dry-run' ? 'dry-run' : arg === '--apply' ? 'apply' : null
  if (!mode) fail('usage: node scripts/system-brain/m2d-hosted-migration-cli.mjs --dry-run|--apply')
  await runM2dHostedMigrationCli(mode)
}
