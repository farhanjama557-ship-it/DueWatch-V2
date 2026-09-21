import { balanceOf, isOutstanding } from '../context/DataContext'
import { daysOverdue, daysUntil } from './format'

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
    .filter((promise) => ['confirmed','due_soon','due_today','broken'].includes(stateOf(promise)))
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
    currency: invoice.currency || null,
    promiseId: promise?.id || null,
  }
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
  let overdueExposure = 0
  let brokenPromiseExposure = 0
  let missingCurrencyCount = 0
  let missingDueDateCount = 0

  for (const invoice of open) {
    const balance = balanceOf(invoice)
    if (!invoice.currency) missingCurrencyCount += 1
    if (!validDate(invoice.due_date)) missingDueDateCount += 1

    const overdue = daysOverdue(invoice.due_date, new Date(today + 'T12:00:00Z'))
    if (overdue > 0) overdueExposure += balance

    const promise = activePromiseForInvoice(promises, invoice.id)
    const pState = stateOf(promise)

    if (promise && pState === 'broken') {
      brokenPromiseExposure += Math.min(Number(promise.promised_amount) || 0, balance)
    }

    if (promise && ['confirmed','due_soon','due_today'].includes(pState)) {
      const promiseDate = validDate(promise.promised_date)
      const promised = Math.min(Number(promise.promised_amount) || 0, balance)
      const promiseDelta = diffDays(today, promiseDate)
      if (promiseDate && promiseDelta !== null && promiseDelta >= 0 && promiseDelta <= horizonDays && promised > 0) {
        events.push(event({ type:'confirmed_promise', date:promiseDate, amount:promised, invoice, promise }))
      }

      const remainder = Math.max(balance - promised, 0)
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

  const weeks = Array.from({length:5},(_,index)=>{
    const start=index*7
    const end=start+6
    const rows=events.filter((item)=>{
      const d=diffDays(today,item.date)
      return d !== null && d >= start && d <= end
    })
    return {
      index,
      startDate:addDays(today,start),
      endDate:addDays(today,end),
      amount:rows.reduce((sum,row)=>sum+row.amount,0),
      promiseAmount:rows.filter((row)=>row.type==='confirmed_promise').reduce((sum,row)=>sum+row.amount,0),
      invoiceAmount:rows.filter((row)=>row.type==='invoice_due').reduce((sum,row)=>sum+row.amount,0),
      eventCount:rows.length,
    }
  })

  const committedPromises = events.filter((item)=>item.type==='confirmed_promise')

  return {
    asOf: today,
    horizonDays,
    openInvoiceCount: open.length,
    outstanding: open.reduce((sum,invoice)=>sum+balanceOf(invoice),0),
    overdueExposure,
    brokenPromiseExposure,
    scheduled7Amount: scheduled7.reduce((sum,item)=>sum+item.amount,0),
    scheduled30Amount: scheduled30.reduce((sum,item)=>sum+item.amount,0),
    committedPromiseAmount30: committedPromises
      .filter((item)=>{
        const d=diffDays(today,item.date)
        return d !== null && d <= 30
      })
      .reduce((sum,item)=>sum+item.amount,0),
    events,
    weeks,
    topUpcoming: events.slice().sort((a,b)=>b.amount-a.amount).slice(0,5),
    dataQuality: {
      missingCurrencyCount,
      missingDueDateCount,
    },
    capabilities: {
      invoiceDueTiming:true,
      confirmedPromiseTiming:true,
      overdueExposure:true,
      brokenPromiseExposure:true,
      paymentProbability:false,
      operatingOutflows:false,
      predictiveForecast:false,
    },
  }
}
