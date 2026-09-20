import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReportCsv,
  buildReportExportRows,
  reportExportFilename,
} from '../src/lib/reports/reportExport.js'

const model = {
  asOf: '2026-09-20',
  period: { startDate: '2026-09-01', endDate: '2026-10-01' },
  collections: {
    current: {
      byCurrency: {
        USD: { amount: 1250.5, paymentCount: 3 },
      },
    },
  },
  aging: {
    outstanding: { byCurrency: { USD: { amount: 2000 } } },
    overdue: { byCurrency: { USD: { amount: 800 } } },
  },
  collectedInvoices: { collectedInvoiceCount: 2 },
  promises: {
    states: {
      due_today: { promiseCount: 1, byCurrency: { USD: { amount: 500 } } },
    },
  },
  operations: {
    execution: { byStatus: { sent: 4, send_failed: 1, uncertain: 0, in_flight: 0 } },
  },
  clientExposure: [
    {
      clientName: 'Atlas, Inc.',
      overdueInvoiceCount: 1,
      maxDaysOverdue: 22,
      byCurrency: { USD: { amount: 1200 } },
    },
  ],
}

test('report export contains only explicit model facts with currency columns', () => {
  const rows = buildReportExportRows(model)
  assert.ok(rows.some((r) => r.metric === 'collected_amount' && r.currency === 'USD' && r.value === 1250.5))
  assert.ok(rows.some((r) => r.metric === 'outstanding_amount' && r.value === 2000))
  assert.ok(rows.some((r) => r.metric === 'execution_send_failed' && r.value === 1))
})

test('CSV escaping protects commas and produces stable headers', () => {
  const csv = buildReportCsv(model)
  assert.equal(csv.split('\n')[0], 'section,metric,currency,value,detail')
  assert.match(csv, /"Atlas, Inc\."/)
  assert.doesNotMatch(csv, /collection_rate/)
  assert.doesNotMatch(csv, /autopilot_roi/)
})

test('export filename contains explicit report period', () => {
  assert.equal(
    reportExportFilename(model),
    'duewatch-report-2026-09-01-to-2026-10-01.csv'
  )
})
