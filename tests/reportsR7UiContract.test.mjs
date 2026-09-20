import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const reports = fs.readFileSync(new URL('../src/pages/Reports.jsx', import.meta.url), 'utf8')

test('R7 schedule button persists real recurring schedules', () => {
  assert.match(reports, /loadReportSchedules/)
  assert.match(reports, /saveReportSchedule/)
  assert.match(reports, /setReportScheduleEnabled/)
  assert.match(reports, /deleteReportSchedule/)
  assert.match(reports, /Save schedule/)
  assert.doesNotMatch(reports, /Scheduled delivery is the next Reports phase/)
})

test('R7 export honors current currency and exposes print-to-PDF path', () => {
  assert.match(reports, /buildReportCsv\(model, \{ currency \}\)/)
  assert.match(reports, /Print \/ PDF/)
  assert.match(reports, /window\.print\(\)/)
})

test('R7 no longer contradicts a configured collection target in the insight rail', () => {
  assert.match(reports, /configuredTarget \? formatMoney\(configuredTarget, currency\) : 'Not configured'/)
})
