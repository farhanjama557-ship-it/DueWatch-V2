import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyClientPair,
  normalizeClientEmail,
  normalizeClientPhone,
  normalizeClientText,
  normalizeSource,
} from '../src/lib/clientIdentity.js'

test('normalizes names, email, phone, and source deterministically', () => {
  assert.equal(normalizeClientText('  Northbend—Studio, LLC '), 'northbend studio llc')
  assert.equal(normalizeClientEmail(' BILLING@Example.COM '), 'billing@example.com')
  assert.equal(normalizeClientPhone('+1 (212) 555-0199'), '12125550199')
  assert.equal(normalizeSource(' Stripe '), 'stripe')
})

test('email alone is review-required', () => {
  assert.deepEqual(classifyClientPair(
    { name: 'Northbend Studio', email: 'billing@example.com' },
    { name: 'Different Company', email: 'BILLING@example.com' },
  ), { classification: 'review_required', ruleCode: 'email_only' })
})

test('email plus normalized name is exact', () => {
  assert.deepEqual(classifyClientPair(
    { name: 'Northbend Studio', email: 'billing@example.com' },
    { name: ' northbend-studio ', email: 'BILLING@example.com' },
  ), { classification: 'exact', ruleCode: 'email_with_name_or_company' })
})

test('shared phone plus matching company remains review-required', () => {
  assert.deepEqual(classifyClientPair(
    { name: 'Reception', company: 'Acme', phone: '+1 212 555 0100' },
    { name: 'Accounts', company: 'ACME', phone: '1 (212) 555-0100' },
  ), {
    classification: 'review_required',
    ruleCode: 'phone_with_name_or_company',
  })
})

test('domain plus company remains review-required', () => {
  assert.deepEqual(classifyClientPair(
    { name: 'Acme East', company: 'Acme', email: 'east@acme.test' },
    { name: 'Acme West', company: 'ACME', email: 'west@acme.test' },
  ), { classification: 'review_required', ruleCode: 'domain_with_company' })
})

test('same normalized name without corroboration requires review', () => {
  assert.deepEqual(classifyClientPair(
    { name: 'Acme', email: 'one@one.test' },
    { name: 'ACME', email: 'two@two.test' },
  ), { classification: 'review_required', ruleCode: 'name_only' })
})

test('same normalized source and exact external ID is exact', () => {
  assert.deepEqual(classifyClientPair(
    { sourceIdentities: [{ source: 'Stripe', externalId: 'cus_123' }] },
    { sourceIdentities: [{ source: ' stripe ', externalId: 'cus_123' }] },
  ), { classification: 'exact', ruleCode: 'external_id' })
})

test('external IDs remain case-sensitive', () => {
  assert.deepEqual(classifyClientPair(
    { sourceIdentities: [{ source: 'stripe', externalId: 'cus_ABC' }] },
    { sourceIdentities: [{ source: 'stripe', externalId: 'cus_abc' }] },
  ), { classification: 'none', ruleCode: null })
})
