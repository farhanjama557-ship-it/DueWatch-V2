import { normalizePaymentAmount } from './payments.js'

// Slice 1 (core lifecycle, happy path only): propose a promise, then
// confirm it. No Broken/Fulfilled/supersession/dunning here -- see
// supabase/migrations/20260822130000_promise_to_pay_foundation.sql's
// header for what is explicitly out of scope and why.
const PROMISE_SOURCES = ['email', 'phone', 'text', 'person', 'reply']

export function buildProposePromiseRequest({ invoiceId, amount, date, source, note }) {
  if (!invoiceId) throw new Error('An invoice is required.')
  const normalizedAmount = normalizePaymentAmount(amount)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) {
    throw new Error('Promised date is required.')
  }
  const normalizedSource = String(source ?? '').trim()
  if (!PROMISE_SOURCES.includes(normalizedSource)) {
    throw new Error('A recognized evidence source is required.')
  }
  return {
    p_invoice_id: invoiceId,
    p_promised_amount: normalizedAmount,
    p_promised_date: date,
    p_source: normalizedSource,
    p_note: String(note ?? '').trim() || null,
  }
}

export function buildConfirmPromiseRequest({ promiseId, amount, date }) {
  if (!promiseId) throw new Error('A promise is required.')
  const normalizedAmount = normalizePaymentAmount(amount)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) {
    throw new Error('Promised date is required.')
  }
  return {
    p_promise_id: promiseId,
    p_promised_amount: normalizedAmount,
    p_promised_date: date,
  }
}

// invoiceId/amount/date/source/note -> propose_promise RPC. Currency is
// never a parameter here -- the RPC derives it server-side from the
// invoice and snapshots it onto the promise; there is no client-facing
// currency or conversion path anywhere in Promise-to-Pay.
export async function proposePromise({ database, ...input }) {
  const request = buildProposePromiseRequest(input)
  const { data, error } = await database.rpc('propose_promise', request)
  if (error) throw new Error(error.message || 'Could not propose promise.')
  return data
}

export async function confirmPromise({ database, ...input }) {
  const request = buildConfirmPromiseRequest(input)
  const { data, error } = await database.rpc('confirm_promise', request)
  if (error) throw new Error(error.message || 'Could not confirm promise.')
  return data
}
