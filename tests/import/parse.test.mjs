import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseImportFile } from '../../src/lib/import/parse.js'
import { FILE_SIZE_LIMIT_BYTES } from '../../src/lib/import/limits.js'
import { csvFile, xlsxFile, bytesFile } from './helpers/files.mjs'

test('clean CSV parses into one sheet with true 1-based row numbers', async () => {
  const file = csvFile('Client,Invoice #,Amount\nNorthbend Studio,INV-1,1200.00\n')
  const { sheets } = await parseImportFile(file)
  assert.equal(sheets.length, 1)
  assert.equal(sheets[0].rows.length, 2)
  assert.equal(sheets[0].rows[0].rowNumber, 1)
  assert.equal(sheets[0].rows[1].rowNumber, 2)
  assert.equal(sheets[0].rows[1].cells[0].raw, 'Northbend Studio')
})

test('clean XLSX parses into one sheet', async () => {
  const file = await xlsxFile((wb) => {
    const ws = wb.addWorksheet('Invoices')
    ws.addRow(['Client', 'Invoice #', 'Amount'])
    ws.addRow(['Silverline Media', 'INV-2', 850])
  })
  const { sheets } = await parseImportFile(file)
  assert.equal(sheets.length, 1)
  assert.equal(sheets[0].name, 'Invoices')
  assert.equal(sheets[0].rows.length, 2)
  assert.equal(sheets[0].rows[1].cells[0].raw, 'Silverline Media')
  assert.equal(sheets[0].rows[1].cells[2].raw, 850)
})

test('empty file yields zero sheets', async () => {
  const file = csvFile('')
  const { sheets } = await parseImportFile(file)
  assert.equal(sheets.length, 0)
})

test('a file of only blank lines yields zero sheets, same as truly empty', async () => {
  const file = csvFile('\n\n\n')
  const { sheets } = await parseImportFile(file)
  assert.equal(sheets.length, 0)
})

test('headers-only CSV yields one sheet with exactly one row', async () => {
  const file = csvFile('Client,Invoice #,Amount\n')
  const { sheets } = await parseImportFile(file)
  assert.equal(sheets.length, 1)
  assert.equal(sheets[0].rows.length, 1)
})

test('ragged rows keep their own true length — never silently padded to a shared width', async () => {
  const file = csvFile('A,B,C\n1,2\n3,4,5,6\n')
  const { sheets } = await parseImportFile(file)
  assert.equal(sheets[0].rows[1].cells.length, 2)
  assert.equal(sheets[0].rows[2].cells.length, 4)
})

test('malformed CSV (unterminated quote) throws a MALFORMED_FILE error', async () => {
  const file = csvFile('A,B,C\n"1,2,3\n4,5,6\n')
  await assert.rejects(() => parseImportFile(file), (err) => err.code === 'MALFORMED_FILE')
})

test('corrupt XLSX (not a real zip) throws a MALFORMED_FILE error', async () => {
  const file = bytesFile(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 'corrupt.xlsx')
  await assert.rejects(() => parseImportFile(file), (err) => err.code === 'MALFORMED_FILE')
})

test('multiple usable sheets are all returned; a fully blank sheet is excluded', async () => {
  const file = await xlsxFile((wb) => {
    const ws1 = wb.addWorksheet('January')
    ws1.addRow(['Client', 'Amount'])
    ws1.addRow(['Acme', 100])
    const ws2 = wb.addWorksheet('February')
    ws2.addRow(['Client', 'Amount'])
    ws2.addRow(['Beta', 200])
    wb.addWorksheet('EmptySheet') // no rows at all
  })
  const { sheets } = await parseImportFile(file)
  assert.deepEqual(sheets.map((s) => s.name), ['January', 'February'])
})

test('unsupported file extension (.xls) is rejected before parsing', async () => {
  const file = bytesFile(new Uint8Array([1, 2, 3]), 'legacy.xls')
  await assert.rejects(() => parseImportFile(file), (err) => err.code === 'UNSUPPORTED_FILE_TYPE')
})

test('a file at exactly the 5 MiB limit is accepted', async () => {
  const bytes = new Uint8Array(FILE_SIZE_LIMIT_BYTES).fill('a'.charCodeAt(0))
  const file = bytesFile(bytes, 'exact.csv')
  assert.equal(file.size, FILE_SIZE_LIMIT_BYTES)
  // Content is garbage binary, not real CSV — we only assert the size gate
  // lets it through to the parser rather than rejecting on size.
  await assert.doesNotReject(async () => {
    try {
      await parseImportFile(file)
    } catch (err) {
      if (err.code === 'FILE_TOO_LARGE') throw err
    }
  })
})

test('a file one byte over the 5 MiB limit is rejected before parsing', async () => {
  const bytes = new Uint8Array(FILE_SIZE_LIMIT_BYTES + 1)
  const file = bytesFile(bytes, 'over.csv')
  await assert.rejects(() => parseImportFile(file), (err) => err.code === 'FILE_TOO_LARGE')
})

test('values beginning with = + - @ are preserved as literal text, never evaluated', async () => {
  const file = csvFile('Notes\n=1+1\n+cmd|calc\n-2\n@SUM(A1)\n')
  const { sheets } = await parseImportFile(file)
  const values = sheets[0].rows.slice(1).map((r) => r.cells[0].raw)
  assert.deepEqual(values, ['=1+1', '+cmd|calc', '-2', '@SUM(A1)'])
})

test('a formula cell with a cached scalar result exposes it, marked as a formula', async () => {
  const file = await xlsxFile((wb) => {
    const ws = wb.addWorksheet('S')
    ws.addRow(['Amount'])
    ws.getCell('A2').value = { formula: 'SUM(1,2)', result: 3 }
  })
  const { sheets } = await parseImportFile(file)
  const cell = sheets[0].rows[1].cells[0]
  assert.equal(cell.isFormula, true)
  assert.equal(cell.hasCachedValue, true)
  assert.equal(cell.raw, 3)
})

test('a formula cell with a cached zero is distinguished from an unavailable cache', async () => {
  const file = await xlsxFile((wb) => {
    const ws = wb.addWorksheet('S')
    ws.addRow(['Amount'])
    ws.getCell('A2').value = { formula: 'SUM(0,0)', result: 0 }
  })
  const { sheets } = await parseImportFile(file)
  const cell = sheets[0].rows[1].cells[0]
  assert.equal(cell.isFormula, true)
  assert.equal(cell.hasCachedValue, true, 'a cached zero must count as a usable cached value')
  assert.equal(cell.raw, 0)
})

test('a formula cell with no cached result has hasCachedValue: false', async () => {
  const file = await xlsxFile((wb) => {
    const ws = wb.addWorksheet('S')
    ws.addRow(['Amount'])
    ws.getCell('A2').value = { formula: 'SUM(1,2)' } // no result written
  })
  const { sheets } = await parseImportFile(file)
  const cell = sheets[0].rows[1].cells[0]
  assert.equal(cell.isFormula, true)
  assert.equal(cell.hasCachedValue, false)
  assert.equal(cell.raw, null)
})

test('a formula cell whose cached result is an error is treated as unavailable', async () => {
  const file = await xlsxFile((wb) => {
    const ws = wb.addWorksheet('S')
    ws.addRow(['Amount'])
    ws.getCell('A2').value = { formula: '1/0', result: { error: '#DIV/0!' } }
  })
  const { sheets } = await parseImportFile(file)
  const cell = sheets[0].rows[1].cells[0]
  assert.equal(cell.hasCachedValue, false)
})

test('1900-system Excel date cell reads correctly with no timezone shift', async () => {
  const file = await xlsxFile((wb) => {
    const ws = wb.addWorksheet('S')
    ws.addRow(['Date'])
    ws.getCell('A2').value = new Date(Date.UTC(2025, 5, 15))
  })
  const { sheets, dateSystem } = await parseImportFile(file)
  assert.equal(dateSystem, '1900')
  const cell = sheets[0].rows[1].cells[0]
  assert.ok(cell.raw instanceof Date)
  assert.equal(cell.raw.getUTCFullYear(), 2025)
  assert.equal(cell.raw.getUTCMonth(), 5)
  assert.equal(cell.raw.getUTCDate(), 15)
})

test('1904-system workbook reports dateSystem "1904"', async () => {
  const file = await xlsxFile((wb) => {
    wb.properties.date1904 = true
    const ws = wb.addWorksheet('S')
    ws.addRow(['Date'])
    ws.addRow([1])
  })
  const { dateSystem } = await parseImportFile(file)
  assert.equal(dateSystem, '1904')
})

test('a raw Excel serial-number cell (not date-formatted) is preserved as a number, not converted here', async () => {
  const file = await xlsxFile((wb) => {
    const ws = wb.addWorksheet('S')
    ws.addRow(['Date'])
    ws.getCell('A2').value = 61 // Excel serial for 1900-03-01, stored as a plain number cell
  })
  const { sheets } = await parseImportFile(file)
  assert.equal(sheets[0].rows[1].cells[0].raw, 61)
})
