import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTOPILOT_MODE, MODE_ACTIVATION } from '../src/lib/autopilot/nightShiftModes.js'
import {
  evaluateContactWindow,
  isValidTimeZone,
  recurringWindowContains,
  resolveNightShiftSchedule,
  zonedLocalParts,
} from '../src/lib/autopilot/nightShiftTime.js'

const USER = '11111111-1111-4111-8111-111111111111'

test('AP2: IANA timezone validation fails closed', () => {
  assert.equal(isValidTimeZone('America/New_York'), true)
  assert.equal(isValidTimeZone('Not/A_Timezone'), false)
})

test('AP2: Night Shift supports recurring overnight schedules in business local time', () => {
  const config = {
    user_id: USER,
    mode: AUTOPILOT_MODE.NIGHT_SHIFT,
    enabled: true,
    business_timezone: 'America/New_York',
    schedule: { start: '22:00', end: '06:00', days: [0, 1, 2, 3, 4, 5, 6] },
  }

  const atTwoAmEastern = resolveNightShiftSchedule(config, {
    userId: USER,
    now: new Date('2026-09-20T06:00:00.000Z'),
  })
  assert.equal(atTwoAmEastern.activation, MODE_ACTIVATION.ACTIVE)
  assert.equal(atTwoAmEastern.active, true)

  const atNoonEastern = resolveNightShiftSchedule(config, {
    userId: USER,
    now: new Date('2026-09-20T16:00:00.000Z'),
  })
  assert.equal(atNoonEastern.activation, MODE_ACTIVATION.INACTIVE)
  assert.equal(atNoonEastern.active, false)
  assert.ok(atNoonEastern.next_start_at)
})

test('AP2: missing Night Shift timezone never activates a recurring schedule', () => {
  const result = resolveNightShiftSchedule({
    user_id: USER,
    mode: AUTOPILOT_MODE.NIGHT_SHIFT,
    enabled: true,
    schedule: { start: '22:00', end: '06:00', days: [0, 1, 2, 3, 4, 5, 6] },
  }, { userId: USER, now: new Date('2026-09-20T06:00:00.000Z') })
  assert.equal(result.activation, MODE_ACTIVATION.INVALID)
  assert.equal(result.active, false)
})

test('AP2: client communications are blocked when timezone or windows are unknown', () => {
  assert.deepEqual(
    evaluateContactWindow({ timezone: null, windows: [] }),
    {
      allowed: false,
      reason: 'client_timezone_unavailable',
      timezone: null,
      next_allowed_at: null,
    },
  )

  const noWindows = evaluateContactWindow({ timezone: 'America/Chicago', windows: [] })
  assert.equal(noWindows.allowed, false)
  assert.equal(noWindows.reason, 'contact_window_unavailable')
})

test('AP2: client-local contact window allows only configured local business time', () => {
  const windows = [{ start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] }]

  const open = evaluateContactWindow({
    timezone: 'America/Chicago',
    windows,
    now: new Date('2026-09-21T15:00:00.000Z'),
  })
  assert.equal(open.allowed, true)

  const closed = evaluateContactWindow({
    timezone: 'America/Chicago',
    windows,
    now: new Date('2026-09-21T03:00:00.000Z'),
  })
  assert.equal(closed.allowed, false)
  assert.equal(closed.reason, 'outside_contact_window')
  assert.ok(closed.next_allowed_at)
})

test('AP2: DST fall-back repeated local hour is evaluated consistently', () => {
  const window = {
    timezone: 'America/New_York',
    start: '01:00',
    end: '02:00',
    days: [0],
  }
  const firstOneThirty = new Date('2026-11-01T05:30:00.000Z')
  const secondOneThirty = new Date('2026-11-01T06:30:00.000Z')
  assert.equal(recurringWindowContains(window, firstOneThirty).active, true)
  assert.equal(recurringWindowContains(window, secondOneThirty).active, true)
  assert.equal(zonedLocalParts(firstOneThirty, 'America/New_York').hour, 1)
  assert.equal(zonedLocalParts(secondOneThirty, 'America/New_York').hour, 1)
})

test('AP2: DST spring-forward never invents the skipped 02:xx local hour', () => {
  const before = zonedLocalParts(new Date('2026-03-08T06:30:00.000Z'), 'America/New_York')
  const after = zonedLocalParts(new Date('2026-03-08T07:30:00.000Z'), 'America/New_York')
  assert.equal(before.hour, 1)
  assert.equal(after.hour, 3)
})
