import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { deriveStripeInvoiceLinkDecision } from '../src/lib/integrations/providerLinkingCore.js'
import { deriveStripeInvoiceLinkDecision as deriveServerStripeInvoiceLinkDecision } from '../supabase/functions/_shared/providerLinkingCore.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

function invoice(id, overrides = {}) {
  return {
    id,
    inv_num: 'INV-100',
    amount: '100.00',
    amount_paid: '0.00',
    paid: false,
    currency: 'USD',
    ...overrides,
  }
}

test('Stripe metadata with an owned DueWatch invoice id is deterministic', () => {
  const decision = deriveStripeInvoiceLinkDecision({
    providerObject: {
      object_type: 'charge',
      object_state: {
        id: 'ch_1',
        amount: 10000,
        currency: 'usd',
        metadata: { duewatch_invoice_id: A },
      },
    },
    invoices: [invoice(A)],
  })
  assert.deepEqual(decision.deterministic, { entityId: A, matchBasis: 'metadata' })
  assert.equal(decision.exceptionReason, null)
})

test('Stripe invoice exact number + currency + amount uniquely resolves', () => {
  const decision = deriveStripeInvoiceLinkDecision({
    providerObject: {
      object_type: 'invoice',
      object_state: {
        id: 'in_1',
        number: 'INV-100',
        total: 10000,
        currency: 'usd',
      },
    },
    invoices: [invoice(A), invoice(B, { inv_num: 'INV-200' })],
  })
  assert.deepEqual(decision.deterministic, { entityId: A, matchBasis: 'exact_number' })
})

test('amount and currency alone never auto-link even with one candidate', () => {
  const decision = deriveStripeInvoiceLinkDecision({
    providerObject: {
      object_type: 'charge',
      object_state: { id: 'ch_1', amount: 10000, currency: 'usd' },
    },
    invoices: [invoice(A)],
  })
  assert.equal(decision.deterministic, null)
  assert.deepEqual(decision.proposals, [A])
  assert.equal(decision.exceptionReason, 'LINK_CONFIRMATION_REQUIRED')
})

test('two same-amount invoices stay ambiguous and neither is selected', () => {
  const decision = deriveStripeInvoiceLinkDecision({
    providerObject: {
      object_type: 'charge',
      object_state: { id: 'ch_1', amount: 50000, currency: 'gbp' },
    },
    invoices: [
      invoice(A, { amount: '500.00', currency: 'GBP', inv_num: 'A' }),
      invoice(B, { amount: '500.00', currency: 'GBP', inv_num: 'B' }),
    ],
  })
  assert.equal(decision.deterministic, null)
  assert.deepEqual([...decision.proposals].sort(), [A, B].sort())
  assert.equal(decision.exceptionReason, 'AMBIGUOUS_INVOICE')
})

test('unknown Stripe currency parks instead of assuming an exponent', () => {
  const decision = deriveStripeInvoiceLinkDecision({
    providerObject: {
      object_type: 'charge',
      object_state: { id: 'ch_1', amount: 10000, currency: 'xts' },
    },
    invoices: [invoice(A, { currency: 'XTS' })],
  })
  assert.equal(decision.deterministic, null)
  assert.equal(decision.exceptionReason, 'CURRENCY_UNKNOWN')
})

test('a confirmed provider invoice link may deterministically carry a charge to the same DueWatch invoice', () => {
  const decision = deriveStripeInvoiceLinkDecision({
    providerObject: {
      object_type: 'charge',
      object_state: { id: 'ch_1', invoice: 'in_1', amount: 10000, currency: 'usd' },
    },
    invoices: [invoice(A)],
    confirmedProviderInvoiceLinks: { in_1: A },
  })
  assert.deepEqual(decision.deterministic, { entityId: A, matchBasis: 'stored_id' })
})

const migration = readFileSync(
  new URL('../supabase/migrations/20260922160000_provider_link_confirmation.sql', import.meta.url),
  'utf8',
)

test('link confirmation derives tenant from auth.uid and accepts no tenant argument', () => {
  assert.match(migration, /v_user_id uuid := auth\.uid\(\)/)
  const signature = migration.match(/create function public\.confirm_provider_object_link\([\s\S]*?\) returns/i)?.[0] || ''
  assert.match(signature, /p_link_id uuid/)
  assert.doesNotMatch(signature, /p_user_id|p_tenant/)
})

test('link confirmation verifies entity ownership and leaves one confirmed link', () => {
  assert.match(migration, /PROVIDER_LINK_ENTITY_TENANT_MISMATCH/)
  assert.match(migration, /provider_object_links_one_confirmed_entity/)
  assert.match(migration, /confirmed_by = v_user_id/)
  assert.match(migration, /match_basis = 'confirmed'/)
  assert.match(migration, /delete from public\.provider_object_links[\s\S]*confirmed_at is null/)
})

test('confirming a provider link resolves only same-tenant open reconciliation exceptions', () => {
  assert.match(
    migration,
    /update public\.provider_reconciliation_exceptions[\s\S]*user_id = v_user_id[\s\S]*provider_object_id = v_link\.provider_object_id[\s\S]*resolved_at is null/i,
  )
})


test('browser/library and server linking cores agree on ambiguity decisions', () => {
  const input = {
    providerObject: {
      object_type: 'charge',
      object_state: { id: 'ch_parity', amount: 50000, currency: 'gbp' },
    },
    invoices: [
      invoice(A, { amount: '500.00', currency: 'GBP', inv_num: 'A' }),
      invoice(B, { amount: '500.00', currency: 'GBP', inv_num: 'B' }),
    ],
  }
  const clientDecision = deriveStripeInvoiceLinkDecision(input)
  const serverDecision = deriveServerStripeInvoiceLinkDecision(input)
  assert.deepEqual(serverDecision, clientDecision)
})

test('provider processor persists proposals/exceptions only after provider object evidence and still has no ledger path', () => {
  const source = readFileSync(
    new URL('../supabase/functions/provider-processor/index.ts', import.meta.url),
    'utf8',
  )
  const objectWrite = source.indexOf('const { data: providerObject, error: objectError }')
  const linkingCall = source.indexOf('const linking = await syncInvoiceLinkProposals({')
  assert.ok(objectWrite >= 0)
  assert.ok(linkingCall > objectWrite)
  assert.match(source, /from\('provider_object_links'\)/)
  assert.match(source, /from\('provider_reconciliation_exceptions'\)/)
  assert.match(source, /match_basis:\s*'proposal'/)
  assert.doesNotMatch(source, /record_payment|record_payment_for_tenant|payment_allocations/)
  assert.doesNotMatch(source, /sendEmail|acquire_guarded_autopilot_execution_claim/)
})
