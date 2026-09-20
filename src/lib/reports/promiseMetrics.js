const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY_RE = /^[A-Z]{3}$/
const MS_PER_DAY = 24 * 60 * 60 * 1000

function localDay(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    const d = new Date(value)
    d.setHours(0, 0, 0, 0)
    return d
  }
  const raw = String(value ?? '').slice(0, 10)
  if (!DATE_RE.test(raw)) return null
  const [y, m, d] = raw.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setHours(0, 0, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date
}

function dayDiff(from, to) {
  const a = localDay(from)
  const b = localDay(to)
  if (!a || !b) return null
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY)
}

function amountOf(row) {
  const n = Number(row?.promised_amount)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function currencyOf(row) {
  const value = String(row?.currency ?? '').trim().toUpperCase()
  return CURRENCY_RE.test(value) ? value : null
}

export const PROMISE_REPORT_STATE = Object.freeze({
  NEEDS_CONFIRMATION: 'needs_confirmation',
  FUTURE: 'future',
  DUE_SOON: 'due_soon',
  DUE_TODAY: 'due_today',
  PAST_DUE_UNRESOLVED: 'past_due_unresolved',
  UNKNOWN: 'unknown',
})

export function promiseReportState(promise, asOf = new Date(), dueSoonDays = 7) {
  if (!promise) return PROMISE_REPORT_STATE.UNKNOWN
  if (promise.status === 'proposed') return PROMISE_REPORT_STATE.NEEDS_CONFIRMATION
  if (promise.status !== 'confirmed') return PROMISE_REPORT_STATE.UNKNOWN

  const promisedDate = localDay(promise.promised_date)
  const today = localDay(asOf)
  if (!promisedDate || !today) return PROMISE_REPORT_STATE.UNKNOWN

  const daysUntil = dayDiff(today, promisedDate)
  if (daysUntil === null) return PROMISE_REPORT_STATE.UNKNOWN
  if (daysUntil < 0) return PROMISE_REPORT_STATE.PAST_DUE_UNRESOLVED
  if (daysUntil === 0) return PROMISE_REPORT_STATE.DUE_TODAY
  if (daysUntil <= dueSoonDays) return PROMISE_REPORT_STATE.DUE_SOON
  return PROMISE_REPORT_STATE.FUTURE
}

function emptyMoneyState() {
  return { promiseCount: 0, byCurrency: {} }
}

function addMoney(state, currency, amount) {
  state.promiseCount += 1
  if (!state.byCurrency[currency]) state.byCurrency[currency] = { amount: 0, promiseCount: 0 }
  state.byCurrency[currency].amount += amount
  state.byCurrency[currency].promiseCount += 1
}

export function buildPromiseSummary(
  promises = [],
  { asOf = new Date(), dueSoonDays = 7 } = {}
) {
  const states = {
    [PROMISE_REPORT_STATE.NEEDS_CONFIRMATION]: emptyMoneyState(),
    [PROMISE_REPORT_STATE.FUTURE]: emptyMoneyState(),
    [PROMISE_REPORT_STATE.DUE_SOON]: emptyMoneyState(),
    [PROMISE_REPORT_STATE.DUE_TODAY]: emptyMoneyState(),
    [PROMISE_REPORT_STATE.PAST_DUE_UNRESOLVED]: emptyMoneyState(),
    [PROMISE_REPORT_STATE.UNKNOWN]: emptyMoneyState(),
  }

  const dataQuality = {
    unsupportedStatusCount: 0,
    missingPromisedDateCount: 0,
    unsupportedCurrencyCount: 0,
    invalidAmountCount: 0,
    duplicateIdentityCount: 0,
  }

  const seen = new Set()
  let reportablePromiseCount = 0

  for (const promise of promises || []) {
    if (promise?.id && seen.has(promise.id)) {
      dataQuality.duplicateIdentityCount += 1
      continue
    }
    if (promise?.id) seen.add(promise.id)

    const amount = amountOf(promise)
    const currency = currencyOf(promise)
    const state = promiseReportState(promise, asOf, dueSoonDays)

    if (!['proposed', 'confirmed'].includes(promise?.status)) {
      dataQuality.unsupportedStatusCount += 1
    }
    if (promise?.status === 'confirmed' && !localDay(promise?.promised_date)) {
      dataQuality.missingPromisedDateCount += 1
    }
    if (!currency) dataQuality.unsupportedCurrencyCount += 1
    if (amount <= 0) dataQuality.invalidAmountCount += 1

    if (!currency || amount <= 0) {
      states[PROMISE_REPORT_STATE.UNKNOWN].promiseCount += 1
      continue
    }

    reportablePromiseCount += 1
    addMoney(states[state], currency, amount)
  }

  return {
    asOf: localDay(asOf)?.toISOString().slice(0, 10) ?? null,
    dueSoonDays,
    reportablePromiseCount,
    states,
    dataQuality,
    capabilities: {
      governingPromiseState: true,
      dueTiming: true,
      fulfilledState: false,
      brokenState: false,
      keptPromiseRate: false,
      paymentToPromiseAttribution: false,
    },
  }
}

export function buildPromiseReportingContract(
  promises = [],
  options = {}
) {
  return Object.freeze({
    schemaVersion: 'reports-r3-v1',
    summary: buildPromiseSummary(promises, options),
  })
}
