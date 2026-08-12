import test from 'node:test'
import assert from 'node:assert/strict'
import { getRunProgress } from '../../src/lib/importPersistence/importProgress.js'
import { runSingleFlight } from '../../src/lib/importPersistence/singleFlight.js'

function createProgressDatabase() {
  const queries = []
  return {
    queries,
    from(table) {
      const query = { table, filters: [] }
      queries.push(query)
      const builder = {
        select() { return builder },
        eq(column, value) { query.filters.push([column, value]); return builder },
        single() {
          return Promise.resolve({
            data: { id: 'run-1', status: 'in_progress', total_rows: 2, eligible_rows: 2, cancel_requested_at: null },
            error: null,
          })
        },
        then(resolve, reject) {
          return Promise.resolve({ count: 0, error: null }).then(resolve, reject)
        },
      }
      return builder
    },
  }
}

test('progress query applies the supplied tenant to run and row-count reads', async () => {
  const database = createProgressDatabase()
  await getRunProgress({ userId: 'tenant-a', runId: 'run-1', database })

  assert.equal(database.queries.length, 5)
  for (const query of database.queries) {
    assert.deepEqual(query.filters.find(([column]) => column === 'user_id'), ['user_id', 'tenant-a'])
    assert.deepEqual(query.filters.find(([column]) => column === 'run_id' || column === 'id'), [
      query.table === 'import_runs' ? 'id' : 'run_id',
      'run-1',
    ])
  }
})

test('progress read fails closed without a tenant identity', async () => {
  await assert.rejects(
    getRunProgress({ userId: '', runId: 'run-1', database: createProgressDatabase() }),
    /Import run not found/,
  )
})

test('synchronous Start guard admits one invocation and releases for later retry', async () => {
  const lockRef = { current: false }
  let resolveFirst
  let calls = 0
  const firstPending = new Promise((resolve) => { resolveFirst = resolve })
  const operation = async () => { calls += 1; return firstPending }

  const first = runSingleFlight(lockRef, operation)
  const duplicate = await runSingleFlight(lockRef, operation)
  assert.equal(duplicate.started, false)
  assert.equal(calls, 1)

  resolveFirst('done')
  assert.deepEqual(await first, { started: true, value: 'done' })
  assert.equal(lockRef.current, false)

  const retry = await runSingleFlight(lockRef, async () => { calls += 1; return 'retried' })
  assert.deepEqual(retry, { started: true, value: 'retried' })
  assert.equal(calls, 2)
})

test('synchronous Start guard releases after failure', async () => {
  const lockRef = { current: false }
  await assert.rejects(runSingleFlight(lockRef, async () => { throw new Error('start failed') }), /start failed/)
  assert.equal(lockRef.current, false)
})
