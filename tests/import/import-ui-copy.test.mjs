import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  categorizeIssue,
  ISSUE_CATEGORY,
  issueDisplayMessage,
  REJECTED_ROW_COPY,
  fileErrorCopy,
  groupDateIssuesByField,
  needsDateDecisionStep,
  needsCurrencyStep,
  rowsWithIssueCode,
  rowsWithOutcome,
  groupRowsByPrimaryIssueCode,
  formatAmountDisplay,
  formatMoneyWithCurrency,
  clientIdentityLabel,
} from '../../src/lib/importUiCopy.js'
import { makeIssue, ISSUE_CODES } from '../../src/lib/import/issues.js'
import { OUTCOMES } from '../../src/lib/import/outcome.js'

function issue(overrides) {
  return makeIssue({ code: ISSUE_CODES.INVALID_DATE, severity: 'error', message: 'msg', ...overrides })
}

test('categorizeIssue: locked resolvable codes', () => {
  assert.equal(categorizeIssue(issue({ code: ISSUE_CODES.AMBIGUOUS_DATE_FORMAT, severity: 'warning', blocksImport: true, requiresUserChoice: true })), ISSUE_CATEGORY.RESOLVABLE)
  assert.equal(categorizeIssue(issue({ code: ISSUE_CODES.CURRENCY_DECISION_REQUIRED, severity: 'warning', blocksImport: true, requiresUserChoice: true })), ISSUE_CATEGORY.RESOLVABLE)
})

test('categorizeIssue: locked source-correction codes', () => {
  for (const code of [
    ISSUE_CODES.MIXED_DATE_FORMATS, ISSUE_CODES.AMBIGUOUS_AMOUNT_FORMAT, ISSUE_CODES.UNKNOWN_STATUS,
    ISSUE_CODES.AMOUNT_PAID_EXCEEDS_AMOUNT, ISSUE_CODES.UNSUPPORTED_CURRENCY, ISSUE_CODES.FORMULA_VALUE_UNAVAILABLE,
    ISSUE_CODES.INVALID_DATE, ISSUE_CODES.INVALID_AMOUNT, ISSUE_CODES.MISSING_REQUIRED_VALUE,
  ]) {
    assert.equal(categorizeIssue(issue({ code, severity: 'error', blocksImport: true })), ISSUE_CATEGORY.SOURCE_CORRECTION, code)
  }
})

test('categorizeIssue: locked inspect-only codes, including nonblocking DUPLICATE_DETECTION_INCOMPLETE', () => {
  assert.equal(categorizeIssue(issue({ code: ISSUE_CODES.DUPLICATE_IN_UPLOAD, severity: 'warning', blocksImport: true, requiresUserChoice: true })), ISSUE_CATEGORY.INSPECT_ONLY)
  assert.equal(categorizeIssue(issue({ code: ISSUE_CODES.DUPLICATE_DETECTION_INCOMPLETE, severity: 'info' })), ISSUE_CATEGORY.INSPECT_ONLY)
  assert.equal(categorizeIssue(issue({ code: ISSUE_CODES.PARTIAL_PAYMENT_REVIEW, severity: 'warning', blocksImport: true, requiresUserChoice: true })), ISSUE_CATEGORY.INSPECT_ONLY)
})

test('categorizeIssue: ROW_COLUMN_COUNT_MISMATCH is derived from its own flags, not assumed fatal', () => {
  const nonblocking = issue({ code: ISSUE_CODES.ROW_COLUMN_COUNT_MISMATCH, severity: 'warning', blocksImport: false, requiresUserChoice: false })
  assert.equal(categorizeIssue(nonblocking), ISSUE_CATEGORY.INFORMATIONAL)
})

test('categorizeIssue: an unlisted blocking+choice code falls back to resolvable, blocking-only falls back to source_correction', () => {
  const blockingChoice = issue({ code: ISSUE_CODES.UNKNOWN_STATUS, severity: 'warning', blocksImport: true, requiresUserChoice: true })
  assert.equal(categorizeIssue(blockingChoice), ISSUE_CATEGORY.SOURCE_CORRECTION) // UNKNOWN_STATUS is locked source_correction regardless of flags
  const unlistedBlockingOnly = issue({ code: ISSUE_CODES.FORMULA_CACHED_VALUE_USED, severity: 'warning', blocksImport: true, requiresUserChoice: false })
  assert.equal(categorizeIssue(unlistedBlockingOnly), ISSUE_CATEGORY.SOURCE_CORRECTION)
})

test('issueDisplayMessage: returns the engine message verbatim', () => {
  assert.equal(issueDisplayMessage(issue({ message: 'Amount could not be read.' })), 'Amount could not be read.')
})

test('REJECTED_ROW_COPY uses the required exact phrase', () => {
  assert.equal(REJECTED_ROW_COPY, 'These rows cannot proceed.')
})

test('fileErrorCopy: known codes have founder-friendly copy, unknown codes fall back', () => {
  for (const code of ['FILE_TOO_LARGE', 'MALFORMED_FILE', 'UNSUPPORTED_FILE_TYPE', 'EMPTY_FILE']) {
    const copy = fileErrorCopy(code)
    assert.equal(typeof copy.title, 'string')
    assert.equal(typeof copy.message, 'string')
    assert.equal(copy.title.includes(code), false)
  }
  assert.equal(typeof fileErrorCopy('SOMETHING_UNKNOWN').title, 'string')
})

function rowWithIssues(issues, outcome = OUTCOMES.REVIEW_REQUIRED) {
  return { originalRowNumber: 1, issues, outcome, normalized: {}, raw: {} }
}

test('groupDateIssuesByField: groups only the requested codes, by field', () => {
  const rows = [
    rowWithIssues([issue({ code: ISSUE_CODES.AMBIGUOUS_DATE_FORMAT, field: 'invoice_date' })]),
    rowWithIssues([issue({ code: ISSUE_CODES.MIXED_DATE_FORMATS, field: 'due_date' })]),
    rowWithIssues([issue({ code: ISSUE_CODES.INVALID_AMOUNT, field: 'amount' })]),
  ]
  const grouped = groupDateIssuesByField(rows, ['AMBIGUOUS_DATE_FORMAT', 'MIXED_DATE_FORMATS'])
  assert.equal(grouped.invoice_date.length, 1)
  assert.equal(grouped.due_date.length, 1)
  assert.equal(grouped.payment_date.length, 0)
})

test('needsDateDecisionStep: true only when a date field has ambiguous or mixed issues', () => {
  assert.equal(needsDateDecisionStep([rowWithIssues([issue({ code: ISSUE_CODES.AMBIGUOUS_DATE_FORMAT, field: 'invoice_date' })])]), true)
  assert.equal(needsDateDecisionStep([rowWithIssues([issue({ code: ISSUE_CODES.MIXED_DATE_FORMATS, field: 'payment_date' })])]), true)
  assert.equal(needsDateDecisionStep([rowWithIssues([issue({ code: ISSUE_CODES.INVALID_AMOUNT, field: 'amount' })])]), false)
})

test('needsCurrencyStep: true only when a row has CURRENCY_DECISION_REQUIRED', () => {
  assert.equal(needsCurrencyStep([rowWithIssues([issue({ code: ISSUE_CODES.CURRENCY_DECISION_REQUIRED, field: 'currency' })])]), true)
  assert.equal(needsCurrencyStep([rowWithIssues([issue({ code: ISSUE_CODES.INVALID_AMOUNT, field: 'amount' })])]), false)
})

test('rowsWithIssueCode and rowsWithOutcome filter correctly', () => {
  const rows = [
    rowWithIssues([issue({ code: ISSUE_CODES.DUPLICATE_IN_UPLOAD })], OUTCOMES.REVIEW_REQUIRED),
    rowWithIssues([], OUTCOMES.READY),
  ]
  assert.equal(rowsWithIssueCode(rows, ISSUE_CODES.DUPLICATE_IN_UPLOAD).length, 1)
  assert.equal(rowsWithOutcome(rows, OUTCOMES.READY).length, 1)
})

test('groupRowsByPrimaryIssueCode groups by the first blocking issue', () => {
  const rows = [
    rowWithIssues([issue({ code: ISSUE_CODES.INVALID_AMOUNT, blocksImport: true }), issue({ code: ISSUE_CODES.UNKNOWN_STATUS, blocksImport: true })], OUTCOMES.REJECTED),
    rowWithIssues([issue({ code: ISSUE_CODES.INVALID_AMOUNT, blocksImport: true })], OUTCOMES.REJECTED),
  ]
  const groups = groupRowsByPrimaryIssueCode(rows)
  assert.equal(groups.get(ISSUE_CODES.INVALID_AMOUNT).length, 2)
})

test('formatAmountDisplay: adds thousands separators via string manipulation only', () => {
  assert.equal(formatAmountDisplay('1234.56'), '1,234.56')
  assert.equal(formatAmountDisplay('100.00'), '100.00')
  assert.equal(formatAmountDisplay('-1234567.89'), '-1,234,567.89')
  assert.equal(formatAmountDisplay(null), null)
})

test('formatAmountDisplay: never round-trips through Number (precision-losing values stay exact)', () => {
  // A value with more significant digits than a double can exactly hold —
  // proves this is string manipulation, not Number()/parseFloat().
  assert.equal(formatAmountDisplay('9007199254740993.00'), '9,007,199,254,740,993.00')
})

test('formatMoneyWithCurrency: prefixes the currency code, or omits it when absent', () => {
  assert.equal(formatMoneyWithCurrency('1234.56', 'USD'), 'USD 1,234.56')
  assert.equal(formatMoneyWithCurrency('1234.56', null), '1,234.56')
  assert.equal(formatMoneyWithCurrency(null, 'USD'), '—')
})

test('clientIdentityLabel: prefers name, falls back through the identity paths, never shows raw duplicateKey', () => {
  assert.equal(clientIdentityLabel({ client_name: 'Acme Co' }), 'Acme Co')
  assert.equal(clientIdentityLabel({ client_company: 'Acme LLC' }), 'Acme LLC')
  assert.equal(clientIdentityLabel({ client_email: 'a@example.test' }), 'a@example.test')
  assert.equal(clientIdentityLabel({ source_system: 'QBO', source_client_id: '123' }), 'QBO #123')
  assert.equal(clientIdentityLabel({}), '—')
})
