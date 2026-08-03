import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeIssue, hasStructuredIssueShape, ISSUE_CODES } from '../../src/lib/import/issues.js'

const REQUIRED_KEYS = [
  'code', 'severity', 'rowNumber', 'columnId', 'field', 'rawValue',
  'normalizedValue', 'message', 'blocksPreview', 'blocksImport', 'requiresUserChoice',
]

test('makeIssue produces every required key, row/column-scoped', () => {
  const issue = makeIssue({
    code: ISSUE_CODES.INVALID_AMOUNT,
    severity: 'error',
    rowNumber: 3,
    columnId: 2,
    field: 'amount',
    rawValue: 'abc',
    normalizedValue: null,
    message: 'bad amount',
    blocksImport: true,
  })
  for (const key of REQUIRED_KEYS) assert.ok(Object.prototype.hasOwnProperty.call(issue, key), `missing key ${key}`)
  assert.equal(issue.rowNumber, 3)
  assert.equal(issue.blocksImport, true)
  assert.equal(issue.blocksPreview, false)
  assert.equal(issue.requiresUserChoice, false)
  assert.ok(hasStructuredIssueShape(issue))
})

test('file-level issues use null for row/column-specific fields but keep every key', () => {
  const issue = makeIssue({
    code: ISSUE_CODES.EMPTY_FILE,
    severity: 'error',
    message: 'no data',
    blocksImport: true,
    blocksPreview: true,
  })
  for (const key of REQUIRED_KEYS) assert.ok(Object.prototype.hasOwnProperty.call(issue, key))
  assert.equal(issue.rowNumber, null)
  assert.equal(issue.columnId, null)
  assert.equal(issue.field, null)
})

test('rawValue is reduced to a safe, deterministic representation for formula objects', () => {
  const issue = makeIssue({
    code: ISSUE_CODES.FORMULA_VALUE_UNAVAILABLE,
    severity: 'error',
    rowNumber: 1,
    rawValue: { formula: 'SUM(A1:A2)' },
    message: 'no cached value',
    blocksImport: true,
  })
  assert.equal(issue.rawValue, '=SUM(A1:A2)')
})

test('rawValue serializes Date instances deterministically', () => {
  const issue = makeIssue({
    code: ISSUE_CODES.INVALID_DATE,
    severity: 'error',
    rowNumber: 1,
    rawValue: new Date(Date.UTC(2026, 0, 1)),
    message: 'bad date',
    blocksImport: true,
  })
  assert.equal(issue.rawValue, '2026-01-01T00:00:00.000Z')
})

test('makeIssue rejects an unknown code and an invalid severity', () => {
  assert.throws(() => makeIssue({ code: 'NOT_A_CODE', severity: 'error', message: 'x' }))
  assert.throws(() => makeIssue({ code: ISSUE_CODES.INVALID_AMOUNT, severity: 'critical', message: 'x' }))
})

test('makeIssue requires a message', () => {
  assert.throws(() => makeIssue({ code: ISSUE_CODES.INVALID_AMOUNT, severity: 'error' }))
})
