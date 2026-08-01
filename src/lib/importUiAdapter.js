// Thin, deterministic adapter between the future importer UI and the
// committed engine under src/lib/import/. Owns exactly one thing the
// engine doesn't: turning a single File into cached, UI-friendly state so
// mapping/date/currency decisions never re-read the File or re-invoke
// parseImportFile/runImportPipeline. All correctness (parsing, validation,
// normalization, outcome derivation) stays in src/lib/import/ untouched —
// this module never reimplements it, only shapes calls into it.
import { parseImportFile, cellAt } from './import/parse.js'
import { normalizeImportFile } from './import/normalize.js'
import {
  guessMapping,
  missingRequiredMappings,
  hasUsableClientIdentityMapping,
} from './import/fields.js'

const UPLOAD_ERROR_CODES = new Set(['FILE_TOO_LARGE', 'MALFORMED_FILE', 'UNSUPPORTED_FILE_TYPE'])

// Reads a single cell's display value out of parse.js's ParsedCell shape
// without ever mutating it. Used only for on-screen text (headers, sample
// rows) — never for anything fed back into normalizeImportFile, which
// always receives the original parsed rows/cells unchanged.
function displayCellValue(cell) {
  if (!cell || cell.raw == null) return ''
  if (cell.raw instanceof Date) return cell.raw.toISOString()
  return String(cell.raw)
}

function widestRowLength(rows) {
  return rows.reduce((max, r) => Math.max(max, r.cells.length), 0)
}

const SAMPLE_ROW_COUNT = 3

function buildSampleRows(dataRows, columnCount) {
  return dataRows.slice(0, SAMPLE_ROW_COUNT).map((row) =>
    Array.from({ length: columnCount }, (_, i) => displayCellValue(cellAt(row.cells, i)))
  )
}

// 1. parseUpload(file) — calls parseImportFile exactly once. Parser error
// codes are preserved verbatim; an empty-but-successfully-parsed workbook
// (zero nonblank sheets) becomes a synthesized EMPTY_FILE upload error.
// These are UI-level file errors surfaced before any engine issue can
// exist yet — never built with makeIssue, and never a substitute for the
// real issues[] the engine produces once normalization runs.
export async function parseUpload(file) {
  let parsed
  try {
    parsed = await parseImportFile(file)
  } catch (err) {
    if (UPLOAD_ERROR_CODES.has(err.code)) {
      return { ok: false, parsed: null, error: { code: err.code, message: err.message } }
    }
    throw err
  }

  if (!parsed.sheets || parsed.sheets.length === 0) {
    return {
      ok: false,
      parsed: null,
      error: { code: 'EMPTY_FILE', message: 'The file has no data.' },
    }
  }

  return { ok: true, parsed: { sheets: parsed.sheets, dateSystem: parsed.dateSystem }, error: null }
}

// 2. describeSheet(sheet) — truthful display metadata only. rowCount is
// the count of nonblank parsed rows (parse.js already dropped blank rows,
// so this is simply sheet.rows.length); columnCount is the widest row in
// the sheet, not just the first row (ragged rows are common in the wild).
export function describeSheet(sheet) {
  return {
    name: sheet.name,
    rowCount: sheet.rows.length,
    columnCount: widestRowLength(sheet.rows),
  }
}

// 3. buildSheetView(sheet, hasHeaderRow) — derives headers/dataRows/
// sampleRows for the Map step. Before this function's caller has decided
// hasHeaderRow, the UI should still just call the parsed rows "rows", not
// "data rows" — that distinction begins here, once hasHeaderRow is known.
// dataRows always references the original parsed row objects (never
// copies or mutates them) so normalizeImportFile keeps working from the
// same cached parse. sampleRows are plain display strings, safe to throw
// away.
export function buildSheetView(sheet, hasHeaderRow) {
  if (hasHeaderRow) {
    const headerRow = sheet.rows[0]
    const headers = headerRow ? headerRow.cells.map(displayCellValue) : []
    const dataRows = sheet.rows.slice(1)
    return { headers, dataRows, sampleRows: buildSampleRows(dataRows, headers.length) }
  }

  const columnCount = widestRowLength(sheet.rows)
  const headers = Array.from({ length: columnCount }, (_, i) => `Column ${i + 1}`)
  const dataRows = sheet.rows
  return { headers, dataRows, sampleRows: buildSampleRows(dataRows, headers.length) }
}

// 4. createInitialMapping(headers) — a pass-through to the engine's own
// guessMapping(), so the UI's starting point and the engine's canonical
// mapping shape ({ [sourceColumnIndex]: duewatchField }) are identical by
// construction. No confidence score of any kind is attached here or ever.
export function createInitialMapping(headers) {
  return guessMapping(headers)
}

function findDuplicateTargetFields(mapping) {
  const counts = new Map()
  for (const fieldKey of Object.values(mapping)) {
    counts.set(fieldKey, (counts.get(fieldKey) || 0) + 1)
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([fieldKey]) => fieldKey)
}

// 5. validateMapping(mapping) — objective, mechanical validation only,
// built from the engine's own helpers. No heuristic "needs review" score
// is derived from sample values; that judgment belongs to the founder, not
// this adapter.
export function validateMapping(mapping) {
  const missingRequiredFields = missingRequiredMappings(mapping)
  const clientIdentityMissing = !hasUsableClientIdentityMapping(mapping)
  const duplicateTargetFields = findDuplicateTargetFields(mapping)
  return {
    missingRequiredFields,
    clientIdentityMissing,
    duplicateTargetFields,
    valid: missingRequiredFields.length === 0 && !clientIdentityMissing && duplicateTargetFields.length === 0,
  }
}

const DATE_DECISION_FIELDS = ['invoice_date', 'due_date', 'payment_date']

function columnForField(mapping, fieldKey) {
  const entry = Object.entries(mapping).find(([, key]) => key === fieldKey)
  return entry ? Number(entry[0]) : null
}

// 6. invalidateDateDecisions(previousMapping, nextMapping, dateConvention)
// — a saved per-field MDY/DMY decision is only meaningful for the specific
// source column it was made against. If that field's mapped column index
// changes (including becoming unmapped), the old decision no longer refers
// to the same data and must be dropped; every other field's decision is
// untouched. Never mutates any of its three arguments.
export function invalidateDateDecisions(previousMapping, nextMapping, dateConvention) {
  const next = { ...dateConvention }
  for (const fieldKey of DATE_DECISION_FIELDS) {
    const prevColumn = columnForField(previousMapping, fieldKey)
    const nextColumn = columnForField(nextMapping, fieldKey)
    if (prevColumn !== nextColumn) {
      delete next[fieldKey]
    }
  }
  return next
}

// 7. normalizeParsedUpload(options) — the only place this adapter calls
// into normalize.js. Always works from the sheet already cached by
// parseUpload; never calls parseImportFile or runImportPipeline, so a
// mapping/date/currency decision never re-reads the File. defaultCurrency
// is passed as null unless the founder has explicitly confirmed one —
// a merely *selected* code is never sent to the engine as approved.
// Returns the engine's result object exactly as normalizeImportFile
// produced it (outcome, fileIssues, rows, summary, and every issue/row
// field) — nothing here rewrites or reshapes it.
export function normalizeParsedUpload({
  parsed,
  sheetIndex = 0,
  hasHeaderRow = true,
  mapping = {},
  dateConvention = {},
  selectedDefaultCurrency = null,
  defaultCurrencyConfirmed = false,
}) {
  if (!parsed || !Array.isArray(parsed.sheets)) {
    throw new Error('normalizeParsedUpload: parsed.sheets is required — call parseUpload first')
  }
  if (!Number.isInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= parsed.sheets.length) {
    throw new Error(
      `normalizeParsedUpload: sheetIndex ${sheetIndex} is out of bounds for ${parsed.sheets.length} sheet(s)`
    )
  }

  const sheet = parsed.sheets[sheetIndex]
  const defaultCurrency = defaultCurrencyConfirmed === true ? selectedDefaultCurrency : null

  return normalizeImportFile({
    sheet,
    hasHeaderRow,
    mapping,
    dateSystem: parsed.dateSystem,
    dateConvention,
    defaultCurrency,
  })
}
