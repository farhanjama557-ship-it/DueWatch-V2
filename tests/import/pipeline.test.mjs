import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runImportPipeline } from '../../src/lib/import/pipeline.js'
import { ISSUE_CODES } from '../../src/lib/import/issues.js'
import { OUTCOMES } from '../../src/lib/import/outcome.js'
import { FILE_SIZE_LIMIT_BYTES } from '../../src/lib/import/limits.js'
import { csvFile, xlsxFile, bytesFile } from './helpers/files.mjs'

const HEADERS = ['Client', 'Email', 'Invoice #', 'Invoice Date', 'Amount']
const MAPPING = { 0: 'client_name', 1: 'client_email', 2: 'invoice_number', 3: 'invoice_date', 4: 'amount' }
// These fixtures don't map a currency column, so a file-level default is
// required for the row to resolve to `ready` (never silently assumed USD).
const OPTIONS = { mapping: MAPPING, defaultCurrency: 'USD' }

test('end-to-end: clean CSV through the full pipeline is ready', async () => {
  const file = csvFile('Client,Email,Invoice #,Invoice Date,Amount\nAshford Legal Partners,ap@example.test,INV-100,2026-01-05,2500.00\n')
  const result = await runImportPipeline(file, OPTIONS)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].outcome, OUTCOMES.READY)
  assert.equal(result.rows[0].normalized.amount, '2500.00')
})

test('end-to-end: clean XLSX through the full pipeline is ready', async () => {
  const file = await xlsxFile((wb) => {
    const ws = wb.addWorksheet('Invoices')
    ws.addRow(HEADERS)
    ws.addRow(['Silverline Media Group', 'billing@example.test', 'INV-200', '2026-02-01', 900])
  })
  const result = await runImportPipeline(file, OPTIONS)
  assert.equal(result.rows[0].outcome, OUTCOMES.READY)
})

test('end-to-end: empty file is rejected with EMPTY_FILE', async () => {
  const result = await runImportPipeline(csvFile(''), { mapping: MAPPING })
  assert.equal(result.outcome, OUTCOMES.REJECTED)
  assert.ok(result.fileIssues.some((i) => i.code === ISSUE_CODES.EMPTY_FILE))
})

test('end-to-end: a file over the 5 MiB limit is rejected with FILE_TOO_LARGE before parsing', async () => {
  const bytes = new Uint8Array(FILE_SIZE_LIMIT_BYTES + 1).fill('a'.charCodeAt(0))
  const result = await runImportPipeline(bytesFile(bytes, 'big.csv'), { mapping: MAPPING })
  assert.equal(result.outcome, OUTCOMES.REJECTED)
  assert.ok(result.fileIssues.some((i) => i.code === ISSUE_CODES.FILE_TOO_LARGE))
})

test('end-to-end: a corrupt XLSX is rejected with MALFORMED_FILE, not an uncaught exception', async () => {
  const result = await runImportPipeline(bytesFile(new Uint8Array([1, 2, 3, 4]), 'corrupt.xlsx'), { mapping: MAPPING })
  assert.equal(result.outcome, OUTCOMES.REJECTED)
  assert.ok(result.fileIssues.some((i) => i.code === ISSUE_CODES.MALFORMED_FILE))
})

test('end-to-end: multiple usable sheets are surfaced for explicit selection', async () => {
  const file = await xlsxFile((wb) => {
    const ws1 = wb.addWorksheet('January')
    ws1.addRow(HEADERS)
    ws1.addRow(['Acme Co', 'a@example.test', 'INV-1', '2026-01-05', 100])
    const ws2 = wb.addWorksheet('February')
    ws2.addRow(HEADERS)
    ws2.addRow(['Beta Co', 'b@example.test', 'INV-2', '2026-02-05', 200])
  })
  const result = await runImportPipeline(file, { mapping: MAPPING, sheetIndex: 1 })
  assert.deepEqual(result.sheets.map((s) => s.name), ['January', 'February'])
  assert.equal(result.rows[0].raw.client_name, 'Beta Co')
})

test('end-to-end: 10,001 rows in a real CSV file are rejected without truncation', async () => {
  const lines = ['Client,Email,Invoice #,Invoice Date,Amount']
  for (let i = 0; i < 10001; i++) lines.push(`Client ${i},c${i}@example.test,INV-${i},2026-01-05,100.00`)
  const result = await runImportPipeline(csvFile(lines.join('\n') + '\n'), { mapping: MAPPING })
  assert.equal(result.outcome, OUTCOMES.REJECTED)
  assert.equal(result.rows.length, 0)
  assert.ok(result.fileIssues.some((i) => i.code === ISSUE_CODES.ROW_LIMIT_EXCEEDED))
})

test('running the pipeline twice on the same file produces the same outcome and normalized values', async () => {
  const csv = 'Client,Email,Invoice #,Invoice Date,Amount\nAcme,a@example.test,INV-1,2026-01-05,100.00\n'
  const resultA = await runImportPipeline(csvFile(csv), { mapping: MAPPING })
  const resultB = await runImportPipeline(csvFile(csv), { mapping: MAPPING })
  assert.deepEqual(resultA.rows[0].normalized, resultB.rows[0].normalized)
  assert.equal(resultA.rows[0].outcome, resultB.rows[0].outcome)
})
