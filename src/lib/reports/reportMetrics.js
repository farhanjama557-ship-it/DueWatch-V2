const MS_PER_DAY = 24 * 60 * 60 * 1000

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
  return { key: label, invoiceCount: 0, amount: 0 }
}

export function buildAgingSummary(invoices = [], asOf = new Date()) {
  const buckets = {
    current: emptyBucket('current'),
    '1_14': emptyBucket('1_14'),
    '15_30': emptyBucket('15_30'),
    '31_60': emptyBucket('31_60'),
    '61_plus': emptyBucket('61_plus'),
  }

  let outstandingAmount = 0
  let outstandingInvoiceCount = 0
  let overdueAmount = 0
  let overdueInvoiceCount = 0
  let missingDueDateCount = 0

  for (const invoice of invoices || []) {
    const balance = reportInvoiceBalance(invoice)
    if (balance <= 0) continue

    outstandingAmount += balance
    outstandingInvoiceCount += 1

    const days = reportDaysOverdue(invoice?.due_date, asOf)
    if (days === null) missingDueDateCount += 1

    const bucketKey = agingBucketForInvoice(invoice, asOf)
    const bucket = buckets[bucketKey]
    if (!bucket) continue

    bucket.invoiceCount += 1
    bucket.amount += balance

    if (bucketKey !== 'current') {
      overdueAmount += balance
      overdueInvoiceCount += 1
    }
  }

  return {
    asOf: localDate(asOf)?.toISOString().slice(0, 10) ?? null,
    outstanding: {
      invoiceCount: outstandingInvoiceCount,
      amount: outstandingAmount,
    },
    overdue: {
      invoiceCount: overdueInvoiceCount,
      amount: overdueAmount,
      shareOfOutstanding:
        outstandingAmount > 0 ? overdueAmount / outstandingAmount : 0,
    },
    dataQuality: {
      missingDueDateCount,
    },
    buckets,
  }
}

export function buildClientExposure(invoices = [], asOf = new Date()) {
  const clients = new Map()

  for (const invoice of invoices || []) {
    const balance = reportInvoiceBalance(invoice)
    if (balance <= 0) continue

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
      })
    }

    const row = clients.get(key)
    row.outstandingAmount += balance
    row.invoiceCount += 1

    const days = reportDaysOverdue(invoice?.due_date, asOf)
    if (days !== null && days > 0) {
      row.overdueAmount += balance
      row.overdueInvoiceCount += 1
    }
  }

  const rows = Array.from(clients.values()).sort(
    (a, b) => b.outstandingAmount - a.outstandingAmount || a.clientName.localeCompare(b.clientName)
  )
  const total = rows.reduce((sum, row) => sum + row.outstandingAmount, 0)

  return rows.map((row) => ({
    ...row,
    shareOfOutstanding: total > 0 ? row.outstandingAmount / total : 0,
  }))
}

export function buildReceivablesReport({ invoices = [], asOf = new Date() } = {}) {
  const aging = buildAgingSummary(invoices, asOf)
  const clients = buildClientExposure(invoices, asOf)

  return Object.freeze({
    schemaVersion: 'reports-r1-v1',
    asOf: aging.asOf,
    aging,
    clients,
  })
}
