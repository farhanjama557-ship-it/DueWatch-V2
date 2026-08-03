import { createClient } from '@supabase/supabase-js'

const [action = 'dry-run', ...args] = process.argv.slice(2)
const value = (flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? null : args[i + 1]
}

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const userId = value('--user-id')
const runId = value('--run-id')
const confirmation = value('--confirm')
const evidenceJson = value('--evidence-json')

if (!url || !key) fail('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.')
if (![
  'dry-run', 'report', 'attest-fks', 'attest-tests', 'execute', 'rollback',
].includes(action)) {
  fail('Usage: client-dedupe.mjs dry-run|report|attest-fks|attest-tests|execute|rollback')
}

const db = createClient(url, key, { auth: { persistSession: false } })

if (action === 'dry-run') {
  if (!userId) fail('dry-run requires --user-id UUID')
  const { data, error } = await db.rpc('admin_prepare_client_dedup', {
    p_user_id: userId,
  })
  if (error) fail(error.message)
  await printReport(data)
} else if (action === 'report') {
  if (!runId) fail('report requires --run-id UUID')
  await printReport(runId)
} else if (action === 'attest-fks' || action === 'attest-tests') {
  if (!runId || !evidenceJson) {
    fail(`${action} requires --run-id and --evidence-json`)
  }
  const gate = action === 'attest-fks' ? 'foreign_keys' : 'integration_tests'
  const required = action === 'attest-fks'
    ? `VERIFY FOREIGN KEYS ${runId}`
    : `VERIFY INTEGRATION TESTS ${runId}`
  if (confirmation !== required) {
    fail(`Refusing attestation. Pass --confirm "${required}"`)
  }
  let evidence
  try {
    evidence = JSON.parse(evidenceJson)
  } catch {
    fail('--evidence-json must contain valid JSON')
  }
  const { error } = await db.rpc('admin_attest_client_dedup_gate', {
    p_run_id: runId,
    p_gate: gate,
    p_evidence: evidence,
    p_confirmation: confirmation,
  })
  if (error) fail(error.message)
  await printReport(runId)
} else {
  if (!runId) fail(`${action} requires --run-id UUID`)
  const required = `${action === 'execute' ? 'EXECUTE' : 'ROLLBACK'} ${runId}`
  if (confirmation !== required) {
    fail(`Refusing to ${action}. Pass --confirm "${required}"`)
  }
  const fn = action === 'execute'
    ? 'admin_execute_client_dedup'
    : 'admin_rollback_client_dedup'
  const { data, error } = await db.rpc(fn, {
    p_run_id: runId,
    p_confirmation: confirmation,
  })
  if (error) fail(error.message)
  console.log(JSON.stringify(data, null, 2))
}

async function printReport(id) {
  const [{ data: run, error: runError }, { data: candidates, error: candidateError }] =
    await Promise.all([
      db.from('client_dedup_runs').select('*').eq('id', id).single(),
      db.from('client_merge_candidates')
        .select('*')
        .eq('run_id', id)
        .order('classification')
        .order('affected_invoice_count', { ascending: false }),
    ])
  if (runError) fail(runError.message)
  if (candidateError) fail(candidateError.message)
  const exactMatches = candidates.filter((c) => c.classification === 'exact')
  const reviewRequired = candidates.filter(
    (c) => c.classification === 'review_required'
  )
  console.log(JSON.stringify({
    run,
    exact_matches: exactMatches,
    review_required: reviewRequired,
    skipped_records: candidates.filter((c) => c.status === 'skipped'),
    affected_invoices_exact: exactMatches.reduce(
      (n, c) => n + c.affected_invoice_count,
      0
    ),
    affected_invoices_review_required: reviewRequired.reduce(
      (n, c) => n + c.affected_invoice_count,
      0
    ),
  }, null, 2))
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
