import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReportCsv } from '../src/lib/reports/reportExport.js'

test('currency-scoped CSV excludes monetary rows from other currencies', () => {
  const model = {
    schemaVersion: 'test',
    asOf: '2026-09-20',
    period: { startDate: '2026-09-01', endDate: '2026-10-01' },
    availability: { collections: true },
    collections: {
      current: {
        byCurrency: {
          USD: { amount: 100, paymentCount: 1 },
          EUR: { amount: 80, paymentCount: 1 },
        },
      },
    },
  }
  const csv = buildReportCsv(model, { currency: 'USD' })
  assert.match(csv, /USD/)
  assert.doesNotMatch(csv, /EUR/)
})
