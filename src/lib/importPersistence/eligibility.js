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
  OUTCOME_ISSUE_MISMATCH: 'OUTCOME_ISSUE_MISMATCH',
  WARNINGS_NOT_ACKNOWLEDGED: 'WARNINGS_NOT_ACKNOWLEDGED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  REJECTED: 'REJECTED',
  FILE_LEVEL_REJECTED: 'FILE_LEVEL_REJECTED',
  MISSING_MATERIAL_FIELD: 'MISSING_MATERIAL_FIELD',
  UNSUPPORTED_STATUS_VALUE: 'UNSUPPORTED_STATUS_VALUE',
  UNKNOWN_STATUS_VALUE: 'UNKNOWN_STATUS_VALUE',
  INVALID_DATE_VALUE: 'INVALID_DATE_VALUE',
  INVALID_AMOUNT_VALUE: 'INVALID_AMOUNT_VALUE',
  NON_POSITIVE_AMOUNT: 'NON_POSITIVE_AMOUNT',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  INVALID_AMOUNT_PAID_VALUE: 'INVALID_AMOUNT_PAID_VALUE',
  AMOUNT_PAID_OUT_OF_RANGE: 'AMOUNT_PAID_OUT_OF_RANGE',
  PAID_STATUS_AMOUNT_MISMATCH: 'PAID_STATUS_AMOUNT_MISMATCH',
  WEAK_CLIENT_IDENTITY: 'WEAK_CLIENT_IDENTITY',
})

// The importer engine's own STATUS_VALUES vocabulary — mirrored here (not
// imported) from src/lib/import/fields.js's STATUS_VALUES, for the same
// independent-auditability reason every other allowlist in this module is
// a local copy: this module must never trust the importer engine's own
// claims about what it produced.
const STATUS_VALUES = Object.freeze(['draft', 'sent', 'paid', 'partial', 'overdue', 'void'])

// 'void' has no supported persistence target (see the migration's
// invoice-persistence comment): there is no void/disputed/cancelled
// concept anywhere in the current invoices table, and inventing one here —
// rather than in a separately reviewed, locked contract — would be exactly
// the kind of silent conversion this checkpoint must never do. Any OTHER
// value outside the six known ones is simply unknown and blocks the same
// way: unknown state, never defaulted to allowed.
const UNSUPPORTED_STATUS_VALUES = Object.freeze(['void'])

// Mirrored (not imported) from src/lib/import/money.js's
// SUPPORTED_CURRENCIES, for the same independent-auditability reason as
// STATUS_VALUES above.
const SUPPORTED_CURRENCIES = Object.freeze(['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD'])

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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DECIMAL_AMOUNT_RE = /^-?\d{1,10}\.\d{2}$/

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (m < 1 || m > 12) return false
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return d >= 1 && d <= daysInMonth
}

// Parses the importer's locked decimal-string money format ("1200.00",
// exactly two fraction digits — see money.js). Returns null on anything
// that isn't exactly that shape; never Number()/parseFloat() on the value.
function parseDecimalAmount(value) {
  if (typeof value !== 'string' || !DECIMAL_AMOUNT_RE.test(value)) return null
  return value
}

function amountLessThanOrEqual(a, b) {
  // Both already validated as exactly-two-fraction-digit decimal strings;
  // compare as BigInt minor units to stay exact, same technique money.js
  // itself uses — never float comparison.
  const toMinorUnits = (s) => BigInt(s.replace('-', '').replace('.', '')) * (s.startsWith('-') ? -1n : 1n)
  return toMinorUnits(a) <= toMinorUnits(b)
}

// Returns { eligible: boolean, reasonCode: string|null, detail: object }.
// `row` is one importer-engine row result: { outcome, issues, normalized, ... }.
// `options.warningsAcknowledged` is the run-level, explicit user
// acknowledgement required before any ready_with_warnings row may persist
// (see start_import_run's p_warnings_acknowledged) — a request-level fact,
// not something any individual row can assert about itself.
export function evaluateRowEligibility(row, options = {}) {
  const warningsAcknowledged = options.warningsAcknowledged === true

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

  // A genuine 'ready' outcome (per normalize.js's own computeOutcome) never
  // carries any issue at all: issues.length > 0 always yields
  // 'ready_with_warnings' instead. A row claiming 'ready' while carrying
  // ANY issue code (blocking or not) is therefore internally contradictory
  // and must not silently persist just because the specific code happens
  // to be a real, known, non-blocking one.
  if (outcome === 'ready' && issues.length > 0) {
    return { eligible: false, reasonCode: BLOCK_REASONS.OUTCOME_ISSUE_MISMATCH, detail: { issueCount: issues.length } }
  }

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
    if (!APPROVED_WARNING_CODES.includes(code)) {
      return { eligible: false, reasonCode: BLOCK_REASONS.UNAPPROVED_WARNING_CODE, detail: { code } }
    }
  }

  if (outcome === 'ready_with_warnings' && issues.length > 0 && !warningsAcknowledged) {
    return { eligible: false, reasonCode: BLOCK_REASONS.WARNINGS_NOT_ACKNOWLEDGED, detail: {} }
  }

  const normalized = row.normalized || {}
  for (const field of REQUIRED_MATERIAL_FIELDS) {
    if (normalized[field] == null || normalized[field] === '') {
      return { eligible: false, reasonCode: BLOCK_REASONS.MISSING_MATERIAL_FIELD, detail: { field } }
    }
  }

  if (!isValidIsoDate(normalized.invoice_date)) {
    return { eligible: false, reasonCode: BLOCK_REASONS.INVALID_DATE_VALUE, detail: { field: 'invoice_date' } }
  }
  if (normalized.due_date != null && normalized.due_date !== '' && !isValidIsoDate(normalized.due_date)) {
    return { eligible: false, reasonCode: BLOCK_REASONS.INVALID_DATE_VALUE, detail: { field: 'due_date' } }
  }
  if (normalized.payment_date != null && normalized.payment_date !== '' && !isValidIsoDate(normalized.payment_date)) {
    return { eligible: false, reasonCode: BLOCK_REASONS.INVALID_DATE_VALUE, detail: { field: 'payment_date' } }
  }

  const amount = parseDecimalAmount(normalized.amount)
  if (amount == null) {
    return { eligible: false, reasonCode: BLOCK_REASONS.INVALID_AMOUNT_VALUE, detail: { field: 'amount' } }
  }
  if (amount.startsWith('-') || amount === '0.00') {
    return { eligible: false, reasonCode: BLOCK_REASONS.NON_POSITIVE_AMOUNT, detail: {} }
  }

  if (normalized.currency != null && normalized.currency !== '' && !SUPPORTED_CURRENCIES.includes(normalized.currency)) {
    return { eligible: false, reasonCode: BLOCK_REASONS.UNSUPPORTED_CURRENCY, detail: { currency: normalized.currency } }
  }

  let amountPaid = null
  if (normalized.amount_paid != null && normalized.amount_paid !== '') {
    amountPaid = parseDecimalAmount(normalized.amount_paid)
    if (amountPaid == null) {
      return { eligible: false, reasonCode: BLOCK_REASONS.INVALID_AMOUNT_PAID_VALUE, detail: {} }
    }
    if (amountPaid.startsWith('-') || !amountLessThanOrEqual(amountPaid, amount)) {
      return { eligible: false, reasonCode: BLOCK_REASONS.AMOUNT_PAID_OUT_OF_RANGE, detail: {} }
    }
  }

  const status = normalized.status
  if (status != null && status !== '') {
    if (UNSUPPORTED_STATUS_VALUES.includes(status)) {
      return { eligible: false, reasonCode: BLOCK_REASONS.UNSUPPORTED_STATUS_VALUE, detail: { status } }
    }
    if (!STATUS_VALUES.includes(status)) {
      return { eligible: false, reasonCode: BLOCK_REASONS.UNKNOWN_STATUS_VALUE, detail: { status } }
    }
    // paid/status consistency: a row explicitly marked paid but supplying
    // an amount_paid that isn't the full amount is a contradiction, not a
    // safe partial-paid inference — persistence's locked status->paid
    // translation treats 'paid' as fully paid, full stop.
    if (status === 'paid' && amountPaid != null && amountPaid !== amount) {
      return { eligible: false, reasonCode: BLOCK_REASONS.PAID_STATUS_AMOUNT_MISMATCH, detail: {} }
    }
  }

  // Strong client identity only: automatic persistence may never rely on
  // company/name-only or name-only identity (that is not retry-safe
  // automatic identity). Required: EITHER a source-system + source-
  // client-id pairing (the same strong-identity fast path
  // public.resolve_or_create_client itself already privileges), OR a
  // present client email. Anything weaker (phone/company/name alone) must
  // become an explicit blocked outcome here, before ever reaching the
  // canonical resolver.
  const hasSourceIdentity =
    typeof normalized.source_system === 'string' &&
    normalized.source_system.trim() !== '' &&
    typeof normalized.source_client_id === 'string' &&
    normalized.source_client_id.trim() !== ''
  const hasEmailIdentity = typeof normalized.client_email === 'string' && normalized.client_email.trim() !== ''
  if (!hasSourceIdentity && !hasEmailIdentity) {
    return { eligible: false, reasonCode: BLOCK_REASONS.WEAK_CLIENT_IDENTITY, detail: {} }
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
export function evaluateAllRows(pipelineResult, options = {}) {
  const fileGate = evaluateFileEligibility(pipelineResult)
  if (!fileGate.eligible) {
    return { eligible: [], blocked: [], fileBlocked: fileGate }
  }
  const eligible = []
  const blocked = []
  for (const row of pipelineResult.rows || []) {
    const result = evaluateRowEligibility(row, options)
    if (result.eligible) eligible.push(row)
    else blocked.push({ row, reasonCode: result.reasonCode, detail: result.detail })
  }
  return { eligible, blocked, fileBlocked: null }
}
