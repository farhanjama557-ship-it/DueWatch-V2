import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const LOCKED_REPO_MAIN_TREE_SHA = '8597c2a661496b88afc92cf4a27c3e58f62dc86e'

export const BASELINE_MIGRATIONS = Object.freeze([
  ['20260726000000_canonical_clients.sql', '5acb4f08041ec958e8c45066209861b19242f624'],
  ['20260803021842_enforce_invoice_client_tenant_ownership.sql', '80e6388e762380ac6a30fd8cf89c9137145117f9'],
  ['20260803150000_import_persistence_core.sql', '0d3177c13b865bd811637f30f0deb318958612a8'],
  ['20260810000000_client_source_identities_rls.sql', 'cf6ae3f47628980d8bf9ab90806a19cfbdb15747'],
  ['20260811000000_client_source_identities_tenant_fk.sql', '360235c678234556541696816b3a52adfb303ef4'],
  ['20260811083005_phase15b_import_table_privilege_baseline.sql', 'a41b058d5ce2a4e04e7c1c1ed4c3fee41b856c13'],
  ['20260811092928_process_import_batch_hosted_compatibility.sql', '0d4e07ad66e4b89299c3794bc597924d2d7f1617'],
  ['20260813161329_autopilot_execution_claims.sql', 'fe5155caa242b61922e260b4ad6b4b67964effea'],
  ['20260814090000_awaiting_signature_pending_only_uniqueness.sql', 'df28ce250383e03a344f5edb8590b4f997845402'],
  ['20260814100000_autopilot_execution_claims_canonical_receipt.sql', 'cffad874db25bec8f06c2c76b1c3c05e025e0cde'],
  ['20260816120000_payments_foundation.sql', '4c53f36a6f5629f5695565a3c3c2d1c016da2626'],
])

export const REPO_EXECUTION_SOURCES = Object.freeze({
  'supabase/functions/autopilot-scheduler/index.ts': '666162d8b6b4dba0d58051ae48d97b7b347a4700',
  'supabase/functions/send-reminder-email/index.ts': '836f0060e573bdeed5d301cf4265abb6d607862e',
  'supabase/functions/_shared/autopilotExecutionCore.js': 'dc360e315a1bf976ec39d5b2725a6bf50b3fb7fb',
  'supabase/functions/_shared/nextActionAuthority.js': 'ced197dfc80adba69b190ccc63096afe235db8f6',
  'supabase/functions/_shared/executionClaim.js': '233651b2fbeff7ee76c102d2ccc16674c74d5e7e',
  'supabase/functions/_shared/autopilotAuthorityInputs.js': '6191c8358f4c5499ba3f5f0175ee8ff9915e1313',
})

export const REQUIRED_SCHEMA_CAPABILITIES = Object.freeze([
  'clients.canonical_id',
  'client_source_identities',
  'import_runs',
  'autopilot_execution_claims',
  'awaiting_signature.authority_receipt',
  'awaiting_signature.rule_snapshot',
  'payments',
  'payment_allocations',
  'invoice_client_composite_tenant_fk',
])

function timestampOf(name) {
  const m = /^(\d{14})_/.exec(name)
  if (!m) throw new Error(`Migration lacks 14-digit timestamp: ${name}`)
  return m[1]
}

export function validateMigrationInventory(migrations = BASELINE_MIGRATIONS) {
  const problems = []
  let previous = null
  const names = new Set()
  const hashes = new Set()
  for (const [name, blobSha] of migrations) {
    if (names.has(name)) problems.push(`duplicate migration name: ${name}`)
    if (hashes.has(blobSha)) problems.push(`duplicate migration blob sha: ${blobSha}`)
    names.add(name)
    hashes.add(blobSha)
    if (!/^[0-9a-f]{40}$/.test(blobSha)) problems.push(`invalid git blob sha for ${name}`)
    const ts = timestampOf(name)
    if (previous && ts <= previous) problems.push(`non-increasing migration order at ${name}`)
    previous = ts
  }
  return { ok: problems.length === 0, problems }
}

export function evaluateBaselineGate(snapshot, { phase2bMigrationName = '20260824234500_dw_intelligence_phase2b_proof.sql' } = {}) {
  const blockers = []
  const warnings = []

  if (!snapshot || typeof snapshot !== 'object') blockers.push('snapshot_missing')
  if (snapshot?.repo_main_tree_sha !== LOCKED_REPO_MAIN_TREE_SHA) blockers.push('repo_tree_sha_mismatch')

  const inventory = validateMigrationInventory()
  if (!inventory.ok) blockers.push(...inventory.problems.map((p) => `migration_inventory:${p}`))

  const lastBaselineTs = timestampOf(BASELINE_MIGRATIONS.at(-1)[0])
  const phase2bTs = timestampOf(phase2bMigrationName)
  if (phase2bTs <= lastBaselineTs) blockers.push('phase2b_migration_not_after_baseline')

  const indicators = snapshot?.live_schema_indicators ?? snapshot?.schema_indicators ?? {}
  for (const capability of REQUIRED_SCHEMA_CAPABILITIES) {
    if (indicators[capability] !== true) blockers.push(`missing_schema_capability:${capability}`)
  }

  if (indicators.cross_tenant_invoice_client_relationship_count > 0) {
    blockers.push('existing_cross_tenant_invoice_client_relationships')
  } else if (indicators.invoice_client_composite_tenant_fk !== true) {
    warnings.push('current data has no observed cross-tenant invoice/client rows, but structural tenant FK is still missing')
  }

  if (indicators.awaiting_signature_has_old_user_invoice_status_unique_index === true) {
    blockers.push('legacy_awaiting_signature_uniqueness_still_present')
  }

  const deployed = snapshot?.deployed_edge_functions ?? {}
  const schedulerBehavior = String(deployed['autopilot-scheduler']?.behavior ?? '')
  const senderBehavior = String(deployed['send-reminder-email']?.behavior ?? '')
  const schedulerCurrent = deployed['autopilot-scheduler']?.repo_current === true ||
    (/autopilotExecutionCore/i.test(schedulerBehavior) && /nextActionAuthority/i.test(schedulerBehavior) && !/legacy/i.test(schedulerBehavior))
  const senderCurrent = deployed['send-reminder-email']?.repo_current === true ||
    (/autopilotExecutionCore/i.test(senderBehavior) && !/legacy/i.test(senderBehavior))

  if (!schedulerCurrent) blockers.push('edge_function_drift:autopilot-scheduler')
  if (!senderCurrent) blockers.push('edge_function_drift:send-reminder-email')

  if (snapshot?.mutations_performed === true) warnings.push('snapshot reports mutations during audit')

  return {
    status: blockers.length === 0 ? 'BASELINE_READY_FOR_PHASE2B_PERSISTENCE_PROOF' : 'BLOCKED_BASELINE_ALIGNMENT_REQUIRED',
    ready: blockers.length === 0,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    locked_repo_main_tree_sha: LOCKED_REPO_MAIN_TREE_SHA,
    required_migration_count: BASELINE_MIGRATIONS.length,
    phase2b_migration: phase2bMigrationName,
  }
}

export function buildSimulatedAlignedSnapshot(snapshot) {
  const clone = structuredClone(snapshot)
  clone.repo_main_tree_sha = LOCKED_REPO_MAIN_TREE_SHA
  clone.live_schema_indicators ??= {}
  for (const capability of REQUIRED_SCHEMA_CAPABILITIES) clone.live_schema_indicators[capability] = true
  clone.live_schema_indicators.cross_tenant_invoice_client_relationship_count = 0
  clone.live_schema_indicators.awaiting_signature_has_old_user_invoice_status_unique_index = false
  clone.deployed_edge_functions = {
    'autopilot-scheduler': { repo_current: true, behavior: 'repo-current nextActionAuthority + autopilotExecutionCore + executionClaim boundary' },
    'send-reminder-email': { repo_current: true, behavior: 'repo-current autopilotExecutionCore approval-send boundary' },
  }
  return clone
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  const input = process.argv[2]
  const mode = process.argv[3] ?? 'current'
  if (!input) {
    console.error('usage: node baselineGate.mjs <snapshot.json> [current|simulated-aligned]')
    process.exit(64)
  }
  const snapshot = JSON.parse(fs.readFileSync(input, 'utf8'))
  const evaluated = evaluateBaselineGate(mode === 'simulated-aligned' ? buildSimulatedAlignedSnapshot(snapshot) : snapshot)
  process.stdout.write(`${JSON.stringify(evaluated, null, 2)}\n`)
  process.exitCode = evaluated.ready ? 0 : 2
}
