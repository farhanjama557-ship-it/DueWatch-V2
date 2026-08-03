import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRunRequestRows, buildImportIdempotencyKey } from '../../src/lib/importPersistence/requestShape.js'

function previewRow(overrides = {}) {
  return {
    originalRowNumber: 1,
    outcome: 'ready',
    issues: [],
    normalized: { invoice_number: 'INV-1', invoice_date: '2026-01-01', amount: '100.00' },
    sourceSheet: 0,
    mapping: {},
    duplicateKey: 'x',
    payment_timing_known: false,
    ...overrides,
  }
}

test('buildRunRequestRows maps originalRowNumber to row_number', () => {
  const [mapped] = buildRunRequestRows([previewRow({ originalRowNumber: 7 })])
  assert.equal(mapped.row_number, 7)
})

test('buildRunRequestRows extracts issue codes only, dropping transport metadata', () => {
  const [mapped] = buildRunRequestRows([
    previewRow({ issues: [{ code: 'PAID_WITHOUT_PAYMENT_DATE', severity: 'warning', rowNumber: 1 }] }),
  ])
  assert.deepEqual(mapped.issue_codes, ['PAID_WITHOUT_PAYMENT_DATE'])
  assert.equal('sourceSheet' in mapped, false)
  assert.equal('mapping' in mapped, false)
  assert.equal('duplicateKey' in mapped, false)
})

test('buildRunRequestRows passes normalized through unchanged', () => {
  const normalized = { invoice_number: 'INV-2', invoice_date: '2026-01-02', amount: '50.00' }
  const [mapped] = buildRunRequestRows([previewRow({ normalized })])
  assert.deepEqual(mapped.normalized, normalized)
})

test('buildRunRequestRows handles an empty/missing row list', () => {
  assert.deepEqual(buildRunRequestRows([]), [])
  assert.deepEqual(buildRunRequestRows(undefined), [])
})

test('buildRunRequestRows includes every row, not just eligible ones', () => {
  const mapped = buildRunRequestRows([
    previewRow({ originalRowNumber: 1, outcome: 'ready' }),
    previewRow({ originalRowNumber: 2, outcome: 'review_required' }),
    previewRow({ originalRowNumber: 3, outcome: 'rejected' }),
  ])
  assert.equal(mapped.length, 3)
  assert.deepEqual(mapped.map((r) => r.outcome), ['ready', 'review_required', 'rejected'])
})

test('buildImportIdempotencyKey is deterministic for the same user + rows', async () => {
  const rows = buildRunRequestRows([previewRow()])
  const a = await buildImportIdempotencyKey('user-1', rows)
  const b = await buildImportIdempotencyKey('user-1', rows)
  assert.equal(a, b)
  assert.match(a, /^user-1:[0-9a-f]{64}$/)
})

test('buildImportIdempotencyKey changes when the rows change', async () => {
  const a = await buildImportIdempotencyKey('user-1', buildRunRequestRows([previewRow({ originalRowNumber: 1 })]))
  const b = await buildImportIdempotencyKey('user-1', buildRunRequestRows([previewRow({ originalRowNumber: 2 })]))
  assert.notEqual(a, b)
})

test('buildImportIdempotencyKey changes across users for identical rows', async () => {
  const rows = buildRunRequestRows([previewRow()])
  const a = await buildImportIdempotencyKey('user-1', rows)
  const b = await buildImportIdempotencyKey('user-2', rows)
  assert.notEqual(a, b)
})

test('buildImportIdempotencyKey throws without a userId', async () => {
  await assert.rejects(() => buildImportIdempotencyKey(null, []))
})
