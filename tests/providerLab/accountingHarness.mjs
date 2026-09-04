import { createProviderObservation, interpretObservation } from '../../src/lib/integrations/providerObservation.js'
import { resolveFreshness } from '../../src/lib/integrations/providerFreshness.js'
import { admitProviderClaim } from '../../src/lib/integrations/providerContract.js'
import { EVIDENCE_CLASS, OBSERVATION_ENVIRONMENT, recordEvidence } from '../../src/lib/integrations/providerEvidence.js'

export const CP2_NOW = '2026-09-04T12:00:00Z'

export function observeAccounting(adapter, { connection, objectType, payload,
  observedAt = CP2_NOW, freshness = {}, expectedConnection = connection } = {}) {
  const input = adapter.createObservationInput({ connection, objectType, payload, observedAt })
  const observation = createProviderObservation({ ...input,
    environment: OBSERVATION_ENVIRONMENT.FIXTURE_REPLAY })
  const evidence = recordEvidence({ evidenceClass: EVIDENCE_CLASS.E0_HYPOTHESIS,
    environment: OBSERVATION_ENVIRONMENT.FIXTURE_REPLAY,
    provider: adapter.provider, propositionKey: 'fixture_interpretation_under_test',
    refs: [], note: 'Sanitized deterministic fixture replay; not a sandbox observation.' })
  const interpretation = interpretObservation({ observation, evidence,
    ...adapter.interpretFor(observation) })
  const freshnessResult = resolveFreshness({ observation, now: CP2_NOW,
    maxAgeMs: 86_400_000, sourceAvailable: true, ...freshness })
  return { observation, interpretation, freshness: freshnessResult,
    admitted: admitProviderClaim({ ...expectedConnection, observation, interpretation,
      evidence, freshness: freshnessResult }) }
}

export function qboInvoice(id = 'q-inv-1', overrides = {}) {
  return { Id: id, SyncToken: '2', DocNumber: '1001', TxnDate: '2026-09-01',
    DueDate: '2026-09-30', CustomerRef: { value: 'q-customer-1' }, TotalAmt: 1000,
    Balance: 1000, CurrencyRef: { value: 'USD' }, TxnStatus: 'Open',
    MetaData: { LastUpdatedTime: '2026-09-04T11:00:00Z' }, ...overrides }
}

export function xeroInvoice(id = 'x-inv-1', overrides = {}) {
  return { InvoiceID: id, InvoiceNumber: 'INV-1001', Type: 'ACCREC', Status: 'AUTHORISED',
    Contact: { ContactID: 'x-contact-1' }, Total: 1000, AmountDue: 1000, AmountPaid: 0,
    AmountCredited: 0, CurrencyCode: 'USD', DateString: '2026-09-01',
    DueDateString: '2026-09-30', UpdatedDateUTCString: '2026-09-04T11:00:00Z',
    Payments: [], CreditNotes: [], Prepayments: [], Overpayments: [], ...overrides }
}
