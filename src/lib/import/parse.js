// File -> raw sheet grid parsing for CSV and XLSX. Pure parsing only — no
// normalization, no field mapping, no DB access, no formula evaluation.
// Every returned cell keeps enough metadata (isFormula/hasCachedValue) for
// the normalization layer to make a truthful decision about formula
// values, and every row keeps its true original spreadsheet row number so
// blank-row skipping never renumbers anything.
import Papa from 'papaparse'
import ExcelJS from 'exceljs'
import { FILE_SIZE_LIMIT_BYTES } from './limits.js'

// @typedef {{ raw: string|number|Date|boolean|null, isFormula: boolean, formula: string|null, hasCachedValue: boolean }} ParsedCell
// @typedef {{ rowNumber: number, cells: ParsedCell[] }} SheetRow
// @typedef {{ name: string, rows: SheetRow[] }} ParsedSheet

function literalCell(raw) {
  return { raw: raw == null ? null : raw, isFormula: false, formula: null, hasCachedValue: true }
}

// A formula cell counts as content even when it has no usable cached
// value — dropping it as "blank" would silently discard a real row that
// should instead surface FORMULA_VALUE_UNAVAILABLE downstream.
function isBlankCells(cells) {
  return cells.every((c) => !c.isFormula && (c.raw == null || String(c.raw).trim() === ''))
}

/** Safe positional lookup — returns a blank literal cell past the end of a row (ragged rows are never index errors). */
export function cellAt(cells, index) {
  return cells[index] ?? literalCell(null)
}

function makeParseError(message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

async function parseCsvFile(file) {
  const text = await file.text()
  // skipEmptyLines is deliberately false here — we filter blank rows
  // ourselves so the surviving rows keep their true 1-based file line
  // number (Papa renumbers when it skips lines internally).
  const results = Papa.parse(text, { skipEmptyLines: false })
  // FieldMismatch just means ragged rows (handled downstream); Delimiter is
  // Papa's own auto-detect-fallback notice on empty/near-empty input, not a
  // real parse failure. Anything else is a genuine malformed-file error.
  const fatal = (results.errors || []).find((e) => e.type !== 'FieldMismatch' && e.type !== 'Delimiter')
  if (fatal) throw makeParseError(`Could not read that CSV file: ${fatal.message}`, 'MALFORMED_FILE')

  const rows = []
  results.data.forEach((rawRow, i) => {
    const cells = rawRow.map((v) => literalCell(v === '' ? null : v))
    if (isBlankCells(cells)) return
    rows.push({ rowNumber: i + 1, cells })
  })

  return { sheets: rows.length > 0 ? [{ name: file.name, rows }] : [], dateSystem: '1900' }
}

// Excel cells can hold plain values, rich text, or hyperlinks — unwrap all
// of those down to a plain string/number/Date/boolean so downstream
// normalization only ever handles primitives.
function unwrapPlainValue(v) {
  if (v == null) return null
  if (v instanceof Date) return v
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('')
    if (typeof v.text === 'string') return v.text // hyperlink: { text, hyperlink }
    return null
  }
  return v
}

function describeCell(cell) {
  if (cell.type === ExcelJS.ValueType.Formula) {
    const result = cell.result
    const isUsableScalar =
      result !== undefined && result !== null && !(typeof result === 'object' && 'error' in result)
    if (!isUsableScalar) {
      return { raw: null, isFormula: true, formula: cell.formula, hasCachedValue: false }
    }
    return { raw: unwrapPlainValue(result), isFormula: true, formula: cell.formula, hasCachedValue: true }
  }
  return literalCell(unwrapPlainValue(cell.value))
}

async function parseExcelFile(file) {
  const buffer = await file.arrayBuffer()
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer)
  } catch (err) {
    throw makeParseError(`Could not read that Excel file: ${err.message}`, 'MALFORMED_FILE')
  }

  const dateSystem = workbook.properties?.date1904 ? '1904' : '1900'

  const sheets = workbook.worksheets
    .map((ws) => {
      const rows = []
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const cells = []
        row.eachCell({ includeEmpty: true }, (cell) => {
          cells.push(describeCell(cell))
        })
        if (isBlankCells(cells)) return
        rows.push({ rowNumber, cells })
      })
      return { name: ws.name, rows }
    })
    .filter((sheet) => sheet.rows.length > 0)

  return { sheets, dateSystem }
}

// Dispatches on file extension and the 5 MiB hard limit. Rejects with a
// structured Error (`.code`) meant to become a file-level issue upstream —
// never partially parses an oversized or unsupported file.
export function parseImportFile(file) {
  if (file.size > FILE_SIZE_LIMIT_BYTES) {
    return Promise.reject(
      makeParseError(`File is ${file.size} bytes, over the ${FILE_SIZE_LIMIT_BYTES} byte (5 MiB) limit.`, 'FILE_TOO_LARGE')
    )
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (ext === 'csv') return parseCsvFile(file)
  if (ext === 'xlsx') return parseExcelFile(file)
  return Promise.reject(
    makeParseError(`Unsupported file type: .${ext || 'unknown'}. Upload a .csv or .xlsx file.`, 'UNSUPPORTED_FILE_TYPE')
  )
}
