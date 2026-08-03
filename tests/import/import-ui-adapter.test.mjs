import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseUpload,
  describeSheet,
  buildSheetView,
  createInitialMapping,
  validateMapping,
  invalidateDateDecisions,
  normalizeParsedUpload,
} from '../../src/lib/importUiAdapter.js'
import { normalizeImportFile } from '../../src/lib/import/normalize.js'
import { ISSUE_CODES } from '../../src/lib/import/issues.js'
import { OUTCOMES } from '../../src/lib/import/outcome.js'
import { csvFile, xlsxFile, bytesFile } from './helpers/files.mjs'
import { cell, row, sheet } from './helpers/rows.mjs'

const HEADERS = ['Client', 'Email', 'Invoice #', 'Invoice Date', 'Amount']
const FULL_MAPPING = { 0: 'client_name', 1: 'client_email', 2: 'invoice_number', 3: 'invoice_date', 4: 'amount' }

function csvWithNoCurrencyColumn() {
  return csvFile('Client,Email,Invoice #,Invoice Date,Amount\nAcme Co,a@example.test,INV-1,2026-01-05,100.00\n')
}

// 1. successful CSV parsing result shape
test('parseUpload: successful CSV parse returns { ok: true, parsed: { sheets, dateSystem }, error: null }', async () => {
  const result = await parseUpload(csvWithNoCurrencyColumn())
  assert.equal(result.ok, true)
  assert.equal(result.error, null)
  assert.equal(Array.isArray(result.parsed.sheets), true)
  assert.equal(result.parsed.sheets.length, 1)
  assert.equal(result.parsed.dateSystem, '1900')
})

// 2. unsupported extension preserves UNSUPPORTED_FILE_TYPE
test('parseUpload: unsupported extension preserves UNSUPPORTED_FILE_TYPE and is not built via makeIssue', async () => {
  const result = await parseUpload(bytesFile(new Uint8Array([1, 2, 3]), 'ledger.txt'))
  assert.equal(result.ok, false)
  assert.equal(result.parsed, null)
  assert.equal(result.error.code, 'UNSUPPORTED_FILE_TYPE')
  assert.equal(typeof result.error.message, 'string')
})

// 3. malformed-file errors preserve their code/message
test('parseUpload: a corrupt XLSX preserves MALFORMED_FILE code and message', async () => {
  const result = await parseUpload(bytesFile(new Uint8Array([1, 2, 3, 4]), 'corrupt.xlsx'))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'MALFORMED_FILE')
  assert.equal(result.error.message.includes('Could not read that Excel file'), true)
})

// 4. empty parsed workbook becomes EMPTY_FILE
test('parseUpload: an empty CSV (zero nonblank sheets) becomes EMPTY_FILE', async () => {
  const result = await parseUpload(csvFile(''))
  assert.equal(result.ok, false)
  assert.equal(result.parsed, null)
  assert.equal(result.error.code, 'EMPTY_FILE')
})

// 5. sheet metadata uses the widest row for column count
test('describeSheet: columnCount uses the widest row, not just the first row', () => {
  const s = sheet('Sheet1', [
    row(1, [cell('a'), cell('b')]),
    row(2, [cell('c'), cell('d'), cell('e'), cell('f')]),
  ])
  const desc = describeSheet(s)
  assert.deepEqual(desc, { name: 'Sheet1', rowCount: 2, columnCount: 4 })
})

// 6. header-row mode returns first-row headers and remaining data rows
test('buildSheetView: hasHeaderRow=true takes headers from row 1 and data from the rest', () => {
  const s = sheet('Sheet1', [
    row(1, [cell('Client'), cell('Amount')]),
    row(2, [cell('Acme'), cell('100')]),
    row(3, [cell('Beta'), cell('200')]),
  ])
  const view = buildSheetView(s, true)
  assert.deepEqual(view.headers, ['Client', 'Amount'])
  assert.equal(view.dataRows.length, 2)
  assert.equal(view.dataRows[0].rowNumber, 2)
  assert.deepEqual(view.sampleRows[0], ['Acme', '100'])
})

// 7. no-header mode generates synthetic headers and keeps all rows
test('buildSheetView: hasHeaderRow=false synthesizes Column N headers and keeps every row as data', () => {
  const s = sheet('Sheet1', [
    row(1, [cell('Acme'), cell('100')]),
    row(2, [cell('Beta'), cell('200')]),
  ])
  const view = buildSheetView(s, false)
  assert.deepEqual(view.headers, ['Column 1', 'Column 2'])
  assert.equal(view.dataRows.length, 2)
  assert.equal(view.dataRows[0].rowNumber, 1)
})

// buildSheetView must not mutate the source sheet
test('buildSheetView: sample rows do not mutate the original parsed cells', () => {
  const originalCell = cell('Acme')
  const s = sheet('Sheet1', [row(1, [cell('Client')]), row(2, [originalCell])])
  buildSheetView(s, true)
  assert.equal(originalCell.raw, 'Acme')
})

// 8. mapping stays { [columnIndex]: fieldKey }
test('createInitialMapping: returns the canonical { [sourceColumnIndex]: duewatchField } shape', () => {
  const mapping = createInitialMapping(HEADERS)
  assert.equal(mapping[2], 'invoice_number')
  assert.equal(mapping[3], 'invoice_date')
  assert.equal(mapping[4], 'amount')
  for (const [key, value] of Object.entries(mapping)) {
    assert.equal(Number.isInteger(Number(key)), true)
    assert.equal(typeof value, 'string')
  }
})

// 9. required-field mapping validation
test('validateMapping: reports every missing required field', () => {
  const result = validateMapping({ 0: 'client_email' })
  assert.deepEqual(
    result.missingRequiredFields.sort(),
    ['amount', 'invoice_date', 'invoice_number'].sort()
  )
  assert.equal(result.valid, false)
})

// 10. client-identity one-of mapping validation
test('validateMapping: client identity is satisfied by any one-of path, not required individually', () => {
  const withoutIdentity = validateMapping({ 0: 'invoice_number', 1: 'invoice_date', 2: 'amount' })
  assert.equal(withoutIdentity.clientIdentityMissing, true)

  const withEmail = validateMapping({ 0: 'invoice_number', 1: 'invoice_date', 2: 'amount', 3: 'client_email' })
  assert.equal(withEmail.clientIdentityMissing, false)

  const phoneAlone = validateMapping({ 0: 'invoice_number', 1: 'invoice_date', 2: 'amount', 3: 'client_phone' })
  assert.equal(phoneAlone.clientIdentityMissing, true, 'phone alone is never sufficient')

  const phoneWithName = validateMapping({
    0: 'invoice_number', 1: 'invoice_date', 2: 'amount', 3: 'client_phone', 4: 'client_name',
  })
  assert.equal(phoneWithName.clientIdentityMissing, false)
})

// 11. duplicate target-field detection
test('validateMapping: detects two source columns mapped to the same target field', () => {
  const result = validateMapping({ 0: 'invoice_number', 1: 'invoice_date', 2: 'amount', 3: 'client_email', 4: 'client_email' })
  assert.deepEqual(result.duplicateTargetFields, ['client_email'])
  assert.equal(result.valid, false)
})

// 12. changing invoice_date mapping invalidates only its date decision
test('invalidateDateDecisions: remapping invoice_date drops only invoice_date, keeps due_date', () => {
  const previous = { 0: 'invoice_date', 1: 'due_date' }
  const next = { 0: 'client_name', 1: 'due_date', 2: 'invoice_date' }
  const decisions = { invoice_date: 'MDY', due_date: 'DMY' }
  const result = invalidateDateDecisions(previous, next, decisions)
  assert.deepEqual(result, { due_date: 'DMY' })
})

// 13. unrelated mapping changes preserve all date decisions
test('invalidateDateDecisions: a non-date field mapping change preserves every date decision', () => {
  const previous = { 0: 'client_name', 1: 'invoice_date', 2: 'due_date' }
  const next = { 0: 'client_email', 1: 'invoice_date', 2: 'due_date' }
  const decisions = { invoice_date: 'MDY', due_date: 'DMY' }
  const result = invalidateDateDecisions(previous, next, decisions)
  assert.deepEqual(result, { invoice_date: 'MDY', due_date: 'DMY' })
})

// 14. unmapping a date field invalidates its decision
test('invalidateDateDecisions: unmapping due_date entirely drops its decision', () => {
  const previous = { 0: 'invoice_date', 1: 'due_date' }
  const next = { 0: 'invoice_date' }
  const decisions = { invoice_date: 'MDY', due_date: 'DMY' }
  const result = invalidateDateDecisions(previous, next, decisions)
  assert.deepEqual(result, { invoice_date: 'MDY' })
})

test('invalidateDateDecisions: never mutates its input objects', () => {
  const previous = { 0: 'invoice_date' }
  const next = {}
  const decisions = { invoice_date: 'MDY' }
  invalidateDateDecisions(previous, next, decisions)
  assert.deepEqual(previous, { 0: 'invoice_date' })
  assert.deepEqual(next, {})
  assert.deepEqual(decisions, { invoice_date: 'MDY' })
})

// 15. unconfirmed selected USD is passed as null
test('normalizeParsedUpload: an unconfirmed selected currency is passed to the engine as null', async () => {
  const { parsed } = await parseUpload(csvWithNoCurrencyColumn())
  const result = normalizeParsedUpload({
    parsed,
    mapping: FULL_MAPPING,
    selectedDefaultCurrency: 'USD',
    defaultCurrencyConfirmed: false,
  })
  assert.equal(result.rows[0].normalized.currency, null)
  assert.equal(result.rows[0].issues.some((i) => i.code === ISSUE_CODES.CURRENCY_DECISION_REQUIRED), true)
})

// 16. confirmed USD is passed as 'USD'
test('normalizeParsedUpload: a confirmed selected currency is passed to the engine and applied', async () => {
  const { parsed } = await parseUpload(csvWithNoCurrencyColumn())
  const result = normalizeParsedUpload({
    parsed,
    mapping: FULL_MAPPING,
    selectedDefaultCurrency: 'USD',
    defaultCurrencyConfirmed: true,
  })
  assert.equal(result.rows[0].normalized.currency, 'USD')
  assert.equal(result.rows[0].issues.some((i) => i.code === ISSUE_CODES.CURRENCY_DECISION_REQUIRED), false)
})

// 17. normalization uses the cached parsed sheet (never re-reads the File)
test('normalizeParsedUpload: works from the cached parsed sheet alone, without ever touching the File again', async () => {
  let file = csvWithNoCurrencyColumn()
  const { parsed } = await parseUpload(file)
  // Prove normalizeParsedUpload cannot have re-read the file: it is no
  // longer referenced anywhere in the call below, and the function's
  // signature never accepts a file argument in the first place.
  file = null
  const first = normalizeParsedUpload({ parsed, mapping: FULL_MAPPING, defaultCurrencyConfirmed: true, selectedDefaultCurrency: 'USD' })
  const second = normalizeParsedUpload({ parsed, mapping: FULL_MAPPING, defaultCurrencyConfirmed: true, selectedDefaultCurrency: 'USD' })
  assert.equal(first.rows.length, 1)
  assert.deepEqual(first.rows[0].normalized, second.rows[0].normalized)
})

// 18. normalized engine outcomes/issues are returned unchanged
test('normalizeParsedUpload: returns normalizeImportFile\'s result unchanged, field for field', async () => {
  const { parsed } = await parseUpload(csvWithNoCurrencyColumn())
  const viaAdapter = normalizeParsedUpload({
    parsed,
    mapping: FULL_MAPPING,
    defaultCurrencyConfirmed: true,
    selectedDefaultCurrency: 'USD',
  })
  const viaEngineDirect = normalizeImportFile({
    sheet: parsed.sheets[0],
    hasHeaderRow: true,
    mapping: FULL_MAPPING,
    dateSystem: parsed.dateSystem,
    dateConvention: {},
    defaultCurrency: 'USD',
  })
  assert.deepEqual(viaAdapter, viaEngineDirect)
  assert.equal(viaAdapter.rows[0].outcome, OUTCOMES.READY)
})

// sheetIndex bounds-checking
test('normalizeParsedUpload: throws a deterministic error for an out-of-bounds sheetIndex', async () => {
  const { parsed } = await parseUpload(csvWithNoCurrencyColumn())
  assert.throws(() => normalizeParsedUpload({ parsed, sheetIndex: 5, mapping: FULL_MAPPING }), /sheetIndex 5 is out of bounds/)
})

test('normalizeParsedUpload: throws when called without a parsed upload', () => {
  assert.throws(() => normalizeParsedUpload({ mapping: FULL_MAPPING }), /call parseUpload first/)
})

// Multi-sheet XLSX sanity check for describeSheet/buildSheetView together
test('multi-sheet XLSX: every nonempty sheet is described and viewable', async () => {
  const file = await xlsxFile((wb) => {
    const ws1 = wb.addWorksheet('January')
    ws1.addRow(HEADERS)
    ws1.addRow(['Acme Co', 'a@example.test', 'INV-1', '2026-01-05', 100])
    const ws2 = wb.addWorksheet('February')
    ws2.addRow(HEADERS)
    ws2.addRow(['Beta Co', 'b@example.test', 'INV-2', '2026-02-05', 200])
  })
  const { ok, parsed } = await parseUpload(file)
  assert.equal(ok, true)
  assert.equal(parsed.sheets.length, 2)
  const descriptions = parsed.sheets.map(describeSheet)
  assert.deepEqual(descriptions.map((d) => d.name), ['January', 'February'])
  const view = buildSheetView(parsed.sheets[1], true)
  assert.deepEqual(view.headers, HEADERS)
  assert.equal(view.dataRows.length, 1)
})
