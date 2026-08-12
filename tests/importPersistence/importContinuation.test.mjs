import test from 'node:test'
import assert from 'node:assert/strict'
import {
  continueExistingImportToCompletion,
  driveNewImportToCompletion,
} from '../../src/lib/importPersistence/importContinuation.js'

const base = (overrides = {}) => ({
  runId: 'run-1', status: 'in_progress', totalRows: 2, pendingRows: 2,
  committedRows: 0, blockedRows: 0, failedRows: 0, cancelRequested: false, ...overrides,
})

test('existing-run recovery has no start path and terminal runs make no mutation', async () => {
  let calls = 0
  const result = await continueExistingImportToCompletion({
    runId: 'run-1', getProgress: async () => base({ status: 'cancelled', pendingRows: 1 }),
    processBatch: async () => { calls += 1 },
  })
  assert.equal(result.status, 'cancelled')
  assert.equal(calls, 0)
})

test('existing-run recovery processes pending rows to durable completion', async () => {
  let processCalls = 0
  const seen = []
  const result = await continueExistingImportToCompletion({
    runId: 'run-1',
    getProgress: async () => processCalls === 0 ? base() : base({ status: 'completed', pendingRows: 0, committedRows: 2 }),
    processBatch: async () => { processCalls += 1; return { status: 'batch_committed' } },
    onProgress: (progress) => seen.push(progress.status),
  })
  assert.equal(result.status, 'completed')
  assert.equal(processCalls, 1)
  assert.deepEqual(seen, ['in_progress', 'completed'])
})

test('batch failure stops recovery and preserves sanitized reason', async () => {
  let processCalls = 0
  const result = await continueExistingImportToCompletion({
    runId: 'run-1', getProgress: async () => base(),
    processBatch: async () => { processCalls += 1; return { status: 'batch_failed', reason: 'Batch stopped safely.' } },
  })
  assert.equal(result.batchFailedReason, 'Batch stopped safely.')
  assert.equal(processCalls, 1)
})

test('route departure during an in-flight batch schedules no later mutation or callback', async () => {
  let active = true
  let resolveBatch
  let processCalls = 0
  let callbacks = 0
  let progressReads = 0
  const batch = new Promise((resolve) => { resolveBatch = resolve })
  const operation = continueExistingImportToCompletion({
    runId: 'run-1', shouldContinue: () => active,
    getProgress: async () => { progressReads += 1; return base({ pendingRows: progressReads === 1 ? 2 : 1, committedRows: progressReads === 1 ? 0 : 1 }) },
    processBatch: async () => { processCalls += 1; return batch },
    onProgress: () => { callbacks += 1 },
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(processCalls, 1)
  active = false
  resolveBatch({ status: 'batch_committed' })
  const result = await operation
  assert.equal(result.continuationStopped, true)
  assert.equal(processCalls, 1)
  assert.equal(callbacks, 1)
  assert.equal(progressReads, 2)
})

test('leaving while start RPC is in flight prevents first batch mutation', async () => {
  let active = true
  let resolveStart
  let processCalls = 0
  const starting = new Promise((resolve) => { resolveStart = resolve })
  const operation = driveNewImportToCompletion({
    userId: 'user-1', idempotencyKey: 'key', rows: [], warningsAcknowledged: false,
    shouldContinue: () => active,
    startRun: async () => starting,
    getProgress: async () => base(),
    processBatch: async () => { processCalls += 1 },
    requestCancellation: async () => {},
  })
  active = false
  resolveStart('run-1')
  const result = await operation
  assert.equal(result.continuationStopped, true)
  assert.equal(processCalls, 0)
})

test('bounded recovery reports stalled instead of looping forever', async () => {
  let calls = 0
  const result = await continueExistingImportToCompletion({
    runId: 'run-1', getProgress: async () => base({ totalRows: 1, pendingRows: 1 }),
    processBatch: async () => { calls += 1; return { status: 'batch_committed' } },
  })
  assert.equal(result.stalled, true)
  assert.equal(calls, 6)
})
