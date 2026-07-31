// File → raw grid parsing for CSV and Excel imports. Pure parsing only — no
// normalization, no field mapping, no DB access. Returns every sheet found
// (Excel workbooks can have more than one) so the caller decides which to use
// rather than this module silently guessing.
import Papa from 'papaparse'
import ExcelJS from 'exceljs'

// Pads every row to the same length (the widest row in the sheet) so the
// column mapper can always index by position without undefined gaps —
// ragged CSV/Excel rows are common (trailing columns omitted on some rows).
function padRows(rows) {
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0)
  return rows.map((r) => {
    const row = r.slice(0, maxCols)
    while (row.length < maxCols) row.push('')
    return row
  })
}

function isBlankRow(row) {
  return row.every((cell) => String(cell ?? '').trim() === '')
}

function parseCsvFile(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      skipEmptyLines: true,
      complete: (results) => {
        // FieldMismatch just means ragged rows, which padRows already
        // handles — only a non-FieldMismatch error should abort the parse.
        const fatal = (results.errors || []).find((e) => e.type !== 'FieldMismatch')
        if (fatal) return reject(new Error(fatal.message))
        const rows = padRows(results.data.filter((r) => !isBlankRow(r)))
        resolve({ sheets: [{ name: file.name, rows }] })
      },
      error: (err) => reject(err),
    })
  })
}

// Excel cells can hold plain values, rich text, formula results, or
// hyperlinks — unwrap all of those down to a plain string/number/Date so
// downstream normalization only ever has to handle primitives.
function cellPlainValue(v) {
  if (v == null) return ''
  if (v instanceof Date) return v
  if (typeof v === 'object') {
    if ('result' in v) return cellPlainValue(v.result)
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('')
    if (typeof v.text === 'string') return v.text
    return ''
  }
  return v
}

async function parseExcelFile(file) {
  const buffer = await file.arrayBuffer()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)

  const sheets = workbook.worksheets
    .map((ws) => {
      // getSheetValues() returns a 1-indexed sparse array of 1-indexed sparse
      // rows (index 0 in both is unused) — this loop converts it to a dense,
      // 0-indexed grid.
      const sheetValues = ws.getSheetValues()
      const rows = []
      for (let r = 1; r < sheetValues.length; r++) {
        const rawRow = sheetValues[r]
        if (!rawRow) continue
        const row = []
        for (let c = 1; c < rawRow.length; c++) {
          row.push(cellPlainValue(rawRow[c]))
        }
        rows.push(row)
      }
      return { name: ws.name, rows: padRows(rows.filter((r) => !isBlankRow(r))) }
    })
    .filter((sheet) => sheet.rows.length > 0)

  return { sheets }
}

// Dispatches on file extension. Rejects unsupported types with a message
// meant to be shown directly to the user.
export function parseImportFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (ext === 'csv') return parseCsvFile(file)
  if (ext === 'xlsx' || ext === 'xls') return parseExcelFile(file)
  return Promise.reject(
    new Error(`Unsupported file type: .${ext || 'unknown'}. Upload a .csv, .xlsx, or .xls file.`)
  )
}
