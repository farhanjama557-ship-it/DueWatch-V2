import { createProviderObservation, interpretObservation } from '../../src/lib/integrations/providerObservation.js'
import { resolveFreshness } from '../../src/lib/integrations/providerFreshness.js'
import { admitProviderClaim } from '../../src/lib/integrations/providerContract.js'
import { EVIDENCE_CLASS, OBSERVATION_ENVIRONMENT, recordEvidence } from '../../src/lib/integrations/providerEvidence.js'
import { STRIPE_PROVIDER, stripeAdmissionIdentity } from '../../src/lib/providerAdapters/payments/stripeAdapter.js'

export const CP3_NOW = '2026-09-04T18:00:00Z'

export function observeStripe(adapter, { connection, objectType, payload,
  observedAt = CP3_NOW, freshness = {}, expectedConnection = connection } = {}) {
  const input = adapter.createObservationInput({ connection, objectType, payload, observedAt })
  const observation = createProviderObservation({ ...input,
    environment: OBSERVATION_ENVIRONMENT.FIXTURE_REPLAY })
  const evidence = recordEvidence({ evidenceClass: EVIDENCE_CLASS.E0_HYPOTHESIS,
    environment: OBSERVATION_ENVIRONMENT.FIXTURE_REPLAY, provider: adapter.provider,
    propositionKey: 'fixture_interpretation_under_test', refs: [],
    note: 'Sanitized deterministic fixture replay; not a sandbox observation.' })
  const interpretation = interpretObservation({ observation, evidence,
    ...adapter.interpretFor(observation) })
  const freshnessResult = resolveFreshness({ observation, now: CP3_NOW,
    maxAgeMs: 86_400_000, sourceAvailable: true, ...freshness })
  const expected = expectedConnection?.provider === STRIPE_PROVIDER
    ? stripeAdmissionIdentity(expectedConnection) : expectedConnection
  return { observation, interpretation, freshness: freshnessResult,
    admitted: admitProviderClaim({ ...expected, observation, interpretation,
      evidence, freshness: freshnessResult }) }
}

export function stripeInvoice(id = 'in_1', overrides = {}) {
  return { id, object: 'invoice', livemode: false, customer: 'cus_1', number: 'INV-1',
    status: 'open', amount_due: 10_000, amount_paid: 0, amount_remaining: 10_000,
    amount_overpaid: 0, amount_paid_off_stripe: 0, total: 10_000, currency: 'usd',
    collection_method: 'send_invoice', created: 1788541200,
    payments: { object: 'list', data: [], has_more: false, total_count: 0,
      url: '/v1/invoice_payments' }, ...overrides }
}

export function paymentIntent(id = 'pi_1', overrides = {}) {
  return { id, object: 'payment_intent', livemode: false, status: 'requires_payment_method',
    amount: 10_000, amount_received: 0, amount_capturable: 0, currency: 'usd',
    customer: 'cus_1', created: 1788541200, ...overrides }
}

export function stripeEvent(type = 'invoice.updated', overrides = {}) {
  return { id: 'evt_1', object: 'event', type, account: 'acct_a', livemode: false,
    api_version: '2026-08-26.preview', created: 1788541200,
    data: { object: { id: 'obj_1' } }, ...overrides }
}
