const DAY_MS = 86_400_000

export const OPERATIONAL_STATE = Object.freeze({
  HANDLED: 'HANDLED',
  READY: 'READY',
  APPROVAL: 'APPROVAL',
  WATCH: 'WATCH',
  INVESTIGATING: 'INVESTIGATING',
  UNCERTAIN: 'UNCERTAIN',
  BLOCKED: 'BLOCKED',
})

export const EVIDENCE_STATUS = Object.freeze({
  ADMITTED: 'ADMITTED',
  CONTEXT_ONLY: 'CONTEXT_ONLY',
  QUARANTINED_INSTRUCTION: 'QUARANTINED_INSTRUCTION',
  REJECTED_TENANT: 'REJECTED_TENANT',
  REJECTED_SCOPE: 'REJECTED_SCOPE',
})

const STRONG_TRUST = new Set(['HIGH', 'MEDIUM'])
const CONTEXT_TRUST = new Set(['LOW'])

function parseDate(value) {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return dt
}

function nowDate(now) {
  const d = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(d.getTime())) throw new Error('Invalid now')
  return d
}

export function canonicalSnapshot(invoice, now = new Date()) {
  if (!invoice || typeof invoice !== 'object') throw new Error('invoice required')
  const amount = Number(invoice.amount) || 0
  const amountPaid = Number(invoice.amount_paid) || 0
  const balance = Math.max(0, amount - amountPaid)
  const due = parseDate(invoice.due_date)
  const current = nowDate(now)
  const daysOverdue = due ? Math.max(0, Math.floor((current.getTime() - due.getTime()) / DAY_MS)) : null
  const settled = invoice.paid === true || balance === 0
  return Object.freeze({
    invoiceId: invoice.id,
    tenantId: invoice.user_id,
    clientId: invoice.client_id ?? null,
    amount,
    amountPaid,
    balance,
    dueDate: invoice.due_date ?? null,
    daysOverdue,
    paid: invoice.paid === true,
    settled,
    canonicalStatus: settled ? 'SETTLED' : 'OPEN',
    lastReminderAt: invoice.last_reminder ?? null,
  })
}

function relevantToScope(item, { invoiceId, clientId }) {
  if (item.invoiceId && item.invoiceId !== invoiceId) return false
  if (item.clientId && item.clientId !== clientId) return false
  return true
}

export function admitEvidence({ tenantId, invoiceId, clientId, evidence = [] }) {
  const records = []
  for (const source of evidence) {
    let status
    let reason = null
    if (!source || source.tenantId !== tenantId) {
      status = EVIDENCE_STATUS.REJECTED_TENANT
      reason = 'tenant_mismatch'
    } else if (!relevantToScope(source, { invoiceId, clientId })) {
      status = EVIDENCE_STATUS.REJECTED_SCOPE
      reason = 'scope_mismatch'
    } else if (source.containsInstructions === true || source.attemptsAuthorityGrant === true || source.attemptsPolicyRewrite === true) {
      status = EVIDENCE_STATUS.QUARANTINED_INSTRUCTION
      reason = 'external_instruction_not_authority'
    } else if (STRONG_TRUST.has(source.trust)) {
      status = EVIDENCE_STATUS.ADMITTED
    } else if (CONTEXT_TRUST.has(source.trust)) {
      status = EVIDENCE_STATUS.CONTEXT_ONLY
      reason = 'low_trust_context_only'
    } else {
      status = EVIDENCE_STATUS.QUARANTINED_INSTRUCTION
      reason = 'untrusted_source'
    }
    records.push({ ...source, status, reason })
  }

  const strong = records.filter((r) => r.status === EVIDENCE_STATUS.ADMITTED)
  const strongIds = new Set(strong.map((r) => r.id))
  const roots = strong.filter((r) => !r.derivedFrom || !strongIds.has(r.derivedFrom))

  return {
    records,
    admitted: strong,
    contextOnly: records.filter((r) => r.status === EVIDENCE_STATUS.CONTEXT_ONLY),
    quarantined: records.filter((r) => r.status === EVIDENCE_STATUS.QUARANTINED_INSTRUCTION),
    rejected: records.filter((r) => r.status === EVIDENCE_STATUS.REJECTED_TENANT || r.status === EVIDENCE_STATUS.REJECTED_SCOPE),
    independentStrongRoots: roots.map((r) => r.id),
    independentStrongRootCount: roots.length,
  }
}

function memoryScopeMatches(m, { tenantId, clientId, invoiceId }) {
  if (m.tenantId !== tenantId) return false
  if (m.scope === 'invoice') return m.invoiceId === invoiceId
  if (m.scope === 'client') return m.clientId === clientId
  return false
}

export function resolveMemory({ tenantId, clientId, invoiceId, memory = [], tombstones = [], evidenceAdmission }) {
  const tombstonedMemoryIds = new Set(tombstones.filter((t) => t.tenantId === tenantId).map((t) => t.memoryId))
  const blockedEvidenceIds = new Set(tombstones.filter((t) => t.tenantId === tenantId).flatMap((t) => t.blockedEvidenceIds || []))
  const admittedEvidenceIds = new Set((evidenceAdmission?.admitted || []).map((e) => e.id))
  const byId = new Map(memory.map((m) => [m.id, m]))

  const hasTombstonedAncestor = (m) => {
    let cur = m
    const seen = new Set()
    while (cur?.derivedFromMemoryId && !seen.has(cur.derivedFromMemoryId)) {
      seen.add(cur.derivedFromMemoryId)
      if (tombstonedMemoryIds.has(cur.derivedFromMemoryId)) return true
      cur = byId.get(cur.derivedFromMemoryId)
    }
    return false
  }

  const active = []
  const blocked = []
  for (const m of memory) {
    let reason = null
    if (!memoryScopeMatches(m, { tenantId, clientId, invoiceId })) reason = 'scope_mismatch'
    else if (m.admitted !== true) reason = 'not_admitted'
    else if (tombstonedMemoryIds.has(m.id) || m.revoked === true) reason = 'tombstoned'
    else if (hasTombstonedAncestor(m)) reason = 'derivative_of_tombstone'
    else if ((m.sourceEvidenceIds || []).some((id) => blockedEvidenceIds.has(id))) reason = 'blocked_source_evidence'
    else if ((m.sourceEvidenceIds || []).some((id) => !admittedEvidenceIds.has(id))) reason = 'source_not_currently_admitted'

    if (reason) blocked.push({ ...m, blockedReason: reason })
    else active.push(m)
  }
  return { active, blocked }
}

export function selectPrecedents({ tenantId, clientId, current = {}, precedents = [] }) {
  const checked = precedents
    .filter((p) => p.tenantId === tenantId)
    .map((p) => {
      const disputeCompatible = Boolean(p.disputed) === Boolean(current.disputed)
      const actionCompatible = !p.actionType || p.actionType === current.actionType
      const clientCompatible = !p.clientId || p.clientId === clientId || p.allowCrossClient === true
      const stale = p.stale === true
      const applicable = disputeCompatible && actionCompatible && clientCompatible && !stale
      return { ...p, applicable, reasons: { disputeCompatible, actionCompatible, clientCompatible, stale } }
    })
  return {
    checked,
    applicable: checked.filter((p) => p.applicable).sort((a, b) => (b.similarity || 0) - (a.similarity || 0)),
  }
}

export function partialPool({ local, prior } = {}) {
  if (!local || !prior) return null
  const localN = Math.max(0, Number(local.n) || 0)
  const localRate = Math.min(1, Math.max(0, Number(local.rate) || 0))
  const priorRate = Math.min(1, Math.max(0, Number(prior.rate) || 0))
  const priorEss = Math.min(16, Math.max(0, Number(prior.ess) || 0))
  const denom = localN + priorEss
  const localWeight = denom > 0 ? localN / denom : 0
  const priorWeight = denom > 0 ? priorEss / denom : 0
  const posteriorRate = denom > 0 ? localWeight * localRate + priorWeight * priorRate : priorRate
  const strongLocalSupport = localN >= 20 && localWeight >= (2 / 3)
  const priorDirection = priorRate >= 0.5 ? 'HIGH' : 'LOW'
  const localDirection = localRate >= 0.5 ? 'HIGH' : 'LOW'
  const posteriorDirection = posteriorRate >= 0.5 ? 'HIGH' : 'LOW'
  const priorOvercome = strongLocalSupport && localDirection !== priorDirection && posteriorDirection === localDirection
  return {
    localN,
    localRate,
    priorRate,
    priorEss,
    localWeight,
    priorWeight,
    posteriorRate,
    strongLocalSupport,
    supportWarning: strongLocalSupport ? null : 'client_local_support_not_yet_dominant',
    priorOvercome,
  }
}

export function assessPrediction(prediction) {
  if (!prediction) return null
  const sampleN = Math.max(0, Number(prediction.sampleN) || 0)
  const intervalDays = Math.max(0, Number(prediction.intervalDays) || 0)
  const staleDays = Math.max(0, Number(prediction.staleDays) || 0)
  const assumptionsOk = prediction.assumptionsOk !== false
  const actionable = sampleN >= 5 && intervalDays <= 14 && staleDays <= 90 && assumptionsOk
  const reasons = []
  if (sampleN < 5) reasons.push('sparse_sample')
  if (intervalDays > 14) reasons.push('interval_too_wide')
  if (staleDays > 90) reasons.push('stale_prediction')
  if (!assumptionsOk) reasons.push('assumption_failure')
  return {
    point: prediction.point ?? null,
    coverage: prediction.coverage ?? null,
    sampleN,
    intervalDays,
    staleDays,
    assumptionsOk,
    actionable,
    reasons,
  }
}

export function chooseFounderQuestion({ candidateQuestion, informationValue = 0, burdenCost = 0.20, liveUncertainty = false, safeReversibleAvailable = false } = {}) {
  const ask = Boolean(candidateQuestion) && liveUncertainty && !safeReversibleAvailable && Number(informationValue) > Number(burdenCost)
  return {
    question: ask ? candidateQuestion : null,
    asked: ask,
    informationValue: Number(informationValue) || 0,
    burdenCost: Number(burdenCost) || 0,
    suppressedReason: ask ? null : (safeReversibleAvailable ? 'safe_reversible_action_available' : 'insufficient_decision_value'),
  }
}

export function filterPreferenceEvidence(events = []) {
  const admitted = []
  const excluded = []
  for (const e of events) {
    if (e?.origin === 'system_exposure' || e?.causedByDwProminence === true) excluded.push({ ...e, reason: 'performative_feedback' })
    else admitted.push(e)
  }
  return { admitted, excluded }
}

function hasPaymentClaim(admission) {
  return [...admission.admitted, ...admission.contextOnly].some((e) => e.claimType === 'payment_claim' || e.claimsPayment === true)
}

function authorityActual(authorityEvaluation, founderApproved) {
  if (founderApproved === true && authorityEvaluation?.authority?.authorized === true) return 'GRANTED'
  if (authorityEvaluation?.authority?.authorized === true && authorityEvaluation?.permission?.canActAutomatically === true) return 'GRANTED'
  return 'NOT_GRANTED'
}

function buildVerifier({ canonical, admission, authorityEvaluation, paymentConflict, predictionAssessment, rejectStagedAction }) {
  const instructionBearing = admission.records.filter((e) =>
    e.containsInstructions === true ||
    e.attemptsAuthorityGrant === true ||
    e.attemptsPolicyRewrite === true
  )
  const checks = {
    invoiceOpen: canonical.canonicalStatus === 'OPEN',
    noCanonicalPaymentConflict: !paymentConflict,
    externalInstructionsQuarantined: instructionBearing.every(
      (e) => e.status === EVIDENCE_STATUS.QUARANTINED_INSTRUCTION
    ),
    recommendationAuthorizedByPolicy: authorityEvaluation?.authority?.authorized === true,
    predictionActionableOrNotRequired: !predictionAssessment || predictionAssessment.actionable,
    stagedActionNotRejected: rejectStagedAction !== true,
  }
  const passed =
    checks.invoiceOpen &&
    checks.noCanonicalPaymentConflict &&
    checks.externalInstructionsQuarantined &&
    checks.recommendationAuthorizedByPolicy &&
    checks.predictionActionableOrNotRequired &&
    checks.stagedActionNotRejected
  return { passed, checks }
}

function toProofEvidenceRecord(record) {
  const rejected = record.status === EVIDENCE_STATUS.REJECTED_TENANT || record.status === EVIDENCE_STATUS.REJECTED_SCOPE
  if (rejected) {
    // A rejected foreign/out-of-scope source is evidence that the admission
    // boundary worked, not content the tenant is entitled to inspect. Keep the
    // rejection classification but redact source identity/trust/lineage from
    // the durable/browser-readable proof object.
    return {
      id: null,
      trust: null,
      status: record.status,
      reason: record.reason ?? null,
      derivedFrom: null,
      claimType: null,
      redacted: true,
    }
  }
  return {
    id: record.id ?? null,
    trust: record.trust ?? null,
    status: record.status,
    reason: record.reason ?? null,
    derivedFrom: record.derivedFrom ?? null,
    claimType: record.claimType ?? null,
    redacted: false,
  }
}

export function auditHardGates(result, input) {
  const violations = []
  const authority = result.proof.authority
  if (authority.actual === 'GRANTED' && !authority.policyAuthorized) violations.push('H01')
  if (result.proof.scope.tenantId !== input.tenantId) violations.push('H02')
  if (result.canonicalAfter.canonicalStatus !== result.canonicalBefore.canonicalStatus || result.canonicalAfter.balance !== result.canonicalBefore.balance) violations.push('H03')
  if (result.proof.evidence.fabricatedIds?.length) violations.push('H04')
  if (result.proof.interpretations.some((x) => x.promotedToCanonical === true)) violations.push('H05')
  if (authority.actual === 'GRANTED' && authority.basis === 'confidence_only') violations.push('H06')
  if (result.execution.sideEffect === true && authority.actual !== 'GRANTED') violations.push('H07')
  if (input.rejectStagedAction === true && result.execution.sideEffect === true) violations.push('H08')
  if (result.proof.identificationStatus === 'IDENTIFIED' && input.identificationStatus && input.identificationStatus !== 'IDENTIFIED') violations.push('H09')
  if (result.proof.memory.rederivedFromBlockedEvidence === true) violations.push('H10')
  return violations
}

export function runPhase2BWorkflow(input = {}) {
  const {
    tenantId,
    invoice,
    client,
    now = new Date(),
    evidence = [],
    memory = [],
    tombstones = [],
    precedents = [],
    pooling = null,
    prediction = null,
    predictionRequired = false,
    authorityEvaluation = null,
    founderApproved = false,
    question = null,
    preferenceEvents = [],
    rejectStagedAction = false,
    sandboxTransport = true,
    identificationStatus = null,
  } = input

  if (!tenantId || invoice?.user_id !== tenantId || client?.user_id !== tenantId || invoice?.client_id !== client?.id) {
    const canonical = invoice ? canonicalSnapshot(invoice, now) : { canonicalStatus: null, balance: null }
    const result = {
      state: OPERATIONAL_STATE.BLOCKED,
      canonicalBefore: canonical,
      canonicalAfter: canonical,
      stagedAction: null,
      execution: { mode: 'none', sideEffect: false, outcome: 'BLOCKED_TENANT_SCOPE' },
      proof: {
        scope: { tenantId, invoiceId: invoice?.id ?? null, clientId: client?.id ?? null },
        canonicalFacts: canonical,
        evidence: { records: [], independentStrongRoots: [], fabricatedIds: [] },
        interpretations: [], predictions: null, identificationStatus,
        memory: { active: [], blocked: [], rederivedFromBlockedEvidence: false },
        precedent: { checked: [], applicable: [] }, pooling: null,
        founderQuestion: { question: null, asked: false },
        policy: authorityEvaluation?.recommendation ?? null,
        authority: { policyAuthorized: false, actual: 'NOT_GRANTED', canActAutomatically: false },
        verifier: { passed: false, checks: { tenantScope: false } },
      },
    }
    result.hardViolations = auditHardGates(result, input)
    return result
  }

  const canonical = canonicalSnapshot(invoice, now)
  const admission = admitEvidence({ tenantId, invoiceId: invoice.id, clientId: client.id, evidence })
  const memoryResolution = resolveMemory({ tenantId, clientId: client.id, invoiceId: invoice.id, memory, tombstones, evidenceAdmission: admission })
  const precedentResolution = selectPrecedents({ tenantId, clientId: client.id, current: { disputed: input.disputed === true, actionType: 'send_reminder' }, precedents })
  const poolingAssessment = partialPool(pooling || undefined)
  const predictionAssessment = assessPrediction(prediction)
  const preference = filterPreferenceEvidence(preferenceEvents)
  const questionDecision = chooseFounderQuestion(question || {})

  const paymentConflict = canonical.canonicalStatus === 'OPEN' && hasPaymentClaim(admission)
  const policyAuthorized = authorityEvaluation?.authority?.authorized === true
  const recommendation = authorityEvaluation?.recommendation ?? null
  const actualAuthority = authorityActual(authorityEvaluation, founderApproved)
  const predictionBlocks = predictionRequired && (!predictionAssessment || !predictionAssessment.actionable)

  let state = OPERATIONAL_STATE.WATCH
  let stagedAction = null
  let execution = { mode: 'none', sideEffect: false, outcome: 'NO_ACTION' }

  if (paymentConflict) {
    state = OPERATIONAL_STATE.INVESTIGATING
  } else if (predictionBlocks) {
    state = OPERATIONAL_STATE.UNCERTAIN
  } else if (!recommendation || !policyAuthorized) {
    state = questionDecision.asked ? OPERATIONAL_STATE.UNCERTAIN : OPERATIONAL_STATE.WATCH
  } else if (actualAuthority !== 'GRANTED') {
    state = OPERATIONAL_STATE.APPROVAL
    stagedAction = {
      action: recommendation.action,
      tone: recommendation.tone ?? null,
      ruleId: recommendation.ruleId ?? null,
      status: 'AWAITING_APPROVAL',
    }
  } else {
    stagedAction = {
      action: recommendation.action,
      tone: recommendation.tone ?? null,
      ruleId: recommendation.ruleId ?? null,
      status: rejectStagedAction ? 'REJECTED' : 'STAGED',
    }
    const verifier = buildVerifier({ canonical, admission, authorityEvaluation, paymentConflict, predictionAssessment: predictionRequired ? predictionAssessment : null, rejectStagedAction })
    if (!verifier.passed) {
      state = rejectStagedAction ? OPERATIONAL_STATE.BLOCKED : OPERATIONAL_STATE.WATCH
      execution = { mode: 'none', sideEffect: false, outcome: rejectStagedAction ? 'REJECTED_BEFORE_EXECUTION' : 'VERIFIER_BLOCKED' }
    } else if (sandboxTransport) {
      state = OPERATIONAL_STATE.HANDLED
      stagedAction.status = 'SANDBOX_EXECUTED'
      execution = { mode: 'sandbox', sideEffect: false, outcome: 'SANDBOX_SENT' }
    } else {
      state = OPERATIONAL_STATE.READY
      execution = { mode: 'none', sideEffect: false, outcome: 'PRODUCTION_EXECUTION_NOT_AUTHORIZED' }
    }
  }

  const verifier = buildVerifier({ canonical, admission, authorityEvaluation, paymentConflict, predictionAssessment: predictionRequired ? predictionAssessment : null, rejectStagedAction })
  const blockedEvidenceIds = new Set(tombstones.flatMap((t) => t.blockedEvidenceIds || []))
  const rederivedFromBlockedEvidence = memoryResolution.active.some((m) => (m.sourceEvidenceIds || []).some((id) => blockedEvidenceIds.has(id)))

  const proof = {
    scope: { tenantId, businessId: tenantId, clientId: client.id, invoiceId: invoice.id },
    canonicalFacts: canonical,
    evidence: {
      records: admission.records.map(toProofEvidenceRecord),
      independentStrongRoots: admission.independentStrongRoots,
      fabricatedIds: [],
    },
    interpretations: paymentConflict ? [{ type: 'payment_claim', value: 'client_says_payment_sent', promotedToCanonical: false }] : [],
    predictions: predictionAssessment,
    identificationStatus,
    memory: {
      active: memoryResolution.active.map((m) => m.id),
      blocked: memoryResolution.blocked.map((m) => ({ id: m.id, reason: m.blockedReason })),
      rederivedFromBlockedEvidence,
    },
    precedent: {
      checked: precedentResolution.checked.map((p) => ({ id: p.id, similarity: p.similarity ?? null, applicable: p.applicable, reasons: p.reasons })),
      applicable: precedentResolution.applicable.map((p) => p.id),
    },
    pooling: poolingAssessment,
    uncertainty: predictionAssessment,
    founderQuestion: questionDecision,
    preferenceEvidence: { admitted: preference.admitted.map((e) => e.id), excluded: preference.excluded.map((e) => ({ id: e.id, reason: e.reason })) },
    policy: recommendation,
    authority: {
      policyAuthorized,
      actual: actualAuthority,
      canActAutomatically: authorityEvaluation?.permission?.canActAutomatically === true,
      requiresApproval: authorityEvaluation?.permission?.requiresApproval !== false,
      basis: authorityEvaluation?.authority?.basis ?? null,
    },
    verifier,
    stagedAction,
    execution,
  }

  const result = {
    state,
    canonicalBefore: canonical,
    canonicalAfter: canonical,
    stagedAction,
    execution,
    proof,
  }
  result.hardViolations = auditHardGates(result, input)
  return result
}
