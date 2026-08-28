import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')

export const M2D_CATCHUP_PLAN_VERSION = 'ASK_DW_M2D_HOSTED_CATCHUP_V2'

export const M2D_BASELINE_RECONCILIATION =
  'supabase/migrations/20260725000000_m2d_hosted_baseline_reconciliation.sql'

export const M2D_AUTHORITATIVE_MIGRATIONS = Object.freeze([
  ['supabase/migrations/20260726000000_canonical_clients.sql', '5acb4f08041ec958e8c45066209861b19242f624'],
  ['supabase/migrations/20260803021842_enforce_invoice_client_tenant_ownership.sql', '80e6388e762380ac6a30fd8cf89c9137145117f9'],
  ['supabase/migrations/20260803150000_import_persistence_core.sql', '0d3177c13b865bd811637f30f0deb318958612a8'],
  ['supabase/migrations/20260810000000_client_source_identities_rls.sql', 'cf6ae3f47628980d8bf9ab90806a19cfbdb15747'],
  ['supabase/migrations/20260811000000_client_source_identities_tenant_fk.sql', '3fe0fe73e038e80c2c171a8aef504cce535ce8d7'],
  ['supabase/migrations/20260811083005_phase15b_import_table_privilege_baseline.sql', 'a41b058d5ce2a4e04e7c1c1ed4c3fee41b856c13'],
  ['supabase/migrations/20260811092928_process_import_batch_hosted_compatibility.sql', '0d4e07ad66e4b89299c3794bc597924d2d7f1617'],
  ['supabase/migrations/20260813161329_autopilot_execution_claims.sql', 'fe5155caa242b61922e260b4ad6b4b67964effea'],
  ['supabase/migrations/20260814090000_awaiting_signature_pending_only_uniqueness.sql', 'df28ce250383e03a344f5edb8590b4f997845402'],
  ['supabase/migrations/20260814100000_autopilot_execution_claims_canonical_receipt.sql', 'cffad874db25bec8f06c2c76b1c3c05e025e0cde'],
  ['supabase/migrations/20260816120000_payments_foundation.sql', '2d82ec37676d59ce9488f01f9ccc16f6c3f90b3b'],
  ['supabase/migrations/20260824234500_dw_intelligence_phase2b_proof.sql', '2ce1896d665c71d1eedf12c96aa5e446dbcd30f1'],
  ['supabase/migrations/20260827173500_ask_dw_conversation_persistence.sql', '824441ba581772fa000b565d6d14305999f2b94c'],
])

export const M2D_LOCAL_ONLY_ARTIFACTS = Object.freeze([
  'supabase/local-proof-migrations/20260825003000_dw_intelligence_live_transitions_phase2b.sql',
])

export const M2D_EDGE_FUNCTION_FILES = Object.freeze([
  ['supabase/functions/ask-dw-model/index.ts', 'b687f54b07ac7f9f31596a7cdf42a472d4ab8855'],
  ['supabase/functions/_shared/cors.js', '1a56c70cd9382e04d205db2aecb68c4cfd7016cb'],
  ['supabase/functions/_shared/askDwOpenAiContract.js', 'e3870f6ffc62fea71118a9202d79af00cdf70477'],
])

export const M2D_NATIVE_MIGRATION_DEPLOYMENT = Object.freeze({
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

function gitBlobSha(file) {
  return execFileSync('git', ['hash-object', file], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
}

function migrationVersion(relative) {
  const match = /^supabase\/migrations\/(\d{14})_/.exec(relative)
  if (!match) throw new Error(`M2D invalid migration path/version: ${relative}`)
  return match[1]
}

export async function verifyM2dHostedCatchupPlan() {
  const baselinePath = path.join(repoRoot, M2D_BASELINE_RECONCILIATION)
  await fs.access(baselinePath)

  const baselineVersion = migrationVersion(M2D_BASELINE_RECONCILIATION)
  const firstAuthoritativeVersion = migrationVersion(M2D_AUTHORITATIVE_MIGRATIONS[0][0])
  if (baselineVersion >= firstAuthoritativeVersion) {
    throw new Error(
      `M2D baseline must sort before first authoritative migration: ${baselineVersion} >= ${firstAuthoritativeVersion}`,
    )
  }

  const verified = []
  for (const [relative, expectedBlobSha] of [
    ...M2D_AUTHORITATIVE_MIGRATIONS,
    ...M2D_EDGE_FUNCTION_FILES,
  ]) {
    const actual = gitBlobSha(relative)
    if (actual !== expectedBlobSha) {
      throw new Error(`M2D source drift: ${relative} expected Git blob ${expectedBlobSha}, got ${actual}`)
    }
    verified.push({ path: relative, git_blob_sha: actual })
  }

  for (const relative of M2D_LOCAL_ONLY_ARTIFACTS) {
    if (relative.startsWith('supabase/migrations/')) {
      throw new Error(`M2D local-only artifact is still cloud-push eligible: ${relative}`)
    }
    const text = await fs.readFile(path.join(repoRoot, relative), 'utf8')
    if (!/do not apply to a paid\/cloud environment/i.test(text)) {
      throw new Error(`M2D local-only artifact lost its cloud-exclusion warning: ${relative}`)
    }
  }

  // Fail closed if any future file is accidentally placed in the real
  // migration directory while declaring itself local/cloud-prohibited.
  const migrationDir = path.join(repoRoot, 'supabase/migrations')
  for (const name of await fs.readdir(migrationDir)) {
    if (!name.endsWith('.sql')) continue
    const relative = `supabase/migrations/${name}`
    const text = await fs.readFile(path.join(migrationDir, name), 'utf8')
    if (/LOCAL PROOF ARTIFACT/i.test(text) || /do not apply to a paid\/cloud environment/i.test(text)) {
      throw new Error(`M2D cloud migration directory contains a local-only artifact: ${relative}`)
    }
  }

  return {
    plan_version: M2D_CATCHUP_PLAN_VERSION,
    baseline_reconciliation: {
      path: M2D_BASELINE_RECONCILIATION,
      version: baselineVersion,
      git_blob_sha: gitBlobSha(M2D_BASELINE_RECONCILIATION),
      sorts_before_first_authoritative: true,
    },
    authoritative_migrations: M2D_AUTHORITATIVE_MIGRATIONS.map(([p]) => ({
      path: p,
      version: migrationVersion(p),
    })),
    local_only_artifacts: [...M2D_LOCAL_ONLY_ARTIFACTS],
    migration_deployment: M2D_NATIVE_MIGRATION_DEPLOYMENT,
    edge_function: {
      slug: 'ask-dw-model',
      verify_jwt_required: true,
      files: M2D_EDGE_FUNCTION_FILES.map(([p]) => p),
    },
    verified_sources: verified,
    verifier_performs_hosted_write: false,
    hosted_deployment_state: 'NOT_INFERRED_BY_STATIC_PLAN',
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await verifyM2dHostedCatchupPlan(), null, 2))
}
