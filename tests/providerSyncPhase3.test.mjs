import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  STRIPE_SYNC_ERROR,
  buildStripeListUrl,
  classifyStripeHttpStatus,
  collectCompleteStripeResource,
  expectedLivemode,
} from '../supabase/functions/_shared/stripeSyncCore.js'

const edge = readFileSync(
  new URL('../supabase/functions/provider-sync/index.ts', import.meta.url),
  'utf8',
)

test('Stripe sync URL uses 100-row cursor pagination and prior complete timestamp', () => {
  const url = new URL(buildStripeListUrl({
    resource: 'charges',
    startingAfter: 'ch_100',
    previousCompleteCursor: '1790000000',
  }))
  assert.equal(url.pathname, '/v1/charges')
  assert.equal(url.searchParams.get('limit'), '100')
  assert.equal(url.searchParams.get('starting_after'), 'ch_100')
  assert.equal(url.searchParams.get('created[gte]'), '1790000000')
})

test('complete Stripe pagination advances only to the greatest observed created timestamp', async () => {
  const pages = [
    {
      data: [
        { id: 'ch_3', created: 300 },
        { id: 'ch_2', created: 200 },
      ],
      has_more: true,
    },
    {
      data: [
        { id: 'ch_2', created: 200 },
        { id: 'ch_1', created: 100 },
      ],
      has_more: false,
    },
  ]
  const calls = []
  const result = await collectCompleteStripeResource({
    resource: 'charges',
    previousCompleteCursor: '50',
    requestPage: async (args) => {
      calls.push(args)
      return pages.shift()
    },
  })

  assert.equal(result.complete, true)
  assert.equal(result.nextCompleteCursor, '300')
  assert.deepEqual(result.items.map((item) => item.id), ['ch_3', 'ch_2', 'ch_1'])
  assert.equal(calls[1].startingAfter, 'ch_2')
})

test('partial Stripe pagination never advances the durable complete cursor', async () => {
  let page = 0
  const result = await collectCompleteStripeResource({
    resource: 'refunds',
    previousCompleteCursor: '500',
    requestPage: async () => {
      page += 1
      if (page === 1) {
        return {
          data: [{ id: 're_1', created: 700 }],
          has_more: true,
        }
      }
      const error = new Error('rate limited')
      error.category = STRIPE_SYNC_ERROR.RATE_LIMIT
      error.code = 'STRIPE_HTTP_429'
      throw error
    },
  })

  assert.equal(result.complete, false)
  assert.equal(result.nextCompleteCursor, '500')
  assert.equal(result.errorCategory, STRIPE_SYNC_ERROR.RATE_LIMIT)
  assert.equal(result.errorCode, 'STRIPE_HTTP_429')
})

test('malformed list response fails closed as schema error', async () => {
  const result = await collectCompleteStripeResource({
    resource: 'invoices',
    requestPage: async () => ({ data: [], has_more: 'false' }),
  })
  assert.equal(result.complete, false)
  assert.equal(result.errorCategory, STRIPE_SYNC_ERROR.SCHEMA)
  assert.equal(result.errorCode, 'STRIPE_LIST_SHAPE_INVALID')
})

test('Stripe sync HTTP failures are categorized without inventing empty results', () => {
  assert.equal(classifyStripeHttpStatus(401), STRIPE_SYNC_ERROR.AUTH)
  assert.equal(classifyStripeHttpStatus(429), STRIPE_SYNC_ERROR.RATE_LIMIT)
  assert.equal(classifyStripeHttpStatus(503), STRIPE_SYNC_ERROR.UNAVAILABLE)
  assert.equal(classifyStripeHttpStatus(422), STRIPE_SYNC_ERROR.SCHEMA)
})

test('connection environment determines expected Stripe livemode exactly', () => {
  assert.equal(expectedLivemode('live'), true)
  assert.equal(expectedLivemode('test'), false)
  assert.throws(() => expectedLivemode('unknown'), /live or test/)
})

test('provider-sync is service-role only and cannot write the canonical payment ledger', () => {
  assert.match(edge, /verifiedJwtRole\(req\) !== 'service_role'/)
  assert.match(edge, /provider_objects/)
  assert.match(edge, /provider_sync_state/)
  assert.doesNotMatch(edge, /record_payment|record_payment_for_tenant|payment_allocations/)
  assert.doesNotMatch(edge, /sendEmail|send-reminder-email|createRefund/)
})

test('provider-sync records attempts before success and only writes last_success after complete collection', () => {
  const attempt = edge.indexOf('last_attempt_at: nowIso')
  const collect = edge.indexOf('const collected = await collectCompleteStripeResource')
  const success = edge.indexOf('last_success_at: nowIso')
  assert.ok(attempt >= 0)
  assert.ok(collect > attempt)
  assert.ok(success > collect)
  assert.match(edge, /if \(!collected\.complete\)[\s\S]*last_error_category/)
})
