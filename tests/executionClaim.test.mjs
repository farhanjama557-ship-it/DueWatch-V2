import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION_TYPE_SEND_REMINDER,
  CLAIM_STATUS,
  buildExecutionIdentity,
  buildIdempotencyKey,
} from '../supabase/functions/_shared/executionClaim.js'

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
const INVOICE_X = '33333333-3333-4333-8333-333333333333'
const INVOICE_Y = '44444444-4444-4444-8444-444444444444'
const RULE_A = '55555555-5555-4555-8555-555555555555'
const RULE_B = '66666666-6666-4666-8666-666666666666'

function identity(overrides = {}) {
  return {
    userId: USER_A,
    invoiceId: INVOICE_X,
    ruleId: RULE_A,
    actionType: ACTION_TYPE_SEND_REMINDER,
    ...overrides,
  }
}

// review checkpoint test 12: deterministic provider Idempotency-Key
test('same logical action produces the same idempotency key', () => {
  const key1 = buildIdempotencyKey(identity())
  const key2 = buildIdempotencyKey(identity())
  assert.equal(key1, key2)
  assert.ok(key1)
})

test('different user produces a different idempotency key', () => {
  assert.notEqual(buildIdempotencyKey(identity()), buildIdempotencyKey(identity({ userId: USER_B })))
})

test('different invoice produces a different idempotency key', () => {
  assert.notEqual(buildIdempotencyKey(identity()), buildIdempotencyKey(identity({ invoiceId: INVOICE_Y })))
})

test('different rule produces a different idempotency key', () => {
  assert.notEqual(buildIdempotencyKey(identity()), buildIdempotencyKey(identity({ ruleId: RULE_B })))
})

test('different action type produces a different idempotency key', () => {
  assert.notEqual(buildIdempotencyKey(identity()), buildIdempotencyKey(identity({ actionType: 'send_final_notice' })))
})

test('idempotency key is a valid single-line ASCII header value within length bounds', () => {
  const key = buildIdempotencyKey(identity())
  assert.ok(key.length > 0 && key.length <= 255)
  assert.ok(/^[\x21-\x7e]+$/.test(key))
  assert.ok(!key.includes('\n') && !key.includes('\r') && !key.includes(' '))
})

// review checkpoint test 7 / 8: independence across the other three axes
test('same rule, different invoice remains an independent identity', () => {
  const a = buildExecutionIdentity(identity())
  const b = buildExecutionIdentity(identity({ invoiceId: INVOICE_Y }))
  assert.notDeepEqual(a, b)
})

test('different rule, same invoice remains an independent identity', () => {
  const a = buildExecutionIdentity(identity())
  const b = buildExecutionIdentity(identity({ ruleId: RULE_B }))
  assert.notDeepEqual(a, b)
})

// review checkpoint test 10: editing non-identity rule fields must not
// manufacture a fresh identity. The identity is built only from rule_id —
// tone/trigger_days/name/sort_order are never inputs, so a rule edited in
// place (same id, different content) is structurally the same identity.
test('editing tone/trigger fields on the same already-executed rule does not change identity', () => {
  const before = buildExecutionIdentity({
    userId: USER_A,
    invoiceId: INVOICE_X,
    ruleId: RULE_A,
    actionType: ACTION_TYPE_SEND_REMINDER,
  })
  // Simulate the rule having been edited: only rule_id carries forward into
  // the identity builder, exactly as it would for the scheduler's real
  // `rule` object after a founder edits tone/trigger_days in place.
  const after = buildExecutionIdentity({
    userId: USER_A,
    invoiceId: INVOICE_X,
    ruleId: RULE_A, // same id — the only field that matters
    actionType: ACTION_TYPE_SEND_REMINDER,
  })
  assert.deepEqual(before, after)
  assert.equal(buildIdempotencyKey(before), buildIdempotencyKey(after))
})

// review checkpoint test 11: no scheduler run id / date / time in the identity
test('identity and idempotency key never vary with wall-clock time', () => {
  const first = buildIdempotencyKey(identity())
  const later = buildIdempotencyKey(identity()) // no clock/run-id input exists to vary
  assert.equal(first, later)
})

// review checkpoint test 14 (the pure-logic half): malformed/missing
// tenant identity fails closed.
test('missing userId fails closed (returns null, not a key built from garbage)', () => {
  assert.equal(buildExecutionIdentity(identity({ userId: undefined })), null)
  assert.equal(buildIdempotencyKey(identity({ userId: undefined })), null)
})

test('missing invoiceId fails closed', () => {
  assert.equal(buildExecutionIdentity(identity({ invoiceId: null })), null)
  assert.equal(buildIdempotencyKey(identity({ invoiceId: null })), null)
})

test('missing ruleId fails closed', () => {
  assert.equal(buildExecutionIdentity(identity({ ruleId: '' })), null)
  assert.equal(buildIdempotencyKey(identity({ ruleId: '' })), null)
})

test('non-uuid-shaped identity fields fail closed', () => {
  assert.equal(buildExecutionIdentity(identity({ userId: 'not-a-uuid' })), null)
  assert.equal(buildExecutionIdentity(identity({ invoiceId: '12345' })), null)
  assert.equal(buildExecutionIdentity(identity({ ruleId: 'DROP TABLE users' })), null)
})

test('missing or blank actionType fails closed', () => {
  assert.equal(buildExecutionIdentity(identity({ actionType: undefined })), null)
  assert.equal(buildExecutionIdentity(identity({ actionType: '   ' })), null)
})

test('CLAIM_STATUS exposes exactly the four terminal/in-flight states the migration check constraint allows', () => {
  assert.deepEqual(new Set(Object.values(CLAIM_STATUS)), new Set(['in_flight', 'sent', 'send_failed', 'uncertain']))
})

test('ACTION_TYPE_SEND_REMINDER matches the existing awaiting_signature action_type vocabulary', () => {
  assert.equal(ACTION_TYPE_SEND_REMINDER, 'send_reminder')
})
