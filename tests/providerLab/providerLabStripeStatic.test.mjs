import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const adapterPath = path.join(repo, 'src/lib/providerAdapters/payments/stripeAdapter.js')
const source = fs.readFileSync(adapterPath, 'utf8')

test('CP3 Stripe adapter is pure and contains no network, SDK, OAuth, DB or write call', () => {
  assert.doesNotMatch(source, /\b(?:fetch|axios)\s*\(|stripe-node|StripeClient|from\s+['"]stripe|createOAuth/i)
  assert.doesNotMatch(source, /\.(?:insert|update|delete|upsert|rpc)\s*\(/)
  assert.doesNotMatch(source, /createPaymentIntent|createRefund|createPayout|sendEmail/)
})

test('CP3 uses frozen CP1 truth vocabulary and common connection primitives', () => {
  assert.match(source, /providerTruthModel\.js/)
  assert.match(source, /accountingAdapterCommon\.js/)
  assert.doesNotMatch(source, /function\s+(?:createProviderObservation|resolveFreshness|admitProviderClaim|governingClaims)/)
})

test('CP3 never emits T6 or collection eligibility directly', () => {
  assert.doesNotMatch(source, /T6_BANK_LEDGER_RECONCILIATION_STATE/)
  assert.doesNotMatch(source, /\bELIGIBLE\b/)
  assert.match(source, /establishesBankLedgerReconciliation:\s*false/)
})

test('CP3 changed no G5, G8, migration or UI file', () => {
  const tracked = [
    'src/lib/companyBrain', 'src/lib/dwIntelligence', 'supabase/migrations',
    'supabase/functions', 'src/components', 'src/pages',
  ]
  for (const relative of tracked) {
    const result = execFileSync('git', ['diff', '--name-only',
      '688da386c9f77cde5d0f8992c43a814c06164505', '--', relative],
    { cwd: repo, encoding: 'utf8' }).trim()
    assert.equal(result, '')
  }
})
