export const CLAIM_ROLE = Object.freeze({
  CANONICAL_RECORD: 'CANONICAL_RECORD',
  ATTRIBUTED_ASSERTION: 'ATTRIBUTED_ASSERTION',
  POLICY_INPUT: 'POLICY_INPUT',
  INFERENCE_ONLY: 'INFERENCE_ONLY',
})

export const PAYMENT_STATE = Object.freeze({
  SETTLED: 'SETTLED',
  OPEN: 'OPEN',
  CLAIMED_UNVERIFIED: 'CLAIMED_UNVERIFIED',
  PENDING_CLEARANCE: 'PENDING_CLEARANCE',
  SETTLEMENT_EVIDENCE_CONFLICT: 'SETTLEMENT_EVIDENCE_CONFLICT',
  REVERSED_OR_FAILED: 'REVERSED_OR_FAILED',
})

export const DISPUTE_STATE = Object.freeze({
  NONE: 'NONE',
  SUSPECTED: 'SUSPECTED',
  CUSTOMER_ASSERTED: 'CUSTOMER_ASSERTED',
  CANONICAL_DISPUTE: 'CANONICAL_DISPUTE',
})

export const PROMISE_STATE = Object.freeze({
  NONE: 'NONE',
  PROPOSED: 'PROPOSED',
  CONFIRMED: 'CONFIRMED',
  DUE_TODAY: 'DUE_TODAY',
  PARTIAL: 'PARTIAL',
  FULFILLED: 'FULFILLED',
  BROKEN: 'BROKEN',
  RENEGOTIATED: 'RENEGOTIATED',
  CANCELLED: 'CANCELLED',
  CLAIMED_UNVERIFIED: 'CLAIMED_UNVERIFIED',
})

export const ACTION_RISK = Object.freeze({
  INFORMATIONAL: 'INFORMATIONAL',
  REVERSIBLE_CUSTOMER_CONTACT: 'REVERSIBLE_CUSTOMER_CONTACT',
  OPERATIONAL_HOLD: 'OPERATIONAL_HOLD',
  FINANCIAL_MUTATION: 'FINANCIAL_MUTATION',
  REPUTATION_SENSITIVE: 'REPUTATION_SENSITIVE',
  UNKNOWN: 'UNKNOWN',
})

const ACTION_PROFILES = Object.freeze({
  send_reminder: {
    riskClass: ACTION_RISK.REVERSIBLE_CUSTOMER_CONTACT,
    reversible: true,
    accountingControlled: false,
    automaticAllowed: true,
    blocksOnPaymentReconciliation: true,
    blocksOnDispute: true,
  },
  pause_dunning: {
    riskClass: ACTION_RISK.OPERATIONAL_HOLD,
    reversible: true,
    accountingControlled: false,
    automaticAllowed: true,
    blocksOnPaymentReconciliation: false,
    blocksOnDispute: false,
  },
  resume_dunning: {
    riskClass: ACTION_RISK.OPERATIONAL_HOLD,
    reversible: true,
    accountingControlled: false,
    automaticAllowed: true,
    blocksOnPaymentReconciliation: true,
    blocksOnDispute: true,
  },
  mark_paid: {
    riskClass: ACTION_RISK.FINANCIAL_MUTATION,
    reversible: false,
    accountingControlled: true,
    automaticAllowed: false,
    blocksOnPaymentReconciliation: true,
    blocksOnDispute: false,
  },
  apply_cash: {
    riskClass: ACTION_RISK.FINANCIAL_MUTATION,
    reversible: false,
    accountingControlled: true,
    automaticAllowed: false,
    blocksOnPaymentReconciliation: true,
    blocksOnDispute: false,
  },
  issue_credit: {
    riskClass: ACTION_RISK.FINANCIAL_MUTATION,
    reversible: false,
    accountingControlled: true,
    automaticAllowed: false,
    blocksOnPaymentReconciliation: false,
    blocksOnDispute: false,
  },
  write_off: {
    riskClass: ACTION_RISK.FINANCIAL_MUTATION,
    reversible: false,
    accountingControlled: true,
    automaticAllowed: false,
    blocksOnPaymentReconciliation: true,
    blocksOnDispute: false,
  },
  legal_escalation: {
    riskClass: ACTION_RISK.REPUTATION_SENSITIVE,
    reversible: false,
    accountingControlled: false,
    automaticAllowed: false,
    blocksOnPaymentReconciliation: true,
    blocksOnDispute: true,
  },
})

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function allEvidence(admission) {
  return [
    ...safeArray(admission?.admitted),
    ...safeArray(admission?.contextOnly),
  ]
}

function hasClaim(admission, predicate) {
  return allEvidence(admission).some(predicate)
}

function normalizePromiseStatus(value) {
  const candidate = String(value || '').toUpperCase()
  return Object.values(PROMISE_STATE).includes(candidate) ? candidate : PROMISE_STATE.NONE
}

function claimRole(record) {
  if (record?.sourceType === 'invoice_system' || record?.sourceType === 'ledger' || record?.claimType === 'ledger_state' || record?.claimType === 'invoice_state') {
    return CLAIM_ROLE.CANONICAL_RECORD
  }
  if (record?.claimType === 'founder_policy' || record?.claimType === 'founder_correction' || record?.sourceType === 'founder_policy') {
    return CLAIM_ROLE.POLICY_INPUT
  }
  if (record?.claimType === 'model_inference' || record?.sourceType === 'model') {
    return CLAIM_ROLE.INFERENCE_ONLY
  }
  return CLAIM_ROLE.ATTRIBUTED_ASSERTION
}

export function projectAttributedClaims({ admission, observedAt = null } = {}) {
  return allEvidence(admission).map((record) => ({
    sourceEvidenceId: record.id ?? null,
    role: claimRole(record),
    claimType: record.claimType ?? 'unspecified',
    sourceType: record.sourceType ?? null,
    tenantId: record.tenantId ?? null,
    clientId: record.clientId ?? null,
    invoiceId: record.invoiceId ?? null,
    trust: record.trust ?? null,
    admissionStatus: record.status ?? null,
    derivedFrom: record.derivedFrom ?? null,
    observedAt: record.observedAt ?? record.occurredAt ?? observedAt,
    canonicalEffect: 'NONE',
  }))
}

export function projectArControlState({ canonical, admission, disputed = false, promise = null } = {}) {
  if (!canonical) throw new Error('canonical required')

  const settlementEvidence = hasClaim(admission, (e) =>
    e.claimType === 'payment_settlement' ||
    e.claimType === 'bank_settlement' ||
    e.settlementConfirmed === true
  )
  const paymentClaim = hasClaim(admission, (e) =>
    e.claimType === 'payment_claim' ||
    e.claimsPayment === true
  )
  const paymentPending = hasClaim(admission, (e) =>
    e.claimType === 'payment_pending' ||
    e.claimType === 'pending_clearance'
  )
  const paymentReversal = hasClaim(admission, (e) =>
    e.claimType === 'payment_reversal' ||
    e.claimType === 'payment_failed'
  )

  let paymentStatus = PAYMENT_STATE.OPEN
  if (canonical.settled) paymentStatus = PAYMENT_STATE.SETTLED
  else if (settlementEvidence) paymentStatus = PAYMENT_STATE.SETTLEMENT_EVIDENCE_CONFLICT
  else if (paymentReversal) paymentStatus = PAYMENT_STATE.REVERSED_OR_FAILED
  else if (paymentPending) paymentStatus = PAYMENT_STATE.PENDING_CLEARANCE
  else if (paymentClaim) paymentStatus = PAYMENT_STATE.CLAIMED_UNVERIFIED

  const disputeClaim = hasClaim(admission, (e) =>
    e.claimType === 'dispute_claim' ||
    e.claimsDispute === true
  )
  const disputeSignal = hasClaim(admission, (e) =>
    e.claimType === 'dispute_signal' ||
    e.suspectedDispute === true
  )

  let disputeStatus = DISPUTE_STATE.NONE
  if (disputed === true) disputeStatus = DISPUTE_STATE.CANONICAL_DISPUTE
  else if (disputeClaim) disputeStatus = DISPUTE_STATE.CUSTOMER_ASSERTED
  else if (disputeSignal) disputeStatus = DISPUTE_STATE.SUSPECTED

  let promiseStatus = normalizePromiseStatus(promise?.status)
  if (promiseStatus === PROMISE_STATE.NONE && hasClaim(admission, (e) => e.claimType === 'promise_claim' || e.claimsPromise === true)) {
    promiseStatus = PROMISE_STATE.CLAIMED_UNVERIFIED
  }

  const requiresPaymentReconciliation = [
    PAYMENT_STATE.CLAIMED_UNVERIFIED,
    PAYMENT_STATE.PENDING_CLEARANCE,
    PAYMENT_STATE.SETTLEMENT_EVIDENCE_CONFLICT,
    PAYMENT_STATE.REVERSED_OR_FAILED,
  ].includes(paymentStatus)

  const requiresDisputeResolution = [
    DISPUTE_STATE.SUSPECTED,
    DISPUTE_STATE.CUSTOMER_ASSERTED,
    DISPUTE_STATE.CANONICAL_DISPUTE,
  ].includes(disputeStatus)

  let collectionStatus = 'CURRENT_OR_PRE_DUE'
  if (canonical.settled) collectionStatus = 'CLOSED'
  else if (requiresPaymentReconciliation) collectionStatus = 'HOLD_RECONCILIATION'
  else if (requiresDisputeResolution) collectionStatus = 'HOLD_DISPUTE'
  else if ((canonical.daysOverdue ?? 0) > 0) collectionStatus = 'ACTIVE_OVERDUE'

  return {
    invoice: {
      status: canonical.canonicalStatus,
      balance: canonical.balance,
      daysOverdue: canonical.daysOverdue,
    },
    payment: { status: paymentStatus },
    dispute: { status: disputeStatus },
    promise: { status: promiseStatus },
    collection: { status: collectionStatus },
    reconciliation: {
      requiresPaymentReconciliation,
      requiresDisputeResolution,
      blocksCustomerContact: requiresPaymentReconciliation || requiresDisputeResolution,
      canonicalMutationAllowed: false,
    },
  }
}

export function assessPrecedentStructure({ precedent = {}, current = {}, clientId = null } = {}) {
  const disputeCompatible = precedent.disputed == null || current.disputed == null || Boolean(precedent.disputed) === Boolean(current.disputed)
  const actionCompatible = !precedent.actionType || !current.actionType || precedent.actionType === current.actionType
  const clientCompatible = !precedent.clientId || precedent.clientId === clientId || precedent.allowCrossClient === true
  const promiseCompatible = !precedent.promiseStatus || !current.promiseStatus || precedent.promiseStatus === current.promiseStatus
  const paymentCompatible = !precedent.paymentState || !current.paymentState || precedent.paymentState === current.paymentState
  const collectionStageCompatible = !precedent.collectionStage || !current.collectionStage || precedent.collectionStage === current.collectionStage
  const stale = precedent.stale === true
  const outcomeQualityOk = precedent.outcomeValid !== false && String(precedent.outcomeQuality || 'OK').toUpperCase() !== 'LOW'

  return {
    disputeCompatible,
    actionCompatible,
    clientCompatible,
    promiseCompatible,
    paymentCompatible,
    collectionStageCompatible,
    stale: !stale,
    outcomeQualityOk,
  }
}

export function actionProfile(action) {
  return ACTION_PROFILES[action] || {
    riskClass: ACTION_RISK.UNKNOWN,
    reversible: false,
    accountingControlled: false,
    automaticAllowed: false,
    blocksOnPaymentReconciliation: true,
    blocksOnDispute: true,
  }
}

export function buildConstraintPlan({
  canonical,
  arState,
  authorityEvaluation = null,
  recommendation = null,
  predictionAssessment = null,
  predictionRequired = false,
  rejectStagedAction = false,
} = {}) {
  const action = recommendation?.action ?? null
  const profile = actionProfile(action)
  const blockers = []

  if (!action) blockers.push('no_recommendation')
  if (canonical?.canonicalStatus !== 'OPEN' && action && action !== 'pause_dunning') blockers.push('invoice_not_open')
  if (profile.blocksOnPaymentReconciliation && arState?.reconciliation?.requiresPaymentReconciliation) blockers.push('payment_reconciliation_required')
  if (profile.blocksOnDispute && arState?.reconciliation?.requiresDisputeResolution) blockers.push('dispute_resolution_required')
  if (predictionRequired && !predictionAssessment?.actionable) blockers.push('prediction_not_actionable')
  if (rejectStagedAction) blockers.push('staged_action_rejected')
  if (recommendation && authorityEvaluation?.authority?.authorized !== true) blockers.push('policy_not_authorized')
  if (profile.accountingControlled) blockers.push('accounting_control_required')

  const requiresFounderApproval =
    profile.automaticAllowed !== true ||
    profile.accountingControlled === true ||
    authorityEvaluation?.permission?.requiresApproval === true

  return {
    action,
    riskClass: profile.riskClass,
    reversible: profile.reversible,
    accountingControlled: profile.accountingControlled,
    automaticAllowedByActionClass: profile.automaticAllowed,
    blockers,
    preconditionsSatisfied: blockers.length === 0,
    requiresFounderApproval,
    requiresServerRevalidation: Boolean(action),
    constraintClasses: [
      'CANONICAL_STATE',
      'RECONCILIATION',
      'POLICY_AUTHORITY',
      ...(predictionRequired ? ['PREDICTION_QUALITY'] : []),
      ...(profile.accountingControlled ? ['ACCOUNTING_CONTROL'] : []),
    ],
  }
}

export function buildExecutionIntent({ tenantId, invoiceId, canonical, recommendation } = {}) {
  if (!recommendation?.action) return null
  const profile = actionProfile(recommendation.action)
  const ruleId = recommendation.ruleId ?? 'none'
  const stateVersion = `${canonical?.canonicalStatus ?? 'unknown'}:${canonical?.balance ?? 'unknown'}:${canonical?.lastReminderAt ?? 'never'}`
  return {
    riskClass: profile.riskClass,
    reversible: profile.reversible,
    accountingControlled: profile.accountingControlled,
    idempotencyKey: `dw:${tenantId}:${invoiceId}:${recommendation.action}:${ruleId}:${stateVersion}`,
    requiresServerRevalidation: true,
    compensationMode: profile.accountingControlled ? 'TRANSACTIONAL_RECONCILIATION' : 'AUDIT_AND_RECONCILE',
  }
}

export function buildArAnalysisPlan(input = {}) {
  const recommendation = input.authorityEvaluation?.recommendation ?? null
  const profile = actionProfile(recommendation?.action)
  const evidence = safeArray(input.evidence)
  const hasConflictHint = evidence.some((e) =>
    e.claimType === 'payment_claim' ||
    e.claimType === 'payment_pending' ||
    e.claimType === 'payment_settlement' ||
    e.claimType === 'dispute_claim' ||
    e.claimsPayment === true ||
    e.claimsDispute === true
  )
  const guarded =
    profile.accountingControlled === true ||
    profile.riskClass === ACTION_RISK.REPUTATION_SENSITIVE ||
    hasConflictHint ||
    input.rejectStagedAction === true

  const run = {
    canonical: true,
    evidenceAdmission: true,
    reconciliation: true,
    constraints: true,
    memory: safeArray(input.memory).length > 0 || safeArray(input.tombstones).length > 0,
    precedent: safeArray(input.precedents).length > 0,
    pooling: Boolean(input.pooling),
    uncertainty: Boolean(input.prediction) || input.predictionRequired === true,
    founderQuestion: Boolean(input.question?.candidateQuestion),
    preferenceEvidence: safeArray(input.preferenceEvents).length > 0,
  }

  const performed = Object.entries(run).filter(([, enabled]) => enabled).map(([name]) => name)
  const skipped = Object.entries(run).filter(([, enabled]) => !enabled).map(([name]) => name)

  return {
    tier: guarded ? 'GUARDED' : 'STANDARD',
    run,
    performed,
    skipped,
    estimatedWorkUnits: performed.length,
    reason: guarded ? 'material_or_conflicting_case' : 'minimum_sufficient_analysis',
  }
}
