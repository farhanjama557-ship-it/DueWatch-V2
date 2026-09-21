import { SUPPORTED_CURRENCIES } from './import/money.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONEY_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function dateOnly(value) {
  const raw = String(value || '').slice(0, 10)
  return DATE_RE.test(raw) ? raw : null
}

function cents(value) {
  const raw = String(value ?? '').trim()
  if (!MONEY_RE.test(raw)) return null
  const [whole, fraction = ''] = raw.split('.')
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2))
}

function decimal(value) {
  const c = cents(value)
  if (c == null) throw new Error('Enter a valid amount with at most two decimal places.')
  if (c <= 0n) throw new Error('Promise amount must be greater than zero.')
  return `${c / 100n}.${String(c % 100n).padStart(2, '0')}`
}

function daysBetween(a, b) {
  const left = dateOnly(a)
  const right = dateOnly(b)
  if (!left || !right) return null
  const [ay, am, ad] = left.split('-').map(Number)
  const [by, bm, bd] = right.split('-').map(Number)
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)
  return Math.round(ms / 86400000)
}

function paymentMap(payments) {
  return new Map(safeArray(payments).map((payment) => [payment.id, payment]))
}

function instantMs(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : null
}

export const PROMISE_DUE_SOON_DAYS = 2

export function derivePromiseOperationalState(
  promise,
  { payments = [], allocations = [], asOf = new Date() } = {}
) {
  if (!promise) return { state: 'unknown', fulfilledAmount: 0 }

  const stored = String(promise.status || '').toLowerCase()
  if (stored === 'cancelled') {
    return { state: 'cancelled', fulfilledAmount: 0 }
  }
  if (stored === 'proposed') {
    return { state: 'proposed', fulfilledAmount: 0 }
  }
  if (stored !== 'confirmed') {
    return { state: 'unknown', fulfilledAmount: 0 }
  }

  const byPayment = paymentMap(payments)
  const confirmationDate = dateOnly(promise.confirmed_at)
  const confirmationInstant = instantMs(promise.confirmed_at)
  const promisedMinor = cents(promise.promised_amount) ?? 0n
  let fulfilledMinor = 0n
  const seenAllocations = new Set()

  for (const allocation of safeArray(allocations)) {
    if (allocation?.invoice_id !== promise.invoice_id) continue
    if (allocation?.id && seenAllocations.has(allocation.id)) continue
    if (allocation?.id) seenAllocations.add(allocation.id)

    const payment = byPayment.get(allocation.payment_id)
    if (!payment) continue
    if (payment.origin !== 'founder_manual') continue
    if (payment.reversed_at) continue
    if (String(payment.currency || '').toUpperCase() !== String(promise.currency || '').toUpperCase()) continue

    const paymentDate = dateOnly(payment.payment_date)
    const recordedInstant = instantMs(payment.recorded_at)

    // Fulfillment must be evidence that happened after the promise became
    // confirmed. A back-dated payment or a payment recorded earlier on the
    // same day cannot retroactively satisfy a later promise.
    if (!confirmationDate || confirmationInstant == null) continue
    if (!paymentDate || paymentDate < confirmationDate) continue
    if (recordedInstant == null || recordedInstant < confirmationInstant) continue

    const allocationMinor = cents(allocation.amount)
    if (allocationMinor == null || allocationMinor <= 0n) continue
    fulfilledMinor += allocationMinor
  }

  const fulfilledAmount = Number(fulfilledMinor) / 100
  if (promisedMinor > 0n && fulfilledMinor >= promisedMinor) {
    return { state: 'fulfilled', fulfilledAmount }
  }

  const today = dateOnly(asOf instanceof Date ? asOf.toISOString() : asOf)
  const promisedDate = dateOnly(promise.promised_date)
  if (!today || !promisedDate) return { state: 'confirmed', fulfilledAmount }

  const delta = daysBetween(today, promisedDate)
  if (delta === null) return { state: 'confirmed', fulfilledAmount }
  if (delta < 0) return { state: 'past_due_unresolved', fulfilledAmount }
  if (delta === 0) return { state: 'due_today', fulfilledAmount }
  if (delta <= PROMISE_DUE_SOON_DAYS) return { state: 'due_soon', fulfilledAmount }
  return { state: 'confirmed', fulfilledAmount }
}

export async function loadPromiseWorkspace({ database, userId } = {}) {
  if (!database?.from) throw new Error('Promise workspace requires a database client.')
  if (!userId) throw new Error('Promise workspace requires a user id.')

  const [promiseResult, paymentResult, allocationResult] = await Promise.all([
    database
      .from('promises')
      .select('id,user_id,invoice_id,status,promised_amount,promised_date,currency,source,note,confirmed_at,cancelled_at,created_at,updated_at,invoices(id,inv_num,amount,amount_paid,due_date,currency,clients(id,name,email,phone))')
      .eq('user_id', userId)
      .order('promised_date', { ascending: true }),
    database
      .from('payments')
      .select('id,user_id,payment_date,total_amount,currency,origin,reversed_at,recorded_at')
      .eq('user_id', userId)
      .order('recorded_at', { ascending: false }),
    database
      .from('payment_allocations')
      .select('id,payment_id,invoice_id,amount,created_at,invoices!inner(user_id)')
      .eq('invoices.user_id', userId)
      .order('created_at', { ascending: false }),
  ])

  if (promiseResult.error) throw new Error(promiseResult.error.message || 'Could not load promises.')
  if (paymentResult.error) throw new Error(paymentResult.error.message || 'Could not load promise payment evidence.')
  if (allocationResult.error) throw new Error(allocationResult.error.message || 'Could not load promise payment allocations.')

  const payments = paymentResult.data || []
  const allocations = allocationResult.data || []

  return (promiseResult.data || []).map((promise) => ({
    ...promise,
    operational: derivePromiseOperationalState(promise, { payments, allocations }),
  }))
}

export async function ensureInvoiceCurrency({
  database,
  userId,
  invoiceId,
  currency,
} = {}) {
  if (!database?.from) throw new Error('Invoice currency update requires a database client.')
  if (!userId || !invoiceId) throw new Error('A tenant and invoice are required.')
  const normalized = String(currency || '').trim().toUpperCase()
  if (!SUPPORTED_CURRENCIES.includes(normalized)) {
    throw new Error('Choose a supported invoice currency.')
  }

  const { data: invoice, error: readError } = await database
    .from('invoices')
    .select('id,user_id,currency')
    .eq('user_id', userId)
    .eq('id', invoiceId)
    .maybeSingle()

  if (readError) throw new Error(readError.message || 'Could not load invoice currency.')
  if (!invoice) throw new Error('Invoice not found.')
  if (invoice.currency) {
    if (String(invoice.currency).toUpperCase() !== normalized) {
      throw new Error('The selected currency does not match the invoice currency.')
    }
    return normalized
  }

  const { data: allocations, error: allocationError } = await database
    .from('payment_allocations')
    .select('id')
    .eq('invoice_id', invoiceId)
    .limit(1)

  if (allocationError) throw new Error(allocationError.message || 'Could not verify invoice payment history.')
  if ((allocations || []).length > 0) {
    throw new Error('This legacy invoice already has payment history but no established currency. Review the invoice before recording a promise; DueWatch will not infer its currency.')
  }

  const { data: updated, error: updateError } = await database
    .from('invoices')
    .update({ currency: normalized })
    .eq('user_id', userId)
    .eq('id', invoiceId)
    .is('currency', null)
    .select('id,currency')
    .maybeSingle()

  if (updateError) throw new Error(updateError.message || 'Could not save invoice currency.')
  if (updated?.currency === normalized) return normalized

  const { data: reread, error: rereadError } = await database
    .from('invoices')
    .select('id,currency')
    .eq('user_id', userId)
    .eq('id', invoiceId)
    .maybeSingle()

  if (rereadError) throw new Error(rereadError.message || 'Could not verify invoice currency.')
  if (String(reread?.currency || '').toUpperCase() !== normalized) {
    throw new Error('Invoice currency changed before the promise could be recorded. Refresh and review it.')
  }
  return normalized
}

export async function recordPromise({
  database,
  userId,
  invoiceId,
  amount,
  promisedDate,
  currency = null,
  note = null,
  source = 'founder_manual',
} = {}) {
  if (!database?.from) throw new Error('Promise recording requires a database client.')
  if (!userId || !invoiceId) throw new Error('A tenant and invoice are required.')
  const normalizedAmount = decimal(amount)
  const normalizedDate = dateOnly(promisedDate)
  if (!normalizedDate) throw new Error('A valid promised date is required.')

  const { data: invoice, error: invoiceError } = await database
    .from('invoices')
    .select('id,user_id,amount,amount_paid,currency')
    .eq('user_id', userId)
    .eq('id', invoiceId)
    .maybeSingle()

  if (invoiceError) throw new Error(invoiceError.message || 'Could not load the invoice.')
  if (!invoice) throw new Error('Invoice not found.')
  const resolvedCurrency = invoice.currency
    ? await ensureInvoiceCurrency({ database, userId, invoiceId, currency: invoice.currency })
    : await ensureInvoiceCurrency({ database, userId, invoiceId, currency })

  const balance = Math.max((Number(invoice.amount) || 0) - (Number(invoice.amount_paid) || 0), 0)
  if (Number(normalizedAmount) > balance + 0.000001) {
    throw new Error('Promise amount cannot exceed the current invoice balance.')
  }

  const { data, error } = await database
    .from('promises')
    .insert({
      user_id: userId,
      invoice_id: invoiceId,
      promised_amount: normalizedAmount,
      promised_date: normalizedDate,
      currency: resolvedCurrency,
      source: String(source || 'founder_manual').trim() || 'founder_manual',
      note: String(note || '').trim() || null,
    })
    .select('id,user_id,invoice_id,status,promised_amount,promised_date,currency,source,note,created_at')
    .single()

  if (error) throw new Error(error.message || 'Could not record the promise.')
  return data
}

export async function confirmPromise({ database, userId, promiseId } = {}) {
  if (!database?.from || !userId || !promiseId) throw new Error('Promise confirmation is missing required context.')
  const { data, error } = await database
    .from('promises')
    .update({ status: 'confirmed' })
    .eq('user_id', userId)
    .eq('id', promiseId)
    .eq('status', 'proposed')
    .select('id,status,confirmed_at,updated_at')
    .maybeSingle()
  if (error) throw new Error(error.message || 'Could not confirm the promise.')
  if (!data) throw new Error('The promise is no longer in a confirmable state.')
  return data
}

export async function cancelPromise({ database, userId, promiseId } = {}) {
  if (!database?.from || !userId || !promiseId) throw new Error('Promise cancellation is missing required context.')
  const { data, error } = await database
    .from('promises')
    .update({ status: 'cancelled' })
    .eq('user_id', userId)
    .eq('id', promiseId)
    .in('status', ['proposed', 'confirmed'])
    .select('id,status,cancelled_at,updated_at')
    .maybeSingle()
  if (error) throw new Error(error.message || 'Could not cancel the promise.')
  if (!data) throw new Error('The promise is no longer cancellable.')
  return data
}

export function promiseStateLabel(state) {
  const labels = {
    proposed: 'Needs confirmation',
    confirmed: 'Confirmed',
    due_soon: 'Due soon',
    due_today: 'Due today',
    past_due_unresolved: 'Past due · unresolved',
    fulfilled: 'Fulfilled',
    cancelled: 'Cancelled',
  }
  return labels[state] || 'Unknown'
}

export function promiseStateTone(state) {
  if (state === 'fulfilled') return 'green'
  if (state === 'past_due_unresolved') return 'red'
  if (state === 'due_today' || state === 'due_soon') return 'amber'
  if (state === 'confirmed') return 'blue'
  return 'neutral'
}
