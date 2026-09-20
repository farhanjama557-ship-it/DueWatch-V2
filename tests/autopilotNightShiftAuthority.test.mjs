import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTION_SEND_REMINDER } from '../src/lib/nextActionAuthority.js'
import {
  NIGHT_SHIFT_AUTHORITY,
  evaluateNightShiftAuthority,
} from '../src/lib/autopilot/nightShiftAuthority.js'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const CLIENT = '33333333-3333-4333-8333-333333333333'

function invoice(overrides = {}) {
  return { id: 'inv-1', user_id: USER, client_id: CLIENT, ...overrides }
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

test('AP3: explicit same-tenant policy preserves already-proven automatic authority', () => {
  const result = evaluateNightShiftAuthority({
    userId: USER,
    invoice: invoice(),
    baseEvaluation: evaluation(),
    authorityPolicy: policy(),
    protectedClients: [],
  })
  assert.equal(result.status, NIGHT_SHIFT_AUTHORITY.AUTOMATIC)
  assert.equal(result.automatic, true)
})

test('AP3: Night Shift never invents authority for an unverified action', () => {
  const result = evaluateNightShiftAuthority({
    userId: USER,
    invoice: invoice(),
    baseEvaluation: evaluation({
      recommendation: { action: 'waive_fee', tone: null, ruleId: 'x' },
    }),
    authorityPolicy: policy({ allowed_actions: ['waive_fee'] }),
    protectedClients: [],
  })
  assert.equal(result.status, NIGHT_SHIFT_AUTHORITY.BLOCKED)
  assert.equal(result.reason, 'action_outside_verified_execution_scope')
})

test('AP3: missing or foreign authority policy fails closed', () => {
  const missing = evaluateNightShiftAuthority({
    userId: USER,
    invoice: invoice(),
    baseEvaluation: evaluation(),
    authorityPolicy: null,
    protectedClients: [],
  })
  assert.equal(missing.status, NIGHT_SHIFT_AUTHORITY.BLOCKED)

  const foreign = evaluateNightShiftAuthority({
    userId: USER,
    invoice: invoice(),
    baseEvaluation: evaluation(),
    authorityPolicy: policy({ user_id: OTHER }),
    protectedClients: [],
  })
  assert.equal(foreign.reason, 'authority_policy_tenant_mismatch')
})

test('AP3: protected client downgrades automatic action to founder approval', () => {
  const result = evaluateNightShiftAuthority({
    userId: USER,
    invoice: invoice(),
    baseEvaluation: evaluation(),
    authorityPolicy: policy(),
    protectedClients: [{
      user_id: USER,
      client_id: CLIENT,
      enabled: true,
      outbound_requires_approval: true,
    }],
  })
  assert.equal(result.status, NIGHT_SHIFT_AUTHORITY.APPROVAL_REQUIRED)
  assert.equal(result.reason, 'protected_client_requires_approval')
})

test('AP3: value ceiling and tone policy only downgrade, never expand', () => {
  const overCeiling = evaluateNightShiftAuthority({
    userId: USER,
    invoice: invoice(),
    baseEvaluation: evaluation({ facts: { amountOutstanding: 9000 } }),
    authorityPolicy: policy(),
    protectedClients: [],
  })
  assert.equal(overCeiling.status, NIGHT_SHIFT_AUTHORITY.APPROVAL_REQUIRED)

  const disallowedTone = evaluateNightShiftAuthority({
    userId: USER,
    invoice: invoice(),
    baseEvaluation: evaluation({
      recommendation: {
        action: ACTION_SEND_REMINDER,
        tone: 'firm',
        ruleId: 'rule-1',
        ruleName: 'Firm reminder',
      },
    }),
    authorityPolicy: policy(),
    protectedClients: [],
  })
  assert.equal(disallowedTone.status, NIGHT_SHIFT_AUTHORITY.APPROVAL_REQUIRED)
})

test('AP3: existing approval requirement is preserved', () => {
  const result = evaluateNightShiftAuthority({
    userId: USER,
    invoice: invoice(),
    baseEvaluation: evaluation({
      permission: { requiresApproval: true, canActAutomatically: false },
    }),
    authorityPolicy: policy(),
    protectedClients: [],
  })
  assert.equal(result.status, NIGHT_SHIFT_AUTHORITY.APPROVAL_REQUIRED)
  assert.equal(result.reason, 'base_authority_requires_approval')
})

test('AP3: paused/off lower-layer permission cannot be converted into a new approval path', () => {
  const result = evaluateNightShiftAuthority({
    userId: USER,
    invoice: invoice(),
    baseEvaluation: evaluation({
      permission: { requiresApproval: false, canActAutomatically: false },
    }),
    authorityPolicy: policy(),
    protectedClients: [],
  })
  assert.equal(result.status, NIGHT_SHIFT_AUTHORITY.BLOCKED)
  assert.equal(result.reason, 'base_permission_not_automatic')
})

test('AP3: foreign protected-client state blocks instead of being silently ignored', () => {
  const result = evaluateNightShiftAuthority({
    userId: USER,
    invoice: invoice(),
    baseEvaluation: evaluation(),
    authorityPolicy: policy(),
    protectedClients: [{
      user_id: OTHER,
      client_id: CLIENT,
      enabled: true,
      outbound_requires_approval: true,
    }],
  })
  assert.equal(result.status, NIGHT_SHIFT_AUTHORITY.BLOCKED)
  assert.equal(result.reason, 'protected_client_state_tenant_mismatch')
})
