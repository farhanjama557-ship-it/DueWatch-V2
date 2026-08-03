// Pure presentation logic for the importer UI: categorizing engine issues,
// grouping them for the date/currency/review/rejected screens, and
// formatting normalized values for display without ever converting the
// engine's exact decimal money strings through Number/parseFloat. Nothing
// here talks to the engine or the adapter — it only reads the structured
// issue/row objects they already produced.
import { OUTCOMES } from './import/outcome.js'

export const DATE_DECISION_FIELDS = ['invoice_date', 'due_date', 'payment_date']

export const ISSUE_CATEGORY = Object.freeze({
  RESOLVABLE: 'resolvable',
  SOURCE_CORRECTION: 'source_correction',
  INSPECT_ONLY: 'inspect_only',
  INFORMATIONAL: 'informational',
})

const RESOLVABLE_CODES = new Set(['AMBIGUOUS_DATE_FORMAT', 'CURRENCY_DECISION_REQUIRED'])

const SOURCE_CORRECTION_CODES = new Set([
  'MIXED_DATE_FORMATS',
  'AMBIGUOUS_AMOUNT_FORMAT',
  'UNKNOWN_STATUS',
  'AMOUNT_PAID_EXCEEDS_AMOUNT',
  'UNSUPPORTED_CURRENCY',
  'FORMULA_VALUE_UNAVAILABLE',
  'INVALID_DATE',
  'INVALID_AMOUNT',
  'MISSING_REQUIRED_VALUE',
])

const INSPECT_ONLY_CODES = new Set([
  'DUPLICATE_IN_UPLOAD',
  'DUPLICATE_DETECTION_INCOMPLETE',
  'PARTIAL_PAYMENT_REVIEW',
])

// Any issue code not in one of the three locked lists above (e.g.
// ROW_COLUMN_COUNT_MISMATCH, FORMULA_CACHED_VALUE_USED,
// PAID_WITHOUT_PAYMENT_DATE) is categorized from its own blocksImport/
// requiresUserChoice flags rather than assumed fatal from its name.
export function categorizeIssue(issue) {
  if (RESOLVABLE_CODES.has(issue.code)) return ISSUE_CATEGORY.RESOLVABLE
  if (SOURCE_CORRECTION_CODES.has(issue.code)) return ISSUE_CATEGORY.SOURCE_CORRECTION
  if (INSPECT_ONLY_CODES.has(issue.code)) return ISSUE_CATEGORY.INSPECT_ONLY
  if (!issue.blocksImport && !issue.requiresUserChoice) return ISSUE_CATEGORY.INFORMATIONAL
  if (issue.blocksImport && issue.requiresUserChoice) return ISSUE_CATEGORY.RESOLVABLE
  return ISSUE_CATEGORY.SOURCE_CORRECTION
}

// The engine's own issue.message is already founder-facing prose (see
// normalize.js) — this just guarantees callers never fall back to
// rendering a bare code if a message is ever missing.
export function issueDisplayMessage(issue) {
  return issue.message || 'This value needs attention.'
}

export const REJECTED_ROW_COPY = 'These rows cannot proceed.'

export const OUTCOME_META = Object.freeze({
  [OUTCOMES.READY]: { label: 'Ready', symbol: '✓' },
  [OUTCOMES.READY_WITH_WARNINGS]: { label: 'Ready with warnings', symbol: '!' },
  [OUTCOMES.REVIEW_REQUIRED]: { label: 'Review required', symbol: '?' },
  [OUTCOMES.REJECTED]: { label: 'Rejected', symbol: '✕' },
})

export const OUTCOME_FILTERS = [OUTCOMES.READY, OUTCOMES.READY_WITH_WARNINGS, OUTCOMES.REVIEW_REQUIRED, OUTCOMES.REJECTED]

const FILE_ERROR_COPY = {
  FILE_TOO_LARGE: {
    title: "That file is too large",
    message: 'Files over 5 MiB are not accepted yet. Split the file into smaller batches and try again.',
  },
  MALFORMED_FILE: {
    title: "Duewatch couldn't read that file",
    message: 'The file looks corrupted or is not a valid CSV/XLSX file. Re-export it and try again.',
  },
  UNSUPPORTED_FILE_TYPE: {
    title: 'Unsupported file type',
    message: 'Only .csv and .xlsx files are accepted right now.',
  },
  EMPTY_FILE: {
    title: 'No data found',
    message: 'That file has no rows Duewatch can read. Check the file and try again.',
  },
}

export function fileErrorCopy(code) {
  return FILE_ERROR_COPY[code] || { title: 'Could not read that file', message: 'Try a different file.' }
}

// Groups every issue on `rows` matching one of `codes` by its `field`,
// scoped to the given date fields. Used to build the per-field
// ambiguous/mixed date decision groups without re-deriving engine logic.
export function groupDateIssuesByField(rows, codes) {
  const byField = Object.fromEntries(DATE_DECISION_FIELDS.map((f) => [f, []]))
  for (const row of rows) {
    for (const issue of row.issues) {
      if (byField[issue.field] && codes.includes(issue.code)) {
        byField[issue.field].push({ row, issue })
      }
    }
  }
  return byField
}

export function needsDateDecisionStep(rows) {
  return rows.some((row) =>
    row.issues.some((issue) => DATE_DECISION_FIELDS.includes(issue.field) && (issue.code === 'AMBIGUOUS_DATE_FORMAT' || issue.code === 'MIXED_DATE_FORMATS'))
  )
}

export function needsCurrencyStep(rows) {
  return rows.some((row) => row.issues.some((issue) => issue.code === 'CURRENCY_DECISION_REQUIRED'))
}

export function rowsWithIssueCode(rows, code) {
  return rows.filter((row) => row.issues.some((issue) => issue.code === code))
}

export function rowsWithOutcome(rows, outcome) {
  return rows.filter((row) => row.outcome === outcome)
}

// Groups rows by their first blocking (blocksImport) issue code — used to
// explain *why* a rejected/review-required row landed where it did without
// listing every issue on it individually.
export function groupRowsByPrimaryIssueCode(rows) {
  const groups = new Map()
  for (const row of rows) {
    const primary = row.issues.find((i) => i.blocksImport) || row.issues[0]
    const code = primary ? primary.code : 'UNKNOWN'
    if (!groups.has(code)) groups.set(code, [])
    groups.get(code).push(row)
  }
  return groups
}

// Formats an engine-normalized decimal string ("1234.56") with thousands
// separators via pure string manipulation — never Number()/parseFloat(),
// so precision is never at risk of a float round-trip.
export function formatAmountDisplay(decimalString) {
  if (decimalString == null) return null
  const negative = decimalString.startsWith('-')
  const abs = negative ? decimalString.slice(1) : decimalString
  const [intPart, fracPart = '00'] = abs.split('.')
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${withCommas}.${fracPart}`
}

export function formatMoneyWithCurrency(amount, currencyCode) {
  if (amount == null) return '—'
  const formatted = formatAmountDisplay(amount)
  return currencyCode ? `${currencyCode} ${formatted}` : formatted
}

// Best-effort client identity label for a normalized row — first usable
// value in the same priority order the engine itself checks in
// hasUsableClientIdentityValue (fields.js), for display only.
export function clientIdentityLabel(normalized) {
  return (
    normalized.client_name ||
    normalized.client_company ||
    normalized.client_email ||
    (normalized.source_system && normalized.source_client_id
      ? `${normalized.source_system} #${normalized.source_client_id}`
      : null) ||
    normalized.client_phone ||
    '—'
  )
}
