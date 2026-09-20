import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeNextReportRun,
  normalizeReportScheduleInput,
  previousCompleteReportPeriod,
} from '../src/lib/reports/reportSchedule.js'

test('weekly next run respects IANA timezone across ordinary DST offset', () => {
  const next = computeNextReportRun(
    {
      cadence: 'weekly',
      weekday: 1,
      local_hour: 8,
      timezone: 'America/New_York',
    },
    new Date('2026-09-20T19:00:00Z')
  )
  // Monday Sep 21 08:00 EDT is 12:00 UTC.
  assert.equal(next, '2026-09-21T12:00:00.000Z')
})

test('monthly next run rolls to the next month when this month time passed', () => {
  const next = computeNextReportRun(
    {
      cadence: 'monthly',
      day_of_month: 5,
      local_hour: 9,
      timezone: 'America/New_York',
    },
    new Date('2026-09-20T19:00:00Z')
  )
  assert.equal(next, '2026-10-05T13:00:00.000Z')
})

test('spring-forward nonexistent hour moves to the first valid later hour that day', () => {
  const next = computeNextReportRun(
    {
      cadence: 'weekly',
      weekday: 0,
      local_hour: 2,
      timezone: 'America/New_York',
    },
    new Date('2027-03-13T12:00:00Z')
  )
  // 02:00 local does not exist on 2027-03-14. First valid whole hour later is 03:00 EDT.
  assert.equal(next, '2027-03-14T07:00:00.000Z')
})

test('previous complete weekly period uses the schedule local calendar date', () => {
  assert.deepEqual(
    previousCompleteReportPeriod(
      { cadence: 'weekly', timezone: 'America/New_York' },
      '2026-09-21T12:00:00.000Z'
    ),
    { startDate: '2026-09-14', endDate: '2026-09-21' }
  )
})

test('previous complete monthly period is the previous calendar month', () => {
  assert.deepEqual(
    previousCompleteReportPeriod(
      { cadence: 'monthly', timezone: 'America/New_York' },
      '2026-10-05T13:00:00.000Z'
    ),
    { startDate: '2026-09-01', endDate: '2026-10-01' }
  )
})

test('schedule normalization is bounded and derives next_run_at', () => {
  const row = normalizeReportScheduleInput({
    userId: 'u1',
    name: ' Weekly CFO ',
    recipientEmail: 'CFO@EXAMPLE.COM',
    cadence: 'weekly',
    weekday: 1,
    localHour: 8,
    timezone: 'America/New_York',
    currency: 'usd',
    activeTab: 'collections',
    now: new Date('2026-09-20T19:00:00Z'),
  })

  assert.equal(row.name, 'Weekly CFO')
  assert.equal(row.recipient_email, 'cfo@example.com')
  assert.equal(row.currency, 'USD')
  assert.equal(row.next_run_at, '2026-09-21T12:00:00.000Z')
  assert.equal(row.delivery_format, 'csv')
  assert.equal(row.period_mode, 'previous_complete_period')
})

test('monthly schedules refuse invalid day-of-month rather than rolling unpredictably', () => {
  assert.throws(
    () => normalizeReportScheduleInput({
      userId: 'u1',
      name: 'Bad monthly',
      recipientEmail: 'cfo@example.com',
      cadence: 'monthly',
      dayOfMonth: 31,
      localHour: 8,
      timezone: 'America/New_York',
    }),
    /day 1–28/
  )
})
