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

/**
 * PRIMITIVE classes: a caller may assert one directly, because each names a
 * single kind of proof they are in a position to supply — a schema reference,
 * a documentation reference, an observation they made.
 */
export const PRIMITIVE_EVIDENCE_CLASSES = Object.freeze([
  'E0_HYPOTHESIS', 'E1_SCHEMA_CONFIRMED', 'E2_DOC_CONFIRMED',
  'E4_SANDBOX_OBSERVED', 'E5_SANDBOX_REPRODUCED',
])

/**
 * COMPOSITE classes: their MEANING is "two kinds of proof agree", so they
 * cannot be chosen — they must be composed from components that exist.
 *
 * This was the defect: a caller could ask for E7 ("multiple materially
 * different providers support this") and simply receive it, without a second
 * provider ever being involved. The label was stronger than the evidence
 * required to obtain it, which is proof inflation and worse than no label.
 *
 * THE CALLER DOES NOT CHOOSE A COMPOSITE PROOF CLASS. THE STRUCTURE EARNS IT.
 */
export const COMPOSITE_EVIDENCE_CLASSES = Object.freeze([
  'E3_SCHEMA_PLUS_DOC', 'E6_DOC_PLUS_SANDBOX',
  'E7_MULTI_PROVIDER_SUPPORTED', 'E8_ACCOUNTING_DOMAIN_SUPPORTED',
])

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
  evidenceClass, environment = OBSERVATION_ENVIRONMENT.MOCK, refs = [],
  note = null, provider = null, domainSupport = null,
} = {}) {
  if (!Object.values(EVIDENCE_CLASS).includes(evidenceClass)) {
    throw new Error(`unknown evidence class: ${evidenceClass}`)
  }
  if (COMPOSITE_EVIDENCE_CLASSES.includes(evidenceClass)) {
    throw new Error(
      `${evidenceClass} is a composite class and must be composed from its component ` +
      'evidence, never selected as a label')
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
    // The provider this record is ABOUT. E7 counts distinct providers from
    // these, so a provider name typed into a list can never stand in for one.
    provider,
    domainSupport,
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

/**
 * Requirements for each composite class, expressed as what must be PRESENT.
 *
 * `requires` names the component classes that must appear; `distinctProviders`
 * demands that many materially different providers among the components.
 */
const COMPOSITION_RULES = Object.freeze({
  [EVIDENCE_CLASS.E3_SCHEMA_PLUS_DOC]: Object.freeze({
    requires: Object.freeze([EVIDENCE_CLASS.E1_SCHEMA_CONFIRMED, EVIDENCE_CLASS.E2_DOC_CONFIRMED]),
    distinctProviders: 0,
  }),
  [EVIDENCE_CLASS.E6_DOC_PLUS_SANDBOX]: Object.freeze({
    // Either strength of sandbox evidence satisfies the empirical half.
    requires: Object.freeze([EVIDENCE_CLASS.E2_DOC_CONFIRMED]),
    requiresOneOf: Object.freeze([EVIDENCE_CLASS.E4_SANDBOX_OBSERVED, EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED]),
    distinctProviders: 0,
  }),
  [EVIDENCE_CLASS.E7_MULTI_PROVIDER_SUPPORTED]: Object.freeze({
    requires: Object.freeze([]),
    // The whole meaning of E7. Two records about the SAME provider are one
    // provider, whatever class each of them carries.
    distinctProviders: 2,
  }),
  [EVIDENCE_CLASS.E8_ACCOUNTING_DOMAIN_SUPPORTED]: Object.freeze({
    requires: Object.freeze([]),
    distinctProviders: 0,
    // E8 is not "several APIs agree" — it is "the accounting domain says so",
    // which needs a domain artifact no provider record can substitute for.
    requiresDomainSupport: true,
  }),
})

/**
 * Composes a composite evidence class from components that actually exist.
 *
 * The resulting record RETAINS its components, so provenance stays inspectable
 * and a reviewer can ask "which two providers?" and get an answer rather than
 * a label.
 *
 * Note what is deliberately absent: no rank, no score, no "at least E6". The
 * classes remain kinds of proof, and composition adds structure, not altitude.
 */
export function composeEvidence({
  evidenceClass, components = [], note = null, domainSupport = null,
} = {}) {
  const rule = COMPOSITION_RULES[evidenceClass]
  if (!rule) {
    throw new Error(`${evidenceClass} is not a composite evidence class`)
  }
  const parts = components.filter((part) => part?.kind === 'M2H_EVIDENCE_V0')
  if (parts.length !== components.length) {
    throw new Error(`${evidenceClass} requires real component evidence records`)
  }

  if (rule.requiresDomainSupport) {
    const support = domainSupport ?? parts.find((part) => part.domainSupport)?.domainSupport ?? null
    if (!support) {
      throw new Error(
        `${evidenceClass} requires explicit accounting/domain support evidence, which no ` +
        'provider record can substitute for')
    }
  }

  const present = new Set(parts.map((part) => part.evidenceClass))
  for (const required of rule.requires) {
    if (!present.has(required)) {
      throw new Error(`${evidenceClass} requires ${required} among its components`)
    }
  }
  if (rule.requiresOneOf && !rule.requiresOneOf.some((cls) => present.has(cls))) {
    throw new Error(
      `${evidenceClass} requires one of ${rule.requiresOneOf.join(' or ')} among its components`)
  }

  const providers = [...new Set(parts.map((part) => part.provider).filter(Boolean))]
  if (rule.distinctProviders > 0) {
    if (parts.length === 0) {
      throw new Error(`${evidenceClass} requires component evidence records, not provider names`)
    }
    if (providers.length < rule.distinctProviders) {
      throw new Error(
        `${evidenceClass} requires ${rule.distinctProviders} distinct providers; ` +
        `the components cover ${providers.length}`)
    }
  }

  return Object.freeze({
    kind: 'M2H_EVIDENCE_V0',
    evidenceClass,
    composite: true,
    // Provenance, retained: which records earned this, and for whom.
    components: Object.freeze(parts.map((part) => Object.freeze({
      evidenceClass: part.evidenceClass,
      provider: part.provider,
      environment: part.environment,
      refs: part.refs,
    }))),
    providers: Object.freeze(providers.sort()),
    domainSupport: domainSupport ?? parts.find((part) => part.domainSupport)?.domainSupport ?? null,
    refs: Object.freeze(parts.flatMap((part) => [...part.refs])),
    note,
    grantsAuthority: false,
    isRanked: EVIDENCE_CLASS_IS_RANKED,
  })
}
