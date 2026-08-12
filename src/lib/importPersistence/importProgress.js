async function countRunRows(database, runId, status, userId) {
  const { count, error } = await database
    .from('import_rows')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('run_id', runId)
    .eq('server_status', status)
  if (error) throw error
  return count ?? 0
}

export async function getRunRowCounts({ userId, runId, database }) {
  if (!userId || !runId || !database) throw new Error('Import run not found.')
  const [committedRows, blockedRows, pendingRows, failedRows] = await Promise.all([
    countRunRows(database, runId, 'committed', userId),
    countRunRows(database, runId, 'blocked', userId),
    countRunRows(database, runId, 'pending', userId),
    countRunRows(database, runId, 'failed', userId),
  ])
  return { committedRows, blockedRows, pendingRows, failedRows }
}

export async function getRunProgress({ userId, runId, database }) {
  if (!userId || !runId || !database) throw new Error('Import run not found.')
  const { data: run, error: runError } = await database
    .from('import_runs')
    .select('id, status, total_rows, eligible_rows, cancel_requested_at')
    .eq('user_id', userId)
    .eq('id', runId)
    .single()
  if (runError) throw runError

  const counts = await getRunRowCounts({ userId, runId, database })

  return {
    runId: run.id,
    status: run.status,
    totalRows: run.total_rows,
    eligibleAtSubmission: run.eligible_rows,
    ...counts,
    cancelRequested: run.cancel_requested_at != null,
  }
}
