import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const startPath = path.join(repo, 'supabase/functions/provider-oauth-start/index.ts')
const callbackPath = path.join(repo, 'supabase/functions/provider-oauth-callback/index.ts')
const start = readFileSync(startPath, 'utf8')
const callback = readFileSync(callbackPath, 'utf8')

test('OAuth start is JWT-authenticated and state is tenant-bound server-side', () => {
  assert.match(start, /admin\.auth\.getUser\(jwt\)/)
  assert.match(start, /user_id:\s*user\.id/)
  assert.match(start, /provider:\s*'stripe'/)
  assert.match(start, /state_token:\s*state/)
  assert.match(start, /STATE_TTL_MS\s*=\s*10 \* 60 \* 1000/)
  assert.match(start, /crypto\.getRandomValues\(bytes\)/)
})

test('Stripe OAuth asks only for read-only provider scope', () => {
  assert.match(start, /url\.searchParams\.set\('scope',\s*'read_only'\)/)
  assert.doesNotMatch(start, /read_write/)
})

test('OAuth callback derives tenant only from the state row, never request tenant or session', () => {
  assert.doesNotMatch(callback, /auth\.getUser\(/)
  assert.doesNotMatch(callback, /searchParams\.get\(['"](?:user_id|userId|tenant|tenant_id)['"]\)/)
  assert.match(callback, /\.eq\('state_token',\s*stateToken\)/)
  assert.match(callback, /user_id:\s*consumedState\.user_id/)
})

test('OAuth state consumption is conditional, expiring, and single-use', () => {
  assert.match(callback, /\.is\('consumed_at',\s*null\)/)
  assert.match(callback, /\.gt\('expires_at',\s*consumedAt\)/)
  assert.match(callback, /already used or expired/i)
})

test('OAuth callback persists only non-secret Stripe connection facts', () => {
  assert.match(callback, /provider_account_id:\s*stripeAccountId/)
  assert.match(callback, /environment,/)
  assert.match(callback, /granted_scopes:\s*grantedScopes/)
  assert.doesNotMatch(callback, /access_token\s*:/i)
  assert.doesNotMatch(callback, /refresh_token\s*:/i)
  assert.doesNotMatch(callback, /credential_ref\s*:/i)
  assert.doesNotMatch(callback, /webhook_secret_ref\s*:/i)
})

test('provider OAuth paths cannot send, refund, or write the payment ledger', () => {
  for (const source of [start, callback]) {
    assert.doesNotMatch(source, /sendEmail|send-reminder-email|record_payment|recordPayment|createRefund|refundPayment/)
    assert.doesNotMatch(source, /autopilot_execution_claims|acquire_guarded_autopilot_execution_claim/)
  }
})

test('callback has no caller-controlled redirect target', () => {
  assert.match(callback, /DUEWATCH_APP_URL/)
  assert.doesNotMatch(callback, /searchParams\.get\(['"](?:redirect|return_to|returnTo|app_url)['"]\)/)
})

test('Stripe OAuth response secrets are neither logged nor returned', () => {
  assert.doesNotMatch(callback, /console\.(?:log|info|debug)\([^\n]*(?:tokenResult|access_token|refresh_token)/i)
  assert.doesNotMatch(callback, /return\s+.*(?:access_token|refresh_token)/i)
})
