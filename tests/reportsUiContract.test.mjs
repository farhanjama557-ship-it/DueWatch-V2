import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const reports = fs.readFileSync(new URL('../src/pages/Reports.jsx', import.meta.url), 'utf8')
const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const sidebar = fs.readFileSync(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8')

test('Reports is a real routed app surface with sidebar navigation', () => {
  assert.match(app, /path="\/reports"/)
  assert.match(app, /<Reports \/>/)
  assert.match(sidebar, /to: '\/reports'/)
  assert.match(sidebar, /label: 'Reports'/)
})

test('Reports consumes the canonical report source/read-model/export seams', () => {
  assert.match(reports, /loadReportsSourceData/)
  assert.match(reports, /buildReportsReadModel/)
  assert.match(reports, /buildReportCsv/)
  assert.match(reports, /reportExportFilename/)
})

test('locked report controls are functional rather than decorative placeholders', () => {
  assert.match(reports, /type="date"/)
  assert.match(reports, /changeCadence/)
  assert.match(reports, /onClick=\{exportCsv\}/)
  assert.match(reports, /selectTab/)
  assert.match(reports, /scrollIntoView/)
})

test('unproven headline metrics are visibly withheld', () => {
  assert.match(reports, /Collection target/)
  assert.match(reports, /Not configured/)
  assert.match(reports, /Collection rate/)
  assert.match(reports, /Historical denominator not proven/)
  assert.doesNotMatch(reports, /107% of target/)
  assert.doesNotMatch(reports, />78%<\//)
  assert.doesNotMatch(reports, /72% fulfilled/)
})

test('Reports uses skeleton loading instead of a blank loading screen', () => {
  assert.match(reports, /ReportsLoading/)
  assert.match(reports, /reports-skeleton/)
  assert.doesNotMatch(reports, /Loading\.\.\./)
})
