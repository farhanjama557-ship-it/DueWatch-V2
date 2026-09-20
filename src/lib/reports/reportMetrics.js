const MS_PER_DAY = 24 * 60 * 60 * 1000
const CURRENCY_RE = /^[A-Z]{3}$/

function localDate(value) {
  if (value instanceof Date) {
    const d = new Date(value)
    d.setHours(0, 0, 0, 0)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (!value) return null
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number)
  if (!year || !month || !day) return null
  const d = new Date(year, month - 1, day)
  d.setHours(0, 0, 0, 0)
  return Number.isNaN(d.getTime()) ? null : d
}

function money(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function currencyOf(invoice) {
  const value = String(invoice?.currency ?? '').trim().toUpperCase()
  return CURRENCY_RE.test(value) ? value : null
}

function addCurrency(bucket, currency, amount) {
  if (!bucket[currency]) bucket[currency] = { amount: 0, invoiceCount: 0 }
  bucket[currency].amount += amount
  bucket[currency].invoiceCount += 1
}

function scalarAmount(byCurrency) {
  const keys = Object.keys(byCurrency)
  return keys.length === 1 ? byCurrency[keys[0]].amount : null
}

function scalarShare(overdueByCurrency, outstandingByCurrency) {
  const currencies = Object.keys(outstandingByCurrency)
  if (currencies.length !== 1) return null
  const currency = currencies[0]
  const denominator = outstandingByCurrency[currency]?.amount ?? 0
  const numerator = overdueByCurrency[currency]?.amount ?? 0
  return denominator > 0 ? numerator / denominator : 0
}

export function reportInvoiceBalance(invoice) {
  if (!invoice || invoice.paid === true) return 0
  return Math.max(money(invoice.amount) - money(invoice.amount_paid), 0)
}

export function reportDaysOverdue(dueDate, asOf = new Date()) {
  const due = localDate(dueDate)
  const today = localDate(asOf)
  if (!due || !today) return null
  return Math.floor((today.getTime() - due.getTime()) / MS_PER_DAY)
}

export function agingBucketForInvoice(invoice, asOf = new Date()) {
  const balance = reportInvoiceBalance(invoice)
  if (balance <= 0) return 'settled'

  const days = reportDaysOverdue(invoice?.due_date, asOf)
  if (days === null || days <= 0) return 'current'
  if (days <= 14) return '1_14'
  if (days <= 30) return '15_30'
  if (days <= 60) return '31_60'
  return '61_plus'
}

function emptyBucket(label) {
  return { key: label, invoiceCount: 0, amount: 0, byCurrency: {} }
}

export function buildAgingSummary(invoices = [], asOf = new Date()) {
  const buckets = {
    current: emptyBucket('current'),
    '1_14': emptyBucket('1_14'),
    '15_30': emptyBucket('15_30'),
    '31_60': emptyBucket('31_60'),
    '61_plus': emptyBucket('61_plus'),
  }

  const outstandingByCurrency = {}
  const overdueByCurrency = {}
  let outstandingInvoiceCount = 0
  let overdueInvoiceCount = 0
  let missingDueDateCount = 0
  let unsupportedCurrencyCount = 0

  for (const invoice of invoices || []) {
    const balance = reportInvoiceBalance(invoice)
    if (balance <= 0) continue

    outstandingInvoiceCount += 1
    const currency = currencyOf(invoice)
    if (!currency) {
      unsupportedCurrencyCount += 1
      continue
    }

    addCurrency(outstandingByCurrency, currency, balance)

    const days = reportDaysOverdue(invoice?.due_date, asOf)
    if (days === null) missingDueDateCount += 1

    const bucketKey = agingBucketForInvoice(invoice, asOf)
    const bucket = buckets[bucketKey]
    if (!bucket) continue

    bucket.invoiceCount += 1
    addCurrency(bucket.byCurrency, currency, balance)

    if (bucketKey !== 'current') {
      overdueInvoiceCount += 1
      addCurrency(overdueByCurrency, currency, balance)
    }
  }

  for (const bucket of Object.values(buckets)) {
    bucket.amount = scalarAmount(bucket.byCurrency)
  }

  return {
    asOf: localDate(asOf)?.toISOString().slice(0, 10) ?? null,
    outstanding: {
      invoiceCount: outstandingInvoiceCount,
      amount: scalarAmount(outstandingByCurrency),
      byCurrency: outstandingByCurrency,
    },
    overdue: {
      invoiceCount: overdueInvoiceCount,
      amount: scalarAmount(overdueByCurrency),
      byCurrency: overdueByCurrency,
      shareOfOutstanding: scalarShare(overdueByCurrency, outstandingByCurrency),
    },
    dataQuality: {
      missingDueDateCount,
      unsupportedCurrencyCount,
    },
    buckets,
  }
}

export function buildClientExposure(invoices = [], asOf = new Date()) {
  const clients = new Map()
  const totalByCurrency = {}

  for (const invoice of invoices || []) {
    const balance = reportInvoiceBalance(invoice)
    if (balance <= 0) continue

    const currency = currencyOf(invoice)
    const clientId = invoice.client_id ?? invoice.clients?.id ?? null
    const clientName = invoice.clients?.name ?? invoice.client_name ?? 'Unknown client'
    const key = clientId || `name:${clientName}`

    if (!clients.has(key)) {
      clients.set(key, {
        clientId,
        clientName,
        outstandingAmount: 0,
        overdueAmount: 0,
        invoiceCount: 0,
        overdueInvoiceCount: 0,
        byCurrency: {},
        overdueByCurrency: {},
        unsupportedCurrencyCount: 0,
      })
    }

    const row = clients.get(key)
    row.invoiceCount += 1

    if (!currency) {
      row.unsupportedCurrencyCount += 1
      continue
    }

    addCurrency(row.byCurrency, currency, balance)
    addCurrency(totalByCurrency, currency, balance)

    const days = reportDaysOverdue(invoice?.due_date, asOf)
    if (days !== null && days > 0) {
      row.overdueInvoiceCount += 1
      addCurrency(row.overdueByCurrency, currency, balance)
    }
  }

  const rows = Array.from(clients.values()).map((row) => {
    const shareOfOutstandingByCurrency = {}
    for (const [currency, value] of Object.entries(row.byCurrency)) {
      const total = totalByCurrency[currency]?.amount ?? 0
      shareOfOutstandingByCurrency[currency] = total > 0 ? value.amount / total : 0
    }

    return {
      ...row,
      outstandingAmount: scalarAmount(row.byCurrency),
      overdueAmount: scalarAmount(row.overdueByCurrency),
      shareOfOutstanding:
        Object.keys(shareOfOutstandingByCurrency).length === 1
          ? Object.values(shareOfOutstandingByCurrency)[0]
          : null,
      shareOfOutstandingByCurrency,
    }
  })

  return rows.sort((a, b) => {
    const aOverdue = a.overdueInvoiceCount
    const bOverdue = b.overdueInvoiceCount
    if (aOverdue !== bOverdue) return bOverdue - aOverdue
    if (a.invoiceCount !== b.invoiceCount) return b.invoiceCount - a.invoiceCount
    return a.clientName.localeCompare(b.clientName)
  })
}

export function buildReceivablesReport({ invoices = [], asOf = new Date() } = {}) {
  const aging = buildAgingSummary(invoices, asOf)
  const clients = buildClientExposure(invoices, asOf)

  return Object.freeze({
    schemaVersion: 'reports-r1-v2-currency-safe',
    asOf: aging.asOf,
    aging,
    clients,
  })
}
