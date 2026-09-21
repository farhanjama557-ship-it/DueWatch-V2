import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sql = await readFile(
  new URL('../supabase/migrations/20260921130000_promises_foundation.sql', import.meta.url),
  'utf8'
)

test('promise foundation is tenant-scoped with RLS and explicit grants', () => {
  assert.match(sql, /alter table public\.promises enable row level security/i)
  assert.match(sql, /for select to authenticated[\s\S]*auth\.uid\(\)[\s\S]*user_id/i)
  assert.match(sql, /for insert to authenticated[\s\S]*with check[\s\S]*auth\.uid\(\)[\s\S]*user_id/i)
  assert.match(sql, /for update to authenticated[\s\S]*using[\s\S]*with check/i)
  assert.match(sql, /revoke all on public\.promises from public, anon, authenticated/i)
})

test('promise foundation does not allow fulfilled or broken as writable canonical statuses', () => {
  const statusCheck = sql.match(/check \(status in \(([^)]+)\)\)/i)
  assert.ok(statusCheck)
  assert.match(statusCheck[1], /proposed/)
  assert.match(statusCheck[1], /confirmed/)
  assert.doesNotMatch(statusCheck[1], /fulfilled/i)
  assert.doesNotMatch(statusCheck[1], /broken/i)
})

test('promise foundation enforces one active commitment per invoice', () => {
  assert.match(sql, /create unique index if not exists promises_one_active_per_invoice_uidx/i)
  assert.match(sql, /where status in \('proposed', 'confirmed'\)/i)
})

test('promise trigger validates tenant, currency, and current invoice balance', () => {
  assert.match(sql, /where id = new\.invoice_id[\s\S]*user_id = new\.user_id/i)
  assert.match(sql, /Promise currency must match invoice currency/i)
  assert.match(sql, /Promise amount cannot exceed the current invoice balance/i)
  assert.match(sql, /security invoker/i)
  assert.doesNotMatch(sql, /security definer/i)
})

test('resolved promise records are immutable and confirmed terms cannot be silently rewritten', () => {
  assert.match(sql, /Resolved promises are immutable/i)
  assert.match(sql, /Confirmed promise terms are immutable; supersede the promise instead/i)
})
