import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const adapterRoot = path.join(root, 'src/lib/providerAdapters/accounting')
const files = readdirSync(adapterRoot).filter((name) => statSync(path.join(adapterRoot, name)).isFile())

test('CP2 adapters are pure read/interpretation code with no network, OAuth, DB or mutation surface', () => {
  const forbidden = [
    /\bfetch\s*\(/i, /axios/i, /node:https/i, /https\.request/i, /createClient\s*\(/i,
    /process\.env/i, /access_token/i, /refresh_token/i, /client_secret/i,
    /create\s+table/i, /alter\s+table/i, /insert\s+into/i, /update\s+.+\s+set/i,
    /createInvoice\s*\(/i, /updateInvoice\s*\(/i, /createPayment\s*\(/i,
  ]
  for (const name of files) {
    const source = readFileSync(path.join(adapterRoot, name), 'utf8')
    for (const pattern of forbidden) assert.equal(pattern.test(source), false, `${name}: ${pattern}`)
  }
})

test('CP2 adapters import the CP1 trust vocabulary instead of cloning its mechanisms', () => {
  const combined = files.map((name) => readFileSync(path.join(adapterRoot, name), 'utf8')).join('\n')
  assert.match(combined, /integrations\/providerTruthModel\.js/)
  for (const duplicate of ['function admitProviderClaim', 'function resolveFreshness',
    'function governingClaims', 'function deriveCollectionEligibility', 'function recordEvidence']) {
    assert.equal(combined.includes(duplicate), false, duplicate)
  }
})

test('CP2 contains no provider capability to authority or execution bridge', () => {
  const combined = files.map((name) => readFileSync(path.join(adapterRoot, name), 'utf8')).join('\n')
  assert.equal(/grantsAuthority\s*:\s*true/i.test(combined), false)
  assert.equal(/authorizedByG5\s*:\s*true/i.test(combined), false)
  assert.equal(/execute|sendEmail|writeJournal|allocateCredit|refundPayment/i.test(combined), false)
})

test('CP2 creates no UI, migration, schema, Stripe, Gmail, CRM, Drive, Dropbox or CP6 implementation', () => {
  const status = readFileSync(path.join(root, 'docs/integrations/M2H_CP2_ACCOUNTING_CONNECTORS.md'), 'utf8')
  assert.match(status, /no OAuth control plane/i)
  assert.match(status, /CP6 owns durable OAuth/i)
  const relative = files.map((name) => path.join('src/lib/providerAdapters/accounting', name))
  assert.ok(relative.every((name) => !/stripe|gmail|crm|drive|dropbox|jsx|tsx|sql/i.test(name)))
})
