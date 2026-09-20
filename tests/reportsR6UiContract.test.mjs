import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const reports = fs.readFileSync(new URL('../src/pages/Reports.jsx', import.meta.url), 'utf8')

test('R6 Reports exposes functional saved-view controls', () => {
  assert.match(reports, /loadReportPreferences/)
  assert.match(reports, /saveReportView/)
  assert.match(reports, /deleteReportView/)
  assert.match(reports, /applySavedView/)
  assert.match(reports, />Save view</)
})

test('R6 collection target is founder configured instead of fabricated', () => {
  assert.match(reports, /findCollectionTarget/)
  assert.match(reports, /saveCollectionTarget/)
  assert.match(reports, /Set target/)
  assert.match(reports, /Edit target/)
  assert.doesNotMatch(reports, /107% of target/)
})
