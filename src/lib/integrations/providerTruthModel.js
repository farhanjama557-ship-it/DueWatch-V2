/**
 * M2H-CP1 — provider truth model.
 *
 * The rule this module exists to make structural:
 *
 *   OWNERSHIP IS CLAIM-LEVEL AND TRUTH-DIMENSION-SPECIFIC.
 *
 * Not "QuickBooks wins", not "Stripe wins". A provider is a place an
 * observation came from; it is not a licence to speak for a dimension of
 * financial truth. QuickBooks' invoice balance speaks to the AR ledger; it
 * says nothing about whether a processor has settled funds. Stripe's
 * PaymentIntent speaks to an attempt, and separately to a receipt; it says
 * nothing about how that receipt was allocated in the books. An email saying
 * "we paid yesterday" is communication evidence and moves no ledger at all.
 *
 * Collapse those and DueWatch starts chasing paid invoices and dropping unpaid
 * ones — the two failures that cost a founder their customers.
 *
 * The six dimensions are NOT redeclared here. They are the Company Brain's
 * canonical money-truth classes, and the suite proves this list is the same
 * one BEHAVIOURALLY, by asserting the Company Brain still refuses to create a
 * claim in each of them.
 */

/** T1-T6. The strings are the Company Brain's MONEY_TRUTH_CLASSES, unchanged. */
export const PROVIDER_TRUTH_DIMENSION = Object.freeze({
  T1_INVOICE_AR_STATE: 'INVOICE_AR_STATE',
  T2_PAYMENT_ATTEMPT_STATE: 'PAYMENT_ATTEMPT_STATE',
  T3_PAYMENT_RECEIPT_STATE: 'PAYMENT_RECEIPT_STATE',
  T4_PAYMENT_CREDIT_ALLOCATION_STATE: 'PAYMENT_CREDIT_ALLOCATION_STATE',
  T5_PROCESSOR_FUNDS_SETTLEMENT_STATE: 'PROCESSOR_FUNDS_SETTLEMENT_STATE',
  T6_BANK_LEDGER_RECONCILIATION_STATE: 'BANK_LEDGER_RECONCILIATION_STATE',
})

export const TRUTH_DIMENSIONS = Object.freeze(Object.values(PROVIDER_TRUTH_DIMENSION))

/**
 * Who owns a CLAIM — not who transmitted it.
 *
 * A provider may act as different owners for different claims (Stripe is a
 * PAYMENT_PROCESSOR for a charge and a COMMUNICATION_SOURCE for a receipt
 * email), and two providers may be the same owner for different tenants. So
 * ownership is declared per claim and never inferred from the provider name.
 */
export const CLAIM_SOURCE_OWNER = Object.freeze({
  LEDGER_SOURCE: 'LEDGER_SOURCE',
  PAYMENT_PROCESSOR: 'PAYMENT_PROCESSOR',
  BANK_RECONCILIATION_SOURCE: 'BANK_RECONCILIATION_SOURCE',
  INVOICE_ORIGIN_SOURCE: 'INVOICE_ORIGIN_SOURCE',
  CONTRACT_SOURCE: 'CONTRACT_SOURCE',
  CRM_SOURCE: 'CRM_SOURCE',
  COMMUNICATION_SOURCE: 'COMMUNICATION_SOURCE',
  DUEWATCH_DERIVED: 'DUEWATCH_DERIVED',
})

/**
 * Which owners may speak to which dimension AT ALL.
 *
 * This is a necessary condition, never a sufficient one: being the right kind
 * of source does not make a stale or invalidated observation govern. It exists
 * so a communication source can never be read as a ledger, whatever it says.
 */
const OWNER_MAY_SPEAK_TO = Object.freeze({
  [CLAIM_SOURCE_OWNER.LEDGER_SOURCE]: Object.freeze([
    PROVIDER_TRUTH_DIMENSION.T1_INVOICE_AR_STATE,
    PROVIDER_TRUTH_DIMENSION.T4_PAYMENT_CREDIT_ALLOCATION_STATE,
  ]),
  [CLAIM_SOURCE_OWNER.PAYMENT_PROCESSOR]: Object.freeze([
    PROVIDER_TRUTH_DIMENSION.T2_PAYMENT_ATTEMPT_STATE,
    PROVIDER_TRUTH_DIMENSION.T3_PAYMENT_RECEIPT_STATE,
    PROVIDER_TRUTH_DIMENSION.T5_PROCESSOR_FUNDS_SETTLEMENT_STATE,
  ]),
  [CLAIM_SOURCE_OWNER.BANK_RECONCILIATION_SOURCE]: Object.freeze([
    PROVIDER_TRUTH_DIMENSION.T6_BANK_LEDGER_RECONCILIATION_STATE,
  ]),
  [CLAIM_SOURCE_OWNER.INVOICE_ORIGIN_SOURCE]: Object.freeze([
    PROVIDER_TRUTH_DIMENSION.T1_INVOICE_AR_STATE,
  ]),
  // Context sources speak to NO money dimension. They are evidence about the
  // world, and the ledger decides what is true of the money.
  [CLAIM_SOURCE_OWNER.CONTRACT_SOURCE]: Object.freeze([]),
  [CLAIM_SOURCE_OWNER.CRM_SOURCE]: Object.freeze([]),
  [CLAIM_SOURCE_OWNER.COMMUNICATION_SOURCE]: Object.freeze([]),
  // DueWatch's own derivations are interpretations, never a source of record.
  [CLAIM_SOURCE_OWNER.DUEWATCH_DERIVED]: Object.freeze([]),
})

export function ownerMaySpeakTo(sourceOwner, truthDimension) {
  return (OWNER_MAY_SPEAK_TO[sourceOwner] ?? []).includes(truthDimension)
}

/** How far a finding has been generalised. One observation never starts at the top. */
export const GENERALIZATION_LEVEL = Object.freeze({
  G0_PROVIDER_IMPLEMENTATION_DETAIL: 'G0_PROVIDER_IMPLEMENTATION_DETAIL',
  G1_PROVIDER_CAPABILITY: 'G1_PROVIDER_CAPABILITY',
  G2_MULTI_PROVIDER_PATTERN: 'G2_MULTI_PROVIDER_PATTERN',
  G3_CANDIDATE_CANONICAL_CONCEPT: 'G3_CANDIDATE_CANONICAL_CONCEPT',
  G4_CANDIDATE_CANONICAL_INVARIANT: 'G4_CANDIDATE_CANONICAL_INVARIANT',
  G5_LOCKED_CANONICAL_RULE: 'G5_LOCKED_CANONICAL_RULE',
})

const GENERALIZATION_ORDER = Object.freeze(Object.values(GENERALIZATION_LEVEL))

/** Status of an architecture decision derived from provider research. */
export const DECISION_STATUS = Object.freeze({
  SUPPORTED: 'SUPPORTED',
  QUALIFIED: 'QUALIFIED',
  FALSIFIED: 'FALSIFIED',
  PROVIDER_SPECIFIC: 'PROVIDER_SPECIFIC',
  STILL_UNKNOWN: 'STILL_UNKNOWN',
  BLOCKED: 'BLOCKED',
  DEFER_TO_M2H: 'DEFER_TO_M2H',
  LOCK_CANDIDATE: 'LOCK_CANDIDATE',
  LOCKED: 'LOCKED',
})

export const CONTRADICTION_MARKER = Object.freeze({
  NO_CONTRADICTION: 'NO_CONTRADICTION',
  DOC_VS_DOC_CONTRADICTION: 'DOC_VS_DOC_CONTRADICTION',
  SCHEMA_VS_DOC_CONTRADICTION: 'SCHEMA_VS_DOC_CONTRADICTION',
  DOC_VS_SANDBOX_CONTRADICTION: 'DOC_VS_SANDBOX_CONTRADICTION',
  PROVIDER_VS_PROVIDER_DIFFERENCE: 'PROVIDER_VS_PROVIDER_DIFFERENCE',
  SOURCE_STATE_DISAGREEMENT: 'SOURCE_STATE_DISAGREEMENT',
  UNRESOLVED: 'UNRESOLVED',
})

/**
 * Promotes a finding by exactly one level, and refuses to skip.
 *
 * One provider behaving a certain way is a fact about that provider. It
 * becomes a DueWatch rule only by being seen elsewhere, reasoned about, and
 * finally locked — never by an adapter author deciding it is obvious.
 */
export function promoteGeneralization(from, to) {
  const start = GENERALIZATION_ORDER.indexOf(from)
  const end = GENERALIZATION_ORDER.indexOf(to)
  if (start < 0 || end < 0) throw new Error('unknown generalization level')
  if (end <= start) throw new Error('generalization must move forward')
  if (end - start > 1) {
    throw new Error(
      `refusing to promote ${from} straight to ${to}: a finding rises one level at a time`)
  }
  return to
}

/**
 * Whether two observations actually disagree.
 *
 * The costly mistake here is treating "Stripe says succeeded" and "QuickBooks
 * says balance $1,000" as a contradiction. They are not: one is a payment
 * receipt, the other an AR balance, and both can be true at once — the money
 * arrived and the books have not allocated it yet. Calling that a conflict
 * teaches a founder to ignore conflicts.
 *
 * A real disagreement needs the SAME dimension, the SAME subject, and
 * different values.
 */
export function classifyDisagreement(a = {}, b = {}) {
  if (a.truthDimension !== b.truthDimension) {
    return Object.freeze({
      marker: CONTRADICTION_MARKER.NO_CONTRADICTION,
      reason: 'The observations speak to different truth dimensions.',
      dimensions: Object.freeze([a.truthDimension ?? null, b.truthDimension ?? null]),
    })
  }
  if (String(a.subject ?? '') !== String(b.subject ?? '')) {
    return Object.freeze({
      marker: CONTRADICTION_MARKER.NO_CONTRADICTION,
      reason: 'The observations describe different subjects.',
      dimensions: Object.freeze([a.truthDimension ?? null]),
    })
  }
  if (JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null)) {
    return Object.freeze({
      marker: CONTRADICTION_MARKER.NO_CONTRADICTION,
      reason: 'The observations agree.',
      dimensions: Object.freeze([a.truthDimension]),
    })
  }
  const marker = a.sourceOwner === b.sourceOwner
    ? CONTRADICTION_MARKER.SOURCE_STATE_DISAGREEMENT
    : CONTRADICTION_MARKER.PROVIDER_VS_PROVIDER_DIFFERENCE
  return Object.freeze({
    marker,
    reason: 'Same dimension, same subject, different values.',
    dimensions: Object.freeze([a.truthDimension]),
    // Reported, never resolved here. Picking a winner is a founder decision or
    // a policy decision, and this module owns neither.
    resolved: false,
  })
}
