import { stripeChargeMinorUnitExponent } from './stripeCurrencyMinorUnits.js'

function upper(value) {
  return String(value ?? '').trim().toUpperCase()
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || ''))
}

function invoiceOpen(invoice) {
  const amount = Number(invoice?.amount)
  const paid = Number(invoice?.amount_paid || 0)
  return invoice?.paid !== true && Number.isFinite(amount) && Number.isFinite(paid) && paid < amount
}

function decimalToMinor(value, exponent) {
  const raw = String(value ?? '').trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return null
  const [whole, fraction = ''] = raw.split('.')
  if (fraction.length > exponent) {
    const discarded = fraction.slice(exponent)
    if (!/^0*$/.test(discarded)) return null
  }
  const kept = fraction.slice(0, exponent).padEnd(exponent, '0')
  return BigInt(whole) * (10n ** BigInt(exponent)) + BigInt(kept || '0')
}

function providerMoney(objectType, state) {
  const currency = upper(state?.currency)
  const exponent = stripeChargeMinorUnitExponent(currency)
  if (!currency || exponent == null) {
    return { known: false, currency, exponent: null, amountMinor: null }
  }

  let amountMinor = null
  if (objectType === 'invoice') {
    if (Number.isInteger(state?.total)) amountMinor = String(state.total)
    else if (Number.isInteger(state?.amount_due)) amountMinor = String(state.amount_due)
  } else if (objectType === 'charge') {
    if (Number.isInteger(state?.amount)) amountMinor = String(state.amount)
  }
  return { known: amountMinor != null, currency, exponent, amountMinor }
}

function invoiceMatchesMoney(invoice, money) {
  if (!money.known || upper(invoice?.currency) !== money.currency) return false
  const minor = decimalToMinor(invoice?.amount, money.exponent)
  return minor != null && minor.toString() === money.amountMinor
}

export function deriveStripeInvoiceLinkDecision({
  providerObject,
  invoices = [],
  confirmedProviderInvoiceLinks = {},
} = {}) {
  const objectType = providerObject?.object_type
  const state = providerObject?.object_state || {}
  if (!['invoice', 'charge'].includes(objectType)) {
    return Object.freeze({
      deterministic: null,
      proposals: Object.freeze([]),
      exceptionReason: null,
      reason: 'OBJECT_TYPE_NOT_LINKED',
    })
  }

  const openInvoices = invoices.filter(invoiceOpen)
  const metadataInvoiceId = state?.metadata?.duewatch_invoice_id
  if (validUuid(metadataInvoiceId)) {
    const match = openInvoices.find((invoice) => invoice.id === metadataInvoiceId)
    if (match) {
      return Object.freeze({
        deterministic: Object.freeze({ entityId: match.id, matchBasis: 'metadata' }),
        proposals: Object.freeze([]),
        exceptionReason: null,
        reason: 'DETERMINISTIC_METADATA',
      })
    }
    return Object.freeze({
      deterministic: null,
      proposals: Object.freeze([]),
      exceptionReason: 'NO_MATCH',
      reason: 'METADATA_INVOICE_NOT_FOUND',
    })
  }

  if (objectType === 'charge') {
    const stripeInvoiceId = typeof state?.invoice === 'string' ? state.invoice : null
    const priorEntityId = stripeInvoiceId ? confirmedProviderInvoiceLinks[stripeInvoiceId] : null
    if (validUuid(priorEntityId) && openInvoices.some((invoice) => invoice.id === priorEntityId)) {
      return Object.freeze({
        deterministic: Object.freeze({ entityId: priorEntityId, matchBasis: 'stored_id' }),
        proposals: Object.freeze([]),
        exceptionReason: null,
        reason: 'DETERMINISTIC_STORED_PROVIDER_LINK',
      })
    }
  }

  const money = providerMoney(objectType, state)
  if (!money.currency || money.exponent == null) {
    return Object.freeze({
      deterministic: null,
      proposals: Object.freeze([]),
      exceptionReason: 'CURRENCY_UNKNOWN',
      reason: 'PROVIDER_CURRENCY_UNKNOWN',
    })
  }

  if (!money.known) {
    return Object.freeze({
      deterministic: null,
      proposals: Object.freeze([]),
      exceptionReason: 'NO_MATCH',
      reason: 'PROVIDER_AMOUNT_UNKNOWN',
    })
  }

  if (objectType === 'invoice') {
    const providerNumber = String(state?.number ?? '').trim()
    if (providerNumber) {
      const exact = openInvoices.filter((invoice) =>
        String(invoice?.inv_num ?? '').trim() === providerNumber &&
        invoiceMatchesMoney(invoice, money)
      )
      if (exact.length === 1) {
        return Object.freeze({
          deterministic: Object.freeze({ entityId: exact[0].id, matchBasis: 'exact_number' }),
          proposals: Object.freeze([]),
          exceptionReason: null,
          reason: 'DETERMINISTIC_NUMBER_CURRENCY_AMOUNT',
        })
      }
      if (exact.length > 1) {
        return Object.freeze({
          deterministic: null,
          proposals: Object.freeze(exact.map((invoice) => invoice.id)),
          exceptionReason: 'AMBIGUOUS_INVOICE',
          reason: 'MULTIPLE_EXACT_INVOICE_MATCHES',
        })
      }
    }
  }

  const amountCandidates = openInvoices.filter((invoice) => invoiceMatchesMoney(invoice, money))
  if (amountCandidates.length > 0) {
    return Object.freeze({
      deterministic: null,
      proposals: Object.freeze(amountCandidates.map((invoice) => invoice.id)),
      exceptionReason: amountCandidates.length > 1 ? 'AMBIGUOUS_INVOICE' : 'LINK_CONFIRMATION_REQUIRED',
      reason: 'AMOUNT_CURRENCY_PROPOSAL_ONLY',
    })
  }

  return Object.freeze({
    deterministic: null,
    proposals: Object.freeze([]),
    exceptionReason: 'NO_MATCH',
    reason: 'NO_DETERMINISTIC_OR_PROPOSAL_MATCH',
  })
}
