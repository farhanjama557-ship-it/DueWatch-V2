// Deny-by-default eligibility for persistence. The browser preview is never
// authoritative here — this module (and its server-side mirror in the
// Checkpoint 1 migration) both independently decide whether a row may
// persist, from first principles, not by trusting a transmitted `outcome`
// or `eligible: true` flag.
//
// Every non-blocking issue code a `ready_with_warnings` row is allowed to
// carry is enumerated explicitly below, derived directly from
// src/lib/import/normalize.js's actual blocksImport flags (verified by
// reading every makeIssue() call site, not assumed): DUPLICATE_HEADER,
// EMPTY_FILE, HEADERS_ONLY, INVALID_AMOUNT, INVALID_DATE,
// MISSING_REQUIRED_MAPPING, MISSING_REQUIRED_VALUE, ROW_LIMIT_EXCEEDED,
// UNSUPPORTED_CURRENCY, and AMOUNT_PAID_EXCEEDS_AMOUNT all block with no
// user choice (rejected); AMBIGUOUS_AMOUNT_FORMAT, AMBIGUOUS_DATE_FORMAT,
// CURRENCY_DECISION_REQUIRED, DUPLICATE_IN_UPLOAD, MIXED_DATE_FORMATS,
// PARTIAL_PAYMENT_REVIEW, and UNKNOWN_STATUS all block AND require a user
// choice (review_required) — none of those thirteen codes can legitimately
// appear on a row whose outcome is ready/ready_with_warnings, so any row
// that claims that outcome while carrying one of them is lying about its
// own state and must be blocked, not trusted.
export const APPROVED_WARNING_CODES = Object.freeze([
  'DUPLICATE_DETECTION_INCOMPLETE',
  'FORMULA_CACHED_VALUE_USED',
  'FORMULA_VALUE_UNAVAILABLE',
  'PAID_WITHOUT_PAYMENT_DATE',
  'ROW_COLUMN_COUNT_MISMATCH',
])

export const ELIGIBLE_OUTCOMES = Object.freeze(['ready', 'ready_with_warnings'])

export const BLOCK_REASONS = Object.freeze({
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
  UNKNOWN_ISSUE_CODE: 'UNKNOWN_ISSUE_CODE',
  UNAPPROVED_WARNING_CODE: 'UNAPPROVED_WARNING_CODE',
  BLOCKING_ISSUE_ON_ELIGIBLE_OUTCOME: 'BLOCKING_ISSUE_ON_ELIGIBLE_OUTCOME',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  REJECTED: 'REJECTED',
  FILE_LEVEL_REJECTED: 'FILE_LEVEL_REJECTED',
  MISSING_MATERIAL_FIELD: 'MISSING_MATERIAL_FIELD',
  UNSUPPORTED_STATUS_VALUE: 'UNSUPPORTED_STATUS_VALUE',
})

// The importer engine's own STATUS_VALUES vocabulary (draft/sent/paid/
// partial/overdue/void — see src/lib/import/fields.js) is intentionally
// independent of this schema's real persistence model (a `paid` boolean +
// amount_paid, no status column). Every value except 'void' has an
// explicit, locked translation (see the migration's invoice-persistence
// comment). 'void' does not: there is no void/disputed/cancelled concept
// anywhere in the current invoices table, and inventing one here — rather
// than in a separately reviewed, locked contract — would be exactly the
// kind of silent conversion this checkpoint must never do. So 'void' rows
// are blocked at this layer, explicitly, rather than persisted under any
// guessed status.
const UNSUPPORTED_STATUS_VALUES = Object.freeze(['void'])

// All 22 codes the importer engine can currently produce, with their known
// blocksImport truth (mirrors issues.js's ISSUE_CODES + normalize.js's
// actual usage — kept as an explicit local copy, not imported, so this
// module has no dependency on the importer engine and stays independently
// auditable; a code missing from this map is unknown by definition and
// blocks, which is exactly the deny-by-default behavior required).
const KNOWN_ISSUE_BLOCKS_IMPORT = Object.freeze({
  EMPTY_FILE: true,
  HEADERS_ONLY: true,
  DUPLICATE_HEADER: true,
  MALFORMED_FILE: true,
  MISSING_REQUIRED_MAPPING: true,
  MISSING_REQUIRED_VALUE: true,
  INVALID_AMOUNT: true,
  AMBIGUOUS_AMOUNT_FORMAT: true,
  INVALID_DATE: true,
  AMBIGUOUS_DATE_FORMAT: true,
  MIXED_DATE_FORMATS: true,
  UNKNOWN_STATUS: true,
  PAID_WITHOUT_PAYMENT_DATE: false,
  AMOUNT_PAID_EXCEEDS_AMOUNT: true,
  PARTIAL_PAYMENT_REVIEW: true,
  DUPLICATE_IN_UPLOAD: true,
  DUPLICATE_DETECTION_INCOMPLETE: false,
  FORMULA_VALUE_UNAVAILABLE: false,
  FORMULA_CACHED_VALUE_USED: false,
  UNSUPPORTED_CURRENCY: true,
  CURRENCY_DECISION_REQUIRED: true,
  ROW_COLUMN_COUNT_MISMATCH: false,
  FILE_TOO_LARGE: true,
  ROW_LIMIT_EXCEEDED: true,
})

// Required material fields for any row to be eligible — checked here as a
// structural precondition, independent of the outcome/issue check. See
// materialPayload.js for the full definition these are drawn from.
const REQUIRED_MATERIAL_FIELDS = Object.freeze(['invoice_number', 'invoice_date', 'amount'])

// Returns { eligible: boolean, reasonCode: string|null, detail: object }.
// `row` is one importer-engine row result: { outcome, issues, normalized, ... }.
export function evaluateRowEligibility(row) {
  if (!row || typeof row !== 'object') {
    return { eligible: false, reasonCode: BLOCK_REASONS.MISSING_MATERIAL_FIELD, detail: { message: 'row is missing' } }
  }

  const outcome = row.outcome
  if (!ELIGIBLE_OUTCOMES.includes(outcome)) {
    // review_required and rejected are explicit, known, deliberately
    // ineligible outcomes — everything else (typos, future codes this
    // module hasn't been taught yet) is simply unknown and blocks the
    // same way, per "unknown row outcome: BLOCKED."
    const reasonCode =
      outcome === 'review_required'
        ? BLOCK_REASONS.REVIEW_REQUIRED
        : outcome === 'rejected'
          ? BLOCK_REASONS.REJECTED
          : BLOCK_REASONS.UNKNOWN_OUTCOME
    return { eligible: false, reasonCode, detail: { outcome } }
  }

  const issues = Array.isArray(row.issues) ? row.issues : []
  for (const issue of issues) {
    const code = issue?.code
    if (!(code in KNOWN_ISSUE_BLOCKS_IMPORT)) {
      return { eligible: false, reasonCode: BLOCK_REASONS.UNKNOWN_ISSUE_CODE, detail: { code } }
    }
    if (KNOWN_ISSUE_BLOCKS_IMPORT[code]) {
      // A blocking code on a row that claims ready/ready_with_warnings is
      // an internal contradiction — the browser's outcome computation may
      // be stale, tampered with, or buggy; block rather than trust either
      // signal alone.
      return { eligible: false, reasonCode: BLOCK_REASONS.BLOCKING_ISSUE_ON_ELIGIBLE_OUTCOME, detail: { code } }
    }
    if (outcome === 'ready_with_warnings' && !APPROVED_WARNING_CODES.includes(code)) {
      return { eligible: false, reasonCode: BLOCK_REASONS.UNAPPROVED_WARNING_CODE, detail: { code } }
    }
  }

  const normalized = row.normalized || {}
  for (const field of REQUIRED_MATERIAL_FIELDS) {
    if (normalized[field] == null || normalized[field] === '') {
      return { eligible: false, reasonCode: BLOCK_REASONS.MISSING_MATERIAL_FIELD, detail: { field } }
    }
  }

  if (normalized.status && UNSUPPORTED_STATUS_VALUES.includes(normalized.status)) {
    return { eligible: false, reasonCode: BLOCK_REASONS.UNSUPPORTED_STATUS_VALUE, detail: { status: normalized.status } }
  }

  return { eligible: true, reasonCode: null, detail: {} }
}

// File-level gate: a file-level rejected result (fileIssues non-empty /
// top-level outcome === 'rejected') means persistence must never start at
// all, regardless of any individual row's own outcome.
export function evaluateFileEligibility(pipelineResult) {
  if (!pipelineResult || typeof pipelineResult !== 'object') {
    return { eligible: false, reasonCode: BLOCK_REASONS.FILE_LEVEL_REJECTED, detail: { message: 'pipeline result is missing' } }
  }
  if (pipelineResult.outcome === 'rejected' || (pipelineResult.fileIssues && pipelineResult.fileIssues.length > 0)) {
    return { eligible: false, reasonCode: BLOCK_REASONS.FILE_LEVEL_REJECTED, detail: { fileIssues: pipelineResult.fileIssues } }
  }
  return { eligible: true, reasonCode: null, detail: {} }
}

// Convenience: evaluate every row in a pipeline result, returning
// { eligible: Row[], blocked: { row, reasonCode, detail }[] }.
export function evaluateAllRows(pipelineResult) {
  const fileGate = evaluateFileEligibility(pipelineResult)
  if (!fileGate.eligible) {
    return { eligible: [], blocked: [], fileBlocked: fileGate }
  }
  const eligible = []
  const blocked = []
  for (const row of pipelineResult.rows || []) {
    const result = evaluateRowEligibility(row)
    if (result.eligible) eligible.push(row)
    else blocked.push({ row, reasonCode: result.reasonCode, detail: result.detail })
  }
  return { eligible, blocked, fileBlocked: null }
}
