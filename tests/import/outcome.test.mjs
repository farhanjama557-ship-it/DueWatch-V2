import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeOutcome, summarizeOutcomes, OUTCOMES } from '../../src/lib/import/outcome.js'
import { makeIssue, ISSUE_CODES } from '../../src/lib/import/issues.js'

function issue(overrides) {
  return makeIssue({ code: ISSUE_CODES.INVALID_AMOUNT, severity: 'error', message: 'x', ...overrides })
}

test('no issues -> ready', () => {
  assert.equal(computeOutcome([]), OUTCOMES.READY)
})

test('only nonblocking issues -> ready_with_warnings', () => {
  const issues = [issue({ code: ISSUE_CODES.PAID_WITHOUT_PAYMENT_DATE, severity: 'warning', blocksImport: false, requiresUserChoice: false })]
  assert.equal(computeOutcome(issues), OUTCOMES.READY_WITH_WARNINGS)
})

test('a blocking issue requiring a user choice -> review_required', () => {
  const issues = [issue({ code: ISSUE_CODES.AMBIGUOUS_DATE_FORMAT, severity: 'warning', blocksImport: true, requiresUserChoice: true })]
  assert.equal(computeOutcome(issues), OUTCOMES.REVIEW_REQUIRED)
})

test('a blocking issue with no user choice available -> rejected', () => {
  const issues = [issue({ code: ISSUE_CODES.INVALID_AMOUNT, severity: 'error', blocksImport: true, requiresUserChoice: false })]
  assert.equal(computeOutcome(issues), OUTCOMES.REJECTED)
})

test('rejected wins over a coexisting nonblocking warning', () => {
  const issues = [
    issue({ code: ISSUE_CODES.INVALID_AMOUNT, severity: 'error', blocksImport: true, requiresUserChoice: false }),
    issue({ code: ISSUE_CODES.PAID_WITHOUT_PAYMENT_DATE, severity: 'warning', blocksImport: false, requiresUserChoice: false }),
  ]
  assert.equal(computeOutcome(issues), OUTCOMES.REJECTED)
})

test('review_required wins over rejected when any blocking issue needs a choice', () => {
  const issues = [
    issue({ code: ISSUE_CODES.INVALID_AMOUNT, severity: 'error', blocksImport: true, requiresUserChoice: false }),
    issue({ code: ISSUE_CODES.DUPLICATE_IN_UPLOAD, severity: 'warning', blocksImport: true, requiresUserChoice: true }),
  ]
  assert.equal(computeOutcome(issues), OUTCOMES.REVIEW_REQUIRED)
})

test('summarizeOutcomes counts every bucket and total', () => {
  const rows = [{ outcome: 'ready' }, { outcome: 'ready' }, { outcome: 'ready_with_warnings' }, { outcome: 'review_required' }, { outcome: 'rejected' }]
  assert.deepEqual(summarizeOutcomes(rows), { ready: 2, ready_with_warnings: 1, review_required: 1, rejected: 1, total: 5 })
})
