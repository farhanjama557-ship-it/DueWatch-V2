import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeImportFile } from '../../src/lib/import/normalize.js'
import { row, sheet, formulaCell } from './helpers/rows.mjs'
import { ISSUE_CODES } from '../../src/lib/import/issues.js'
import { OUTCOMES } from '../../src/lib/import/outcome.js'
import { REQUIRED_KEYS_FOR_TEST } from './helpers/issue-keys.mjs'

const MAPPING = {
  0: 'client_name',
  1: 'client_email',
  2: 'client_company',
  3: 'invoice_number',
  4: 'invoice_date',
  5: 'due_date',
  6: 'amount',
  7: 'amount_paid',
  8: 'currency',
  9: 'status',
  10: 'payment_date',
  11: 'notes',
}

function dataRow(rowNumber, {
  client_name = 'Northbend Studio',
  client_email = 'billing@example.test',
  client_company = '',
  invoice_number = 'INV-1',
  invoice_date = '2026-01-05',
  due_date = '2026-02-05',
  amount = '1200.00',
  amount_paid = '',
  currency = 'USD',
  status = '',
  payment_date = '',
  notes = '',
} = {}) {
  return row(rowNumber, [client_name, client_email, client_company, invoice_number, invoice_date, due_date, amount, amount_paid, currency, status, payment_date, notes])
}

function oneRowResult(fields, options = {}) {
  const s = sheet('Sheet1', [row(1, Object.keys(MAPPING).map((i) => `header${i}`)), dataRow(2, fields)])
  const result = normalizeImportFile({ sheet: s, hasHeaderRow: true, mapping: MAPPING, ...options })
  return result.rows[0]
}

test('a clean row is ready with no issues', () => {
  const r = oneRowResult({})
  assert.equal(r.outcome, OUTCOMES.READY)
  assert.deepEqual(r.issues, [])
})

test('unpaid invoice: blank amount_paid is not treated as a payment', () => {
  const r = oneRowResult({ amount_paid: '' })
  assert.equal(r.normalized.amount_paid, null)
  assert.equal(r.payment_timing_known, false)
  assert.ok(!r.issues.some((i) => i.code === ISSUE_CODES.PAID_WITHOUT_PAYMENT_DATE))
  assert.equal(r.outcome, OUTCOMES.READY)
})

test('paid with payment date: fully-paid-by-amount, timing known, no warning', () => {
  const r = oneRowResult({ amount: '500.00', amount_paid: '500.00', payment_date: '2026-01-10' })
  assert.equal(r.payment_timing_known, true)
  assert.equal(r.outcome, OUTCOMES.READY)
})

test('paid without payment date: truthful warning, payment_timing_known is false, ready_with_warnings', () => {
  const r = oneRowResult({ amount: '500.00', amount_paid: '500.00', payment_date: '' })
  assert.equal(r.payment_timing_known, false)
  const issue = r.issues.find((i) => i.code === ISSUE_CODES.PAID_WITHOUT_PAYMENT_DATE)
  assert.ok(issue)
  assert.equal(issue.blocksImport, false)
  assert.equal(r.outcome, OUTCOMES.READY_WITH_WARNINGS)
})

test('partial payment is review_required, not silently accepted or rejected', () => {
  const r = oneRowResult({ amount: '500.00', amount_paid: '200.00' })
  const issue = r.issues.find((i) => i.code === ISSUE_CODES.PARTIAL_PAYMENT_REVIEW)
  assert.ok(issue)
  assert.equal(issue.requiresUserChoice, true)
  assert.equal(r.outcome, OUTCOMES.REVIEW_REQUIRED)
})

test('amount paid equal to amount: no partial-payment or exceeds issue', () => {
  const r = oneRowResult({ amount: '500.00', amount_paid: '500.00', payment_date: '2026-01-10' })
  assert.ok(!r.issues.some((i) => i.code === ISSUE_CODES.PARTIAL_PAYMENT_REVIEW))
  assert.ok(!r.issues.some((i) => i.code === ISSUE_CODES.AMOUNT_PAID_EXCEEDS_AMOUNT))
})

test('amount paid greater than amount is rejected, not review_required', () => {
  const r = oneRowResult({ amount: '500.00', amount_paid: '600.00' })
  const issue = r.issues.find((i) => i.code === ISSUE_CODES.AMOUNT_PAID_EXCEEDS_AMOUNT)
  assert.ok(issue)
  assert.equal(issue.requiresUserChoice, false)
  assert.equal(r.outcome, OUTCOMES.REJECTED)
})

test('zero or negative invoice amount is INVALID_AMOUNT, rejected', () => {
  assert.equal(oneRowResult({ amount: '0' }).outcome, OUTCOMES.REJECTED)
  assert.equal(oneRowResult({ amount: '-50.00' }).outcome, OUTCOMES.REJECTED)
})

test('negative amount_paid is INVALID_AMOUNT, rejected', () => {
  const r = oneRowResult({ amount_paid: '-10.00' })
  assert.ok(r.issues.some((i) => i.code === ISSUE_CODES.INVALID_AMOUNT && i.field === 'amount_paid'))
  assert.equal(r.outcome, OUTCOMES.REJECTED)
})

test('unknown status is review_required', () => {
  const r = oneRowResult({ status: 'archived' })
  const issue = r.issues.find((i) => i.code === ISSUE_CODES.UNKNOWN_STATUS)
  assert.ok(issue)
  assert.equal(r.outcome, OUTCOMES.REVIEW_REQUIRED)
})

test('blank currency before a file-level default is chosen: review_required, never silently USD', () => {
  const r = oneRowResult({ currency: '' })
  const issue = r.issues.find((i) => i.code === ISSUE_CODES.CURRENCY_DECISION_REQUIRED)
  assert.ok(issue)
  assert.equal(r.normalized.currency, null)
  assert.equal(r.outcome, OUTCOMES.REVIEW_REQUIRED)
})

test('blank currency after an explicit USD default: resolved, no issue', () => {
  const r = oneRowResult({ currency: '' }, { defaultCurrency: 'USD' })
  assert.equal(r.normalized.currency, 'USD')
  assert.ok(!r.issues.some((i) => i.code === ISSUE_CODES.CURRENCY_DECISION_REQUIRED))
  assert.equal(r.outcome, OUTCOMES.READY)
})

test('all six supported currencies pass through untouched', () => {
  for (const code of ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD']) {
    const r = oneRowResult({ currency: code })
    assert.equal(r.normalized.currency, code)
  }
})

test('unsupported/malformed nonblank currency is rejected, never coerced to USD', () => {
  const r = oneRowResult({ currency: 'ZZZ' })
  assert.equal(r.normalized.currency, null)
  assert.ok(r.issues.some((i) => i.code === ISSUE_CODES.UNSUPPORTED_CURRENCY))
  assert.equal(r.outcome, OUTCOMES.REJECTED)
})

test('missing required invoice_date value is MISSING_REQUIRED_VALUE, rejected', () => {
  const r = oneRowResult({ invoice_date: '' })
  assert.ok(r.issues.some((i) => i.code === ISSUE_CODES.MISSING_REQUIRED_VALUE && i.field === 'invoice_date'))
  assert.equal(r.outcome, OUTCOMES.REJECTED)
})

test('invalid required date is rejected', () => {
  const r = oneRowResult({ invoice_date: '02/30/2026' })
  assert.ok(r.issues.some((i) => i.code === ISSUE_CODES.INVALID_DATE))
  assert.equal(r.outcome, OUTCOMES.REJECTED)
})

test('file-level: missing required mapping rejects the whole file before any row is processed', () => {
  const s = sheet('Sheet1', [row(1, ['h1']), row(2, ['x'])])
  const result = normalizeImportFile({ sheet: s, hasHeaderRow: true, mapping: { 0: 'client_name' } })
  assert.equal(result.outcome, OUTCOMES.REJECTED)
  assert.equal(result.rows.length, 0)
  assert.ok(result.fileIssues.some((i) => i.code === ISSUE_CODES.MISSING_REQUIRED_MAPPING))
})

test('file-level: an empty sheet is EMPTY_FILE', () => {
  const result = normalizeImportFile({ sheet: sheet('S', []), hasHeaderRow: true, mapping: MAPPING })
  assert.equal(result.outcome, OUTCOMES.REJECTED)
  assert.ok(result.fileIssues.some((i) => i.code === ISSUE_CODES.EMPTY_FILE))
})

test('file-level: a header-only sheet is HEADERS_ONLY', () => {
  const s = sheet('S', [row(1, Object.keys(MAPPING).map((i) => `header${i}`))])
  const result = normalizeImportFile({ sheet: s, hasHeaderRow: true, mapping: MAPPING })
  assert.equal(result.outcome, OUTCOMES.REJECTED)
  assert.ok(result.fileIssues.some((i) => i.code === ISSUE_CODES.HEADERS_ONLY))
})

test('file-level: duplicate headers reject the file', () => {
  const headers = ['Client', 'Email', 'Company', 'Invoice #', 'Invoice Date', 'Due Date', 'Amount', 'Amount Paid', 'Currency', 'Status', 'Payment Date', 'Amount']
  const s = sheet('S', [row(1, headers), dataRow(2, {})])
  const result = normalizeImportFile({ sheet: s, hasHeaderRow: true, mapping: MAPPING })
  assert.equal(result.outcome, OUTCOMES.REJECTED)
  assert.ok(result.fileIssues.some((i) => i.code === ISSUE_CODES.DUPLICATE_HEADER))
})

test('file-level: every null field on a file-level issue still has all required keys present', () => {
  const result = normalizeImportFile({ sheet: sheet('S', []), hasHeaderRow: true, mapping: MAPPING })
  const issue = result.fileIssues[0]
  for (const key of REQUIRED_KEYS_FOR_TEST) assert.ok(Object.prototype.hasOwnProperty.call(issue, key))
  assert.equal(issue.rowNumber, null)
  assert.equal(issue.columnId, null)
  assert.equal(issue.field, null)
})

test('row limit: 10,000 data rows are accepted (no file-level rejection)', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const rows = [headerRow]
  for (let i = 0; i < 10000; i++) rows.push(dataRow(i + 2, { invoice_number: `INV-${i}` }))
  const result = normalizeImportFile({ sheet: sheet('S', rows), hasHeaderRow: true, mapping: MAPPING })
  assert.notEqual(result.outcome, OUTCOMES.REJECTED)
  assert.equal(result.rows.length, 10000)
})

test('row limit: 10,001 data rows are rejected outright, not truncated', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const rows = [headerRow]
  for (let i = 0; i < 10001; i++) rows.push(dataRow(i + 2, { invoice_number: `INV-${i}` }))
  const result = normalizeImportFile({ sheet: sheet('S', rows), hasHeaderRow: true, mapping: MAPPING })
  assert.equal(result.outcome, OUTCOMES.REJECTED)
  assert.equal(result.rows.length, 0, 'must reject outright, never truncate and continue')
  assert.ok(result.fileIssues.some((i) => i.code === ISSUE_CODES.ROW_LIMIT_EXCEEDED))
})

test('mixed date formats: unambiguous forced-opposite rows resolve fine; the ambiguous row is flagged MIXED_DATE_FORMATS', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const rows = [
    headerRow,
    dataRow(2, { invoice_number: 'A', invoice_date: '25/03/2025' }), // forced DMY
    dataRow(3, { invoice_number: 'B', invoice_date: '03/25/2025' }), // forced MDY
    dataRow(4, { invoice_number: 'C', invoice_date: '04/05/2025' }), // ambiguous
  ]
  const result = normalizeImportFile({ sheet: sheet('S', rows), hasHeaderRow: true, mapping: MAPPING })
  assert.equal(result.rows[0].normalized.invoice_date, '2025-03-25')
  assert.equal(result.rows[1].normalized.invoice_date, '2025-03-25')
  assert.ok(!result.rows[0].issues.some((i) => i.code === ISSUE_CODES.MIXED_DATE_FORMATS))
  const ambiguousIssue = result.rows[2].issues.find((i) => i.code === ISSUE_CODES.MIXED_DATE_FORMATS)
  assert.ok(ambiguousIssue)
  assert.equal(ambiguousIssue.requiresUserChoice, true)
  assert.equal(result.rows[2].outcome, OUTCOMES.REVIEW_REQUIRED)
})

test('an ambiguous date with no mixed-file evidence uses its own field\'s supplied convention', () => {
  const r = oneRowResult({ invoice_date: '04/05/2025' }, { dateConvention: { invoice_date: 'DMY' } })
  assert.equal(r.normalized.invoice_date, '2025-05-04')
  assert.ok(!r.issues.some((i) => i.code === ISSUE_CODES.AMBIGUOUS_DATE_FORMAT))
})

// ---- Correction 1: date decisions are per mapped date column ----

test('per-column dates: invoice_date MDY and due_date DMY both resolve correctly in the same row', () => {
  const r = oneRowResult(
    { invoice_date: '04/05/2025', due_date: '04/05/2025' },
    { dateConvention: { invoice_date: 'MDY', due_date: 'DMY' } }
  )
  assert.equal(r.normalized.invoice_date, '2025-04-05') // MDY: April 5
  assert.equal(r.normalized.due_date, '2025-05-04') // DMY: May 4
  assert.ok(!r.issues.some((i) => i.code === ISSUE_CODES.AMBIGUOUS_DATE_FORMAT))
})

test('per-column dates: conflicting conventions in different columns are allowed (not a mixed-format conflict)', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const rows = [
    headerRow,
    // invoice_date column has forced-MDY evidence (day=25 in position 2)
    dataRow(2, { invoice_number: 'A', invoice_date: '03/25/2025', due_date: '2026-01-01' }),
    // due_date column has forced-DMY evidence (day=25 in position 1) —
    // a DIFFERENT column, so this must not conflict with invoice_date's
    // own MDY evidence above.
    dataRow(3, { invoice_number: 'B', invoice_date: '2026-01-01', due_date: '25/03/2025' }),
  ]
  const result = normalizeImportFile({ sheet: sheet('S', rows), hasHeaderRow: true, mapping: MAPPING })
  assert.ok(!result.rows[0].issues.some((i) => i.code === ISSUE_CODES.MIXED_DATE_FORMATS))
  assert.ok(!result.rows[1].issues.some((i) => i.code === ISSUE_CODES.MIXED_DATE_FORMATS))
  assert.equal(result.rows[0].normalized.invoice_date, '2025-03-25')
  assert.equal(result.rows[1].normalized.due_date, '2025-03-25')
})

test('per-column dates: conflicting forced evidence WITHIN the same column produces MIXED_DATE_FORMATS scoped to that field/column', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const rows = [
    headerRow,
    dataRow(2, { invoice_number: 'A', invoice_date: '25/03/2025' }), // forces DMY in invoice_date
    dataRow(3, { invoice_number: 'B', invoice_date: '03/25/2025' }), // forces MDY in invoice_date — same column, conflicting
    dataRow(4, { invoice_number: 'C', invoice_date: '04/05/2025' }), // ambiguous in invoice_date
  ]
  const result = normalizeImportFile({ sheet: sheet('S', rows), hasHeaderRow: true, mapping: MAPPING })
  const issue = result.rows[2].issues.find((i) => i.code === ISSUE_CODES.MIXED_DATE_FORMATS)
  assert.ok(issue)
  assert.equal(issue.field, 'invoice_date')
  assert.equal(issue.columnId, 4)
  assert.equal(issue.rowNumber, result.rows[2].originalRowNumber)
})

test('per-column dates: an unresolved choice in one column does not block a different, resolved column', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const rows = [headerRow, dataRow(2, { invoice_date: '04/05/2025', due_date: '2026-02-01' })]
  // No dateConvention supplied at all -> invoice_date is ambiguous and
  // blocked, but due_date (a plain ISO date) must resolve untouched.
  const result = normalizeImportFile({ sheet: sheet('S', rows), hasHeaderRow: true, mapping: MAPPING })
  const r = result.rows[0]
  assert.ok(r.issues.some((i) => i.code === ISSUE_CODES.AMBIGUOUS_DATE_FORMAT && i.field === 'invoice_date'))
  assert.equal(r.normalized.due_date, '2026-02-01')
  assert.ok(!r.issues.some((i) => i.field === 'due_date'))
})

test('duplicate in upload: same client + invoice number flags both rows, review_required', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const rows = [headerRow, dataRow(2, { invoice_number: 'INV-DUP' }), dataRow(3, { invoice_number: 'INV-DUP' })]
  const result = normalizeImportFile({ sheet: sheet('S', rows), hasHeaderRow: true, mapping: MAPPING })
  assert.ok(result.rows[0].issues.some((i) => i.code === ISSUE_CODES.DUPLICATE_IN_UPLOAD))
  assert.ok(result.rows[1].issues.some((i) => i.code === ISSUE_CODES.DUPLICATE_IN_UPLOAD))
  assert.equal(result.rows[0].outcome, OUTCOMES.REVIEW_REQUIRED)
  assert.equal(result.rows[0].duplicateKey, result.rows[1].duplicateKey)
})

test('the same invoice number for two different clients is not flagged as a duplicate', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const rows = [
    headerRow,
    dataRow(2, { invoice_number: 'INV-SHARED', client_email: 'alice@example.test' }),
    dataRow(3, { invoice_number: 'INV-SHARED', client_email: 'bob@example.test' }),
  ]
  const result = normalizeImportFile({ sheet: sheet('S', rows), hasHeaderRow: true, mapping: MAPPING })
  assert.ok(!result.rows[0].issues.some((i) => i.code === ISSUE_CODES.DUPLICATE_IN_UPLOAD))
  assert.ok(!result.rows[1].issues.some((i) => i.code === ISSUE_CODES.DUPLICATE_IN_UPLOAD))
})

test('no reliable client identity: duplicate detection is marked incomplete, key stays null, not blocking', () => {
  const mappingNoEmail = { ...MAPPING }
  delete mappingNoEmail[1] // drop client_email mapping
  delete mappingNoEmail[2] // drop client_company mapping
  const s = sheet('S', [row(1, Object.keys(MAPPING).map((i) => `header${i}`)), dataRow(2, {})])
  const result = normalizeImportFile({ sheet: s, hasHeaderRow: true, mapping: mappingNoEmail })
  const r = result.rows[0]
  assert.equal(r.duplicateKey, null)
  const issue = r.issues.find((i) => i.code === ISSUE_CODES.DUPLICATE_DETECTION_INCOMPLETE)
  assert.ok(issue)
  assert.equal(issue.blocksImport, false)
})

test('formula value unavailable in a required mapped field blocks the row (rejected)', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const dRow = dataRow(2, {})
  dRow.cells[6] = formulaCell('SUM(A1:A2)', undefined) // amount column, no cached result
  const result = normalizeImportFile({ sheet: sheet('S', [headerRow, dRow]), hasHeaderRow: true, mapping: MAPPING })
  const r = result.rows[0]
  assert.ok(r.issues.some((i) => i.code === ISSUE_CODES.FORMULA_VALUE_UNAVAILABLE && i.blocksImport === true))
  assert.ok(!r.issues.some((i) => i.code === ISSUE_CODES.MISSING_REQUIRED_VALUE && i.field === 'amount'), 'must not double-issue the same blank cell')
  assert.equal(r.outcome, OUTCOMES.REJECTED)
})

test('formula value unavailable in an optional field is a nonblocking warning', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const dRow = dataRow(2, {})
  dRow.cells[11] = formulaCell('CONCAT(A1,A2)', undefined) // notes column, optional
  const result = normalizeImportFile({ sheet: sheet('S', [headerRow, dRow]), hasHeaderRow: true, mapping: MAPPING })
  const r = result.rows[0]
  const issue = r.issues.find((i) => i.code === ISSUE_CODES.FORMULA_VALUE_UNAVAILABLE)
  assert.ok(issue)
  assert.equal(issue.blocksImport, false)
  assert.equal(r.outcome, OUTCOMES.READY_WITH_WARNINGS)
})

test('formula cached value used (including a cached zero) is a nonblocking warning that preserves the formula in the issue', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const dRow = dataRow(2, { amount_paid: '' })
  dRow.cells[7] = formulaCell('SUM(0,0)', 0) // amount_paid column, cached zero
  const result = normalizeImportFile({ sheet: sheet('S', [headerRow, dRow]), hasHeaderRow: true, mapping: MAPPING })
  const r = result.rows[0]
  const issue = r.issues.find((i) => i.code === ISSUE_CODES.FORMULA_CACHED_VALUE_USED)
  assert.ok(issue)
  assert.equal(issue.rawValue, '=SUM(0,0)')
  assert.equal(r.normalized.amount_paid, '0.00')
  assert.equal(r.outcome, OUTCOMES.READY_WITH_WARNINGS)
})

test('ROW_COLUMN_COUNT_MISMATCH is nonblocking when the shortfall only affects an optional trailing column', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const dRow = dataRow(2, {})
  dRow.cells = dRow.cells.slice(0, -1) // drop the trailing "notes" cell entirely
  const result = normalizeImportFile({ sheet: sheet('S', [headerRow, dRow]), hasHeaderRow: true, mapping: MAPPING })
  const r = result.rows[0]
  const issue = r.issues.find((i) => i.code === ISSUE_CODES.ROW_COLUMN_COUNT_MISMATCH)
  assert.ok(issue)
  assert.equal(issue.blocksImport, false)
  assert.equal(r.outcome, OUTCOMES.READY_WITH_WARNINGS, 'a nonblocking issue still means the row is not issue-free')
})

test('row metadata: original row number, source sheet, raw/normalized records, mapping snapshot', () => {
  const r = oneRowResult({})
  assert.equal(r.originalRowNumber, 2)
  assert.equal(r.sourceSheet, 'Sheet1')
  assert.equal(r.raw.client_name, 'Northbend Studio')
  assert.equal(r.normalized.client_name, 'Northbend Studio')
  assert.equal(r.normalized.amount, '1200.00')
  assert.equal(r.mapping, MAPPING)
})

test('all four preview outcomes are reachable and correctly labeled', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const rows = [
    headerRow,
    dataRow(2, { invoice_number: 'INV-A' }), // ready
    dataRow(3, { invoice_number: 'INV-B', amount: '500.00', amount_paid: '500.00' }), // ready_with_warnings (paid, no payment date)
    dataRow(4, { invoice_number: 'INV-C', currency: '' }), // review_required (currency decision)
    dataRow(5, { invoice_number: 'INV-D', amount: '-10.00' }), // rejected
  ]
  const result = normalizeImportFile({ sheet: sheet('S', rows), hasHeaderRow: true, mapping: MAPPING })
  assert.deepEqual(result.rows.map((r) => r.outcome), [
    OUTCOMES.READY,
    OUTCOMES.READY_WITH_WARNINGS,
    OUTCOMES.REVIEW_REQUIRED,
    OUTCOMES.REJECTED,
  ])
  assert.deepEqual(result.summary, { ready: 1, ready_with_warnings: 1, review_required: 1, rejected: 1, total: 4 })
})

test('running the same file twice produces identical, deterministic results', () => {
  const headerRow = row(1, Object.keys(MAPPING).map((i) => `header${i}`))
  const rows = [headerRow, dataRow(2, {}), dataRow(3, { amount: '500.00', amount_paid: '200.00' })]
  const options = { sheet: sheet('S', rows), hasHeaderRow: true, mapping: MAPPING }
  const first = normalizeImportFile(options)
  const second = normalizeImportFile({ sheet: sheet('S', rows), hasHeaderRow: true, mapping: MAPPING })
  assert.deepEqual(first, second)
})

// ---- Correction 3: client identity is a one-of rule, not a single required field ----

const IDENTITY_MAPPING = {
  0: 'client_name',
  1: 'client_company',
  2: 'client_email',
  3: 'client_phone',
  4: 'source_system',
  5: 'source_client_id',
  6: 'invoice_number',
  7: 'invoice_date',
  8: 'amount',
}

function identityRowResult({
  client_name = '',
  client_company = '',
  client_email = '',
  client_phone = '',
  source_system = '',
  source_client_id = '',
  invoice_number = 'INV-1',
  invoice_date = '2026-01-05',
  amount = '100.00',
} = {}) {
  const headerRow = row(1, Object.keys(IDENTITY_MAPPING).map((i) => `header${i}`))
  const dRow = row(2, [client_name, client_company, client_email, client_phone, source_system, source_client_id, invoice_number, invoice_date, amount])
  // No currency column is mapped here — supply a file-level default so
  // these tests isolate client-identity behavior from the (already
  // separately tested) currency-decision requirement.
  const result = normalizeImportFile({ sheet: sheet('S', [headerRow, dRow]), hasHeaderRow: true, mapping: IDENTITY_MAPPING, defaultCurrency: 'USD' })
  return result.rows[0]
}

function hasIdentityMissingIssue(r) {
  return r.issues.some((i) => i.code === ISSUE_CODES.MISSING_REQUIRED_VALUE && i.message.includes('client identity'))
}

test('client identity: name-only is a usable identity (not rejected for missing identity)', () => {
  const r = identityRowResult({ client_name: 'Northbend Studio' })
  assert.ok(!hasIdentityMissingIssue(r))
  assert.notEqual(r.outcome, OUTCOMES.REJECTED)
})

test('client identity: company-only is a usable identity (a company-only export may proceed)', () => {
  const r = identityRowResult({ client_company: 'Northbend Studio LLC' })
  assert.ok(!hasIdentityMissingIssue(r))
  assert.notEqual(r.outcome, OUTCOMES.REJECTED)
})

test('client identity: email-only is a usable identity and is also a reliable duplicate key, so the row is fully ready', () => {
  const r = identityRowResult({ client_email: 'billing@example.test' })
  assert.ok(!hasIdentityMissingIssue(r))
  assert.equal(r.outcome, OUTCOMES.READY)
})

test('client identity: source_system + source_client_id is a usable identity', () => {
  const r = identityRowResult({ source_system: 'QuickBooks', source_client_id: 'QB-42' })
  assert.ok(!hasIdentityMissingIssue(r))
  assert.equal(r.outcome, OUTCOMES.READY)
})

test('client identity: source_client_id WITHOUT source_system is not usable, rejected', () => {
  const r = identityRowResult({ source_client_id: 'QB-42' })
  assert.ok(hasIdentityMissingIssue(r))
  assert.equal(r.outcome, OUTCOMES.REJECTED)
})

test('client identity: phone alone is never sufficient, rejected', () => {
  const r = identityRowResult({ client_phone: '+1 212 555 0100' })
  assert.ok(hasIdentityMissingIssue(r))
  assert.equal(r.outcome, OUTCOMES.REJECTED)
})

test('client identity: phone + company is accepted', () => {
  const r = identityRowResult({ client_phone: '+1 212 555 0100', client_company: 'Northbend Studio LLC' })
  assert.ok(!hasIdentityMissingIssue(r))
  assert.notEqual(r.outcome, OUTCOMES.REJECTED)
})

test('client identity: no identity value at all is rejected with the existing MISSING_REQUIRED_VALUE code (no new code invented)', () => {
  const r = identityRowResult({})
  const issue = r.issues.find((i) => hasIdentityMissingIssue({ issues: [i] }))
  assert.ok(issue)
  assert.equal(issue.code, ISSUE_CODES.MISSING_REQUIRED_VALUE)
  assert.equal(r.outcome, OUTCOMES.REJECTED)
})

test('client identity: a file whose mapping has no identity-capable column at all is rejected at the file level with MISSING_REQUIRED_MAPPING', () => {
  const noIdentityMapping = { 0: 'invoice_number', 1: 'invoice_date', 2: 'amount' }
  const s = sheet('S', [row(1, ['a', 'b', 'c']), row(2, ['INV-1', '2026-01-05', '100.00'])])
  const result = normalizeImportFile({ sheet: s, hasHeaderRow: true, mapping: noIdentityMapping })
  assert.equal(result.outcome, OUTCOMES.REJECTED)
  assert.ok(result.fileIssues.some((i) => i.code === ISSUE_CODES.MISSING_REQUIRED_MAPPING && i.message.includes('client identity')))
})
