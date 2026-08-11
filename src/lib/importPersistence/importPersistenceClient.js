// Thin browser client for the Checkpoint 1 persistence RPCs. This module
// only calls the three server entry points and reads back plain server
// state — it makes no eligibility or matching decisions of its own (those
// live in eligibility.js and the server, respectively) and never declares
// a row "saved" from anything other than a value read back from the
// server after the call returns.
import { supabase } from '../supabase.js'

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
export async function getRunProgress(runId) {
  const { data: run, error: runError } = await supabase
    .from('import_runs')
    .select('id, status, total_rows, eligible_rows, cancel_requested_at')
    .eq('id', runId)
    .single()
  if (runError) throw runError

  const { count: committedRows, error: committedError } = await supabase
    .from('import_rows')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .eq('server_status', 'committed')
  if (committedError) throw committedError

  const { count: blockedRows, error: blockedError } = await supabase
    .from('import_rows')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .eq('server_status', 'blocked')
  if (blockedError) throw blockedError

  return {
    runId: run.id,
    status: run.status,
    totalRows: run.total_rows,
    eligibleAtSubmission: run.eligible_rows,
    blockedRows: blockedRows ?? 0,
    committedRows: committedRows ?? 0,
    cancelRequested: run.cancel_requested_at != null,
  }
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'partially_completed', 'cancelled', 'failed'])

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
}) {
  const runId = await startImportRun({ userId, idempotencyKey, rows, warningsAcknowledged })
  let progress = await getRunProgress(runId)
  onProgress?.(progress)
  if (TERMINAL_RUN_STATUSES.has(progress.status)) {
    return progress
  }

  // Defensive bound only — normal termination is always one of the status
  // checks below. Real batches make forward progress every call (claim a
  // batch, or discover none remain and settle into a terminal status), so
  // total rows plus a small buffer is generous, not a tuned retry count.
  const maxCalls = progress.totalRows + 5
  let cancellationRequested = false

  for (let i = 0; i < maxCalls; i++) {
    if (!cancellationRequested && isCancelRequested?.()) {
      await requestImportCancellation(runId)
      cancellationRequested = true
    }

    const batchResult = await processImportBatch(runId, batchSize)
    if (batchResult.status === 'batch_failed') {
      progress = { ...(await getRunProgress(runId)), batchFailedReason: batchResult.reason }
      onProgress?.(progress)
      return progress
    }

    progress = await getRunProgress(runId)
    onProgress?.(progress)
    if (TERMINAL_RUN_STATUSES.has(progress.status)) {
      return progress
    }
  }

  return { ...progress, stalled: true }
}
