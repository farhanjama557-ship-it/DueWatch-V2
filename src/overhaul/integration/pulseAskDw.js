import { balanceOf, isOutstanding } from '../../context/DataContext'
import { daysOverdue, daysUntil, formatMoney } from '../../lib/format'
import {
  ASK_DW_JOB,
  ASK_DW_SCOPE,
  classifyAskDwIntent,
} from '../../lib/dwIntelligence/askDwIntent'
import {
  ASK_DW_CASE_EVENT,
} from '../../lib/dwIntelligence/askDwCaseState'
import { createAskDwEntityResolver } from '../../lib/dwIntelligence/askDwEntityResolver'
import { createAskDwControlledActivationRuntime } from '../../lib/dwIntelligence/askDwControlledActivation'

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function clientName(invoice) {
  return invoice?.clients?.name || 'Client'
}

function isPaymentEvent(event) {
  return /payment/i.test(String(event?.event_type || ''))
}

function total(rows) {
  return rows.reduce((sum, invoice) => sum + balanceOf(invoice), 0)
}

function portfolioSnapshot({ invoices, clients, events, approvals }) {
  const outstanding = safeArray(invoices).filter(isOutstanding)
  const overdue = outstanding
    .filter((invoice) => daysOverdue(invoice.due_date) > 0)
    .sort((a, b) => daysOverdue(b.due_date) - daysOverdue(a.due_date) || balanceOf(b) - balanceOf(a))
  const due7 = outstanding.filter((invoice) => {
    const days = daysUntil(invoice.due_date)
    return days !== null && days >= 0 && days <= 7
  })
  const due30 = outstanding.filter((invoice) => {
    const days = daysUntil(invoice.due_date)
    return days !== null && days >= 0 && days <= 30
  })
  const payments = safeArray(events).filter(isPaymentEvent)

  return {
    invoiceCount: safeArray(invoices).length,
    clientCount: safeArray(clients).length,
    outstanding,
    overdue,
    due7,
    due30,
    paymentEvents: payments,
    approvals: safeArray(approvals),
  }
}

function attentionAnswer(snapshot) {
  const top = snapshot.overdue.slice(0, 3)
  const lines = []
  if (snapshot.approvals.length) {
    lines.push(`${snapshot.approvals.length} approval${snapshot.approvals.length === 1 ? '' : 's'} need your judgment.`)
  }
  if (top.length) {
    lines.push(
      `The highest-priority overdue invoices are ${top.map((invoice) =>
        `${clientName(invoice)} ${invoice.invoice_number || ''} (${daysOverdue(invoice.due_date)}d, ${formatMoney(balanceOf(invoice))})`
      ).join('; ')}.`
    )
  }
  if (!lines.length) lines.push('No overdue invoices or approval requests are visible in the current loaded portfolio.')

  return {
    conclusion: lines.join(' '),
    evidence: [
      `${snapshot.overdue.length} overdue invoice${snapshot.overdue.length === 1 ? '' : 's'} in the loaded portfolio.`,
      `${snapshot.approvals.length} pending founder approval${snapshot.approvals.length === 1 ? '' : 's'}.`,
    ],
    limitations: [],
    nextStep: top[0]
      ? `Open ${top[0].invoice_number || 'the highest-priority invoice'} to review evidence and governed actions.`
      : null,
  }
}

function overdueAnswer(snapshot) {
  const buckets = [
    { label: '1–14 days', rows: snapshot.overdue.filter((invoice) => daysOverdue(invoice.due_date) <= 14) },
    { label: '15–30 days', rows: snapshot.overdue.filter((invoice) => daysOverdue(invoice.due_date) >= 15 && daysOverdue(invoice.due_date) <= 30) },
    { label: '31+ days', rows: snapshot.overdue.filter((invoice) => daysOverdue(invoice.due_date) >= 31) },
  ]
  const populated = buckets.filter((bucket) => bucket.rows.length)

  return {
    conclusion: populated.length
      ? populated.map((bucket) => `${bucket.label}: ${bucket.rows.length} invoice${bucket.rows.length === 1 ? '' : 's'} totaling ${formatMoney(total(bucket.rows))}`).join('. ') + '.'
      : 'No overdue invoices are visible in the current loaded portfolio.',
    evidence: populated.map((bucket) => `${bucket.label} aging bucket derived from canonical invoice due dates and balances.`),
    limitations: ['DueWatch can group overdue exposure by aging here, but it does not infer an unsupported business-cause “reason” from due dates alone.'],
    nextStep: null,
  }
}

function cashTimingAnswer(snapshot) {
  return {
    conclusion: `${formatMoney(total(snapshot.due7))} is scheduled due within 7 days and ${formatMoney(total(snapshot.due30))} within 30 days. ${formatMoney(total(snapshot.overdue))} is already overdue.`,
    evidence: [
      `${snapshot.due7.length} open invoice${snapshot.due7.length === 1 ? '' : 's'} due within 7 days.`,
      `${snapshot.due30.length} open invoice${snapshot.due30.length === 1 ? '' : 's'} due within 30 days.`,
    ],
    limitations: ['This is invoice-date cash timing, not a predictive cash forecast. DueWatch is not assigning payment probabilities in this surface.'],
    nextStep: null,
  }
}

function generalPortfolioAnswer(snapshot) {
  return {
    conclusion: `DueWatch currently sees ${snapshot.invoiceCount} invoices across ${snapshot.clientCount} clients, with ${formatMoney(total(snapshot.outstanding))} outstanding and ${snapshot.overdue.length} overdue invoice${snapshot.overdue.length === 1 ? '' : 's'}.`,
    evidence: [
      `${snapshot.paymentEvents.length} recent payment event${snapshot.paymentEvents.length === 1 ? '' : 's'} in the loaded activity window.`,
      `${snapshot.approvals.length} approval${snapshot.approvals.length === 1 ? '' : 's'} waiting.`,
    ],
    limitations: ['Portfolio answers are computed from the data already loaded into Pulse and do not grant execution authority.'],
    nextStep: null,
  }
}

function answerPortfolio({ text, invoices, clients, events, approvals }) {
  const intent = classifyAskDwIntent({ text })
  const snapshot = portfolioSnapshot({ invoices, clients, events, approvals })
  const normalized = String(text || '').trim().toLowerCase()

  if (intent.job === ASK_DW_JOB.ACT) {
    return {
      status: 'blocked',
      scope: ASK_DW_SCOPE.PORTFOLIO,
      conclusion: 'Ask DW does not execute portfolio actions from this bar. Use the invoice or Autopilot controls so DueWatch can revalidate authority before any action.',
      evidence: [],
      limitations: ['The Pulse Ask surface is read-only for action requests.'],
      nextStep: 'Open the relevant invoice or Autopilot approval to continue.',
      verification: 'BOUNDARY_ENFORCED',
    }
  }

  if (intent.job === ASK_DW_JOB.PREDICT || normalized.includes('cash forecast')) {
    const answer = cashTimingAnswer(snapshot)
    return { status: 'answered', scope: ASK_DW_SCOPE.PORTFOLIO, ...answer, verification: 'DETERMINISTIC_PORTFOLIO_READ' }
  }

  if (normalized.includes('attention') || normalized.includes('priority')) {
    const answer = attentionAnswer(snapshot)
    return { status: 'answered', scope: ASK_DW_SCOPE.PORTFOLIO, ...answer, verification: 'DETERMINISTIC_PORTFOLIO_READ' }
  }

  if (normalized.includes('overdue')) {
    const answer = overdueAnswer(snapshot)
    return { status: 'answered', scope: ASK_DW_SCOPE.PORTFOLIO, ...answer, verification: 'DETERMINISTIC_PORTFOLIO_READ' }
  }

  const answer = generalPortfolioAnswer(snapshot)
  return { status: 'answered', scope: ASK_DW_SCOPE.PORTFOLIO, ...answer, verification: 'DETERMINISTIC_PORTFOLIO_READ' }
}

function selectedInvoiceId(events) {
  const selection = safeArray(events)
    .slice()
    .reverse()
    .find((event) => event?.type === ASK_DW_CASE_EVENT.SELECT_INVOICE)
  return selection?.payload?.invoiceRef?.id || null
}

function mapInvoiceAnswer(result, invoiceId) {
  return {
    status: 'answered',
    scope: ASK_DW_SCOPE.INVOICE,
    invoiceId,
    conclusion: result?.answer?.executiveConclusion || 'Ask DW completed without a user-facing conclusion.',
    evidence: safeArray(result?.answer?.evidenceBasis),
    limitations: safeArray(result?.answer?.uncertaintyAndLimitations),
    nextStep: result?.answer?.recommendationOrNextStep || null,
    verification: result?.verification?.verdict || 'UNKNOWN',
  }
}

export function createPulseAskDwRuntime({ supabase } = {}) {
  const resolver = createAskDwEntityResolver({ supabase })
  const controlled = createAskDwControlledActivationRuntime({ supabase })

  return Object.freeze({
    async run({
      tenantId,
      text,
      invoices = [],
      clients = [],
      events = [],
      approvals = [],
    } = {}) {
      const question = String(text || '').trim()
      if (!question) throw new Error('Ask DW question required.')
      if (!tenantId) throw new Error('Ask DW requires an authenticated user.')

      const intent = classifyAskDwIntent({ text: question })

      if (intent.scope === ASK_DW_SCOPE.PORTFOLIO) {
        return answerPortfolio({ text: question, invoices, clients, events, approvals })
      }

      const resolution = await resolver.resolveCaseEvents({
        tenantId,
        text: question,
        caseContext: {},
      })

      const invoiceId = selectedInvoiceId(resolution?.events)
      if (resolution?.blocked || !invoiceId) {
        return {
          status: 'needs_resolution',
          scope: intent.scope,
          conclusion: resolution?.reason || 'Ask DW needs an explicit invoice before it can read canonical financial truth.',
          evidence: [],
          limitations: ['DueWatch will not guess which invoice you mean.'],
          nextStep: 'Include the invoice number, or name a client with exactly one invoice.',
          verification: 'ENTITY_RESOLUTION_REQUIRED',
        }
      }

      const result = await controlled.runInvoiceQuestion({
        tenantId,
        invoiceId,
        mode: 'normal',
        text: question,
        now: new Date(),
      })

      return mapInvoiceAnswer(result, invoiceId)
    },
  })
}
