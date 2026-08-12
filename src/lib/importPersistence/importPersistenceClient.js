// Thin browser client for the Checkpoint 1 persistence RPCs. This module
// only calls the three server entry points and reads back plain server
// state — it makes no eligibility or matching decisions of its own (those
// live in eligibility.js and the server, respectively) and never declares
// a row "saved" from anything other than a value read back from the
// server after the call returns.
import { supabase } from '../supabase.js'
import {
  driveNewImportToCompletion,
  continueExistingImportToCompletion,
} from './importContinuation.js'
import {
  getRunProgress as readRunProgress,
  getRunRowCounts as readRunRowCounts,
} from './importProgress.js'

export { buildRunRequestRows, buildImportIdempotencyKey } from './requestShape.js'

export async function startImportRun({ userId, idempotencyKey, rows, warningsAcknowledged }) {
  const { data, error } = await supabase.rpc('start_import_run', {
    p_user_id: userId,
    p_idempotency_key: idempotencyKey,
    p_rows: rows,
    p_warnings_acknowledged: warningsAcknowledged === true,
  })
  if (error) throw error
  if (!data) throw new Error('start_import_run returned no run id')
  return data
}

export async function processImportBatch(runId, batchSize) {
  const { data, error } = await supabase.rpc('process_import_batch', {
    p_run_id: runId,
    ...(batchSize ? { p_batch_size: batchSize } : {}),
  })
  if (error) throw error
  return data
}

export async function requestImportCancellation(runId) {
  const { error } = await supabase.rpc('request_import_cancellation', { p_run_id: runId })
  if (error) throw error
}

// Truthful progress read directly from server state — never from local
// counters — so this is exactly what powers both live progress display and
// resuming after a refresh: the same read either way. blockedRows in
// particular MUST be a live count against import_rows, not
// import_runs.blocked_rows (that column only reflects blocking decisions
// made at start_import_run time; rows can also become blocked later,
// during batch execution — e.g. AMBIGUOUS_CLIENT_IDENTITY or
// INVOICE_MATERIAL_CONFLICT — and a stale read would under-report them).
export async function getRunRowCounts({ userId, runId, database = supabase }) {
  return readRunRowCounts({ userId, runId, database })
}

export async function getRunProgress({ userId, runId, database = supabase }) {
  return readRunProgress({ userId, runId, database })
}

export async function listImportRuns({ userId, page = 0, pageSize = 20, database = supabase }) {
  if (!userId) throw new Error('A signed-in user is required to load import history.')
  const safePage = Number.isInteger(page) && page >= 0 ? page : 0
  const safePageSize = Number.isInteger(pageSize) ? Math.min(Math.max(pageSize, 1), 20) : 20
  const start = safePage * safePageSize
  const end = start + safePageSize - 1
  const { data, error } = await database
    .from('import_runs')
    .select('id, status, total_rows, eligible_rows, cancel_requested_at, created_at, started_at, completed_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(start, end)
  if (error) throw error

  return Promise.all((data || []).map(async (run) => ({
    ...run,
    ...(await getRunRowCounts({ userId, runId: run.id, database })),
  })))
}

async function selectAllForRun({ database, table, fields, userId, runId, orderColumn, pageSize = 1000 }) {
  const rows = []
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await database
      .from(table)
      .select(fields)
      .eq('user_id', userId)
      .eq('run_id', runId)
      .order(orderColumn, { ascending: true })
      .order('id', { ascending: true })
      .range(start, start + pageSize - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) return rows
  }
}

export async function getImportRunDetail({ userId, runId, database = supabase }) {
  if (!userId || !runId) throw new Error('Import run not found.')
  const { data: run, error: runError } = await database
    .from('import_runs')
    .select('id, status, total_rows, eligible_rows, blocked_rows, cancel_requested_at, created_at, started_at, completed_at')
    .eq('user_id', userId)
    .eq('id', runId)
    .maybeSingle()
  if (runError || !run) throw new Error('Import run not found.')

  const [rows, events, batches, counts] = await Promise.all([
    selectAllForRun({
      database,
      table: 'import_rows',
      fields: 'id, batch_id, row_number, server_status, block_reason_code, client_id, client_result, invoice_id, invoice_result, committed_at, created_at, material_payload',
      userId,
      runId,
      orderColumn: 'row_number',
    }),
    selectAllForRun({
      database,
      table: 'import_events',
      fields: 'id, batch_id, row_id, event_type, created_at',
      userId,
      runId,
      orderColumn: 'created_at',
    }),
    // Authenticated has an intentionally column-scoped SELECT grant here.
    // Request only the customer-safe batch columns; internal_diagnostic is
    // operator-only and must never enter the browser query.
    selectAllForRun({
      database,
      table: 'import_batches',
      fields: 'id, run_id, user_id, batch_index, status, row_count, failure_reason, created_at',
      userId,
      runId,
      orderColumn: 'batch_index',
    }),
    getRunRowCounts({ userId, runId, database }),
  ])

  return {
    run,
    rows,
    events,
    batches,
    progress: {
      runId: run.id,
      status: run.status,
      totalRows: run.total_rows,
      eligibleAtSubmission: run.eligible_rows,
      ...counts,
      cancelRequested: run.cancel_requested_at != null,
    },
  }
}

// Drives start_import_run + repeated process_import_batch calls to a
// terminal state, reporting truthful progress after every batch (read back
// from the server, per getRunProgress — never inferred). Stops immediately
// on a batch_failed result rather than silently retrying the same failing
// batch forever; stops on cancellation once the server actually reports
// cancelled, never optimistically before that.
export async function runImportToCompletion({
  userId,
  idempotencyKey,
  rows,
  warningsAcknowledged,
  batchSize,
  onProgress,
  isCancelRequested,
  shouldContinue,
}) {
  return driveNewImportToCompletion({
    userId,
    idempotencyKey,
    rows,
    warningsAcknowledged,
    batchSize,
    onProgress,
    isCancelRequested,
    shouldContinue,
    startRun: startImportRun,
    getProgress: (runId) => getRunProgress({ userId, runId }),
    processBatch: processImportBatch,
    requestCancellation: requestImportCancellation,
  })
}

export async function continueImportRunToCompletion({ userId, runId, batchSize, onProgress, shouldContinue }) {
  if (!userId || !runId) throw new Error('Import run not found.')
  return continueExistingImportToCompletion({
    runId,
    batchSize,
    onProgress,
    shouldContinue,
    getProgress: (existingRunId) => getRunProgress({ userId, runId: existingRunId }),
    processBatch: processImportBatch,
  })
}
