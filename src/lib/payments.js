const MONEY_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/
const CURRENCY_PATTERN = /^[A-Z]{3}$/

export function normalizePaymentAmount(value) {
  const raw = String(value ?? '').trim()
  if (!MONEY_PATTERN.test(raw)) throw new Error('Enter a valid payment amount with at most two decimal places.')
  const [whole, fraction = ''] = raw.split('.')
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2))
  if (cents <= 0n) throw new Error('Payment amount must be greater than zero.')
  // public.payments.total_amount is numeric(12,2).
  if (cents > 999999999999n) throw new Error('Payment amount is too large.')
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}

export function formatPaymentAmount(value, currency) {
  const amount = normalizePaymentAmount(value)
  return `${currency} ${amount}`
}

export function summarizeCollectedPaymentRows(...rowGroups) {
  const rows = rowGroups.flat()
  return {
    sum: rows.reduce((total, row) => total + (Number(row.total_amount) || 0), 0),
    count: rows.length,
  }
}

export function buildInvoicePaymentRequest({ invoiceId, amount, currency, paymentDate, method, note }) {
  if (!invoiceId) throw new Error('An invoice is required.')
  const normalizedAmount = normalizePaymentAmount(amount)
  const normalizedCurrency = String(currency ?? '').trim()
  if (!CURRENCY_PATTERN.test(normalizedCurrency)) {
    throw new Error('This invoice needs an explicit currency before a payment can be recorded.')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(paymentDate ?? ''))) {
    throw new Error('Payment date is required.')
  }
  return {
    p_payment_date: paymentDate,
    p_total_amount: normalizedAmount,
    p_currency: normalizedCurrency,
    p_allocations: [{ invoice_id: invoiceId, amount: normalizedAmount }],
    p_method: String(method ?? '').trim() || null,
    p_note: String(note ?? '').trim() || null,
  }
}

export async function recordInvoicePayment({ database, ...input }) {
  const request = buildInvoicePaymentRequest(input)
  const { data, error } = await database.rpc('record_payment', request)
  if (error) throw new Error(error.message || 'Could not record payment.')
  return data
}

export async function reversePayment({ database, paymentId, reason }) {
  if (!paymentId) throw new Error('Payment ID is required.')
  if (!String(reason ?? '').trim()) throw new Error('Reversal reason is required.')
  const { data, error } = await database.rpc('reverse_payment', {
    p_payment_id: paymentId,
    p_reversal_reason: String(reason).trim(),
  })
  if (error) throw new Error(error.message || 'Could not reverse payment.')
  return data
}
