// Thin orchestrator wiring parse.js -> normalize.js into the single call
// the Import UI will eventually make (added now so the later UI-wiring
// pass has one clear entry point to call; Import.jsx itself is untouched
// in this pass). Converts parse.js's thrown file-level errors into the
// same structured-issue shape normalize.js produces for everything else.
import { parseImportFile } from './parse.js'
import { normalizeImportFile } from './normalize.js'
import { makeIssue, ISSUE_CODES } from './issues.js'
import { OUTCOMES } from './outcome.js'

function rejectedResult(issue) {
  return {
    outcome: OUTCOMES.REJECTED,
    fileIssues: [issue],
    rows: [],
    summary: { ready: 0, ready_with_warnings: 0, review_required: 0, rejected: 0, total: 0 },
    sheets: [],
  }
}

// options: { sheetIndex, hasHeaderRow, mapping, dateConvention, defaultCurrency }
// `dateConvention` is per-field, e.g. { invoice_date: 'MDY', due_date: 'DMY' }.
export async function runImportPipeline(file, options = {}) {
  let parsed
  try {
    parsed = await parseImportFile(file)
  } catch (err) {
    if (err.code === 'FILE_TOO_LARGE') {
      return rejectedResult(
        makeIssue({ code: ISSUE_CODES.FILE_TOO_LARGE, severity: 'error', message: err.message, blocksImport: true, blocksPreview: true })
      )
    }
    if (err.code === 'MALFORMED_FILE') {
      return rejectedResult(
        makeIssue({ code: ISSUE_CODES.MALFORMED_FILE, severity: 'error', message: err.message, blocksImport: true, blocksPreview: true })
      )
    }
    // Unsupported file extension is a pre-flight UI concern (the file
    // picker already restricts to .csv/.xlsx) — not converted to a
    // structured issue, re-thrown as-is.
    throw err
  }

  if (parsed.sheets.length === 0) {
    return rejectedResult(
      makeIssue({ code: ISSUE_CODES.EMPTY_FILE, severity: 'error', message: 'The file has no data.', blocksImport: true, blocksPreview: true })
    )
  }

  const sheetIndex = options.sheetIndex ?? 0
  const sheet = parsed.sheets[sheetIndex]
  const result = normalizeImportFile({
    sheet,
    hasHeaderRow: options.hasHeaderRow ?? true,
    mapping: options.mapping ?? {},
    dateSystem: parsed.dateSystem,
    dateConvention: options.dateConvention ?? {},
    defaultCurrency: options.defaultCurrency ?? null,
  })

  return { ...result, sheets: parsed.sheets.map((s) => ({ name: s.name, rowCount: s.rows.length })) }
}
