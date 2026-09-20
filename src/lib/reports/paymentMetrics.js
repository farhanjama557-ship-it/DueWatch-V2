const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY_RE = /^[A-Z]{3}$/

function dateOnly(value) {
  if (!value) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    const offset = value.getTimezoneOffset()
    return new Date(value.getTime() - offset * 60000).toISOString().slice(0, 10)
  }
  const raw = String(value)
  const day = raw.slice(0, 10)
  return DATE_RE.test(day) ? day : null
}

function amountOf(row) {
  const n = Number(row?.total_amount)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function currencyOf(row) {
  const value = String(row?.currency ?? '').trim().toUpperCase()
  return CURRENCY_RE.test(value) ? value : null
}

export function effectivePaymentDate(payment) {
  if (!payment || payment.reversed_at) return null

  const explicit = dateOnly(payment.payment_date)
  if (explicit) return explicit

  if (
    payment.origin === 'legacy_carry_forward' &&
    payment.source_event_id &&
    payment.recorded_at
  ) {
    return dateOnly(payment.recorded_at)
  }

  return null
}

export function classifyPaymentForReporting(payment) {
  if (!payment) return { included: false, reason: 'missing_payment' }
  if (payment.reversed_at) return { included: false, reason: 'reversed' }
  if (amountOf(payment) <= 0) return { included: false, reason: 'invalid_amount' }

  const effectiveDate = effectivePaymentDate(payment)
  if (!effectiveDate) return { included: false, reason: 'unsupported_payment_date' }

  const currency = currencyOf(payment)
  if (!currency) return { included: false, reason: 'unsupported_currency' }

  if (!['founder_manual', 'legacy_carry_forward'].includes(payment.origin)) {
    return { included: false, reason: 'unsupported_origin' }
  }

  return {
    included: true,
    paymentId: payment.id ?? null,
    effectiveDate,
    amount: amountOf(payment),
    currency,
    origin: payment.origin,
  }
}

function inRange(day, startDate, endDate) {
  if (!day) return false
  return (!startDate || day >= startDate) && (!endDate || day < endDate)
}

function addMoney(bucket, currency, amount) {
  if (!bucket[currency]) bucket[currency] = { amount: 0, paymentCount: 0 }
  bucket[currency].amount += amount
  bucket[currency].paymentCount += 1
}

export function buildCollectionsSummary(
  payments = [],
  { startDate = null, endDate = null } = {}
) {
  const byCurrency = {}
  const byDay = {}
  const byOrigin = {
    founder_manual: { paymentCount: 0, byCurrency: {} },
    legacy_carry_forward: { paymentCount: 0, byCurrency: {} },
  }

  const excluded = {
    reversed: 0,
    invalid_amount: 0,
    unsupported_payment_date: 0,
    unsupported_currency: 0,
    unsupported_origin: 0,
    missing_payment: 0,
  }

  const seenIds = new Set()
  let duplicateIdentityCount = 0
  let includedPaymentCount = 0

  for (const payment of payments || []) {
    const id = payment?.id ?? null
    if (id && seenIds.has(id)) {
      duplicateIdentityCount += 1
      continue
    }
    if (id) seenIds.add(id)

    const classified = classifyPaymentForReporting(payment)
    if (!classified.included) {
      excluded[classified.reason] = (excluded[classified.reason] || 0) + 1
      continue
    }

    if (!inRange(classified.effectiveDate, startDate, endDate)) continue

    includedPaymentCount += 1
    addMoney(byCurrency, classified.currency, classified.amount)

    if (!byDay[classified.effectiveDate]) byDay[classified.effectiveDate] = {}
    addMoney(byDay[classified.effectiveDate], classified.currency, classified.amount)

    const originBucket = byOrigin[classified.origin]
    originBucket.paymentCount += 1
    addMoney(originBucket.byCurrency, classified.currency, classified.amount)
  }

  return {
    period: { startDate, endDate },
    includedPaymentCount,
    byCurrency,
    byDay,
    byOrigin,
    dataQuality: {
      excluded,
      duplicateIdentityCount,
    },
  }
}

function parseDay(value) {
  if (!DATE_RE.test(String(value ?? ''))) return null
  const [y, m, d] = String(value).split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setHours(0, 0, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date
}

function dayString(date) {
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10)
}

export function previousEquivalentPeriod(startDate, endDate) {
  const start = parseDay(startDate)
  const end = parseDay(endDate)
  if (!start || !end || end <= start) return null

  const duration = end.getTime() - start.getTime()
  const previousEnd = new Date(start.getTime())
  const previousStart = new Date(start.getTime() - duration)

  return {
    startDate: dayString(previousStart),
    endDate: dayString(previousEnd),
  }
}

function compareCurrencyTotals(current = {}, previous = {}) {
  const currencies = new Set([...Object.keys(current), ...Object.keys(previous)])
  const result = {}

  for (const currency of currencies) {
    const currentAmount = current[currency]?.amount ?? 0
    const previousAmount = previous[currency]?.amount ?? 0
    result[currency] = {
      currentAmount,
      previousAmount,
      absoluteChange: currentAmount - previousAmount,
      relativeChange:
        previousAmount > 0 ? (currentAmount - previousAmount) / previousAmount : null,
      currentPaymentCount: current[currency]?.paymentCount ?? 0,
      previousPaymentCount: previous[currency]?.paymentCount ?? 0,
    }
  }

  return result
}

export function buildCollectionsComparison(
  payments = [],
  { startDate, endDate } = {}
) {
  const previousPeriod = previousEquivalentPeriod(startDate, endDate)
  if (!previousPeriod) {
    throw new Error('A valid startDate and exclusive endDate are required.')
  }

  const current = buildCollectionsSummary(payments, { startDate, endDate })
  const previous = buildCollectionsSummary(payments, previousPeriod)

  return {
    current,
    previous,
    comparisonByCurrency: compareCurrencyTotals(current.byCurrency, previous.byCurrency),
  }
}

export function buildPaymentReportingContract(
  payments = [],
  { startDate, endDate } = {}
) {
  const comparison = buildCollectionsComparison(payments, { startDate, endDate })

  return Object.freeze({
    schemaVersion: 'reports-r2-v1',
    period: { startDate, endDate },
    ...comparison,
  })
}
