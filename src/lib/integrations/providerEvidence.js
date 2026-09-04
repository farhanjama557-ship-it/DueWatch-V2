/**
 * M2H-CP1 — evidence classes E0-E8.
 *
 * These record HOW something came to be believed about a provider. They are
 * deliberately NOT a confidence score and NOT a ranking: "the OpenAPI schema
 * says this field exists" and "we saw this happen twice in a sandbox" are
 * different KINDS of proof, and which one a statement needs depends on the
 * statement. A field's existence is a schema question. A provider's behaviour
 * under a deleted payment is not — no schema will ever answer it.
 *
 * Two things follow, and both are enforced below rather than described:
 *
 *   - evidence classes cannot be compared, so no code can "upgrade" a claim by
 *     picking the bigger number;
 *   - evidence is never authority. Knowing exactly how Stripe behaves grants
 *     DueWatch nothing. G5 owns permission, and it does not read this file.
 */

export const EVIDENCE_CLASS = Object.freeze({
  E0_HYPOTHESIS: 'E0_HYPOTHESIS',
  E1_SCHEMA_CONFIRMED: 'E1_SCHEMA_CONFIRMED',
  E2_DOC_CONFIRMED: 'E2_DOC_CONFIRMED',
  E3_SCHEMA_PLUS_DOC: 'E3_SCHEMA_PLUS_DOC',
  E4_SANDBOX_OBSERVED: 'E4_SANDBOX_OBSERVED',
  E5_SANDBOX_REPRODUCED: 'E5_SANDBOX_REPRODUCED',
  E6_DOC_PLUS_SANDBOX: 'E6_DOC_PLUS_SANDBOX',
  E7_MULTI_PROVIDER_SUPPORTED: 'E7_MULTI_PROVIDER_SUPPORTED',
  E8_ACCOUNTING_DOMAIN_SUPPORTED: 'E8_ACCOUNTING_DOMAIN_SUPPORTED',
})

/** Stated as data so no reader mistakes the ordering of the names for a scale. */
export const EVIDENCE_CLASS_IS_RANKED = false

/**
 * Classes that assert someone actually watched a real provider do something.
 * A simulated or mock environment can never produce them, however faithful the
 * mock is: a fixture reproduces what we already believed, which is why it
 * cannot be the reason we believe it.
 */
const REQUIRES_LIVE_OBSERVATION = new Set([
  EVIDENCE_CLASS.E4_SANDBOX_OBSERVED,
  EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED,
  EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
])

/** Classes that assert an official provider document says so. */
const REQUIRES_OFFICIAL_SOURCE = new Set([
  EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED,
  EVIDENCE_CLASS.E2_DOC_CONFIRMED,
  EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC,
  EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX,
])

export const OBSERVATION_ENVIRONMENT = Object.freeze({
  MOCK: 'MOCK',
  FIXTURE_REPLAY: 'FIXTURE_REPLAY',
  PROVIDER_SANDBOX: 'PROVIDER_SANDBOX',
  PROVIDER_PRODUCTION: 'PROVIDER_PRODUCTION',
})

const LIVE_ENVIRONMENTS = new Set([
  OBSERVATION_ENVIRONMENT.PROVIDER_SANDBOX,
  OBSERVATION_ENVIRONMENT.PROVIDER_PRODUCTION,
])

/**
 * Records an evidence claim, refusing the ones the environment cannot support.
 *
 * @param {string} input.evidenceClass one of EVIDENCE_CLASS
 * @param {string} input.environment   where the observation happened
 * @param {Array}  input.refs          citations: doc URLs, fixture ids, capture ids
 */
export function recordEvidence({
  evidenceClass, environment = OBSERVATION_ENVIRONMENT.MOCK, refs = [], note = null,
} = {}) {
  if (!Object.values(EVIDENCE_CLASS).includes(evidenceClass)) {
    throw new Error(`unknown evidence class: ${evidenceClass}`)
  }
  if (!Object.values(OBSERVATION_ENVIRONMENT).includes(environment)) {
    throw new Error(`unknown observation environment: ${environment}`)
  }
  if (REQUIRES_LIVE_OBSERVATION.has(evidenceClass) && !LIVE_ENVIRONMENTS.has(environment)) {
    throw new Error(
      `${evidenceClass} claims a real provider observation, but the environment was ${environment}: ` +
      'a mock cannot be the evidence that a provider behaves a certain way')
  }
  if (REQUIRES_OFFICIAL_SOURCE.has(evidenceClass) && refs.length === 0) {
    throw new Error(`${evidenceClass} requires a citation to the official provider source`)
  }
  return Object.freeze({
    kind: 'M2H_EVIDENCE_V0',
    evidenceClass,
    environment,
    refs: Object.freeze([...refs]),
    note,
    // Said out loud on every record, because this is the confusion that would
    // let good research turn into unearned permission.
    grantsAuthority: false,
    isRanked: EVIDENCE_CLASS_IS_RANKED,
  })
}

/**
 * Evidence never authorises. There is no argument, no provider and no evidence
 * class for which this returns true; it exists so the question has one answer
 * in code rather than an assumption per caller.
 */
export function evidenceGrantsAuthority() {
  return false
}
