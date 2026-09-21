import { SUPPORTED_CURRENCIES } from './import/money.js'

const TWO_DECIMAL_RE = /^(-?)(\d+)(?:\.(\d{1,2}))?$/

export function normalizeDisplayCurrency(raw) {
  const code = String(raw || '').trim().toUpperCase()
  return SUPPORTED_CURRENCIES.includes(code) ? code : null
}

export function toMinorUnits(value) {
  if (typeof value === 'bigint') return value
  let raw
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    raw = value.toFixed(2)
  } else {
    raw = String(value ?? '').trim()
  }

  const match = TWO_DECIMAL_RE.exec(raw)
  if (!match) return null
  const sign = match[1] === '-' ? -1n : 1n
  const whole = BigInt(match[2])
  const fraction = BigInt((match[3] || '').padEnd(2, '0'))
  return sign * (whole * 100n + fraction)
}

export function minorUnitsToNumber(minor) {
  if (typeof minor !== 'bigint') return 0
  return Number(minor) / 100
}

export function formatKnownMoney(value, currency, { compact = false } = {}) {
  const code = normalizeDisplayCurrency(currency)
  const minor = toMinorUnits(value)
  if (!code || minor == null) return null

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: code,
    currencyDisplay: 'code',
    notation: compact && (minor >= 1000000n || minor <= -1000000n) ? 'compact' : 'standard',
    minimumFractionDigits: compact ? 0 : 2,
    maximumFractionDigits: compact ? 1 : 2,
  }).format(minorUnitsToNumber(minor))
}

export function formatUnknownMoney(value, { compact = false } = {}) {
  const minor = toMinorUnits(value)
  if (minor == null) return '—'
  const formatted = new Intl.NumberFormat('en-US', {
    notation: compact && (minor >= 1000000n || minor <= -1000000n) ? 'compact' : 'standard',
    minimumFractionDigits: compact ? 0 : 2,
    maximumFractionDigits: compact ? 1 : 2,
  }).format(minorUnitsToNumber(minor))
  return `${formatted} · currency unknown`
}

export function formatMoneyTruth(value, currency, options = {}) {
  return formatKnownMoney(value, currency, options) || formatUnknownMoney(value, options)
}

export function summarizeMoney(items, {
  amountOf = (item) => item?.amount,
  currencyOf = (item) => item?.currency,
} = {}) {
  const byCurrencyMinor = new Map()
  let unknownMinor = 0n
  let unknownCount = 0
  let invalidAmountCount = 0
  let rowCount = 0

  for (const item of Array.isArray(items) ? items : []) {
    const minor = toMinorUnits(amountOf(item))
    if (minor == null) {
      invalidAmountCount += 1
      continue
    }

    rowCount += 1
    const currency = normalizeDisplayCurrency(currencyOf(item))
    if (!currency) {
      unknownMinor += minor
      unknownCount += 1
      continue
    }

    byCurrencyMinor.set(currency, (byCurrencyMinor.get(currency) || 0n) + minor)
  }

  const byCurrency = [...byCurrencyMinor.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, minor]) => ({
      currency,
      minor,
      amount: minorUnitsToNumber(minor),
    }))

  return Object.freeze({
    byCurrency,
    unknownMinor,
    unknownAmount: minorUnitsToNumber(unknownMinor),
    unknownCount,
    invalidAmountCount,
    rowCount,
    knownCurrencyCount: byCurrency.length,
    canRepresentAsSingleMoney: byCurrency.length === 1 && unknownCount === 0 && invalidAmountCount === 0,
  })
}

export function formatMoneySummary(summary, { compact = false, maxCurrencies = 3 } = {}) {
  if (!summary) return '—'

  const parts = summary.byCurrency
    .slice(0, maxCurrencies)
    .map((entry) => formatKnownMoney(entry.amount, entry.currency, { compact }))

  if (summary.byCurrency.length > maxCurrencies) {
    parts.push(`+${summary.byCurrency.length - maxCurrencies} currencies`)
  }

  if (summary.unknownCount > 0) {
    parts.push(formatUnknownMoney(summary.unknownAmount, { compact }))
  }

  if (summary.invalidAmountCount > 0) {
    parts.push(`${summary.invalidAmountCount} invalid amount${summary.invalidAmountCount === 1 ? '' : 's'}`)
  }

  return parts.length ? parts.join(' · ') : formatKnownMoney(0, 'USD', { compact }).replace(/^USD\s*/, '')
}

export function summarizeInvoiceBalances(invoices, balanceOf) {
  return summarizeMoney(invoices, {
    amountOf: (invoice) => balanceOf(invoice),
    currencyOf: (invoice) => invoice?.currency,
  })
}
