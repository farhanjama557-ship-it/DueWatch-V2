import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(
  new URL('../supabase/migrations/20260920214632_reports_saved_views_targets.sql', import.meta.url),
  'utf8'
)

test('R6 migration enables RLS on both report preference tables', () => {
  assert.match(sql, /alter table public\.report_saved_views enable row level security/i)
  assert.match(sql, /alter table public\.report_collection_targets enable row level security/i)
})

test('R6 saved-view policies scope reads and writes to auth.uid', () => {
  assert.match(sql, /report_saved_views_select_own/)
  assert.match(sql, /report_saved_views_insert_own/)
  assert.match(sql, /report_saved_views_update_own/)
  assert.match(sql, /report_saved_views_delete_own/)
  assert.match(sql, /auth\.uid\(\).*user_id/i)
})

test('R6 target uniqueness is period and currency scoped per tenant', () => {
  assert.match(sql, /unique \(user_id, period_start, period_end, currency\)/i)
  assert.match(sql, /target_amount > 0/i)
})
