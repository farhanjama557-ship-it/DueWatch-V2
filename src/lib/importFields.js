// Target fields the column mapper offers, and the header-guessing heuristic
// that pre-fills a suggested mapping. `dbField` documents where each field
// will eventually be written (PR B, once PR #22's canonical resolver is
// merged) — nothing in this module touches the database.
export const TARGET_FIELDS = [
  { key: 'client_name', label: 'Client Name', required: true, dbField: 'clients.name' },
  { key: 'client_email', label: 'Client Email', required: false, dbField: 'clients.email' },
  { key: 'invoice_number', label: 'Invoice #', required: true, dbField: 'invoices.inv_num' },
  { key: 'invoice_date', label: 'Invoice Date', required: false, dbField: 'invoices.inv_date' },
  { key: 'due_date', label: 'Due Date', required: true, dbField: 'invoices.due_date' },
  { key: 'amount', label: 'Amount', required: true, dbField: 'invoices.amount' },
  { key: 'amount_paid', label: 'Amount Paid', required: false, dbField: 'invoices.amount_paid' },
  { key: 'notes', label: 'Notes', required: false, dbField: 'invoices.notes' },
]

export const IGNORE_KEY = '__ignore__'

export function fieldLabel(key) {
  return TARGET_FIELDS.find((f) => f.key === key)?.label ?? key
}

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase()
}

// Checked in order, most-specific first, so e.g. "Amount Paid" is claimed by
// amount_paid before the generic "amount" fallback gets a chance at it, and
// "Invoice Date" is claimed by invoice_date before invoice_number's `/invoice/`
// pattern would otherwise grab it.
const GUESS_RULES = [
  { key: 'amount_paid', patterns: [/amount ?paid/, /paid ?amount/, /^paid$/] },
  { key: 'due_date', patterns: [/due ?date/, /payment ?due/, /date ?due/, /^due$/] },
  { key: 'invoice_date', patterns: [/invoice ?date/, /issue ?date/, /bill ?date/, /^date$/] },
  { key: 'client_email', patterns: [/email/] },
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
  { key: 'client_name', patterns: [/client/, /customer/, /company/, /bill ?to/, /account ?name/, /^name$/] },
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
    const norm = normalizeHeader(header)
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
