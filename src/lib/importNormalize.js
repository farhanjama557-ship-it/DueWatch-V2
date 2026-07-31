// Pure normalization + ambiguity detection for one uploaded row at a time,
// plus a cross-row duplicate-invoice-number check. No DB access, no client
// identity resolution — that's PR #22's canonical resolver's job, deliberately
// out of scope here (see IMPORT_STATUS_NOTE in Import.jsx).
import { TARGET_FIELDS } from './importFields'

function pad2(n) {
  return String(n).padStart(2, '0')
}

function ymd(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`
}

// Excel's day-zero, in UTC — Excel serial dates have no timezone of their
// own, so every conversion here stays in UTC to avoid a local-timezone
// off-by-one on the resulting calendar date.
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30)

// Accepts a Date (from Excel's own date-formatted cells), a number (an Excel
// serial date that wasn't cell-formatted as a date), or a string (from CSV,
// or an Excel text cell). Always normalizes to YYYY-MM-DD, matching
// lib/format.js's parseDate and the Postgres `date` columns this will
// eventually write to.
export function parseFlexibleDate(raw) {
  if (raw == null || raw === '') return { value: null, error: null }

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { value: null, error: `Unreadable date: "${raw}"` }
    return { value: ymd(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate()), error: null }
  }

  if (typeof raw === 'number') {
    const d = new Date(EXCEL_EPOCH_UTC_MS + raw * 86400000)
    if (Number.isNaN(d.getTime())) return { value: null, error: `Unreadable date: "${raw}"` }
    return { value: ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), error: null }
  }

  const str = String(raw).trim()
  if (!str) return { value: null, error: null }

  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return { value: ymd(+m[1], +m[2], +m[3]), error: null }

  // Numeric slash/dash dates. Assumed month-first (US convention, matching
  // this app's own en-US date formatting) unless the first number can't be a
  // month, in which case treated as day-first — a disclosed judgment call,
  // not a full locale-detection system.
  m = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (m) {
    let [, a, b, y] = m
    a = +a
    b = +b
    let year = +y
    if (year < 100) year += year < 70 ? 2000 : 1900
    let month = a
    let day = b
    if (a > 12 && b <= 12) {
      month = b
      day = a
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { value: ymd(year, month, day), error: null }
    }
    return { value: null, error: `Unreadable date: "${raw}"` }
  }

  // Named-month text ("Jan 5, 2026") — only trust Date.parse when the string
  // actually contains letters, since its numeric-only parsing is inconsistent
  // across engines and already handled explicitly above.
  if (/[a-zA-Z]/.test(str)) {
    const parsed = new Date(str)
    if (!Number.isNaN(parsed.getTime())) {
      return { value: ymd(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate()), error: null }
    }
  }

  return { value: null, error: `Unreadable date: "${raw}"` }
}

// Strips currency symbols/thousands separators; treats parenthesized values
// as negative (accounting notation, e.g. a credit memo).
export function parseFlexibleAmount(raw) {
  if (raw == null || raw === '') return { value: null, error: null }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { value: null, error: `Unreadable amount: "${raw}"` }
    return { value: raw, error: null }
  }

  let str = String(raw).trim()
  if (!str) return { value: null, error: null }

  let negative = false
  if (/^\(.*\)$/.test(str)) {
    negative = true
    str = str.slice(1, -1)
  }
  str = str.replace(/[^0-9.\-]/g, '')
  if (str === '' || str === '-') return { value: null, error: `Unreadable amount: "${raw}"` }

  const n = Number(str)
  if (!Number.isFinite(n)) return { value: null, error: `Unreadable amount: "${raw}"` }
  return { value: negative ? -Math.abs(n) : n, error: null }
}

function cleanText(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ')
}

function severity(errors, warnings) {
  if (errors.length) return 'error'
  if (warnings.length) return 'warning'
  return 'ready'
}

// mapping: { [columnIndex]: targetFieldKey }. Pulls the one column (if any)
// mapped to each target field, normalizes it, and flags anything that would
// block or merely deserve review — without touching a database.
export function normalizeRow(rawRow, mapping) {
  const rawByField = {}
  TARGET_FIELDS.forEach((f) => {
    const idx = Object.keys(mapping).find((i) => mapping[i] === f.key)
    rawByField[f.key] = idx !== undefined ? rawRow[idx] : undefined
  })

  const errors = []
  const warnings = []

  const clientName = cleanText(rawByField.client_name)
  const clientEmail = cleanText(rawByField.client_email).toLowerCase()
  const invoiceNumber = cleanText(rawByField.invoice_number)
  const notes = cleanText(rawByField.notes)

  const invDate = parseFlexibleDate(rawByField.invoice_date)
  const dueDate = parseFlexibleDate(rawByField.due_date)
  const amount = parseFlexibleAmount(rawByField.amount)
  const amountPaid = parseFlexibleAmount(rawByField.amount_paid)

  if (!clientName) errors.push('Missing client name')
  if (!invoiceNumber) errors.push('Missing invoice number')
  if (dueDate.error) errors.push(dueDate.error)
  else if (!dueDate.value) errors.push('Missing due date')
  if (amount.error) errors.push(amount.error)
  else if (amount.value == null) errors.push('Missing amount')
  if (invDate.error) errors.push(invDate.error)
  if (amountPaid.error) errors.push(amountPaid.error)

  if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    warnings.push(`Client email looks invalid: "${rawByField.client_email}"`)
  }
  if (amount.value != null && amount.value <= 0) {
    warnings.push('Amount is zero or negative')
  }
  if (amountPaid.value != null && amount.value != null && amountPaid.value > amount.value) {
    warnings.push('Amount paid exceeds invoice amount')
  }
  if (invDate.value && dueDate.value && invDate.value > dueDate.value) {
    warnings.push('Due date is before invoice date')
  }

  return {
    raw: rawByField,
    values: {
      client_name: clientName || null,
      client_email: clientEmail || null,
      invoice_number: invoiceNumber || null,
      invoice_date: invDate.value,
      due_date: dueDate.value,
      amount: amount.value,
      amount_paid: amountPaid.value,
      notes: notes || null,
    },
    errors,
    warnings,
    status: severity(errors, warnings),
  }
}

// Cross-row check across the whole parsed file: flags invoice numbers that
// repeat within this one upload. Deliberately scoped to "within this file" —
// checking against invoice numbers already in the database is persistence-
// layer work that belongs to PR B, not this preview-only pass.
export function flagDuplicateInvoiceNumbers(normalizedRows) {
  const seen = new Map()
  normalizedRows.forEach((row, i) => {
    const key = (row.values.invoice_number || '').trim().toLowerCase()
    if (!key) return
    if (!seen.has(key)) seen.set(key, [])
    seen.get(key).push(i)
  })

  for (const indices of seen.values()) {
    if (indices.length < 2) continue
    indices.forEach((i) => {
      const others = indices.filter((x) => x !== i).map((x) => x + 1)
      normalizedRows[i].warnings.push(
        `Duplicate invoice # in this file (also row ${others.join(', ')})`
      )
      normalizedRows[i].status = severity(normalizedRows[i].errors, normalizedRows[i].warnings)
    })
  }

  return normalizedRows
}
