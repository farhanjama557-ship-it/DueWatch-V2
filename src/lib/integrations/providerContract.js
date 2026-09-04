/**
 * M2H-CP1 — the provider-neutral claim contract.
 *
 * This assembles the pieces the other modules own — identity, observation,
 * interpretation, evidence, freshness — into the one shape every later
 * connector produces. CP2 (QuickBooks/Xero), CP3 (Stripe) and the rest should
 * be an adapter plus fixtures, not a seventh bespoke integration.
 *
 * It is a PURE, LOCAL contract. No persistence, no network, no provider SDK,
 * no schema. That is a deliberate CP1 choice: provider tables written before
 * their lifecycle is understood are the ones that get migrated three times.
 *
 * Two doors are locked here rather than described:
 *
 *   A provider claim cannot write canonical money. It is an input to the
 *   normalisation path that owns those facts, and this contract has no route
 *   to the ledger.
 *
 *   Tenant AND provider-account identity must match, or the claim is refused.
 *   One founder may connect two QuickBooks companies; an object from the wrong
 *   company is as dangerous as one from the wrong tenant, and neither is
 *   recoverable by being "mostly right".
 */

import { ownerMaySpeakTo, CLAIM_SOURCE_OWNER } from './providerTruthModel.js'
import { FRESHNESS_STATE, freshnessMayGovern } from './providerFreshness.js'

export const PROVIDER_CLAIM_ADMISSION = Object.freeze({
  ADMITTED: 'ADMITTED',
  REJECTED_TENANT: 'REJECTED_TENANT',
  REJECTED_PROVIDER_ACCOUNT: 'REJECTED_PROVIDER_ACCOUNT',
  REJECTED_OWNER_CANNOT_SPEAK: 'REJECTED_OWNER_CANNOT_SPEAK',
  REJECTED_MALFORMED: 'REJECTED_MALFORMED',
})

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) frozen(child)
  return Object.freeze(value)
}

/**
 * Admits one interpreted provider observation as a claim, or refuses and says
 * why. Refusal is a typed outcome rather than an exception: a foreign object
 * arriving is an expected event in a multi-connection world, not a crash.
 */
export function admitProviderClaim({
  tenantId = null, providerAccountId = null, observation = null,
  interpretation = null, evidence = null, freshness = null,
} = {}) {
  const reject = (admission, reason) => frozen({
    kind: 'M2H_PROVIDER_CLAIM_V0', admitted: false, admission, reason, claim: null,
  })

  if (!observation || !interpretation) {
    return reject(PROVIDER_CLAIM_ADMISSION.REJECTED_MALFORMED,
      'A claim requires both an observation and an interpretation of it.')
  }
  if (interpretation.observationId !== observation.id ||
      interpretation.observationHash !== observation.rawHash) {
    return reject(PROVIDER_CLAIM_ADMISSION.REJECTED_MALFORMED,
      'The interpretation does not belong to this observation.')
  }
  if (String(tenantId ?? '') !== String(observation.tenantId ?? '')) {
    return reject(PROVIDER_CLAIM_ADMISSION.REJECTED_TENANT,
      "Refusing an observation belonging to another tenant.")
  }
  if (String(providerAccountId ?? '') !== String(observation.providerAccountId ?? '')) {
    return reject(PROVIDER_CLAIM_ADMISSION.REJECTED_PROVIDER_ACCOUNT,
      'Refusing an observation from another provider account.')
  }
  // A money dimension may only be spoken to by an owner that owns it. A
  // customer email is evidence about the world; it is not the ledger.
  if (interpretation.truthDimension &&
      !ownerMaySpeakTo(interpretation.sourceOwner, interpretation.truthDimension)) {
    return reject(PROVIDER_CLAIM_ADMISSION.REJECTED_OWNER_CANNOT_SPEAK,
      `${interpretation.sourceOwner} does not own ${interpretation.truthDimension}.`)
  }

  return frozen({
    kind: 'M2H_PROVIDER_CLAIM_V0',
    admitted: true,
    admission: PROVIDER_CLAIM_ADMISSION.ADMITTED,
    reason: null,
    claim: {
      tenantId: observation.tenantId,
      provider: observation.provider,
      providerAccountId: observation.providerAccountId,
      observationId: observation.id,
      truthDimension: interpretation.truthDimension,
      sourceOwner: interpretation.sourceOwner,
      subject: interpretation.subject,
      value: interpretation.value,
      evidence,
      freshness: freshness ?? { state: FRESHNESS_STATE.UNKNOWN, mayGovern: false },
      // Both stated on every admitted claim, so no consumer has to infer them.
      writesCanonicalMoney: false,
      grantsAuthority: false,
    },
  })
}

/**
 * A provider claim NEVER writes canonical money. It is evidence handed to the
 * path that owns those facts, exactly as the Company Brain is.
 */
export function assertProviderCannotWriteCanonicalMoney(mutation = {}) {
  if (mutation?.writesCanonicalMoney === true || mutation?.canonicalFinancialTruth === true) {
    throw new Error('a provider claim cannot write canonical money truth')
  }
  return true
}

/**
 * Claims that may currently be relied upon, for one dimension.
 *
 * Everything non-FRESH is excluded and REPORTED, not silently dropped: the
 * caller needs to know the difference between "the ledger says nothing is
 * owed" and "we could not read the ledger".
 */
export function governingClaims(claims = [], truthDimension = null) {
  const relevant = claims.filter((claim) =>
    claim?.admitted && claim.claim.truthDimension === truthDimension)
  const governing = relevant.filter((claim) => freshnessMayGovern(claim.claim.freshness?.state))
  const withheld = relevant.filter((claim) => !freshnessMayGovern(claim.claim.freshness?.state))
  return frozen({
    truthDimension,
    governing: governing.map((claim) => claim.claim),
    withheld: withheld.map((claim) => ({
      subject: claim.claim.subject,
      freshness: claim.claim.freshness?.state ?? FRESHNESS_STATE.UNKNOWN,
    })),
    complete: withheld.length === 0,
  })
}

export { CLAIM_SOURCE_OWNER }
