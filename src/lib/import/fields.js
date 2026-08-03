// Target field schema for the import engine. `dbField` documents where each
// field will eventually be written in Phase 1.5B — nothing in this engine
// touches a database.
//
// Individually required: invoice_number, invoice_date, amount. Client
// identity is NOT an individually required field — it's a one-of group
// (see CLIENT_IDENTITY_PATHS below), so client_name.required is false here
// even though some usable identity is still mandatory at the row/file
// level. due_date, source ids, status, currency, and payment_date are all
// optional inputs.
export const TARGET_FIELDS = [
  { key: 'client_name', label: 'Client Name', required: false, dbField: 'clients.name' },
  { key: 'client_company', label: 'Client Company', required: false, dbField: 'clients.company' },
  { key: 'client_email', label: 'Client Email', required: false, dbField: 'clients.email' },
  { key: 'client_phone', label: 'Client Phone', required: false, dbField: 'clients.phone' },
  { key: 'source_system', label: 'Source System', required: false, dbField: 'client_source_identities.source' },
  { key: 'source_client_id', label: 'Source Client ID', required: false, dbField: 'client_source_identities.external_id' },
  { key: 'invoice_number', label: 'Invoice #', required: true, dbField: 'invoices.inv_num' },
  { key: 'source_invoice_id', label: 'Source Invoice ID', required: false, dbField: null },
  { key: 'invoice_date', label: 'Invoice Date', required: true, dbField: 'invoices.inv_date' },
  { key: 'due_date', label: 'Due Date', required: false, dbField: 'invoices.due_date' },
  { key: 'status', label: 'Status', required: false, dbField: null },
  { key: 'amount', label: 'Amount', required: true, dbField: 'invoices.amount' },
  { key: 'amount_paid', label: 'Amount Paid', required: false, dbField: 'invoices.amount_paid' },
  { key: 'currency', label: 'Currency', required: false, dbField: null },
  { key: 'payment_date', label: 'Payment Date', required: false, dbField: null },
  { key: 'notes', label: 'Notes', required: false, dbField: 'invoices.notes' },
]

export const REQUIRED_FIELD_KEYS = TARGET_FIELDS.filter((f) => f.required).map((f) => f.key)
export const IGNORE_KEY = '__ignore__'

export function fieldLabel(key) {
  return TARGET_FIELDS.find((f) => f.key === key)?.label ?? key
}

// Own import vocabulary for the optional `status` column — intentionally
// independent of the live schema (which has no status text column; it
// derives status from `invoices.paid` + `due_date`). Phase 1.5B will need
// to translate this vocabulary at write time, same as every other
// `dbField: null` field above.
export const STATUS_VALUES = ['draft', 'sent', 'paid', 'partial', 'overdue', 'void']

export function normalizeStatus(raw) {
  if (raw == null) return { value: null, blank: true, error: null }
  const trimmed = String(raw).trim()
  if (trimmed === '') return { value: null, blank: true, error: null }
  const lower = trimmed.toLowerCase()
  if (STATUS_VALUES.includes(lower)) return { value: lower, blank: false, error: null }
  return { value: null, blank: false, error: 'UNKNOWN_STATUS' }
}

function normalizeHeaderText(h) {
  return String(h ?? '').trim().toLowerCase()
}

// Checked in order, most-specific first, so e.g. "Amount Paid" is claimed
// by amount_paid before the generic "amount" fallback, and "Invoice Date"
// is claimed before invoice_number's `/invoice/` pattern would grab it.
const GUESS_RULES = [
  { key: 'amount_paid', patterns: [/amount ?paid/, /paid ?amount/, /^paid$/] },
  { key: 'due_date', patterns: [/due ?date/, /payment ?due/, /date ?due/, /^due$/] },
  { key: 'payment_date', patterns: [/payment ?date/, /paid ?date/, /date ?paid/] },
  { key: 'invoice_date', patterns: [/invoice ?date/, /issue ?date/, /bill ?date/, /^date$/] },
  { key: 'client_email', patterns: [/email/] },
  { key: 'client_phone', patterns: [/phone/, /tel(ephone)?/] },
  { key: 'source_invoice_id', patterns: [/source ?invoice ?id/, /external ?invoice ?id/] },
  { key: 'source_client_id', patterns: [/source ?client ?id/, /external ?client ?id/, /external ?id/] },
  { key: 'source_system', patterns: [/source ?system/, /^source$/] },
  { key: 'currency', patterns: [/currency/, /^ccy$/] },
  { key: 'status', patterns: [/^status$/, /invoice ?status/, /payment ?status/] },
  {
    key: 'invoice_number',
    patterns: [
      /invoice ?(number|no\.?|num|#)/,
      /^inv[ _-]?(number|no\.?|num|#)?$/,
      /^(invoice|inv)$/,
      /^(#|no\.?)$/,
      /reference/,
      /^ref$/,
    ],
  },
  { key: 'client_company', patterns: [/company/, /organi[sz]ation/, /business ?name/] },
  { key: 'client_name', patterns: [/client/, /customer/, /bill ?to/, /account ?name/, /^name$/] },
  { key: 'amount', patterns: [/grand ?total/, /sub ?total/, /total/, /amount/, /balance/] },
  { key: 'notes', patterns: [/notes?/, /memo/, /description/, /comments?/] },
]

// headers: array of raw header strings (or synthetic "Column N" labels).
// Returns { [columnIndex]: fieldKey } — a best-effort starting point the
// user reviews and can override; never applied silently.
export function guessMapping(headers) {
  const mapping = {}
  const claimed = new Set()
  headers.forEach((header, i) => {
    const norm = normalizeHeaderText(header)
    if (!norm) return
    for (const { key, patterns } of GUESS_RULES) {
      if (claimed.has(key)) continue
      if (patterns.some((p) => p.test(norm))) {
        mapping[i] = key
        claimed.add(key)
        return
      }
    }
  })
  return mapping
}

// Detects duplicate header names (case-insensitive, trimmed) in a header
// row. Returns [{ header, indices }] for every header text that repeats.
export function detectDuplicateHeaders(headers) {
  const seen = new Map()
  headers.forEach((h, i) => {
    const norm = normalizeHeaderText(h)
    if (!norm) return
    if (!seen.has(norm)) seen.set(norm, [])
    seen.get(norm).push(i)
  })
  return [...seen.entries()]
    .filter(([, indices]) => indices.length > 1)
    .map(([header, indices]) => ({ header, indices }))
}

export function missingRequiredMappings(mapping) {
  const mappedKeys = new Set(Object.values(mapping))
  return REQUIRED_FIELD_KEYS.filter((key) => !mappedKeys.has(key))
}

// Client identity is a one-of requirement, not a single required field: any
// ONE of these mapped-field combinations is sufficient. Phone is never
// sufficient alone (it needs name or company alongside it); a source
// client ID is only usable paired with its source system. Being enough to
// satisfy this requirement does NOT automatically make an identity a
// reliable duplicate-matching key — that's governed separately and more
// strictly by duplicates.js.
export const CLIENT_IDENTITY_PATHS = [
  ['source_system', 'source_client_id'],
  ['client_email'],
  ['client_name'],
  ['client_company'],
  ['client_phone', 'client_name'],
  ['client_phone', 'client_company'],
]

export function hasUsableClientIdentityMapping(mapping) {
  const mappedKeys = new Set(Object.values(mapping))
  return CLIENT_IDENTITY_PATHS.some((path) => path.every((key) => mappedKeys.has(key)))
}

// `normalized` is a row's normalized field values ({ [fieldKey]: value }).
export function hasUsableClientIdentityValue(normalized) {
  return CLIENT_IDENTITY_PATHS.some((path) => path.every((key) => Boolean(normalized[key])))
}
