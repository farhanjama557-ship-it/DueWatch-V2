import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  createStripeWebhookTestSignature,
  verifyStripeWebhookSignature,
} from '../supabase/functions/_shared/stripeWebhookSignature.js'
import {
  normalizeStripeWebhookEnvelope,
  stripeRetrieveUrl,
  supportedStripeApiVersion,
} from '../supabase/functions/_shared/stripeWebhookProcessorCore.js'

const webhook = readFileSync(
  new URL('../supabase/functions/provider-webhook/index.ts', import.meta.url),
  'utf8',
)
const processor = readFileSync(
  new URL('../supabase/functions/provider-processor/index.ts', import.meta.url),
  'utf8',
)
const replayMigration = readFileSync(
  new URL('../supabase/migrations/20260922153500_provider_webhook_replay_guard.sql', import.meta.url),
  'utf8',
)

const SECRET = 'whsec_test_duewatch_provider_boundary'
const NOW_SECONDS = 1790089500
const BODY = JSON.stringify({
  id: 'evt_1',
  type: 'charge.succeeded',
  api_version: '2026-08-26.preview',
  account: 'acct_123',
  livemode: false,
  created: NOW_SECONDS,
  data: { object: { id: 'ch_1', object: 'charge', livemode: false } },
})

test('valid Stripe signature verifies against the exact raw body', async () => {
  const header = await createStripeWebhookTestSignature({
    rawBody: BODY,
    secret: SECRET,
    timestamp: NOW_SECONDS,
  })
  const result = await verifyStripeWebhookSignature({
    rawBody: BODY,
    signatureHeader: header,
    secret: SECRET,
    nowMs: NOW_SECONDS * 1000,
  })
  assert.equal(result.verified, true)
  assert.equal(result.reason, null)
})

test('mutating one byte after signing rejects the webhook', async () => {
  const header = await createStripeWebhookTestSignature({
    rawBody: BODY,
    secret: SECRET,
    timestamp: NOW_SECONDS,
  })
  const result = await verifyStripeWebhookSignature({
    rawBody: BODY.replace('ch_1', 'ch_2'),
    signatureHeader: header,
    secret: SECRET,
    nowMs: NOW_SECONDS * 1000,
  })
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'SIGNATURE_MISMATCH')
})

test('wrong Stripe endpoint secret rejects the same valid body', async () => {
  const header = await createStripeWebhookTestSignature({
    rawBody: BODY,
    secret: SECRET,
    timestamp: NOW_SECONDS,
  })
  const result = await verifyStripeWebhookSignature({
    rawBody: BODY,
    signatureHeader: header,
    secret: 'whsec_wrong',
    nowMs: NOW_SECONDS * 1000,
  })
  assert.equal(result.verified, false)
})

test('stale Stripe signature timestamp fails closed', async () => {
  const header = await createStripeWebhookTestSignature({
    rawBody: BODY,
    secret: SECRET,
    timestamp: NOW_SECONDS - 1000,
  })
  const result = await verifyStripeWebhookSignature({
    rawBody: BODY,
    signatureHeader: header,
    secret: SECRET,
    nowMs: NOW_SECONDS * 1000,
  })
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'SIGNATURE_TIMESTAMP_OUTSIDE_TOLERANCE')
})

test('normalizer requires account, livemode, event and object identity', () => {
  const event = JSON.parse(BODY)
  const normalized = normalizeStripeWebhookEnvelope(event)
  assert.equal(normalized.valid, true)
  assert.equal(normalized.account, 'acct_123')
  assert.equal(normalized.objectId, 'ch_1')
  assert.equal(normalized.objectType, 'charge')

  assert.equal(normalizeStripeWebhookEnvelope({ ...event, account: undefined }).valid, false)
  assert.equal(normalizeStripeWebhookEnvelope({ ...event, data: { object: {} } }).valid, false)
})

test('processor API-version support is explicit and exact', () => {
  assert.equal(
    supportedStripeApiVersion('2026-08-26.preview', '2026-08-26.preview,2025-11-17.preview'),
    true,
  )
  assert.equal(
    supportedStripeApiVersion('2099-01-01.unknown', '2026-08-26.preview'),
    false,
  )
  assert.equal(supportedStripeApiVersion(null, '2026-08-26.preview'), false)
})

test('processor re-fetch paths are object-specific and unsupported types fail closed', () => {
  assert.equal(stripeRetrieveUrl('charge', 'ch_1'), 'https://api.stripe.com/v1/charges/ch_1')
  assert.equal(stripeRetrieveUrl('refund', 're_1'), 'https://api.stripe.com/v1/refunds/re_1')
  assert.equal(stripeRetrieveUrl('invoice', 'in_1'), 'https://api.stripe.com/v1/invoices/in_1')
  assert.equal(stripeRetrieveUrl('customer', 'cus_1'), null)
})

test('webhook ingress verifies before resolving a tenant and reads the body once', () => {
  const verifyAt = webhook.indexOf('verifyStripeWebhookSignature')
  const resolveAt = webhook.indexOf("from('provider_connections')")
  assert.ok(verifyAt >= 0)
  assert.ok(resolveAt > verifyAt)
  assert.equal((webhook.match(/await req\.text\(\)/g) || []).length, 1)
  assert.match(webhook, /signature_verified:\s*false[\s\S]*processing_status:\s*'quarantined'/)
  assert.match(webhook, /return json\(\{ received: true \}, 200\)/)
})

test('Connect webhook refuses to platform-attribute a missing account', () => {
  assert.match(webhook, /if \(!account \|\| livemode === null\)/)
  assert.match(webhook, /STRIPE_ACCOUNT_MISSING/)
  assert.match(webhook, /connection_id:\s*null/)
  assert.match(webhook, /user_id:\s*null/)
})

test('webhook and processor have no ledger, promise, approval or send write path', () => {
  for (const source of [webhook, processor]) {
    assert.doesNotMatch(source, /record_payment|record_payment_for_tenant|payment_allocations/)
    assert.doesNotMatch(source, /sendEmail|send-reminder-email|acquire_guarded_autopilot_execution_claim/)
    assert.doesNotMatch(source, /\.from\(['"]promises['"]\)/)
    assert.doesNotMatch(source, /\.from\(['"]awaiting_signature['"]\)/)
  }
})

test('processor requires service-role authority and re-fetches before provider-object write', () => {
  assert.match(processor, /verifiedJwtRole\(req\) !== 'service_role'/)
  const fetchAt = processor.indexOf('fetch(retrieveUrl')
  const writeAt = processor.indexOf("from('provider_objects')")
  assert.ok(fetchAt >= 0)
  assert.ok(writeAt > fetchAt)
})

test('unattributed webhook replay is absorbed by a partial unique index', () => {
  assert.match(
    replayMigration,
    /create unique index provider_webhook_events_unattributed_event_uniq[\s\S]*\(provider, provider_event_id\)[\s\S]*where connection_id is null;/i,
  )
})
