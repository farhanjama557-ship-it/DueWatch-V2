import { buildAgingSummary, buildClientExposure } from './reportMetrics.js'
import {
  buildCollectionsComparison,
  buildCollectionsSummary,
  classifyPaymentForReporting,
  previousEquivalentPeriod,
} from './paymentMetrics.js'
import { buildPromiseSummary } from './promiseMetrics.js'
import { buildOperationalReportingContract } from './operationsMetrics.js'

const CURRENCY_RE = /^[A-Z]{3}$/

function dateOnly(date) {
  if (date instanceof Date) {
    const d = new Date(date)
    d.setHours(0, 0, 0, 0)
    const offset = d.getTimezoneOffset()
    return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10)
  }
  return String(date ?? '').slice(0, 10)
}

function addMonths(date, months) {
  const d = new Date(date.getFullYear(), date.getMonth() + months, 1)
  d.setHours(0, 0, 0, 0)
  return d
}

export function monthPeriod(asOf = new Date(), monthOffset = 0) {
  const base = new Date(asOf)
  if (Number.isNaN(base.getTime())) throw new Error('Invalid asOf date.')
  const start = addMonths(base, monthOffset)
  const end = addMonths(base, monthOffset + 1)
  return { startDate: dateOnly(start), endDate: dateOnly(end) }
}

export function buildMonthlyCollectionSeries(payments = [], { asOf = new Date(), months = 5 } = {}) {
  const points = []
  for (let offset = -(months - 1); offset <= 0; offset += 1) {
    const period = monthPeriod(asOf, offset)
    const summary = buildCollectionsSummary(payments, period)
    const labelDate = new Date(period.startDate + 'T12:00:00')
    points.push({
      ...period,
      label: labelDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      byCurrency: summary.byCurrency,
      paymentCount: summary.includedPaymentCount,
    })
  }
  return points
}

function includedPaymentMap(payments, period) {
  const map = new Map()
  for (const payment of payments || []) {
    const classified = classifyPaymentForReporting(payment)
    if (!classified.included) continue
    if (classified.effectiveDate < period.startDate || classified.effectiveDate >= period.endDate) continue
    if (payment?.id && !map.has(payment.id)) map.set(payment.id, classified)
  }
  return map
}

function allocationCurrency(paymentClassified) {
  const c = paymentClassified?.currency
  return CURRENCY_RE.test(String(c ?? '')) ? c : null
}

export function buildCollectedInvoiceSummary(payments = [], allocations = [], period) {
  const paymentMap = includedPaymentMap(payments, period)
  const invoiceIds = new Set()
  const byCurrency = {}

  for (const allocation of allocations || []) {
    const payment = paymentMap.get(allocation?.payment_id)
    if (!payment) continue

    const currency = allocationCurrency(payment)
    const amount = Number(allocation?.amount)
    if (!currency || !Number.isFinite(amount) || amount <= 0) continue

    if (allocation?.invoice_id) invoiceIds.add(allocation.invoice_id)
    if (!byCurrency[currency]) byCurrency[currency] = { allocatedAmount: 0, allocationCount: 0 }
    byCurrency[currency].allocatedAmount += amount
    byCurrency[currency].allocationCount += 1
  }

  return {
    collectedInvoiceCount: invoiceIds.size,
    byCurrency,
  }
}

function clientIdentityFromAllocation(allocation) {
  const invoice = allocation?.invoices
  const client = invoice?.clients
  const clientId = invoice?.client_id ?? client?.id ?? null
  const clientName = client?.name ?? allocation?.client_name ?? 'Unknown client'
  return { key: clientId || 'name:' + clientName, clientId, clientName }
}

function buildClientCollectionsForPeriod(payments, allocations, period) {
  const paymentMap = includedPaymentMap(payments, period)
  const clients = new Map()

  for (const allocation of allocations || []) {
    const payment = paymentMap.get(allocation?.payment_id)
    if (!payment) continue

    const amount = Number(allocation?.amount)
    const currency = allocationCurrency(payment)
    if (!currency || !Number.isFinite(amount) || amount <= 0) continue

    const identity = clientIdentityFromAllocation(allocation)
    if (!clients.has(identity.key)) {
      clients.set(identity.key, {
        clientId: identity.clientId,
        clientName: identity.clientName,
        byCurrency: {},
      })
    }

    const row = clients.get(identity.key)
    row.byCurrency[currency] = (row.byCurrency[currency] || 0) + amount
  }

  return clients
}

export function buildClientCollectionComparison(payments = [], allocations = [], period) {
  const previousPeriod = previousEquivalentPeriod(period.startDate, period.endDate)
  if (!previousPeriod) throw new Error('A valid report period is required.')

  const current = buildClientCollectionsForPeriod(payments, allocations, period)
  const previous = buildClientCollectionsForPeriod(payments, allocations, previousPeriod)
  const keys = new Set([...current.keys(), ...previous.keys()])
  const rows = []

  for (const key of keys) {
    const cur = current.get(key)
    const prev = previous.get(key)
    const base = cur || prev
    const currencies = new Set([
      ...Object.keys(cur?.byCurrency || {}),
      ...Object.keys(prev?.byCurrency || {}),
    ])
    const comparisonByCurrency = {}

    for (const currency of currencies) {
      const currentAmount = cur?.byCurrency?.[currency] || 0
      const previousAmount = prev?.byCurrency?.[currency] || 0
      comparisonByCurrency[currency] = {
        currentAmount,
        previousAmount,
        absoluteChange: currentAmount - previousAmount,
        relativeChange:
          previousAmount > 0 ? (currentAmount - previousAmount) / previousAmount : null,
      }
    }

    rows.push({
      clientId: base.clientId,
      clientName: base.clientName,
      comparisonByCurrency,
    })
  }

  return rows
}

function deterministicInsights({ collections, aging, promises, operations, promisesAvailable }) {
  const insights = []

  for (const [currency, comparison] of Object.entries(collections.comparisonByCurrency || {})) {
    if (comparison.previousAmount <= 0) continue
    const pct = comparison.relativeChange
    if (pct === null) continue
    insights.push({
      id: 'collections-change-' + currency,
      kind: pct >= 0 ? 'positive' : 'attention',
      title: 'Collections ' + (pct >= 0 ? 'increased' : 'decreased') + ' ' + Math.abs(Math.round(pct * 100)) + '%',
      detail: currency + ' ' + comparison.currentAmount.toFixed(2) + ' this period vs ' + comparison.previousAmount.toFixed(2) + ' previously.',
      evidence: {
        type: 'payment_ledger',
        currency,
      },
    })
  }

  if (aging.overdue.shareOfOutstanding !== null) {
    insights.push({
      id: 'overdue-share',
      kind: aging.overdue.shareOfOutstanding >= 0.3 ? 'attention' : 'neutral',
      title: Math.round(aging.overdue.shareOfOutstanding * 100) + '% of outstanding is overdue',
      detail: aging.overdue.invoiceCount + ' overdue invoice' + (aging.overdue.invoiceCount === 1 ? '' : 's') + ' are included.',
      evidence: { type: 'invoice_ledger' },
    })
  }

  if (promisesAvailable) {
    const unresolved = promises.states.past_due_unresolved.promiseCount
    const dueSoon = promises.states.due_soon.promiseCount + promises.states.due_today.promiseCount
    if (unresolved > 0) {
      insights.push({
        id: 'ptp-past-due',
        kind: 'attention',
        title: unresolved + ' promise' + (unresolved === 1 ? '' : 's') + ' passed the promised date',
        detail: 'These remain confirmed and unresolved; DueWatch does not label them broken without terminal evidence.',
        evidence: { type: 'promise_current_state' },
      })
    } else if (dueSoon > 0) {
      insights.push({
        id: 'ptp-due-soon',
        kind: 'neutral',
        title: dueSoon + ' confirmed promise' + (dueSoon === 1 ? '' : 's') + ' due soon',
        detail: 'Based on confirmed Promise-to-Pay dates.',
        evidence: { type: 'promise_current_state' },
      })
    }
  }

  const uncertainty = operations.execution.byStatus.uncertain
  const failures = operations.execution.byStatus.send_failed
  if (uncertainty + failures > 0) {
    insights.push({
      id: 'execution-exceptions',
      kind: 'attention',
      title: (uncertainty + failures) + ' Autopilot execution exception' + (uncertainty + failures === 1 ? '' : 's'),
      detail: failures + ' failed and ' + uncertainty + ' uncertain send attempt' + (uncertainty === 1 ? '' : 's') + '.',
      evidence: { type: 'autopilot_execution_claims' },
    })
  }

  return insights.slice(0, 6)
}

export function buildReportsReadModel({
  invoices = [],
  payments = [],
  allocations = [],
  promises = [],
  promisesAvailable = false,
  executionClaims = [],
  approvals = [],
  events = [],
  asOf = new Date(),
  startDate = null,
  endDate = null,
} = {}) {
  const defaultPeriod = monthPeriod(asOf)
  const period = {
    startDate: startDate || defaultPeriod.startDate,
    endDate: endDate || defaultPeriod.endDate,
  }
  const startAt = period.startDate + 'T00:00:00.000Z'
  const endAt = period.endDate + 'T00:00:00.000Z'

  const aging = buildAgingSummary(invoices, asOf)
  const clientExposure = buildClientExposure(invoices, asOf)
  const collections = buildCollectionsComparison(payments, period)
  const collectedInvoices = buildCollectedInvoiceSummary(payments, allocations, period)
  const clientCollections = buildClientCollectionComparison(payments, allocations, period)
  const promisesSummary = buildPromiseSummary(promisesAvailable ? promises : [], { asOf })
  const operations = buildOperationalReportingContract({
    executionClaims,
    approvals,
    events,
    startAt,
    endAt,
  })
  const monthlyCollections = buildMonthlyCollectionSeries(payments, { asOf, months: 5 })

  const insights = deterministicInsights({
    collections,
    aging,
    promises: promisesSummary,
    operations,
    promisesAvailable,
  })

  return Object.freeze({
    schemaVersion: 'reports-r5-read-model-v1',
    asOf: dateOnly(asOf),
    period,
    collections,
    collectedInvoices,
    aging,
    clientExposure,
    clientCollections,
    promises: promisesSummary,
    operations,
    monthlyCollections,
    insights,
    availability: {
      collections: true,
      aging: true,
      clientExposure: true,
      promiseCurrentState: promisesAvailable,
      promiseFulfillment: false,
      collectionTarget: false,
      collectionRate: false,
      collectorPerformance: false,
      timeSaved: false,
      recoveredCashAttribution: false,
    },
  })
}
