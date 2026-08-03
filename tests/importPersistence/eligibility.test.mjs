import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateRowEligibility,
  evaluateFileEligibility,
  evaluateAllRows,
  APPROVED_WARNING_CODES,
  BLOCK_REASONS,
} from '../../src/lib/importPersistence/eligibility.js'

function readyRow(overrides = {}) {
  return {
    outcome: 'ready',
    issues: [],
    normalized: { invoice_number: 'INV-1', invoice_date: '2026-01-01', amount: '100.00' },
    ...overrides,
  }
}

test('a clean ready row is eligible', () => {
  const result = evaluateRowEligibility(readyRow())
  assert.equal(result.eligible, true)
})

test('review_required is never eligible', () => {
  const result = evaluateRowEligibility(readyRow({ outcome: 'review_required' }))
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.REVIEW_REQUIRED)
})

test('rejected is never eligible', () => {
  const result = evaluateRowEligibility(readyRow({ outcome: 'rejected' }))
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.REJECTED)
})

test('an unrecognized outcome string is blocked, not treated as eligible', () => {
  const result = evaluateRowEligibility(readyRow({ outcome: 'somehow_fine' }))
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.UNKNOWN_OUTCOME)
})

test('a missing row is blocked', () => {
  assert.equal(evaluateRowEligibility(null).eligible, false)
  assert.equal(evaluateRowEligibility(undefined).eligible, false)
})

test('an unknown issue code blocks even on a claimed-ready row', () => {
  const result = evaluateRowEligibility(
    readyRow({ issues: [{ code: 'SOME_FUTURE_CODE_NOT_YET_TAUGHT' }] })
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.UNKNOWN_ISSUE_CODE)
})

test('every currently-approved warning code is individually eligible on ready_with_warnings', () => {
  for (const code of APPROVED_WARNING_CODES) {
    const result = evaluateRowEligibility(
      readyRow({ outcome: 'ready_with_warnings', issues: [{ code }] })
    )
    assert.equal(result.eligible, true, `expected ${code} to be eligible`)
  }
})

test('a real blocking code contradicting a claimed ready_with_warnings outcome is blocked, not trusted', () => {
  const result = evaluateRowEligibility(
    readyRow({ outcome: 'ready_with_warnings', issues: [{ code: 'AMOUNT_PAID_EXCEEDS_AMOUNT' }] })
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.BLOCKING_ISSUE_ON_ELIGIBLE_OUTCOME)
})

test('a non-blocking code that is not on the approved list still blocks ready_with_warnings', () => {
  // DUPLICATE_IN_UPLOAD is a real, known code but it blocksImport=true —
  // this specifically exercises the branch where the code IS known and IS
  // blocking, distinguishing it from the unknown-code case above.
  const result = evaluateRowEligibility(
    readyRow({ outcome: 'ready_with_warnings', issues: [{ code: 'DUPLICATE_IN_UPLOAD' }] })
  )
  assert.equal(result.eligible, false)
})

test('missing a required material field blocks even with a clean outcome/issues', () => {
  for (const field of ['invoice_number', 'invoice_date', 'amount']) {
    const normalized = { invoice_number: 'INV-1', invoice_date: '2026-01-01', amount: '100.00' }
    normalized[field] = null
    const result = evaluateRowEligibility(readyRow({ normalized }))
    assert.equal(result.eligible, false, `expected missing ${field} to block`)
    assert.equal(result.reasonCode, BLOCK_REASONS.MISSING_MATERIAL_FIELD)
  }
})

test('status "void" is blocked explicitly, never silently converted', () => {
  const result = evaluateRowEligibility(
    readyRow({ normalized: { invoice_number: 'INV-1', invoice_date: '2026-01-01', amount: '100.00', status: 'void' } })
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.UNSUPPORTED_STATUS_VALUE)
})

test('other known status values (draft/sent/paid/partial/overdue) are not blocked by the status check', () => {
  for (const status of ['draft', 'sent', 'paid', 'partial', 'overdue', null]) {
    const result = evaluateRowEligibility(
      readyRow({ normalized: { invoice_number: 'INV-1', invoice_date: '2026-01-01', amount: '100.00', status } })
    )
    assert.equal(result.eligible, true, `expected status=${status} to be eligible`)
  }
})

test('file-level rejected blocks persistence regardless of any row', () => {
  const result = evaluateFileEligibility({ outcome: 'rejected', fileIssues: [{ code: 'EMPTY_FILE' }], rows: [] })
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.FILE_LEVEL_REJECTED)
})

test('file-level rejected via non-empty fileIssues (outcome null) also blocks', () => {
  const result = evaluateFileEligibility({ outcome: null, fileIssues: [{ code: 'DUPLICATE_HEADER' }], rows: [] })
  assert.equal(result.eligible, false)
})

test('a normal per-row file passes the file-level gate', () => {
  const result = evaluateFileEligibility({ outcome: null, fileIssues: [], rows: [readyRow()] })
  assert.equal(result.eligible, true)
})

test('evaluateAllRows splits eligible/blocked correctly and short-circuits on file rejection', () => {
  const fileRejected = evaluateAllRows({ outcome: 'rejected', fileIssues: [{ code: 'EMPTY_FILE' }], rows: [readyRow()] })
  assert.equal(fileRejected.eligible.length, 0)
  assert.equal(fileRejected.blocked.length, 0)
  assert.ok(fileRejected.fileBlocked)

  const mixed = evaluateAllRows({
    outcome: null,
    fileIssues: [],
    rows: [
      readyRow(),
      readyRow({ outcome: 'review_required' }),
      readyRow({ outcome: 'ready_with_warnings', issues: [{ code: 'FORMULA_CACHED_VALUE_USED' }] }),
    ],
  })
  assert.equal(mixed.eligible.length, 2)
  assert.equal(mixed.blocked.length, 1)
  assert.equal(mixed.blocked[0].reasonCode, BLOCK_REASONS.REVIEW_REQUIRED)
  assert.equal(mixed.fileBlocked, null)
})
