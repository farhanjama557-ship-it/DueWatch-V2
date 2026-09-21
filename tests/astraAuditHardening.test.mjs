import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fetchAllPages } from '../src/lib/supabasePaging.js'
import { buildInvoicePaymentRequest } from '../src/lib/payments.js'

const migration = await readFile(
  new URL('../supabase/migrations/20260921144500_astra_audit_hardening.sql', import.meta.url),
  'utf8'
)
const reminderFn = await readFile(
  new URL('../supabase/functions/send-reminder-email/index.ts', import.meta.url),
  'utf8'
)
const resend = await readFile(
  new URL('../supabase/functions/_shared/resend.js', import.meta.url),
  'utf8'
)
const scheduler = await readFile(
  new URL('../supabase/functions/autopilot-scheduler/index.ts', import.meta.url),
  'utf8'
)
const remindersClient = await readFile(
  new URL('../src/lib/reminders.js', import.meta.url),
  'utf8'
)

test('Astra payment idempotency: browser payment request requires a stable operation key', () => {
  assert.throws(
    () => buildInvoicePaymentRequest({
      invoiceId: 'i',
      amount: '1.00',
      currency: 'USD',
      paymentDate: '2026-09-21',
    }),
    /stable payment operation key/
  )

  const request = buildInvoicePaymentRequest({
    invoiceId: 'i',
    amount: '1.00',
    currency: 'USD',
    paymentDate: '2026-09-21',
    operationKey: 'operation-123',
  })
  assert.equal(request.p_operation_key, 'operation-123')
})

test('Astra payment idempotency: database serializes and replays one tenant operation', () => {
  assert.match(migration, /payments_user_operation_key_uniq/i)
  assert.match(migration, /pg_advisory_xact_lock/i)
  assert.match(migration, /PAYMENT_OPERATION_CONFLICT/i)
  assert.match(migration, /return v_existing_result/i)
  assert.match(migration, /record_payment_unkeyed_internal/i)
  assert.doesNotMatch(migration, /grant execute on function duewatch_ops\.record_payment_unkeyed_internal[\s\S]*?to authenticated/i)
})

test('Astra manual reminder replay: operation identity is stable and time buckets are gone', () => {
  assert.match(reminderFn, /operationId/)
  assert.match(reminderFn, /manual-reminder:\$\{operationId\}/)
  assert.doesNotMatch(reminderFn, /MANUAL_DEDUPE_WINDOW_MS|Math\.floor\(Date\.now\(\)/)
  assert.match(remindersClient, /getManualReminderOperationId/)
  assert.match(remindersClient, /localStorage/)
  assert.match(migration, /status in \('in_flight', 'uncertain'\)/)
})

test('Astra authority race: both scheduler and approval path use guarded atomic claim acquisition', () => {
  assert.match(migration, /acquire_guarded_autopilot_execution_claim/i)
  assert.match(migration, /for share/i)
  assert.match(migration, /for update/i)
  assert.match(migration, /status = 'dispatching'/i)
  assert.match(scheduler, /acquire_guarded_autopilot_execution_claim/)
  assert.match(reminderFn, /acquire_guarded_autopilot_execution_claim/)
  assert.match(reminderFn, /\.eq\('status', 'dispatching'\)/)
})

test('Astra promise lifecycle: cancellation is not balance-gated and replacement is atomic', () => {
  assert.match(migration, /Cancellation resolves historical commitment state/)
  assert.match(migration, /v_requires_balance_check/i)
  assert.match(migration, /create or replace function public\.replace_promise/i)
  assert.match(migration, /for update/i)
  assert.match(migration, /set status = 'cancelled'/i)
})

test('Astra tenant relationship: event invoice and previous-action ownership are checked structurally', () => {
  assert.match(migration, /EVENT_INVOICE_TENANT_MISMATCH/)
  assert.match(migration, /EVENT_PREVIOUS_ACTION_TENANT_MISMATCH/)
  assert.match(migration, /events_validate_relationships/)
})

test('Astra provider receipt: Resend success requires a non-empty provider message id', () => {
  assert.match(resend, /providerMessageId/)
  assert.match(resend, /success without a verifiable message receipt/i)
  assert.match(resend, /ambiguous: true/)
})

test('Astra completeness: paged reads do not silently accept a capped first page', async () => {
  const rows = Array.from({ length: 1203 }, (_, id) => ({ id }))
  const result = await fetchAllPages(
    async (from, to) => ({ data: rows.slice(from, to + 1), error: null }),
    { pageSize: 500, maxPages: 10 }
  )
  assert.equal(result.complete, true)
  assert.equal(result.data.length, 1203)
  assert.equal(result.data[1202].id, 1202)
})

test('Astra completeness: query errors and max-page exhaustion are explicit incomplete results', async () => {
  const errorResult = await fetchAllPages(
    async () => ({ data: null, error: new Error('db unavailable') }),
    { pageSize: 500 }
  )
  assert.equal(errorResult.complete, false)
  assert.match(errorResult.error.message, /db unavailable/)

  const capped = await fetchAllPages(
    async (from, to) => ({
      data: Array.from({ length: to - from + 1 }, (_, index) => ({ id: from + index })),
      error: null,
    }),
    { pageSize: 2, maxPages: 2 }
  )
  assert.equal(capped.complete, false)
  assert.match(capped.error.message, /completeness limit/)
})
