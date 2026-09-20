import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTOPILOT_MODE } from '../src/lib/autopilot/nightShiftModes.js'
import { CASH_GUARD_STATE } from '../src/lib/autopilot/nightShiftCashGuard.js'
import {
  NIGHT_SHIFT_DISPOSITION,
  NIGHT_SHIFT_WORK_STATE,
  planNightShiftWork,
} from '../src/lib/autopilot/nightShiftPlanner.js'
import { ACTION_SEND_REMINDER } from '../src/lib/nextActionAuthority.js'

const USER = '11111111-1111-4111-8111-111111111111'
const CLIENT = '33333333-3333-4333-8333-333333333333'
const NOW = new Date('2026-09-21T15:00:00.000Z') // Monday 10:00 Chicago

function mode(overrides = {}) {
  return {
    user_id: USER,
    mode: AUTOPILOT_MODE.NIGHT_SHIFT,
    enabled: true,
    business_timezone: 'America/Chicago',
    schedule: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] },
    ...overrides,
  }
}

function invoice(overrides = {}) {
  return { id: 'inv-1', user_id: USER, client_id: CLIENT, ...overrides }
}

function baseEvaluation(overrides = {}) {
  return {
    facts: { amountOutstanding: 1000 },
    recommendation: {
      action: ACTION_SEND_REMINDER,
      tone: 'friendly',
      ruleId: 'rule-1',
      ruleName: 'Friendly reminder',
    },
    authority: { authorized: true, blockedReason: null },
    permission: { requiresApproval: false, canActAutomatically: true },
    ...overrides,
  }
}

function policy(overrides = {}) {
  return {
    user_id: USER,
    enabled: true,
    allowed_actions: [ACTION_SEND_REMINDER],
    allowed_channels: ['email'],
    allowed_automatic_tones: ['friendly'],
    max_automatic_invoice_amount: 5000,
    ...overrides,
  }
}

const contact = {
  timezone: 'America/Chicago',
  windows: [{ start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] }],
}

test('AP5: eligible work is only prepared for the existing execution boundary', () => {
  const result = planNightShiftWork({
    userId: USER,
    modeConfig: mode(),
    invoice: invoice(),
    baseEvaluation: baseEvaluation(),
    authorityPolicy: policy(),
    protectedClients: [],
    clientContact: contact,
    now: NOW,
  })
  assert.equal(result.disposition, NIGHT_SHIFT_DISPOSITION.EXECUTE)
  assert.equal(result.work_state, NIGHT_SHIFT_WORK_STATE.PREPARING)
  assert.equal(result.executed, false)
  assert.equal(result.provider_receipt, null)
  assert.equal(result.requires_execution_time_revalidation, true)
})

test('AP5: outside client contact window becomes a revalidated future schedule, not an immediate send', () => {
  const result = planNightShiftWork({
    userId: USER,
    modeConfig: mode(),
    invoice: invoice(),
    baseEvaluation: baseEvaluation(),
    authorityPolicy: policy(),
    protectedClients: [],
    clientContact: contact,
    now: new Date('2026-09-21T03:00:00.000Z'),
  })
  assert.equal(result.disposition, NIGHT_SHIFT_DISPOSITION.SCHEDULE)
  assert.equal(result.work_state, NIGHT_SHIFT_WORK_STATE.WAITING)
  assert.ok(result.scheduled_for)
  assert.equal(result.requires_execution_time_revalidation, true)
  assert.equal(result.executed, false)
})

test('AP5: protected client remains founder approval even during Cash Guard shortfall', () => {
  const result = planNightShiftWork({
    userId: USER,
    modeConfig: mode(),
    invoice: invoice(),
    baseEvaluation: baseEvaluation(),
    authorityPolicy: policy(),
    protectedClients: [{
      user_id: USER,
      client_id: CLIENT,
      enabled: true,
      outbound_requires_approval: true,
    }],
    clientContact: contact,
    cashGuard: { state: CASH_GUARD_STATE.SHORTFALL },
    now: NOW,
  })
  assert.equal(result.disposition, NIGHT_SHIFT_DISPOSITION.NEEDS_APPROVAL)
  assert.equal(result.priority_reason, 'cash_guard_shortfall')
  assert.equal(result.executed, false)
})

test('AP5: inactive mode blocks work even if lower authority would allow it', () => {
  const result = planNightShiftWork({
    userId: USER,
    modeConfig: mode({ enabled: false }),
    invoice: invoice(),
    baseEvaluation: baseEvaluation(),
    authorityPolicy: policy(),
    protectedClients: [],
    clientContact: contact,
    now: NOW,
  })
  assert.equal(result.disposition, NIGHT_SHIFT_DISPOSITION.BLOCKED)
  assert.equal(result.reason, 'mode_disabled')
})

test('AP5: unknown client contact state blocks instead of guessing', () => {
  const result = planNightShiftWork({
    userId: USER,
    modeConfig: mode(),
    invoice: invoice(),
    baseEvaluation: baseEvaluation(),
    authorityPolicy: policy(),
    protectedClients: [],
    clientContact: { timezone: null, windows: [] },
    now: NOW,
  })
  assert.equal(result.disposition, NIGHT_SHIFT_DISPOSITION.BLOCKED)
  assert.equal(result.reason, 'client_timezone_unavailable')
})

test('AP5: Cash Guard changes priority context but cannot rescue missing authority', () => {
  const result = planNightShiftWork({
    userId: USER,
    modeConfig: mode(),
    invoice: invoice(),
    baseEvaluation: baseEvaluation({
      recommendation: null,
      authority: { authorized: false, blockedReason: 'already_handled' },
      permission: { requiresApproval: null, canActAutomatically: false },
    }),
    authorityPolicy: policy(),
    protectedClients: [],
    clientContact: contact,
    cashGuard: { state: CASH_GUARD_STATE.SHORTFALL },
    now: NOW,
  })
  assert.equal(result.disposition, NIGHT_SHIFT_DISPOSITION.BLOCKED)
  assert.equal(result.reason, 'already_handled')
  assert.equal(result.priority_reason, 'cash_guard_shortfall')
})
