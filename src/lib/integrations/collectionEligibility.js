/**
 * M2H-CP1 — trusted collection eligibility decision.
 *
 * ELIGIBLE is intentionally difficult to produce. Canonical AR truth enters
 * only as a registered governingClaims result for T1. Context enters through
 * one constructor that preserves true / false / unknown instead of replacing
 * missing facts with favourable defaults. Operating policy is an explicit,
 * provider-neutral input; G5 authority remains a separate decision at use.
 */

import { FRESHNESS_STATE } from './providerFreshness.js'
import { isGoverningClaimSelection } from './providerContract.js'
import { PROVIDER_TRUTH_DIMENSION } from './providerTruthModel.js'

export const COLLECTION_ELIGIBILITY = Object.freeze({
  ELIGIBLE: 'ELIGIBLE',
  LIMITED: 'LIMITED',
  HOLD: 'HOLD',
  BLOCKED: 'BLOCKED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  UNKNOWN: 'UNKNOWN',
})

export const COLLECTION_POLICY_DECISION = Object.freeze({
  ALLOWED: 'ALLOWED',
  BLOCKED: 'BLOCKED',
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
  TRUSTED_LEDGER_REQUIRED: 'TRUSTED_LEDGER_REQUIRED',
  ATTRIBUTION_UNKNOWN: 'ATTRIBUTION_UNKNOWN',
  CONTEXT_INCOMPLETE: 'CONTEXT_INCOMPLETE',
  POLICY_UNKNOWN: 'POLICY_UNKNOWN',
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  NOTHING_OUTSTANDING: 'NOTHING_OUTSTANDING',
})

const CONSTRUCTED_COLLECTION_CONTEXTS = new WeakSet()

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freeze(child)
  return Object.freeze(value)
}

function triState(value, name) {
  if (value == null) return null
  if (typeof value !== 'boolean') throw new Error(`${name} must be true, false or null`)
  return value
}

function knownAmount(value, name) {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number or null`)
  }
  return value
}

/**
 * Constructs the contextual fact envelope. Null means explicitly unknown; it
 * never becomes false, zero or true by default.
 */
export function createCollectionDecisionContext(input = {}) {
  const policyDecision = input.policyDecision ?? COLLECTION_POLICY_DECISION.UNKNOWN
  if (!Object.values(COLLECTION_POLICY_DECISION).includes(policyDecision)) {
    throw new Error('policyDecision must be ALLOWED, BLOCKED or UNKNOWN')
  }
  const context = freeze({
    kind: 'M2H_COLLECTION_DECISION_CONTEXT_V0',
    disputeActive: triState(input.disputeActive, 'disputeActive'),
    paymentInFlight: triState(input.paymentInFlight, 'paymentInFlight'),
    availableCredit: knownAmount(input.availableCredit, 'availableCredit'),
    unappliedValue: knownAmount(input.unappliedValue, 'unappliedValue'),
    sourceConflict: triState(input.sourceConflict, 'sourceConflict'),
    attributionKnown: triState(input.attributionKnown, 'attributionKnown'),
    policyDecision,
  })
  CONSTRUCTED_COLLECTION_CONTEXTS.add(context)
  return context
}

export function isCollectionDecisionContext(candidate) {
  return CONSTRUCTED_COLLECTION_CONTEXTS.has(candidate)
}

const STOPPING_REASONS = Object.freeze([
  [ELIGIBILITY_REASON.DISPUTE_ACTIVE, COLLECTION_ELIGIBILITY.BLOCKED],
  [ELIGIBILITY_REASON.POLICY_BLOCKED, COLLECTION_ELIGIBILITY.BLOCKED],
  [ELIGIBILITY_REASON.LEDGER_UNAVAILABLE, COLLECTION_ELIGIBILITY.UNKNOWN],
  [ELIGIBILITY_REASON.TRUSTED_LEDGER_REQUIRED, COLLECTION_ELIGIBILITY.UNKNOWN],
  [ELIGIBILITY_REASON.CONTEXT_INCOMPLETE, COLLECTION_ELIGIBILITY.UNKNOWN],
  [ELIGIBILITY_REASON.POLICY_UNKNOWN, COLLECTION_ELIGIBILITY.UNKNOWN],
  [ELIGIBILITY_REASON.LEDGER_STALE, COLLECTION_ELIGIBILITY.HOLD],
  [ELIGIBILITY_REASON.SOURCE_CONFLICT, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED],
  [ELIGIBILITY_REASON.PAYMENT_IN_FLIGHT, COLLECTION_ELIGIBILITY.HOLD],
  [ELIGIBILITY_REASON.AVAILABLE_CREDIT_PRESENT, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED],
  [ELIGIBILITY_REASON.UNAPPLIED_VALUE_MATERIAL, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED],
  [ELIGIBILITY_REASON.ATTRIBUTION_UNKNOWN, COLLECTION_ELIGIBILITY.REVIEW_REQUIRED],
])

const REQUIRED_CONTEXT = Object.freeze([
  'disputeActive', 'paymentInFlight', 'availableCredit', 'unappliedValue',
  'sourceConflict', 'attributionKnown',
])

function ledgerState(selection, reasons) {
  if (!isGoverningClaimSelection(selection) ||
      selection.truthDimension !== PROVIDER_TRUTH_DIMENSION.T1_INVOICE_AR_STATE) {
    reasons.push(ELIGIBILITY_REASON.TRUSTED_LEDGER_REQUIRED)
    return null
  }

  if (selection.complete !== true) {
    const states = new Set(selection.withheld.map((item) => item.freshness))
    if (states.has(FRESHNESS_STATE.SOURCE_UNAVAILABLE) || states.has(FRESHNESS_STATE.UNKNOWN)) {
      reasons.push(ELIGIBILITY_REASON.LEDGER_UNAVAILABLE)
    } else {
      reasons.push(ELIGIBILITY_REASON.LEDGER_STALE)
    }
    if (selection.untrustedInputs > 0) reasons.push(ELIGIBILITY_REASON.TRUSTED_LEDGER_REQUIRED)
    return null
  }

  if (selection.governing.length !== 1) {
    reasons.push(selection.governing.length > 1
      ? ELIGIBILITY_REASON.SOURCE_CONFLICT
      : ELIGIBILITY_REASON.LEDGER_UNAVAILABLE)
    return null
  }

  const ledger = selection.governing[0]
  const balance = ledger?.value?.balance
  if (typeof balance !== 'number' || !Number.isFinite(balance)) {
    reasons.push(ELIGIBILITY_REASON.TRUSTED_LEDGER_REQUIRED)
    return null
  }
  return { ledger, balance }
}

/**
 * Derives eligibility from trusted governing T1 state plus explicit context.
 * No raw ledger, freshness, availability or favourable default is accepted.
 */
export function deriveCollectionEligibility({ governingLedger = null, context = null } = {}) {
  const reasons = []
  const selected = ledgerState(governingLedger, reasons)

  if (!isCollectionDecisionContext(context)) {
    reasons.push(ELIGIBILITY_REASON.CONTEXT_INCOMPLETE)
  } else {
    if (REQUIRED_CONTEXT.some((name) => context[name] == null)) {
      reasons.push(ELIGIBILITY_REASON.CONTEXT_INCOMPLETE)
    }
    if (context.policyDecision === COLLECTION_POLICY_DECISION.UNKNOWN) {
      reasons.push(ELIGIBILITY_REASON.POLICY_UNKNOWN)
    }
    if (context.policyDecision === COLLECTION_POLICY_DECISION.BLOCKED) {
      reasons.push(ELIGIBILITY_REASON.POLICY_BLOCKED)
    }
    if (context.disputeActive === true) reasons.push(ELIGIBILITY_REASON.DISPUTE_ACTIVE)
    if (context.sourceConflict === true) reasons.push(ELIGIBILITY_REASON.SOURCE_CONFLICT)
    if (context.paymentInFlight === true) reasons.push(ELIGIBILITY_REASON.PAYMENT_IN_FLIGHT)
    if (context.availableCredit != null && context.availableCredit > 0) {
      reasons.push(ELIGIBILITY_REASON.AVAILABLE_CREDIT_PRESENT)
    }
    if (context.unappliedValue != null && context.unappliedValue > 0) {
      reasons.push(ELIGIBILITY_REASON.UNAPPLIED_VALUE_MATERIAL)
    }
    if (context.attributionKnown === false) reasons.push(ELIGIBILITY_REASON.ATTRIBUTION_UNKNOWN)
  }

  let outcome = COLLECTION_ELIGIBILITY.ELIGIBLE
  for (const [reason, produced] of STOPPING_REASONS) {
    if (reasons.includes(reason)) { outcome = produced; break }
  }
  if (reasons.length === 0 && selected.balance <= 0) {
    outcome = COLLECTION_ELIGIBILITY.BLOCKED
    reasons.push(ELIGIBILITY_REASON.NOTHING_OUTSTANDING)
  }

  return freeze({
    kind: 'M2H_COLLECTION_ELIGIBILITY_V0',
    outcome,
    reasons: [...new Set(reasons)],
    trustedLedgerSelected: selected != null,
    contextComplete: isCollectionDecisionContext(context) &&
      REQUIRED_CONTEXT.every((name) => context[name] != null) &&
      context.policyDecision !== COLLECTION_POLICY_DECISION.UNKNOWN,
    policyEvaluated: isCollectionDecisionContext(context) &&
      context.policyDecision !== COLLECTION_POLICY_DECISION.UNKNOWN,
    policyOwner: 'OPERATING_POLICY_INPUT',
    authorityEvaluated: false,
    authorityOwner: 'G5',
    requiresFreshAuthorityAtUse: true,
    derivedFromBalanceAlone: false,
  })
}
