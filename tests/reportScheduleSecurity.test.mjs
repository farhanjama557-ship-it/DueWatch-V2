import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(
  new URL('../supabase/migrations/20260920201000_report_schedules.sql', import.meta.url),
  'utf8'
)
const worker = fs.readFileSync(
  new URL('../supabase/functions/process-report-schedules/index.ts', import.meta.url),
  'utf8'
)

test('R7 report delivery receipts are tenant-bound and browser read-only', () => {
  assert.match(sql, /foreign key \(schedule_id, user_id\)/i)
  assert.match(sql, /grant select on public\.report_delivery_runs to authenticated/i)
  assert.doesNotMatch(sql, /grant select, insert, update, delete on public\.report_delivery_runs to authenticated/i)
})

test('R7 claim and completion RPCs are service-role only', () => {
  assert.match(sql, /revoke all on function public\.claim_due_report_runs[\s\S]*authenticated/i)
  assert.match(sql, /grant execute on function public\.claim_due_report_runs[\s\S]*to service_role/i)
  assert.match(sql, /grant execute on function public\.complete_report_delivery_run[\s\S]*to service_role/i)
})

test('R7 delivery worker authenticates scheduler before claiming work', () => {
  const authIndex = worker.indexOf('x-duewatch-scheduler-secret')
  const claimIndex = worker.indexOf("rpc('claim_due_report_runs'")
  assert.ok(authIndex >= 0)
  assert.ok(claimIndex > authIndex)
  assert.match(worker, /isProviderConfigured\(\)/)
})
