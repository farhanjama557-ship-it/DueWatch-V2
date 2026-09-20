import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTOPILOT_MODE,
  MODE_ACTIVATION,
  modeMayExpandAuthority,
  normalizeModeConfig,
  resolveModeActivation,
} from '../src/lib/autopilot/nightShiftModes.js'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-09-20T03:00:00.000Z')

function config(overrides = {}) {
  return {
    user_id: USER,
    mode: AUTOPILOT_MODE.NORMAL,
    enabled: true,
    ...overrides,
  }
}

test('AP1: operating modes are explicit and bounded', () => {
  assert.deepEqual(
    Object.values(AUTOPILOT_MODE).sort(),
    ['CASH_RECOVERY', 'FULL_AUTOPILOT_AWAY', 'NIGHT_SHIFT', 'NORMAL', 'PROTECT', 'QUARTER_END'].sort(),
  )
})

test('AP1: same-tenant mode config normalizes and freezes', () => {
  const normalized = normalizeModeConfig(config(), { userId: USER })
  assert.equal(normalized.user_id, USER)
  assert.equal(normalized.revision, 1)
  assert.equal(Object.isFrozen(normalized), true)
})

test('AP1: wrong-tenant mode config fails closed', () => {
  assert.throws(
    () => normalizeModeConfig(config({ user_id: OTHER }), { userId: USER }),
    /tenant mismatch/,
  )
})

test('AP1: temporary modes require an explicit expiry', () => {
  for (const mode of [
    AUTOPILOT_MODE.FULL_AUTOPILOT_AWAY,
    AUTOPILOT_MODE.CASH_RECOVERY,
    AUTOPILOT_MODE.PROTECT,
    AUTOPILOT_MODE.QUARTER_END,
  ]) {
    assert.throws(
      () => normalizeModeConfig(config({ mode }), { userId: USER }),
      /requires explicit expiry/,
      mode,
    )
  }
})

test('AP1: temporary mode is active only before its expiry', () => {
  const active = resolveModeActivation(
    config({
      mode: AUTOPILOT_MODE.PROTECT,
      starts_at: '2026-09-20T02:00:00.000Z',
      expires_at: '2026-09-20T04:00:00.000Z',
    }),
    { userId: USER, now: NOW },
  )
  assert.equal(active.activation, MODE_ACTIVATION.ACTIVE)
  assert.equal(active.active, true)

  const expired = resolveModeActivation(
    config({
      mode: AUTOPILOT_MODE.PROTECT,
      starts_at: '2026-09-20T01:00:00.000Z',
      expires_at: '2026-09-20T03:00:00.000Z',
    }),
    { userId: USER, now: NOW },
  )
  assert.equal(expired.activation, MODE_ACTIVATION.EXPIRED)
  assert.equal(expired.active, false)
})

test('AP1: scheduled Night Shift never pretends system-clock evaluation is enough', () => {
  const result = resolveModeActivation(
    config({
      mode: AUTOPILOT_MODE.NIGHT_SHIFT,
      schedule: { start: '22:00', end: '06:00', days: [0, 1, 2, 3, 4, 5, 6] },
    }),
    { userId: USER, now: NOW },
  )
  assert.equal(result.activation, MODE_ACTIVATION.SCHEDULE_REQUIRED)
  assert.equal(result.active, false)
})

test('AP1: an operating posture can never expand authority', () => {
  assert.equal(modeMayExpandAuthority(), false)
})
