import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CASH_GUARD_STATE,
  STRATEGY_STATE,
  evaluateCashGuard,
  evaluateTemporaryStrategy,
} from '../src/lib/autopilot/nightShiftCashGuard.js'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-09-20T03:00:00.000Z')

test('AP4: Cash Guard uses only evidence-backed risk-adjusted forecast amounts', () => {
  const result = evaluateCashGuard({
    userId: USER,
    cashFloor: 100_000,
    forecastItems: [
      { id: 'a', user_id: USER, eligible: true, risk_adjusted_expected_amount: 60_000, evidence_ref: 'forecast:a' },
      { id: 'b', user_id: USER, eligible: true, risk_adjusted_expected_amount: 20_000, evidence_ref: 'forecast:b' },
      { id: 'c', user_id: USER, eligible: true, risk_adjusted_expected_amount: 99_999, evidence_ref: '' },
    ],
  })
  assert.equal(result.state, CASH_GUARD_STATE.SHORTFALL)
  assert.equal(result.risk_adjusted_expected_collections, 80_000)
  assert.equal(result.shortfall, 20_000)
  assert.equal(result.excluded_items.length, 1)
  assert.equal(result.canonical_money_mutated, false)
  assert.equal(result.authority_granted, false)
})

test('AP4: foreign forecast state fails closed instead of contributing cash', () => {
  const result = evaluateCashGuard({
    userId: USER,
    cashFloor: 100,
    forecastItems: [
      { id: 'foreign', user_id: OTHER, eligible: true, risk_adjusted_expected_amount: 1_000_000, evidence_ref: 'x' },
    ],
  })
  assert.equal(result.state, CASH_GUARD_STATE.UNKNOWN)
  assert.equal(result.reason, 'forecast_tenant_mismatch')
})

test('AP4: temporary strategy must be founder-approved, bounded, and unrevoked', () => {
  const base = {
    user_id: USER,
    approved_at: '2026-09-19T20:00:00.000Z',
    approved_by: USER,
    starts_at: '2026-09-20T02:00:00.000Z',
    expires_at: '2026-09-20T06:00:00.000Z',
    overrides: { priority_bias: 'collectible_cash' },
  }

  const active = evaluateTemporaryStrategy({ userId: USER, strategy: base, now: NOW })
  assert.equal(active.state, STRATEGY_STATE.ACTIVE)
  assert.equal(active.active, true)
  assert.equal(active.authority_granted, false)

  const revoked = evaluateTemporaryStrategy({
    userId: USER,
    strategy: { ...base, revoked_at: '2026-09-20T02:30:00.000Z' },
    now: NOW,
  })
  assert.equal(revoked.state, STRATEGY_STATE.REVOKED)

  const expired = evaluateTemporaryStrategy({
    userId: USER,
    strategy: { ...base, expires_at: '2026-09-20T03:00:00.000Z' },
    now: NOW,
  })
  assert.equal(expired.state, STRATEGY_STATE.EXPIRED)
})

test('AP4: strategy can never smuggle in execution authority', () => {
  for (const [key, value] of [
    ['allowed_actions', ['send_reminder', 'waive_fee']],
    ['allowed_channels', ['email', 'sms']],
    ['approval_required', false],
    ['max_automatic_invoice_amount', 1_000_000],
    ['reminder_timing', { days: 1 }],
  ]) {
    const result = evaluateTemporaryStrategy({
      userId: USER,
      now: NOW,
      strategy: {
        user_id: USER,
        approved_at: '2026-09-19T20:00:00.000Z',
        approved_by: USER,
        starts_at: '2026-09-20T02:00:00.000Z',
        expires_at: '2026-09-20T06:00:00.000Z',
        overrides: { [key]: value },
      },
    })
    assert.equal(result.state, STRATEGY_STATE.INVALID, key)
    assert.equal(result.reason, 'strategy_cannot_expand_authority', key)
  }
})

test('AP4: planning-only forecast weighting is bounded to 0..1', () => {
  const invalid = evaluateTemporaryStrategy({
    userId: USER,
    now: NOW,
    strategy: {
      user_id: USER,
      approved_at: '2026-09-19T20:00:00.000Z',
      approved_by: USER,
      starts_at: '2026-09-20T02:00:00.000Z',
      expires_at: '2026-09-20T06:00:00.000Z',
      overrides: { forecast_weight_cap: 1.2 },
    },
  })
  assert.equal(invalid.state, STRATEGY_STATE.INVALID)
  assert.equal(invalid.reason, 'invalid_forecast_weight_cap')
})
