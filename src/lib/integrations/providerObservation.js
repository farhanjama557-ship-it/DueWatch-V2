/**
 * M2H-CP1 — raw observation, and the interpretation kept separate from it.
 *
 * The distinction is structural because our understanding of a provider WILL
 * be wrong at least once. When it is, the fix must not require re-fetching
 * history we can no longer obtain.
 *
 *   OBSERVATION    the provider's returned payload as an immutable structured
 *                  JSON snapshot. Never edited, never "corrected", never
 *                  normalised in place.
 *   INTERPRETATION what DueWatch currently believes it means. Replaceable.
 *
 * PRECISELY WHAT IS STORED, since an earlier comment here overstated it: this
 * is a structured JSON snapshot of the parsed payload, NOT the exact original
 * HTTP wire bytes and NOT a verbatim request body. Key order and byte-level
 * formatting are not preserved, and the hash is over the canonical structural
 * form. That is sufficient for interpretation and provenance, and insufficient
 * for webhook signature verification, which needs the exact bytes as received.
 *
 * FUTURE REQUIREMENT, recorded rather than silently assumed: exact request-body
 * capture for signature verification belongs to the runtime/lifecycle
 * checkpoint (CP6). It is deliberately NOT added here.
 *
 * The worked example that motivates it: a QuickBooks Payment with TotalAmt 0
 * linked to a CreditMemo and an Invoice. Interpreted as "cash received" it
 * marks an invoice paid that nobody paid. Interpreted as "provider-generated
 * credit allocation" it is correct. Same bytes, different meaning — and when
 * we learn the difference, the bytes must still be there.
 */

import { canonicalHash as contentHash } from './canonicalValue.js'

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`)
  return value.trim()
}

/**
 * One thing a provider said, at one moment.
 *
 * providerAccountId is required and separate from tenantId on purpose: one
 * DueWatch tenant may connect several QuickBooks companies, and an object from
 * the wrong company is exactly as dangerous as one from the wrong tenant.
 */
export function createProviderObservation(input = {}) {
  const payload = input.rawPayload
  if (payload === undefined) throw new Error('observation rawPayload required')
  return deepFreeze({
    kind: 'M2H_PROVIDER_OBSERVATION_V0',
    tenantId: required(input.tenantId, 'observation tenantId'),
    provider: required(input.provider, 'observation provider'),
    providerAccountId: required(input.providerAccountId, 'observation providerAccountId'),
    objectType: required(input.objectType, 'observation objectType'),
    externalObjectId: required(input.externalObjectId, 'observation externalObjectId'),
    // Delivery identity, distinct from the object's identity: the same
    // semantic event can be delivered many times with different delivery ids.
    eventId: input.eventId ?? null,
    deliveryId: input.deliveryId ?? null,
    providerTimestamp: input.providerTimestamp ?? null,
    observedAt: required(input.observedAt, 'observation observedAt'),
    apiVersion: input.apiVersion ?? null,
    environment: input.environment ?? null,
    // The structured payload snapshot, plus a canonical hash so a later
    // reinterpretation can prove it is reading the same observation.
    rawPayload: JSON.parse(JSON.stringify(payload)),
    rawHash: contentHash(payload),
    id: `obs:${required(input.provider, 'p')}:${required(input.externalObjectId, 'o')}:${contentHash({
      p: input.provider, a: input.providerAccountId, o: input.externalObjectId,
      e: input.eventId ?? null, d: input.deliveryId ?? null, t: input.observedAt,
    })}`,
  })
}

/**
 * What DueWatch currently believes an observation means.
 *
 * It REFERENCES the observation rather than containing it, so replacing an
 * interpretation cannot rewrite history, and carries the raw hash so a stale
 * interpretation of an edited observation is detectable rather than silent.
 */
export function interpretObservation({
  observation, truthDimension = null, sourceOwner = null, subject = null,
  value = null, evidence = null, uncertainty = [], interpretedAt = null,
  interpretationVersion = 'v1',
} = {}) {
  if (observation?.kind !== 'M2H_PROVIDER_OBSERVATION_V0') {
    throw new Error('interpretation requires a provider observation')
  }
  return deepFreeze({
    kind: 'M2H_PROVIDER_INTERPRETATION_V0',
    observationId: observation.id,
    observationHash: observation.rawHash,
    tenantId: observation.tenantId,
    provider: observation.provider,
    providerAccountId: observation.providerAccountId,
    truthDimension,
    sourceOwner,
    subject,
    value,
    evidence,
    uncertainty: [...uncertainty],
    interpretedAt: interpretedAt ?? observation.observedAt,
    interpretationVersion,
    // An interpretation is a reading, never a permission and never a ledger
    // write. Both are stated so a consumer cannot infer otherwise.
    grantsAuthority: false,
    writesCanonicalMoney: false,
  })
}

/**
 * Replaces a reading without touching what was seen.
 *
 * This is the operation the observation/interpretation split exists for: we
 * learn a provider quirk, we reinterpret, and every historical observation is
 * still exactly what the provider sent.
 */
export function reinterpret(previous, changes = {}) {
  if (previous?.kind !== 'M2H_PROVIDER_INTERPRETATION_V0') {
    throw new Error('reinterpret requires a previous interpretation')
  }
  return deepFreeze({
    ...previous,
    ...changes,
    // Identity of the underlying observation is not a field an author may edit.
    observationId: previous.observationId,
    observationHash: previous.observationHash,
    tenantId: previous.tenantId,
    provider: previous.provider,
    providerAccountId: previous.providerAccountId,
    supersedesVersion: previous.interpretationVersion,
    interpretationVersion: changes.interpretationVersion ??
      `v${Number(String(previous.interpretationVersion).replace(/^v/, '')) + 1}`,
    grantsAuthority: false,
    writesCanonicalMoney: false,
  })
}
