import test from 'node:test'
import assert from 'node:assert/strict'
import {
  processClaimedReportRun,
  reportDeliveryIdempotencyKey,
  sha256Hex,
} from '../supabase/functions/_shared/reportDeliveryCore.js'

test('report delivery idempotency key is stable for one scheduled occurrence', () => {
  const claim = { schedule_id: 's1', scheduled_for: '2026-09-21T12:00:00.000Z' }
  assert.equal(
    reportDeliveryIdempotencyKey(claim),
    'duewatch-report:s1:2026-09-21T12:00:00.000Z'
  )
})

test('sha256 digest is deterministic', async () => {
  const a = await sha256Hex('abc')
  const b = await sha256Hex('abc')
  assert.equal(a, b)
  assert.equal(a.length, 64)
})

function fakeDb() {
  const rows = {
    invoices: [],
    payments: [],
    payment_allocations: [],
    promises: [],
    autopilot_execution_claims: [],
    awaiting_signature: [],
    events: [],
  }
  return {
    from(table) {
      const chain = {
        select() { return chain },
        eq() { return chain },
        order() { return chain },
        async range() { return { data: rows[table] || [], error: null } },
      }
      return chain
    },
  }
}

const claim = {
  run_id: 'r1',
  lease_token: 'lease1',
  schedule_id: 's1',
  user_id: 'u1',
  scheduled_for: '2026-09-21T12:00:00.000Z',
  period_start: '2026-09-14',
  period_end: '2026-09-21',
  recipient_email: 'cfo@example.com',
  cadence: 'weekly',
  weekday: 1,
  day_of_month: null,
  local_hour: 8,
  timezone: 'America/New_York',
  currency: 'USD',
}

test('successful delivery completes the durable run and advances schedule exactly once', async () => {
  const sends = []
  const completions = []
  const result = await processClaimedReportRun({
    database: fakeDb(),
    claim,
    async sendEmail(input) {
      sends.push(input)
      return { id: 'provider-1', status: 'sent' }
    },
    async completeRun(input) {
      completions.push(input)
    },
  })

  assert.equal(result.ok, true)
  assert.equal(sends.length, 1)
  assert.equal(sends[0].idempotencyKey, 'duewatch-report:s1:2026-09-21T12:00:00.000Z')
  assert.equal(sends[0].attachments.length, 1)
  assert.equal(completions.length, 1)
  assert.equal(completions[0].status, 'sent')
  assert.equal(completions[0].providerMessageId, 'provider-1')
  assert.equal(completions[0].nextRunAt, '2026-09-28T12:00:00.000Z')
})

test('provider failure marks the run failed and does not advance next_run_at', async () => {
  const completions = []
  const result = await processClaimedReportRun({
    database: fakeDb(),
    claim,
    async sendEmail() {
      return { error: 'provider down' }
    },
    async completeRun(input) {
      completions.push(input)
    },
  })

  assert.equal(result.ok, false)
  assert.equal(completions.length, 1)
  assert.equal(completions[0].status, 'failed')
  assert.equal(completions[0].nextRunAt, null)
  assert.match(completions[0].errorDetail, /provider down/)
})
