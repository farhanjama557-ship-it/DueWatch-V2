export const TERMINAL_RUN_STATUSES = new Set(['completed', 'partially_completed', 'cancelled', 'failed'])

function isContinuing(shouldContinue) {
  return shouldContinue?.() !== false
}

function stopped(progress) {
  return { ...progress, continuationStopped: true }
}

function emitIfContinuing(progress, shouldContinue, onProgress) {
  if (!isContinuing(shouldContinue)) return false
  onProgress?.(progress)
  return true
}

async function settleBatchResult({ runId, batchResult, getProgress, shouldContinue, onProgress }) {
  let progress = await getProgress(runId)
  if (batchResult?.status === 'batch_failed') {
    progress = { ...progress, batchFailedReason: batchResult.reason }
  }
  if (!emitIfContinuing(progress, shouldContinue, onProgress)) return stopped(progress)
  return progress
}

// New-import orchestration. The founder's explicit Start action authorizes
// this visible loop, but leaving the route prevents this browser from
// scheduling another mutation after any already-running RPC settles.
export async function driveNewImportToCompletion({
  userId,
  idempotencyKey,
  rows,
  warningsAcknowledged,
  batchSize,
  onProgress,
  isCancelRequested,
  shouldContinue,
  startRun,
  getProgress,
  processBatch,
  requestCancellation,
}) {
  const runId = await startRun({ userId, idempotencyKey, rows, warningsAcknowledged })
  const continuingAfterStart = isContinuing(shouldContinue)
  let progress = await getProgress(runId)
  if (!continuingAfterStart || !emitIfContinuing(progress, shouldContinue, onProgress)) return stopped(progress)
  if (TERMINAL_RUN_STATUSES.has(progress.status)) return progress

  const maxCalls = progress.totalRows + 5
  let cancellationRequested = progress.cancelRequested === true

  for (let i = 0; i < maxCalls; i++) {
    if (!isContinuing(shouldContinue)) return stopped(progress)
    if (!cancellationRequested && isCancelRequested?.()) {
      await requestCancellation(runId)
      cancellationRequested = true
      if (!isContinuing(shouldContinue)) {
        progress = await getProgress(runId)
        return stopped(progress)
      }
    }
    if (!isContinuing(shouldContinue)) return stopped(progress)

    const batchResult = await processBatch(runId, batchSize)
    progress = await settleBatchResult({ runId, batchResult, getProgress, shouldContinue, onProgress })
    if (progress.continuationStopped || progress.batchFailedReason) return progress
    if (TERMINAL_RUN_STATUSES.has(progress.status)) return progress
  }

  return { ...progress, stalled: true }
}

// Existing-run recovery. This boundary deliberately has no startRun,
// request payload, or idempotency-key input: historical recovery can only
// continue the durable run identified by runId.
export async function continueExistingImportToCompletion({
  runId,
  batchSize,
  onProgress,
  shouldContinue,
  getProgress,
  processBatch,
}) {
  let progress = await getProgress(runId)
  if (!emitIfContinuing(progress, shouldContinue, onProgress)) return stopped(progress)
  if (TERMINAL_RUN_STATUSES.has(progress.status)) return progress

  const maxCalls = Math.max(progress.pendingRows ?? 0, 1) + 5
  for (let i = 0; i < maxCalls; i++) {
    if (!isContinuing(shouldContinue)) return stopped(progress)
    const batchResult = await processBatch(runId, batchSize)
    progress = await settleBatchResult({ runId, batchResult, getProgress, shouldContinue, onProgress })
    if (progress.continuationStopped || progress.batchFailedReason) return progress
    if (TERMINAL_RUN_STATUSES.has(progress.status)) return progress
  }

  return { ...progress, stalled: true }
}
