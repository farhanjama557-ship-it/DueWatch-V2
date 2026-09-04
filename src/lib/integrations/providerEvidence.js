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
 *
 * PROPOSITION IDENTITY
 *
 * Every record states WHAT IT PROVES, as an explicit `propositionKey`. Without
 * it, composition was checking class, environment and provider count while
 * ignoring subject matter — so a schema fact about invoice balances and a doc
 * fact about webhook retries composed into E3, and two providers supporting
 * two unrelated things composed into E7.
 *
 * The key is assigned by the researcher, deterministic, provider-neutral and
 * compared by EXACT equality. Never similarity, never embeddings, never a model
 * deciding two claims are close enough. "proposition" is the repository's
 * existing word for a typed claim evaluated in isolation (G7 authority
 * propositions); this is the same idea for provider research, and the two
 * vocabularies never mix.
 *
 *   propositionKey  WHAT is being proved   (provider-neutral)
 *   provider        WHERE it was observed
 *   captureId       WHICH observation saw it
 *
 * WHAT THIS CONTRACT CANNOT DO
 *
 * A pure JavaScript object cannot authenticate its external origin. This
 * contract proves shape, identity consistency, proposition consistency and
 * composition requirements. It does NOT prove a record truly came from Intuit
 * or anyone else — the same honest limit G8 carries for receipts. Establishing
 * external provenance belongs to CP2+ provider experiments and the CP6 runtime
 * lifecycle, and no signature or hash is invented here to fake it.
 */

/**
 * PRIMITIVE classes: a caller may assert one directly, because each names a
 * single kind of proof they are in a position to supply — a schema reference,
 * a documentation reference, an observation they made.
 */
export const PRIMITIVE_EVIDENCE_CLASSES = Object.freeze([
  'E0_HYPOTHESIS', 'E1_SCHEMA_CONFIRMED', 'E2_DOC_CONFIRMED', 'E4_SANDBOX_OBSERVED',
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
  'E3_SCHEMA_PLUS_DOC', 'E5_SANDBOX_REPRODUCED', 'E6_DOC_PLUS_SANDBOX',
  'E7_MULTI_PROVIDER_SUPPORTED', 'E8_ACCOUNTING_DOMAIN_SUPPORTED',
])

import { canonicalHash } from './canonicalValue.js'

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
/** A provider-neutral, deterministic key: what is being proved. */
const PROPOSITION_KEY = /^[a-z][a-z0-9_]*$/

function requirePropositionKey(propositionKey, provider) {
  if (typeof propositionKey !== 'string' || !PROPOSITION_KEY.test(propositionKey)) {
    throw new Error(
      'evidence requires a proposition key: a lower_snake_case identifier naming ' +
      'exactly what is being proved')
  }
  // A key naming its own provider is a provider fact wearing a universal
  // label, which is precisely what E7 must not be able to assemble.
  //
  // Compared by TOKEN, not by substring: a substring test flags a provider
  // called "p" inside the word "proposition", which is a false positive that
  // would push authors toward vaguer keys — the opposite of what this wants.
  const keyTokens = new Set(propositionKey.split('_'))
  const providerTokens = String(provider ?? '').toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)
  const named = providerTokens.find((token) => keyTokens.has(token))
  if (named) {
    throw new Error(
      `proposition key "${propositionKey}" is not provider-neutral: it names "${named}" ` +
      `from provider ${provider}. The key says WHAT is proved; the provider field says ` +
      'WHERE it was seen.')
  }
  return propositionKey
}

export function recordEvidence({
  evidenceClass, environment = OBSERVATION_ENVIRONMENT.MOCK, refs = [],
  note = null, provider = null, propositionKey = null, captureId = null,
  domainSupport = null,
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
  requirePropositionKey(propositionKey, provider)
  // A sandbox observation needs a capture identity, or two observations can
  // never be shown to be independent and E5 becomes unprovable in principle.
  if (evidenceClass === EVIDENCE_CLASS.E4_SANDBOX_OBSERVED &&
      (typeof captureId !== 'string' || !captureId.trim())) {
    throw new Error(
      `${evidenceClass} requires a captureId identifying the observation, so an ` +
      'independent reproduction can be told apart from the same observation twice')
  }
  return Object.freeze({
    kind: 'M2H_EVIDENCE_V0',
    evidenceClass,
    environment,
    // The provider this record is ABOUT. E7 counts distinct providers from
    // these, so a provider name typed into a list can never stand in for one.
    provider,
    propositionKey,
    captureId,
    domainSupport,
    // Deterministic provenance identity — not authentication. Identical
    // evidence yields an identical id, so a copy cannot pose as independent.
    evidenceId: canonicalHash({
      evidenceClass, provider, propositionKey, captureId, environment, refs: [...refs],
    }),
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
  [EVIDENCE_CLASS.E5_SANDBOX_REPRODUCED]: Object.freeze({
    // Two sandbox observations of the same proposition, by the same provider,
    // from genuinely different captures. Reproduction is provider-specific:
    // another provider behaving similarly is E7, not a reproduction.
    requires: Object.freeze([EVIDENCE_CLASS.E4_SANDBOX_OBSERVED]),
    distinctProviders: 0,
    requiresIndependentCaptures: 2,
    requiresSingleProvider: true,
  }),
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
  // Every composite requires ONE shared proposition; see agreeOnProposition.
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

  // ONE proposition, by exact identity. This is the check whose absence let a
  // schema fact about invoice balances and a doc fact about webhook retries
  // compose into E3. No similarity, no fuzzy matching, no model judgement.
  const propositions = [...new Set(parts.map((part) => part.propositionKey).filter(Boolean))]
  if (parts.length > 0 && propositions.length !== 1) {
    throw new Error(
      `${evidenceClass} requires every component to support the same proposition; ` +
      `the components cover ${propositions.length === 0 ? 'none' : propositions.join(', ')}`)
  }
  const propositionKey = propositions[0] ?? null

  if (rule.requiresDomainSupport) {
    const support = domainSupport ?? parts.find((part) => part.domainSupport)?.domainSupport ?? null
    // A typed artifact, constructed through its own validating constructor.
    // 'trust me', 'GAAP', true and an object literal are all refused: the
    // previous version accepted any truthy value, so E8 was mintable at will.
    if (!support || support.kind !== DOMAIN_SUPPORT_KIND) {
      throw new Error(
        `${evidenceClass} requires a typed domain support artifact created by ` +
        'createDomainSupportArtifact; an arbitrary value cannot stand for accounting support')
    }
    if (propositionKey && support.propositionKey !== propositionKey) {
      throw new Error(
        `${evidenceClass} requires the domain artifact to support the same proposition: ` +
        `artifact proves ${support.propositionKey}, components prove ${propositionKey}`)
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

  if (rule.requiresSingleProvider && providers.length > 1) {
    throw new Error(
      `${evidenceClass} requires the same provider: reproducing a behaviour means seeing ` +
      `it again in the same system, not seeing something similar in another one`)
  }
  if (rule.requiresIndependentCaptures) {
    // Independence is proven by DISTINCT CAPTURE identity. The same object
    // twice, or a copy of it, or two records dressed up from one capture, are
    // all one observation.
    //
    // Note what is deliberately NOT also checked here: distinct evidenceId.
    // The id is derived from the capture among other fields, so distinct
    // captures always imply distinct ids — a second condition no test could
    // ever distinguish from the first. Keeping it would be decoration
    // pretending to be a control. evidenceId remains the exposed provenance
    // identity, and its determinism is asserted on its own.
    const captures = [...new Set(parts.map((part) => part.captureId).filter(Boolean))]
    if (captures.length < rule.requiresIndependentCaptures) {
      throw new Error(
        `${evidenceClass} requires ${rule.requiresIndependentCaptures} independent observations ` +
        `with distinct capture identity; the components cover ${captures.length}`)
    }
  }

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
    propositionKey,
    captureIds: Object.freeze([...new Set(parts.map((part) => part.captureId).filter(Boolean))].sort()),
    domainSupport: domainSupport ?? parts.find((part) => part.domainSupport)?.domainSupport ?? null,
    refs: Object.freeze(parts.flatMap((part) => [...part.refs])),
    evidenceId: canonicalHash({
      evidenceClass, propositionKey, providers,
      components: parts.map((part) => part.evidenceId).sort(),
    }),
    note,
    grantsAuthority: false,
    isRanked: EVIDENCE_CLASS_IS_RANKED,
  })
}

export const DOMAIN_SUPPORT_KIND = 'M2H_DOMAIN_SUPPORT_ARTIFACT_V0'

/**
 * A typed accounting/domain-support artifact.
 *
 * E8 says "this is grounded in accounting principle", which is a claim about a
 * body of knowledge, not about an API. It therefore needs a real citation to
 * that body of knowledge, and cannot be satisfied by any number of provider
 * records — nor, as the previous version allowed, by the string 'GAAP'.
 *
 * Every field is required: an artifact that cannot say which principle, from
 * where, proving what, is not support.
 *
 * CP1 ships NO instance of this. The contract exists; the artifact does not,
 * because no accounting-domain research has been done — so E8 is genuinely
 * unissuable here, which is the honest state.
 */
export function createDomainSupportArtifact(input = {}) {
  const need = (key) => {
    const value = input[key]
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`domain support artifact requires ${key}`)
    }
    return value.trim()
  }
  const propositionKey = need('propositionKey')
  if (!PROPOSITION_KEY.test(propositionKey)) {
    throw new Error('domain support artifact requires a valid proposition key')
  }
  return Object.freeze({
    kind: DOMAIN_SUPPORT_KIND,
    artifactId: need('artifactId'),
    propositionKey,
    domainCategory: need('domainCategory'),
    citation: need('citation'),
    recordedAt: need('recordedAt'),
    // Same honesty as everywhere else in this module.
    grantsAuthority: false,
  })
}
