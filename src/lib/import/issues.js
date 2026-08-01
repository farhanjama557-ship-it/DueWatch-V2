// Structured issue records for the import engine. Every problem found while
// parsing/normalizing a file is represented as one of these — never as a
// plain display string — so the UI, tests, and (eventually) Phase 1.5B can
// all reason about severity/blocking/choice mechanically instead of
// re-parsing English sentences.

// Codes from the Phase 1.5A spec, plus four additions that the spec's own
// outcome/behavior rules require but the original stable-code list omitted:
//   - MALFORMED_FILE: the spec's rejected-outcome list names "malformed
//     file" as a reason, but no code covers a whole-file parse failure
//     (corrupt XLSX, unreadable zip) that isn't EMPTY_FILE/HEADERS_ONLY.
//   - FORMULA_CACHED_VALUE_USED: required by correction #7 (nonblocking
//     warning when a formula's cached result is used).
//   - CURRENCY_DECISION_REQUIRED: required by correction #4 (blank currency
//     needs an explicit file-level decision before a row can be ready).
//   - DUPLICATE_DETECTION_INCOMPLETE: required by correction #5 (no
//     reliable client reference — do not manufacture a duplicate key).
export const ISSUE_CODES = Object.freeze({
  EMPTY_FILE: 'EMPTY_FILE',
  HEADERS_ONLY: 'HEADERS_ONLY',
  DUPLICATE_HEADER: 'DUPLICATE_HEADER',
  MALFORMED_FILE: 'MALFORMED_FILE',
  MISSING_REQUIRED_MAPPING: 'MISSING_REQUIRED_MAPPING',
  MISSING_REQUIRED_VALUE: 'MISSING_REQUIRED_VALUE',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  AMBIGUOUS_AMOUNT_FORMAT: 'AMBIGUOUS_AMOUNT_FORMAT',
  INVALID_DATE: 'INVALID_DATE',
  AMBIGUOUS_DATE_FORMAT: 'AMBIGUOUS_DATE_FORMAT',
  MIXED_DATE_FORMATS: 'MIXED_DATE_FORMATS',
  UNKNOWN_STATUS: 'UNKNOWN_STATUS',
  PAID_WITHOUT_PAYMENT_DATE: 'PAID_WITHOUT_PAYMENT_DATE',
  AMOUNT_PAID_EXCEEDS_AMOUNT: 'AMOUNT_PAID_EXCEEDS_AMOUNT',
  PARTIAL_PAYMENT_REVIEW: 'PARTIAL_PAYMENT_REVIEW',
  DUPLICATE_IN_UPLOAD: 'DUPLICATE_IN_UPLOAD',
  DUPLICATE_DETECTION_INCOMPLETE: 'DUPLICATE_DETECTION_INCOMPLETE',
  FORMULA_VALUE_UNAVAILABLE: 'FORMULA_VALUE_UNAVAILABLE',
  FORMULA_CACHED_VALUE_USED: 'FORMULA_CACHED_VALUE_USED',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  CURRENCY_DECISION_REQUIRED: 'CURRENCY_DECISION_REQUIRED',
  ROW_COLUMN_COUNT_MISMATCH: 'ROW_COLUMN_COUNT_MISMATCH',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  ROW_LIMIT_EXCEEDED: 'ROW_LIMIT_EXCEEDED',
})

const SEVERITIES = ['error', 'warning', 'info']
const REQUIRED_KEYS = [
  'code',
  'severity',
  'rowNumber',
  'columnId',
  'field',
  'rawValue',
  'normalizedValue',
  'message',
  'blocksPreview',
  'blocksImport',
  'requiresUserChoice',
]

// Formula objects, Date instances, etc. are not safe/deterministic to carry
// as-is inside an issue (JSON-unfriendly, non-deterministic key order for
// plain objects). Reduce every rawValue to a primitive or a deterministic
// string before it leaves this module.
function safeRawValue(v) {
  if (v === undefined || v === null) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    if (typeof v.formula === 'string') {
      return `=${v.formula}`
    }
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

// Builds one structured issue. All keys in REQUIRED_KEYS are always present
// on the returned object, even when a value is legitimately null (e.g. a
// file-level issue has rowNumber/columnId/field: null, never an omitted
// key) — callers and tests can rely on `Object.keys(issue)` being stable.
export function makeIssue({
  code,
  severity,
  rowNumber = null,
  columnId = null,
  field = null,
  rawValue = null,
  normalizedValue = null,
  message,
  blocksPreview = false,
  blocksImport = false,
  requiresUserChoice = false,
} = {}) {
  if (!code || !Object.values(ISSUE_CODES).includes(code)) {
    throw new Error(`makeIssue: unknown issue code "${code}"`)
  }
  if (!SEVERITIES.includes(severity)) {
    throw new Error(`makeIssue: invalid severity "${severity}"`)
  }
  if (!message) {
    throw new Error('makeIssue: message is required')
  }

  const issue = {
    code,
    severity,
    rowNumber,
    columnId,
    field,
    rawValue: safeRawValue(rawValue),
    normalizedValue: normalizedValue === undefined ? null : normalizedValue,
    message,
    blocksPreview: Boolean(blocksPreview),
    blocksImport: Boolean(blocksImport),
    requiresUserChoice: Boolean(requiresUserChoice),
  }

  for (const key of REQUIRED_KEYS) {
    if (!(key in issue)) throw new Error(`makeIssue: missing required key "${key}"`)
  }
  return issue
}

export function hasStructuredIssueShape(issue) {
  return REQUIRED_KEYS.every((key) => Object.prototype.hasOwnProperty.call(issue, key))
}
