// Orchestrates one uploaded sheet into structured, previewable row results:
// parse -> map -> normalize -> validate. No Supabase/DB access, no client
// identity resolution (that's PR #22's canonical resolver — Phase 1.5B).
import {
  TARGET_FIELDS,
  detectDuplicateHeaders,
  missingRequiredMappings,
  normalizeStatus,
  hasUsableClientIdentityMapping,
  hasUsableClientIdentityValue,
} from './fields.js'
import { parseDateValue, classifyNumericDate, detectMixedDateConvention } from './dates.js'
import { parseAmount, normalizeCurrencyCode, compareAmounts } from './money.js'
import { buildDuplicateKey, findDuplicateGroups } from './duplicates.js'
import { makeIssue, ISSUE_CODES } from './issues.js'
import { computeOutcome, summarizeOutcomes, OUTCOMES } from './outcome.js'
import { cellAt } from './parse.js'
import { ROW_LIMIT } from './limits.js'

const DATE_FIELD_KEYS = ['invoice_date', 'due_date', 'payment_date']

function cleanText(raw) {
  if (raw == null) return ''
  if (raw instanceof Date) return raw.toISOString()
  return String(raw).trim().replace(/\s+/g, ' ')
}

// Source identifiers are opaque, system-generated IDs, not human names —
// only outer whitespace is trimmed; internal whitespace/case are preserved
// exactly (Correction 4). The generic human-text cleanText() above must
// never touch these two fields.
const EXACT_TEXT_FIELD_KEYS = new Set(['source_client_id', 'source_invoice_id'])

function cleanExactId(raw) {
  if (raw == null) return ''
  if (raw instanceof Date) return raw.toISOString()
  return String(raw).trim()
}

function fieldDef(key) {
  return TARGET_FIELDS.find((f) => f.key === key)
}

function findColumnIndex(mapping, fieldKey) {
  const entry = Object.entries(mapping).find(([, key]) => key === fieldKey)
  return entry ? Number(entry[0]) : null
}

// Resolves one mapped field's raw cell value for one row, handling
// formula-cell truthfulness up front so every downstream parser only ever
// sees either a real value or a clean `null` (never a stale/unavailable
// formula artifact) and never emits a duplicate issue for the same cell.
function getFieldRaw(row, mapping, fieldKey, rowNumber) {
  const columnId = findColumnIndex(mapping, fieldKey)
  if (columnId == null) return { raw: null, columnId: null, issues: [], skipRequiredCheck: false }

  const cell = cellAt(row.cells, columnId)
  const field = fieldDef(fieldKey)
  const issues = []

  if (cell.isFormula) {
    if (!cell.hasCachedValue) {
      issues.push(
        makeIssue({
          code: ISSUE_CODES.FORMULA_VALUE_UNAVAILABLE,
          severity: field.required ? 'error' : 'warning',
          rowNumber,
          columnId,
          field: fieldKey,
          rawValue: { formula: cell.formula },
          normalizedValue: null,
          message: field.required
            ? `Formula in a required column ("${field.label}") has no usable cached value.`
            : `Formula in "${field.label}" has no usable cached value; left blank.`,
          blocksPreview: false,
          blocksImport: Boolean(field.required),
          requiresUserChoice: false,
        })
      )
      return { raw: null, columnId, issues, skipRequiredCheck: Boolean(field.required) }
    }
    issues.push(
      makeIssue({
        code: ISSUE_CODES.FORMULA_CACHED_VALUE_USED,
        severity: 'warning',
        rowNumber,
        columnId,
        field: fieldKey,
        rawValue: { formula: cell.formula },
        normalizedValue: cell.raw,
        message: `"${field.label}" contained a formula; its cached result was used.`,
        blocksPreview: false,
        blocksImport: false,
        requiresUserChoice: false,
      })
    )
  }

  return { raw: cell.raw, columnId, issues, skipRequiredCheck: false }
}

function requiredValueIssue(rowNumber, columnId, fieldKey) {
  const field = fieldDef(fieldKey)
  return makeIssue({
    code: ISSUE_CODES.MISSING_REQUIRED_VALUE,
    severity: 'error',
    rowNumber,
    columnId,
    field: fieldKey,
    rawValue: null,
    normalizedValue: null,
    message: `"${field.label}" is required and was blank.`,
    blocksPreview: false,
    blocksImport: true,
    requiresUserChoice: false,
  })
}

function processDateField({ fieldKey, raw, columnId, rowNumber, dateSystem, effectiveConvention, mixedDetected, required }) {
  const issues = []
  const field = fieldDef(fieldKey)

  // When this mapped date column has conflicting forced MDY/DMY evidence
  // elsewhere in itself, EVERY nonblank numeric slash/dash date in this
  // column is affected — including rows whose own value would otherwise
  // be unambiguously forced one way or the other (e.g. 25/03/2025 and
  // 03/25/2025 sitting in the same column are each individually
  // resolvable in isolation, but together they prove this column doesn't
  // consistently use one convention, so neither may be auto-resolved).
  // Deterministic ISO/named-month dates never match classifyNumericDate,
  // so they fall through untouched below, and this check is entirely
  // scoped to `raw`/`fieldKey` — a different mapped date column is
  // unaffected regardless of its own mixedDetected state.
  if (mixedDetected && typeof raw === 'string' && raw.trim()) {
    const classification = classifyNumericDate(raw.trim())
    if (classification && (classification.kind === 'ambiguous' || classification.kind === 'forced-mdy' || classification.kind === 'forced-dmy')) {
      issues.push(
        makeIssue({
          code: ISSUE_CODES.MIXED_DATE_FORMATS,
          severity: 'warning',
          rowNumber,
          columnId,
          field: fieldKey,
          rawValue: raw,
          normalizedValue: null,
          message: `"${field.label}" mixes Month/Day/Year and Day/Month/Year dates within this column — this value cannot be auto-resolved and needs a manual choice.`,
          blocksPreview: false,
          blocksImport: true,
          requiresUserChoice: true,
        })
      )
      return { value: null, issues }
    }
  }

  const result = parseDateValue(raw, { convention: effectiveConvention, dateSystem })

  if (result.code === 'AMBIGUOUS_DATE_FORMAT') {
    issues.push(
      makeIssue({
        code: ISSUE_CODES.AMBIGUOUS_DATE_FORMAT,
        severity: 'warning',
        rowNumber,
        columnId,
        field: fieldKey,
        rawValue: raw,
        normalizedValue: null,
        message: `"${field.label}" is ambiguous ("${raw}") — choose Month/Day/Year or Day/Month/Year for this column.`,
        blocksPreview: false,
        blocksImport: true,
        requiresUserChoice: true,
      })
    )
    return { value: null, issues }
  }

  if (result.code === 'INVALID_DATE') {
    issues.push(
      makeIssue({
        code: ISSUE_CODES.INVALID_DATE,
        severity: 'error',
        rowNumber,
        columnId,
        field: fieldKey,
        rawValue: raw,
        normalizedValue: null,
        message: `"${field.label}" could not be read as a date: "${raw}".`,
        blocksPreview: false,
        blocksImport: true,
        requiresUserChoice: false,
      })
    )
    return { value: null, issues }
  }

  if (result.value == null && required) {
    issues.push(requiredValueIssue(rowNumber, columnId, fieldKey))
    return { value: null, issues }
  }

  return { value: result.value, issues }
}

function processAmountField({ fieldKey, raw, columnId, rowNumber, required }) {
  const issues = []
  const field = fieldDef(fieldKey)
  const result = parseAmount(raw)

  if (result.blank) {
    if (required) issues.push(requiredValueIssue(rowNumber, columnId, fieldKey))
    return { value: null, issues }
  }

  if (result.error === 'AMBIGUOUS_AMOUNT_FORMAT') {
    issues.push(
      makeIssue({
        code: ISSUE_CODES.AMBIGUOUS_AMOUNT_FORMAT,
        severity: 'warning',
        rowNumber,
        columnId,
        field: fieldKey,
        rawValue: raw,
        normalizedValue: null,
        message: `"${field.label}" amount "${raw}" uses an ambiguous thousands/decimal separator.`,
        blocksPreview: false,
        blocksImport: true,
        requiresUserChoice: true,
      })
    )
    return { value: null, issues }
  }

  if (result.error === 'INVALID_AMOUNT') {
    issues.push(
      makeIssue({
        code: ISSUE_CODES.INVALID_AMOUNT,
        severity: 'error',
        rowNumber,
        columnId,
        field: fieldKey,
        rawValue: raw,
        normalizedValue: null,
        message: `"${field.label}" could not be read as an amount: "${raw}".`,
        blocksPreview: false,
        blocksImport: true,
        requiresUserChoice: false,
      })
    )
    return { value: null, issues }
  }

  return { value: result.value, issues }
}

// One full pass over every mapped date field in every data row, purely to
// gather numeric-date classifications for PER-COLUMN mixed-convention
// detection — no values are resolved here. Each mapped date field
// (invoice_date / due_date / payment_date) is its own independent column:
// forced MDY evidence in one column must never be compared against forced
// DMY evidence in a different column.
function collectDateClassificationsByField(dataRows, mapping) {
  const byField = {}
  for (const fieldKey of DATE_FIELD_KEYS) byField[fieldKey] = []
  for (const row of dataRows) {
    for (const fieldKey of DATE_FIELD_KEYS) {
      const columnId = findColumnIndex(mapping, fieldKey)
      if (columnId == null) continue
      const cell = cellAt(row.cells, columnId)
      if (typeof cell.raw !== 'string') continue
      const classification = classifyNumericDate(cell.raw.trim())
      if (classification) byField[fieldKey].push(classification)
    }
  }
  return byField
}

function rejectedFileResult(issues) {
  return {
    outcome: OUTCOMES.REJECTED,
    fileIssues: issues,
    rows: [],
    summary: { ready: 0, ready_with_warnings: 0, review_required: 0, rejected: 0, total: 0 },
  }
}

// Main entry point. `sheet` is one already-selected, already-parsed sheet
// from parse.js (`{ name, rows: SheetRow[] }`). Returns:
//   { outcome, fileIssues, rows, summary }
// `outcome` is only a single top-level value ('rejected') when the whole
// file was rejected before any row was processed (empty/headers-only/
// duplicate headers/missing required mapping/row-limit exceeded); otherwise
// it is null and each row carries its own `outcome`.
// `dateConvention` is a PER-FIELD map, not one global choice, e.g.
// `{ invoice_date: 'MDY', due_date: 'DMY' }`. Each of invoice_date/
// due_date/payment_date may use a different confirmed convention (or none
// yet) in the same file; a field with no entry is treated as undecided.
export function normalizeImportFile({
  sheet,
  hasHeaderRow = true,
  mapping = {},
  dateSystem = '1900',
  dateConvention = {},
  defaultCurrency = null,
}) {
  if (!sheet || sheet.rows.length === 0) {
    return rejectedFileResult([
      makeIssue({
        code: ISSUE_CODES.EMPTY_FILE,
        severity: 'error',
        message: 'The file (or selected sheet) has no data.',
        blocksImport: true,
        blocksPreview: true,
      }),
    ])
  }

  const headerRow = hasHeaderRow ? sheet.rows[0] : null
  const dataRows = hasHeaderRow ? sheet.rows.slice(1) : sheet.rows
  const columnCount = Math.max(...sheet.rows.map((r) => r.cells.length))
  const headers = hasHeaderRow
    ? headerRow.cells.map((c) => cleanText(c.raw))
    : Array.from({ length: columnCount }, (_, i) => `Column ${i + 1}`)

  if (dataRows.length === 0) {
    return rejectedFileResult([
      makeIssue({
        code: ISSUE_CODES.HEADERS_ONLY,
        severity: 'error',
        message: 'The file only contains a header row — no data rows to import.',
        blocksImport: true,
        blocksPreview: true,
      }),
    ])
  }

  if (hasHeaderRow) {
    const dupes = detectDuplicateHeaders(headers)
    if (dupes.length > 0) {
      return rejectedFileResult(
        dupes.map(({ header, indices }) =>
          makeIssue({
            code: ISSUE_CODES.DUPLICATE_HEADER,
            severity: 'error',
            columnId: indices[0],
            rawValue: header,
            message: `Column header "${header}" appears more than once (columns ${indices.join(', ')}).`,
            blocksImport: true,
            blocksPreview: true,
          })
        )
      )
    }
  }

  const missingMappings = missingRequiredMappings(mapping)
  const identityMappingMissing = !hasUsableClientIdentityMapping(mapping)
  if (missingMappings.length > 0 || identityMappingMissing) {
    const issues = missingMappings.map((key) =>
      makeIssue({
        code: ISSUE_CODES.MISSING_REQUIRED_MAPPING,
        severity: 'error',
        field: key,
        message: `No column is mapped to required field "${fieldDef(key).label}".`,
        blocksImport: true,
        blocksPreview: true,
      })
    )
    if (identityMappingMissing) {
      issues.push(
        makeIssue({
          code: ISSUE_CODES.MISSING_REQUIRED_MAPPING,
          severity: 'error',
          message:
            'No column is mapped to a usable client identity (email, name, company, phone + name/company, or source system + source client ID).',
          blocksImport: true,
          blocksPreview: true,
        })
      )
    }
    return rejectedFileResult(issues)
  }

  if (dataRows.length > ROW_LIMIT) {
    return rejectedFileResult([
      makeIssue({
        code: ISSUE_CODES.ROW_LIMIT_EXCEEDED,
        severity: 'error',
        rawValue: dataRows.length,
        message: `File has ${dataRows.length} data rows, over the ${ROW_LIMIT}-row limit. Split the file and try again.`,
        blocksImport: true,
        blocksPreview: true,
      }),
    ])
  }

  // Validate the file-level default-currency decision ONCE, up front.
  // `null`/`undefined` (no decision made yet) is legitimate and leaves
  // blank-currency rows individually review_required — it is NOT an
  // error. But if a decision WAS supplied (including an empty string,
  // which is never treated as an approved default), it must be a real
  // supported code or the whole file is blocked — an invalid decision is
  // never silently copied into normalized rows.
  let validatedDefaultCurrency = null
  if (defaultCurrency != null) {
    const decision = normalizeCurrencyCode(defaultCurrency)
    if (decision.blank || decision.error === 'UNSUPPORTED_CURRENCY') {
      return rejectedFileResult([
        makeIssue({
          code: ISSUE_CODES.UNSUPPORTED_CURRENCY,
          severity: 'error',
          rawValue: defaultCurrency,
          message: `The supplied file-level default currency ("${defaultCurrency}") is not a supported currency and cannot be applied.`,
          blocksImport: true,
          blocksPreview: true,
        }),
      ])
    }
    validatedDefaultCurrency = decision.value
  }

  const classificationsByField = collectDateClassificationsByField(dataRows, mapping)
  const mixedByField = {}
  const effectiveConventionByField = {}
  for (const fieldKey of DATE_FIELD_KEYS) {
    mixedByField[fieldKey] = detectMixedDateConvention(classificationsByField[fieldKey])
    // Never fall back to a global convention: a field with its own mixed
    // evidence ignores any supplied choice; every other field only ever
    // sees its own per-field decision, never another column's.
    effectiveConventionByField[fieldKey] = mixedByField[fieldKey] ? null : dateConvention?.[fieldKey] ?? null
  }

  const rows = dataRows.map((row) =>
    buildRowResult(row, {
      mapping,
      headers,
      dateSystem,
      effectiveConventionByField,
      mixedByField,
      defaultCurrency: validatedDefaultCurrency,
      sourceSheet: sheet.name,
    })
  )

  // Third pass: duplicate detection needs every row's key at once.
  const entries = rows.map((r, i) => ({ index: i, key: r.duplicateKey }))
  const dupGroups = findDuplicateGroups(entries)
  for (const indices of dupGroups.values()) {
    for (const i of indices) {
      const others = indices.filter((x) => x !== i).map((x) => rows[x].originalRowNumber)
      rows[i].issues.push(
        makeIssue({
          code: ISSUE_CODES.DUPLICATE_IN_UPLOAD,
          severity: 'warning',
          rowNumber: rows[i].originalRowNumber,
          rawValue: rows[i].duplicateKey,
          message: `Duplicate within this upload (also row ${others.join(', ')}).`,
          blocksImport: true,
          requiresUserChoice: true,
        })
      )
      rows[i].outcome = computeOutcome(rows[i].issues)
    }
  }

  return { outcome: null, fileIssues: [], rows, summary: summarizeOutcomes(rows) }
}

function buildRowResult(row, { mapping, headers, dateSystem, effectiveConventionByField, mixedByField, defaultCurrency, sourceSheet }) {
  const rowNumber = row.rowNumber
  const issues = []
  const raw = {}
  const normalized = {}

  if (row.cells.length !== headers.length) {
    issues.push(
      makeIssue({
        code: ISSUE_CODES.ROW_COLUMN_COUNT_MISMATCH,
        severity: 'warning',
        rowNumber,
        rawValue: row.cells.length,
        normalizedValue: headers.length,
        message: `Row has ${row.cells.length} columns; the header row has ${headers.length}.`,
        blocksPreview: false,
        blocksImport: false,
        requiresUserChoice: false,
      })
    )
  }

  // ---- text fields ----
  for (const key of ['client_name', 'client_company', 'client_email', 'client_phone', 'source_system', 'source_client_id', 'source_invoice_id', 'invoice_number', 'notes']) {
    const field = fieldDef(key)
    const { raw: value, columnId, issues: fieldIssues, skipRequiredCheck } = getFieldRaw(row, mapping, key, rowNumber)
    issues.push(...fieldIssues)
    raw[key] = value
    let text = EXACT_TEXT_FIELD_KEYS.has(key) ? cleanExactId(value) : cleanText(value)
    if (key === 'client_email') text = text.toLowerCase()
    normalized[key] = text || null
    if (field.required && !text && !skipRequiredCheck) {
      issues.push(requiredValueIssue(rowNumber, columnId, key))
    }
  }

  // ---- client identity (one-of group, not a single required field) ----
  if (!hasUsableClientIdentityValue(normalized)) {
    issues.push(
      makeIssue({
        code: ISSUE_CODES.MISSING_REQUIRED_VALUE,
        severity: 'error',
        rowNumber,
        message:
          'No usable client identity value is present for this row (email, name, company, phone + name/company, or source system + source client ID).',
        blocksImport: true,
        requiresUserChoice: false,
      })
    )
  }

  // ---- status ----
  {
    const { raw: value, columnId, issues: fieldIssues } = getFieldRaw(row, mapping, 'status', rowNumber)
    issues.push(...fieldIssues)
    raw.status = value
    const result = normalizeStatus(value)
    normalized.status = result.value
    if (result.error === 'UNKNOWN_STATUS') {
      issues.push(
        makeIssue({
          code: ISSUE_CODES.UNKNOWN_STATUS,
          severity: 'warning',
          rowNumber,
          columnId,
          field: 'status',
          rawValue: value,
          normalizedValue: null,
          message: `Status "${value}" is not recognized.`,
          blocksPreview: false,
          blocksImport: true,
          requiresUserChoice: true,
        })
      )
    }
  }

  // ---- dates ----
  const dateValues = {}
  for (const key of DATE_FIELD_KEYS) {
    const field = fieldDef(key)
    const { raw: value, columnId, issues: fieldIssues, skipRequiredCheck } = getFieldRaw(row, mapping, key, rowNumber)
    issues.push(...fieldIssues)
    raw[key] = value
    if (skipRequiredCheck) {
      dateValues[key] = null
      normalized[key] = null
      continue
    }
    const { value: dateValue, issues: dateIssues } = processDateField({
      fieldKey: key,
      raw: value,
      columnId,
      rowNumber,
      dateSystem,
      effectiveConvention: effectiveConventionByField[key],
      mixedDetected: mixedByField[key],
      required: field.required,
    })
    issues.push(...dateIssues)
    dateValues[key] = dateValue
    normalized[key] = dateValue
  }

  // ---- amount / amount_paid ----
  const amounts = {}
  for (const key of ['amount', 'amount_paid']) {
    const field = fieldDef(key)
    const { raw: value, columnId, issues: fieldIssues, skipRequiredCheck } = getFieldRaw(row, mapping, key, rowNumber)
    issues.push(...fieldIssues)
    raw[key] = value
    if (skipRequiredCheck) {
      amounts[key] = null
      normalized[key] = null
      continue
    }
    const { value: amountValue, issues: amountIssues } = processAmountField({
      fieldKey: key,
      raw: value,
      columnId,
      rowNumber,
      required: field.required,
    })
    issues.push(...amountIssues)
    amounts[key] = amountValue
    normalized[key] = amountValue
  }

  if (amounts.amount != null && compareAmounts(amounts.amount, '0.00') <= 0) {
    issues.push(
      makeIssue({
        code: ISSUE_CODES.INVALID_AMOUNT,
        severity: 'error',
        rowNumber,
        field: 'amount',
        rawValue: raw.amount,
        normalizedValue: amounts.amount,
        message: 'Invoice amount must be greater than zero. Negative invoices and credit notes are not supported yet.',
        blocksImport: true,
        requiresUserChoice: false,
      })
    )
    amounts.amount = null
    normalized.amount = null
  }

  if (amounts.amount_paid != null && compareAmounts(amounts.amount_paid, '0.00') < 0) {
    issues.push(
      makeIssue({
        code: ISSUE_CODES.INVALID_AMOUNT,
        severity: 'error',
        rowNumber,
        field: 'amount_paid',
        rawValue: raw.amount_paid,
        normalizedValue: amounts.amount_paid,
        message: 'Amount paid must be zero or greater.',
        blocksImport: true,
        requiresUserChoice: false,
      })
    )
    amounts.amount_paid = null
    normalized.amount_paid = null
  }

  let fullyPaidByAmount = false
  if (amounts.amount != null && amounts.amount_paid != null) {
    const cmp = compareAmounts(amounts.amount_paid, amounts.amount)
    if (cmp > 0) {
      issues.push(
        makeIssue({
          code: ISSUE_CODES.AMOUNT_PAID_EXCEEDS_AMOUNT,
          severity: 'error',
          rowNumber,
          field: 'amount_paid',
          rawValue: raw.amount_paid,
          normalizedValue: amounts.amount_paid,
          message: `Amount paid (${amounts.amount_paid}) exceeds the invoice amount (${amounts.amount}).`,
          blocksImport: true,
          requiresUserChoice: false,
        })
      )
    } else if (cmp < 0 && compareAmounts(amounts.amount_paid, '0.00') > 0) {
      issues.push(
        makeIssue({
          code: ISSUE_CODES.PARTIAL_PAYMENT_REVIEW,
          severity: 'warning',
          rowNumber,
          field: 'amount_paid',
          rawValue: raw.amount_paid,
          normalizedValue: amounts.amount_paid,
          message: `Amount paid (${amounts.amount_paid}) is less than the invoice amount (${amounts.amount}) — partial payment.`,
          blocksImport: true,
          requiresUserChoice: true,
        })
      )
    } else if (cmp === 0) {
      fullyPaidByAmount = true
    }
  }

  // ---- currency ----
  {
    const { raw: value, columnId, issues: fieldIssues } = getFieldRaw(row, mapping, 'currency', rowNumber)
    issues.push(...fieldIssues)
    raw.currency = value
    const result = normalizeCurrencyCode(value)
    if (result.error === 'UNSUPPORTED_CURRENCY') {
      normalized.currency = null
      issues.push(
        makeIssue({
          code: ISSUE_CODES.UNSUPPORTED_CURRENCY,
          severity: 'error',
          rowNumber,
          columnId,
          field: 'currency',
          rawValue: value,
          normalizedValue: null,
          message: `Currency "${value}" is not recognized or not yet supported.`,
          blocksImport: true,
          requiresUserChoice: false,
        })
      )
    } else if (result.blank) {
      if (defaultCurrency) {
        normalized.currency = defaultCurrency
      } else {
        normalized.currency = null
        issues.push(
          makeIssue({
            code: ISSUE_CODES.CURRENCY_DECISION_REQUIRED,
            severity: 'warning',
            rowNumber,
            columnId,
            field: 'currency',
            rawValue: null,
            normalizedValue: null,
            message: 'No currency was supplied and no file-level default currency has been chosen yet.',
            blocksImport: true,
            requiresUserChoice: true,
          })
        )
      }
    } else {
      normalized.currency = result.value
    }
  }

  // ---- paid fact / payment_timing_known ----
  const isPaid = normalized.status === 'paid' || fullyPaidByAmount
  const paymentTimingKnown = normalized.payment_date != null
  if (isPaid && !paymentTimingKnown) {
    issues.push(
      makeIssue({
        code: ISSUE_CODES.PAID_WITHOUT_PAYMENT_DATE,
        severity: 'warning',
        rowNumber,
        field: 'payment_date',
        rawValue: raw.payment_date,
        normalizedValue: null,
        message: 'Invoice is paid but no payment date was supplied.',
        blocksPreview: false,
        blocksImport: false,
        requiresUserChoice: false,
      })
    )
  }

  // ---- duplicate key (grouped across the whole file by the caller) ----
  const { key: duplicateKey, incomplete } = buildDuplicateKey({
    source_system: normalized.source_system,
    source_invoice_id: normalized.source_invoice_id,
    source_client_id: normalized.source_client_id,
    client_email: normalized.client_email,
    client_company: normalized.client_company,
    client_name: normalized.client_name,
    client_phone: normalized.client_phone,
    invoice_number: normalized.invoice_number,
  })
  if (incomplete) {
    issues.push(
      makeIssue({
        code: ISSUE_CODES.DUPLICATE_DETECTION_INCOMPLETE,
        severity: 'info',
        rowNumber,
        rawValue: null,
        normalizedValue: null,
        message: 'No reliable client reference was available, so duplicate detection could not run for this row.',
        blocksPreview: false,
        blocksImport: false,
        requiresUserChoice: false,
      })
    )
  }

  const result = {
    originalRowNumber: rowNumber,
    sourceSheet,
    raw,
    normalized,
    mapping,
    issues,
    duplicateKey,
    payment_timing_known: paymentTimingKnown,
  }
  result.outcome = computeOutcome(issues)
  return result
}
