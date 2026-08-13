import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Second execution-safety review-fix pass, MEDIUM: Activity.jsx now loads
// lifecycle_state/evidence, but DataContext's shared `events` query (used
// by Pulse/Dashboard's existing lifecycle_state === 'error' logic) did
// not select lifecycle_state at all -- meaning a failed/uncertain send
// event could silently disappear from Dashboard's error-state detection
// even though it was correctly persisted. This is a static check (not a
// runtime DataContext test, which would require a full Supabase/React
// harness) confirming the shared events query actually selects the field
// Dashboard already reads.

test('DataContext.jsx selects lifecycle_state on its shared events query', () => {
  const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'context', 'DataContext.jsx')
  const content = readFileSync(filePath, 'utf8')
  const selectMatch = content.match(/\.from\('events'\)\s*\n?\s*\.select\('([^']+)'\)/)
  assert.ok(selectMatch, 'expected to find the events table .select(...) call in DataContext.jsx')
  const selectedColumns = selectMatch[1]
  assert.match(selectedColumns, /\blifecycle_state\b/)
  assert.match(selectedColumns, /\bevidence\b/)
})
