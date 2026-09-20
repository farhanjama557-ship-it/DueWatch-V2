import test from 'node:test'
import assert from 'node:assert/strict'
import { collectPagedRows, loadReportsSourceData } from '../src/lib/reports/reportDataSource.js'

test('collectPagedRows reads until a short page and preserves order', async () => {
  const pages = [
    [{ id: 1 }, { id: 2 }],
    [{ id: 3 }],
  ]
  const calls = []

  const result = await collectPagedRows(
    async ({ from, to }) => {
      calls.push({ from, to })
      return { data: pages[calls.length - 1] || [], error: null }
    },
    { pageSize: 2, maxPages: 10 }
  )

  assert.deepEqual(result.rows.map((row) => row.id), [1, 2, 3])
  assert.equal(result.truncated, false)
  assert.deepEqual(calls, [
    { from: 0, to: 1 },
    { from: 2, to: 3 },
  ])
})

test('collectPagedRows marks a max-page cutoff as truncated', async () => {
  const result = await collectPagedRows(
    async () => ({ data: [{ id: 1 }, { id: 2 }], error: null }),
    { pageSize: 2, maxPages: 2 }
  )
  assert.equal(result.rows.length, 4)
  assert.equal(result.truncated, true)
})

test('collectPagedRows surfaces query errors rather than turning them into empty truth', async () => {
  await assert.rejects(
    collectPagedRows(async () => ({ data: null, error: { message: 'boom' } })),
    /boom/
  )
})

function fakeDatabase(config = {}, trace = []) {
  return {
    from(table) {
      const state = { table }
      const chain = {
        select(value) {
          trace.push({ table, op: 'select', value })
          return chain
        },
        eq(column, value) {
          trace.push({ table, op: 'eq', column, value })
          return chain
        },
        order() {
          return chain
        },
        async range() {
          const entry = config[state.table]
          if (entry instanceof Error) return { data: null, error: { message: entry.message } }
          return { data: entry || [], error: null }
        },
      }
      return chain
    },
  }
}

test('loadReportsSourceData reports per-source availability independently', async () => {
  const result = await loadReportsSourceData({
    database: fakeDatabase({
      invoices: [{ id: 'i1' }],
      payments: [{ id: 'p1' }],
      payment_allocations: [{ id: 'a1' }],
      promises: new Error('relation promises does not exist'),
      autopilot_execution_claims: [{ id: 'c1' }],
      awaiting_signature: [{ id: 's1' }],
      events: [{ id: 'e1' }],
    }),
    userId: 'u1',
  })

  assert.equal(result.invoices.available, true)
  assert.equal(result.payments.available, true)
  assert.equal(result.allocations.available, true)
  assert.equal(result.promises.available, false)
  assert.match(result.promises.error, /promises/)
  assert.equal(result.executionClaims.available, true)
  assert.equal(result.approvals.available, true)
  assert.equal(result.events.available, true)
})

test('loadReportsSourceData does not collapse invoice or event failures into empty success', async () => {
  const result = await loadReportsSourceData({
    database: fakeDatabase({
      invoices: new Error('invoice query failed'),
      payments: [],
      payment_allocations: [],
      promises: [],
      autopilot_execution_claims: [],
      awaiting_signature: [],
      events: new Error('event query failed'),
    }),
    userId: 'u1',
  })

  assert.equal(result.invoices.available, false)
  assert.match(result.invoices.error, /invoice query failed/)
  assert.equal(result.events.available, false)
  assert.match(result.events.error, /event query failed/)
})


test('allocation reads are explicitly tenant scoped even when RLS is bypassed server-side', async () => {
  const trace = []
  await loadReportsSourceData({
    database: fakeDatabase({
      invoices: [],
      payments: [],
      payment_allocations: [],
      promises: [],
      autopilot_execution_claims: [],
      awaiting_signature: [],
      events: [],
    }, trace),
    userId: 'tenant-1',
  })

  assert.ok(
    trace.some(
      (entry) =>
        entry.table === 'payment_allocations' &&
        entry.op === 'eq' &&
        entry.column === 'invoices.user_id' &&
        entry.value === 'tenant-1'
    )
  )
  assert.ok(
    trace.some(
      (entry) =>
        entry.table === 'payment_allocations' &&
        entry.op === 'select' &&
        String(entry.value).includes('invoices!inner')
    )
  )
})


test('loadReportsSourceData withholds truncated sources instead of reporting partial totals', async () => {
  const result = await loadReportsSourceData({
    database: fakeDatabase({
      invoices: [{ id: 'i1' }],
      payments: [{ id: 'p1' }],
      payment_allocations: [{ id: 'a1' }],
      promises: [{ id: 'ptp1' }],
      autopilot_execution_claims: [{ id: 'c1' }],
      awaiting_signature: [{ id: 's1' }],
      events: [{ id: 'e1' }],
    }),
    userId: 'u1',
    pageSize: 1,
    maxPages: 1,
  })

  assert.equal(result.payments.available, false)
  assert.equal(result.payments.truncated, true)
  assert.deepEqual(result.payments.rows, [])
  assert.match(result.payments.error, /exceeded the supported row limit/i)
  assert.equal(result.invoices.available, false)
  assert.equal(result.allocations.available, false)
})
