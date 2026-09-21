import { summarizeMoney } from './moneyTruth.js'

function balanceOf(invoice) {
  return Math.max((Number(invoice?.amount) || 0) - (Number(invoice?.amount_paid) || 0), 0)
}

function isOutstanding(invoice) {
  return invoice?.paid !== true && balanceOf(invoice) > 0
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function validDate(value) {
  const raw = String(value || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

function addDays(date, days) {
  const raw = validDate(date instanceof Date ? date.toISOString() : date)
  if (!raw) return null
  const [y,m,d] = raw.split('-').map(Number)
  const next = new Date(Date.UTC(y,m-1,d+days))
  return next.toISOString().slice(0,10)
}

function diffDays(from, to) {
  const a=validDate(from instanceof Date ? from.toISOString() : from)
  const b=validDate(to instanceof Date ? to.toISOString() : to)
  if(!a||!b) return null
  const [ay,am,ad]=a.split('-').map(Number)
  const [by,bm,bd]=b.split('-').map(Number)
  return Math.round((Date.UTC(by,bm-1,bd)-Date.UTC(ay,am-1,ad))/86400000)
}

function stateOf(promise) {
  return promise?.operational?.state || String(promise?.status || '').toLowerCase()
}

function activePromiseForInvoice(promises, invoiceId) {
  return safeArray(promises)
    .filter((promise) => promise.invoice_id === invoiceId)
    .filter((promise) => ['confirmed','due_soon','due_today','past_due_unresolved'].includes(stateOf(promise)))
    .sort((a,b) => String(b.confirmed_at || b.created_at || '').localeCompare(String(a.confirmed_at || a.created_at || '')))[0] || null
}

function event({ type, date, amount, invoice, promise = null }) {
  return {
    type,
    date,
    amount: Math.max(Number(amount) || 0, 0),
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number || invoice.inv_num || null,
    clientName: invoice.clients?.name || 'Client',
    currency: promise?.currency || invoice.currency || null,
    promiseId: promise?.id || null,
  }
}

function moneySummary(rows, amountOf = (row) => row.amount, currencyOf = (row) => row.currency) {
  return summarizeMoney(rows, { amountOf, currencyOf })
}

function singleAmount(summary) {
  if (!summary) return null
  if (summary.rowCount === 0) return 0
  if (!summary.canRepresentAsSingleMoney) return null
  return summary.byCurrency[0]?.amount ?? 0
}

function remainingPromiseAmount(promise, invoiceBalance) {
  if (!promise) return 0
  const promised = Math.max(Number(promise.promised_amount) || 0, 0)
  const fulfilled = Math.max(Number(promise.operational?.fulfilledAmount) || 0, 0)
  return Math.min(Math.max(promised - fulfilled, 0), invoiceBalance)
}

export function buildCashFlowReadModel({
  invoices = [],
  promises = [],
  asOf = new Date(),
  horizonDays = 35,
} = {}) {
  const today = validDate(asOf instanceof Date ? asOf.toISOString() : asOf)
  if (!today) throw new Error('Cash Flow requires a valid as-of date.')

  const open = safeArray(invoices).filter(isOutstanding)
  const events = []
  const overdueRows = []
  const pastDuePromiseRows = []
  let missingCurrencyCount = 0
  let missingDueDateCount = 0

  for (const invoice of open) {
    const balance = balanceOf(invoice)
    if (!invoice.currency) missingCurrencyCount += 1
    if (!validDate(invoice.due_date)) missingDueDateCount += 1

    const overdue = diffDays(invoice.due_date, today)
    if (overdue !== null && overdue > 0) {
      overdueRows.push({ amount: balance, currency: invoice.currency || null })
    }

    const promise = activePromiseForInvoice(promises, invoice.id)
    const pState = stateOf(promise)
    const remainingPromise = remainingPromiseAmount(promise, balance)

    if (promise && pState === 'past_due_unresolved' && remainingPromise > 0) {
      pastDuePromiseRows.push({
        amount: remainingPromise,
        currency: promise.currency || invoice.currency || null,
      })
    }

    if (promise && ['confirmed','due_soon','due_today'].includes(pState)) {
      const promiseDate = validDate(promise.promised_date)
      const promiseDelta = diffDays(today, promiseDate)
      if (
        promiseDate &&
        promiseDelta !== null &&
        promiseDelta >= 0 &&
        promiseDelta <= horizonDays &&
        remainingPromise > 0
      ) {
        events.push(event({
          type:'confirmed_promise',
          date:promiseDate,
          amount:remainingPromise,
          invoice,
          promise,
        }))
      }

      const remainder = Math.max(balance - remainingPromise, 0)
      const dueDate = validDate(invoice.due_date)
      const dueDelta = diffDays(today, dueDate)
      if (remainder > 0 && dueDate && dueDelta !== null && dueDelta >= 0 && dueDelta <= horizonDays) {
        events.push(event({ type:'invoice_due', date:dueDate, amount:remainder, invoice }))
      }
      continue
    }

    const dueDate = validDate(invoice.due_date)
    const dueDelta = diffDays(today, dueDate)
    if (dueDate && dueDelta !== null && dueDelta >= 0 && dueDelta <= horizonDays) {
      events.push(event({ type:'invoice_due', date:dueDate, amount:balance, invoice }))
    }
  }

  events.sort((a,b) => a.date.localeCompare(b.date) || b.amount-a.amount)

  const scheduled7 = events.filter((item) => {
    const d=diffDays(today,item.date)
    return d !== null && d >= 0 && d <= 7
  })
  const scheduled30 = events.filter((item) => {
    const d=diffDays(today,item.date)
    return d !== null && d >= 0 && d <= 30
  })
  const committedPromises = events.filter((item)=>item.type==='confirmed_promise')
    .filter((item)=>{
      const d=diffDays(today,item.date)
      return d !== null && d <= 30
    })

  const outstandingRows = open.map((invoice) => ({
    amount: balanceOf(invoice),
    currency: invoice.currency || null,
  }))
  const outstandingSummary = moneySummary(outstandingRows)
  const overdueExposureSummary = moneySummary(overdueRows)
  const pastDuePromiseExposureSummary = moneySummary(pastDuePromiseRows)
  const scheduled7Summary = moneySummary(scheduled7)
  const scheduled30Summary = moneySummary(scheduled30)
  const committedPromise30Summary = moneySummary(committedPromises)

  const weeks = Array.from({length:5},(_,index)=>{
    const start=index*7
    const end=start+6
    const rows=events.filter((item)=>{
      const d=diffDays(today,item.date)
      return d !== null && d >= start && d <= end
    })
    const promiseRows=rows.filter((row)=>row.type==='confirmed_promise')
    const invoiceRows=rows.filter((row)=>row.type==='invoice_due')
    const amountSummary=moneySummary(rows)
    const promiseSummary=moneySummary(promiseRows)
    const invoiceSummary=moneySummary(invoiceRows)
    return {
      index,
      startDate:addDays(today,start),
      endDate:addDays(today,end),
      amount:singleAmount(amountSummary),
      promiseAmount:singleAmount(promiseSummary),
      invoiceAmount:singleAmount(invoiceSummary),
      amountSummary,
      promiseSummary,
      invoiceSummary,
      eventCount:rows.length,
    }
  })

  return {
    asOf: today,
    horizonDays,
    openInvoiceCount: open.length,
    outstanding: singleAmount(outstandingSummary),
    outstandingSummary,
    overdueExposure: singleAmount(overdueExposureSummary),
    overdueExposureSummary,
    pastDuePromiseExposure: singleAmount(pastDuePromiseExposureSummary),
    pastDuePromiseExposureSummary,
    scheduled7Amount: singleAmount(scheduled7Summary),
    scheduled7Summary,
    scheduled30Amount: singleAmount(scheduled30Summary),
    scheduled30Summary,
    committedPromiseAmount30: singleAmount(committedPromise30Summary),
    committedPromise30Summary,
    timingCurrency: scheduled30Summary.canRepresentAsSingleMoney
      ? scheduled30Summary.byCurrency[0]?.currency || null
      : null,
    events,
    weeks,
    topUpcoming: events.slice().sort((a,b)=>b.amount-a.amount).slice(0,5),
    dataQuality: {
      missingCurrencyCount,
      missingDueDateCount,
      mixedCurrencyTiming: scheduled30Summary.knownCurrencyCount > 1,
      incompleteEvidence: false,
    },
    capabilities: {
      invoiceDueTiming:true,
      confirmedPromiseTiming:true,
      overdueExposure:true,
      pastDuePromiseExposure:true,
      paymentProbability:false,
      operatingOutflows:false,
      predictiveForecast:false,
    },
  }
}
