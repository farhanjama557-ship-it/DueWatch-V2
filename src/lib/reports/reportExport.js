function csvEscape(value) {
  const text = String(value ?? '')
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"'
  return text
}

function row(section, metric, currency, value, detail = '') {
  return { section, metric, currency: currency || '', value, detail }
}

export function buildReportExportRows(model) {
  if (!model) return []
  const rows = []

  for (const [currency, value] of Object.entries(model.collections?.current?.byCurrency || {})) {
    rows.push(row('collections', 'collected_amount', currency, value.amount, 'Current report period'))
    rows.push(row('collections', 'payment_count', currency, value.paymentCount, 'Current report period'))
  }

  for (const [currency, value] of Object.entries(model.aging?.outstanding?.byCurrency || {})) {
    rows.push(row('aging', 'outstanding_amount', currency, value.amount, model.asOf || ''))
  }
  for (const [currency, value] of Object.entries(model.aging?.overdue?.byCurrency || {})) {
    rows.push(row('aging', 'overdue_amount', currency, value.amount, model.asOf || ''))
  }

  rows.push(row('collections', 'collected_invoice_count', '', model.collectedInvoices?.collectedInvoiceCount ?? 0))

  const promiseStates = model.promises?.states || {}
  for (const [stateName, state] of Object.entries(promiseStates)) {
    rows.push(row('promise_to_pay', stateName + '_count', '', state.promiseCount ?? 0))
    for (const [currency, value] of Object.entries(state.byCurrency || {})) {
      rows.push(row('promise_to_pay', stateName + '_amount', currency, value.amount ?? 0))
    }
  }

  const claimStatuses = model.operations?.execution?.byStatus || {}
  for (const [status, count] of Object.entries(claimStatuses)) {
    rows.push(row('autopilot', 'execution_' + status, '', count))
  }

  for (const client of model.clientExposure || []) {
    for (const [currency, value] of Object.entries(client.byCurrency || {})) {
      rows.push(
        row(
          'client_exposure',
          client.clientName,
          currency,
          value.amount,
          'Outstanding; overdue invoices=' + client.overdueInvoiceCount + '; max days overdue=' + client.maxDaysOverdue
        )
      )
    }
  }

  return rows
}

export function buildReportCsv(model) {
  const headers = ['section', 'metric', 'currency', 'value', 'detail']
  const rows = buildReportExportRows(model)
  return [
    headers.join(','),
    ...rows.map((record) => headers.map((key) => csvEscape(record[key])).join(',')),
  ].join('\n')
}

export function reportExportFilename(model) {
  const start = model?.period?.startDate || 'start'
  const end = model?.period?.endDate || 'end'
  return 'duewatch-report-' + start + '-to-' + end + '.csv'
}
