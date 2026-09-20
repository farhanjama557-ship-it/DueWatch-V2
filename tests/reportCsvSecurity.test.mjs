import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReportCsv } from '../src/lib/reports/reportExport.js'

test('CSV export neutralizes spreadsheet formula injection in untrusted labels', () => {
  const model = {
    schemaVersion: 'test',
    asOf: '2026-09-20',
    period: { startDate: '2026-09-01', endDate: '2026-10-01' },
    availability: { clientExposure: true },
    clientExposure: [
      {
        clientName: '=HYPERLINK("https://attacker.invalid","click")',
        overdueInvoiceCount: 1,
        maxDaysOverdue: 5,
        byCurrency: { USD: { amount: 100 } },
      },
      {
        clientName: '@SUM(1+1)',
        overdueInvoiceCount: 1,
        maxDaysOverdue: 5,
        byCurrency: { USD: { amount: 50 } },
      },
    ],
  }

  const csv = buildReportCsv(model)
  assert.doesNotMatch(csv, /,=HYPERLINK/)
  assert.doesNotMatch(csv, /,@SUM/)
  assert.match(csv, /'=HYPERLINK/)
  assert.match(csv, /'@SUM/)
})
