import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTOPILOT_MODE,
  MODE_ACTIVATION,
  modeMayExpandAuthority,
  normalizeModeConfig,
} from '../src/lib/autopilot/nightShiftModes.js'
import { resolveNightShiftSchedule } from '../src/lib/autopilot/nightShiftTime.js'
import {
  NIGHT_SHIFT_AUTHORITY,
  evaluateNightShiftAuthority,
} from '../src/lib/autopilot/nightShiftAuthority.js'
import {
  CASH_GUARD_STATE,
  STRATEGY_STATE,
  evaluateCashGuard,
  evaluateTemporaryStrategy,
} from '../src/lib/autopilot/nightShiftCashGuard.js'
import {
  NIGHT_SHIFT_DISPOSITION,
  planNightShiftWork,
} from '../src/lib/autopilot/nightShiftPlanner.js'
import {
  SHIFT_RESULT,
  buildMorningHandoff,
  buildShiftLogEntry,
} from '../src/lib/autopilot/nightShiftProof.js'
import { ACTION_SEND_REMINDER } from '../src/lib/nextActionAuthority.js'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const CLIENT = '33333333-3333-4333-8333-333333333333'
const NOW = new Date('2026-09-21T15:00:00.000Z')

function invoice() {
  return { id: 'inv-1', user_id: USER, client_id: CLIENT }
}

function evaluation(overrides = {}) {
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

function activeMode() {
  return {
    user_id: USER,
    mode: AUTOPILOT_MODE.NIGHT_SHIFT,
    enabled: true,
    business_timezone: 'America/Chicago',
    schedule: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] },
  }
}

test('AP7 freeze: no mode can expand authority', () => {
  assert.equal(modeMayExpandAuthority(), false)
})

test('AP7 freeze: temporary autonomy without expiry is structurally rejected', () => {
  assert.throws(() => normalizeModeConfig({
    user_id: USER,
    mode: AUTOPILOT_MODE.FULL_AUTOPILOT_AWAY,
    enabled: true,
  }, { userId: USER }), /explicit expiry/)
})

test('AP7 freeze: recurring Night Shift with unknown timezone is inactive', () => {
  const state = resolveNightShiftSchedule({
    user_id: USER,
    mode: AUTOPILOT_MODE.NIGHT_SHIFT,
    enabled: true,
    schedule: { start: '22:00', end: '06:00', days: [0, 1, 2, 3, 4, 5, 6] },
  }, { userId: USER, now: NOW })
  assert.equal(state.activation, MODE_ACTIVATION.INVALID)
  assert.equal(state.active, false)
})

test('AP7 freeze: model/planner cannot turn an unsupported action into execution authority', () => {
  const auth = evaluateNightShiftAuthority({
    userId: USER,
    invoice: invoice(),
    baseEvaluation: evaluation({
      recommendation: { action: 'legal_escalation', tone: 'firm', ruleId: 'invented' },
    }),
    authorityPolicy: policy({ allowed_actions: ['legal_escalation'] }),
    protectedClients: [],
  })
  assert.equal(auth.status, NIGHT_SHIFT_AUTHORITY.BLOCKED)
  assert.equal(auth.reason, 'action_outside_verified_execution_scope')
})

test('AP7 freeze: foreign protected-client state poisons the decision closed', () => {
  const auth = evaluateNightShiftAuthority({
    userId: USER,
    invoice: invoice(),
    baseEvaluation: evaluation(),
    authorityPolicy: policy(),
    protectedClients: [{ user_id: OTHER, client_id: CLIENT, enabled: true }],
  })
  assert.equal(auth.status, NIGHT_SHIFT_AUTHORITY.BLOCKED)
  assert.equal(auth.reason, 'protected_client_state_tenant_mismatch')
})

test('AP7 freeze: unknown contact perimeter can never produce EXECUTE or SCHEDULE', () => {
  const work = planNightShiftWork({
    userId: USER,
    modeConfig: activeMode(),
    invoice: invoice(),
    baseEvaluation: evaluation(),
    authorityPolicy: policy(),
    protectedClients: [],
    clientContact: { timezone: null, windows: null },
    now: NOW,
  })
  assert.equal(work.disposition, NIGHT_SHIFT_DISPOSITION.BLOCKED)
})

test('AP7 freeze: Cash Guard refuses foreign forecast evidence', () => {
  const state = evaluateCashGuard({
    userId: USER,
    cashFloor: 10,
    forecastItems: [{
      user_id: OTHER,
      eligible: true,
      risk_adjusted_expected_amount: 1000000,
      evidence_ref: 'foreign',
    }],
  })
  assert.equal(state.state, CASH_GUARD_STATE.UNKNOWN)
})

test('AP7 freeze: temporary strategy cannot disable approval or widen actions', () => {
  for (const overrides of [
    { approval_required: false },
    { allowed_actions: ['send_reminder', 'waive_fee'] },
  ]) {
    const state = evaluateTemporaryStrategy({
      userId: USER,
      now: NOW,
      strategy: {
        user_id: USER,
        approved_at: '2026-09-21T14:00:00.000Z',
        approved_by: USER,
        starts_at: '2026-09-21T14:00:00.000Z',
        expires_at: '2026-09-21T18:00:00.000Z',
        overrides,
      },
    })
    assert.equal(state.state, STRATEGY_STATE.INVALID)
    assert.equal(state.reason, 'strategy_cannot_expand_authority')
  }
})

test('AP7 freeze: no provider receipt means no completed external-action proof', () => {
  assert.throws(() => buildShiftLogEntry({
    userId: USER,
    shiftRunId: 'run-1',
    evidenceRefs: ['invoice:1'],
    authorityProof: { authorized: true },
    plan: { disposition: NIGHT_SHIFT_DISPOSITION.EXECUTE },
    result: { status: SHIFT_RESULT.COMPLETED, external_action_performed: true },
  }), /provider and execution claim receipt/)
})

test('AP7 freeze: PTP and forecasts can never inflate Morning Handoff collected cash', () => {
  const handoff = buildMorningHandoff({
    userId: USER,
    shiftRun: { id: 'run-1', user_id: USER, mode: 'NIGHT_SHIFT' },
    entries: [],
    canonicalMoneyEvents: [
      { user_id: USER, shift_run_id: 'run-1', kind: 'PTP_PROMISED', canonical: false, amount: 50000, evidence_ref: 'ptp' },
      { user_id: USER, shift_run_id: 'run-1', kind: 'FORECAST_EXPECTED', canonical: false, amount: 70000, evidence_ref: 'forecast' },
    ],
    generatedAt: '2026-09-21T18:00:00.000Z',
  })
  assert.equal(handoff.money_collected, 0)
  assert.equal(handoff.unauthorized_actions, 0)
})
