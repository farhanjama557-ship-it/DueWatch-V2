/**
 * M2H-CP1 — collection eligibility, derived.
 *
 * The rule this file exists to prevent is the one every naive collections tool
 * implements:
 *
 *     balance > 0  ->  chase
 *
 * A balance is one dimension of one source at one moment. Chasing on it alone
 * means chasing customers whose payment is in flight, whose credit covers the
 * invoice, whose dispute is open, or whose ledger we simply could not read
 * this morning. Each of those is a real customer receiving a wrong demand.
 *
 * So eligibility is DERIVED, from truth AND context AND policy AND freshness
 * AND conflict state AND — separately and last — G5 authority. This module
 * computes the first five. It does not evaluate authority: it reports what it
 * needs, and G5 answers at the point of use.
 */

import { freshnessMayGovern } from './providerFreshness.js'

export const COLLECTION_ELIGIBILITY = Object.freeze({
  ELIGIBLE: 'ELIGIBLE',
  LIMITED: 'LIMITED',
  HOLD: 'HOLD',
  BLOCKED: 'BLOCKED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  UNKNOWN: 'UNKNOWN',
})

export const ELIGIBILITY_REASON = Object.freeze({
  PAYMENT_IN_FLIGHT: 'PAYMENT_IN_FLIGHT',
  AVAILABLE_CREDIT_PRESENT: 'AVAILABLE_CREDIT_PRESENT',
  UNAPPLIED_VALUE_MATERIAL: 'UNAPPLIED_VALUE_MATERIAL',
  SOURCE_CONFLICT: 'SOURCE_CONFLICT',
  DISPUTE_ACTIVE: 'DISPUTE_ACTIVE',
  LEDGER_STALE: 'LEDGER_STALE',
  LEDGER_UNAVAILABLE: 'LEDGER_UNAVAILABLE',
  ATTRIBUTION_UNKNOWN: 'ATTRIBUTION_UNKNOWN',
  NOTHING_OUTSTANDING: 'NOTHING_OUTSTANDING',
})

/** Reasons that stop collection outright, and the outcome each produces. */
const STOPPING_REASONS = Object.freeze([
  [ELIGIBILITY_REASON.DISPUTE_ACTIVE, COLLECTION_ELIGIBILITY.BLOCKED],
  [ELIGIBILITY_REASON.LEDGER_UNAVAILABLE, COLLECTION_ELIGIBILITY.UNKNOWN],
  [ELIGIBILITY_REASON.LEDGER_STALE, COLLECTION_ELIGIBILITY.HOLD],
  [ELIGIBILITY_REASON.SOURCE_CONFLICT, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED],
  [ELIGIBILITY_REASON.PAYMENT_IN_FLIGHT, COLLECTION_ELIGIBILITY.HOLD],
  [ELIGIBILITY_REASON.AVAILABLE_CREDIT_PRESENT, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED],
  [ELIGIBILITY_REASON.UNAPPLIED_VALUE_MATERIAL, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED],
  [ELIGIBILITY_REASON.ATTRIBUTION_UNKNOWN, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED],
])

/**
 * @param {object} input.ledger        the governing AR claim, if there is one
 * @param {object} input.ledgerFreshness freshness of that claim
 * @param {boolean} input.paymentInFlight a payment ATTEMPT with no proven receipt
 * @param {boolean} input.disputeActive
 * @param {number} input.availableCredit
 * @param {number} input.unappliedValue
 * @param {boolean} input.sourceConflict a real same-dimension disagreement
 * @param {boolean} input.attributionKnown whether the money is attributable
 */
export function deriveCollectionEligibility({
  ledger = null, ledgerFreshness = null, paymentInFlight = false, disputeActive = false,
  availableCredit = 0, unappliedValue = 0, sourceConflict = false,
  attributionKnown = true, sourceAvailable = true,
} = {}) {
  const reasons = []

  if (sourceAvailable === false) reasons.push(ELIGIBILITY_REASON.LEDGER_UNAVAILABLE)
  else if (!ledger) reasons.push(ELIGIBILITY_REASON.LEDGER_UNAVAILABLE)
  else if (!freshnessMayGovern(ledgerFreshness?.state)) reasons.push(ELIGIBILITY_REASON.LEDGER_STALE)

  if (disputeActive) reasons.push(ELIGIBILITY_REASON.DISPUTE_ACTIVE)
  if (sourceConflict) reasons.push(ELIGIBILITY_REASON.SOURCE_CONFLICT)
  if (paymentInFlight) reasons.push(ELIGIBILITY_REASON.PAYMENT_IN_FLIGHT)
  if (Number(availableCredit) > 0) reasons.push(ELIGIBILITY_REASON.AVAILABLE_CREDIT_PRESENT)
  if (Number(unappliedValue) > 0) reasons.push(ELIGIBILITY_REASON.UNAPPLIED_VALUE_MATERIAL)
  if (attributionKnown === false) reasons.push(ELIGIBILITY_REASON.ATTRIBUTION_UNKNOWN)

  let outcome = COLLECTION_ELIGIBILITY.ELIGIBLE
  for (const [reason, produced] of STOPPING_REASONS) {
    if (reasons.includes(reason)) { outcome = produced; break }
  }
  if (reasons.length === 0 && Number(ledger?.value?.balance ?? 0) <= 0) {
    outcome = COLLECTION_ELIGIBILITY.BLOCKED
    reasons.push(ELIGIBILITY_REASON.NOTHING_OUTSTANDING)
  }

  return Object.freeze({
    kind: 'M2H_COLLECTION_ELIGIBILITY_V0',
    outcome,
    reasons: Object.freeze([...reasons]),
    // Eligibility is a statement about the FACTS. Whether DueWatch may then
    // act is a separate question with a separate owner, still unanswered here.
    authorityEvaluated: false,
    authorityOwner: 'G5',
    requiresFreshAuthorityAtUse: true,
    derivedFromBalanceAlone: false,
  })
}
