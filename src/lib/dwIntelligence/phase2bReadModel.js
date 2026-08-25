/**
 * Phase 2B application-facing DW read model.
 *
 * This module is deliberately read-only. It projects persisted/proven DW
 * Intelligence state into UI-safe data for Pulse, Invoice Detail, Activity,
 * Needs You, Evidence, and future • LIVE surfaces.
 *
 * It never grants authority, never mutates canonical money truth, never
 * executes a reminder, and never treats a UI button as permission. Any
 * founder action surfaced here must cross the existing server-side authority
 * revalidation/execution boundary later.
 */

export const DW_UI_STATE = Object.freeze({
  HANDLED: 'HANDLED',
  READY: 'READY',
  APPROVAL: 'APPROVAL',
  WATCH: 'WATCH',
  INVESTIGATING: 'INVESTIGATING',
  UNCERTAIN: 'UNCERTAIN',
  BLOCKED: 'BLOCKED',
})

export const DW_WORK_PHASE = Object.freeze({
  ANALYZING: 'analyzing',
  VERIFYING: 'verifying',
  PREPARING: 'preparing',
  WAITING: 'waiting',
  HANDLED: 'handled',
  BLOCKED: 'blocked',
})

export const FOUNDER_ACTION_BOUNDARY = 'REQUEST_BACKEND_REVALIDATION'

const KNOWN_STATES = new Set(Object.values(DW_UI_STATE))

function asIso(value) {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) freezeDeep(item)
  return value
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function validTenantScope({ userId, invoiceId, clientId, invoice, client, run, proofEvent }) {
  if (!proofEvent || proofEvent.user_id !== userId) return false
  if (proofEvent.invoice_id !== invoiceId) return false
  if (clientId != null && proofEvent.client_id !== clientId) return false
  if (invoice?.user_id != null && invoice.user_id !== userId) return false
  if (client?.user_id != null && client.user_id !== userId) return false
  if (run?.user_id != null && run.user_id !== userId) return false
  if (run?.id != null && proofEvent.run_id != null && run.id !== proofEvent.run_id) return false
  const scope = proofEvent.proof?.scope
  if (!scope || scope.tenantId !== userId || scope.invoiceId !== invoiceId) return false
  if (clientId != null && scope.clientId !== clientId) return false
  const canonical = proofEvent.proof?.canonicalFacts
  if (canonical?.invoiceId != null && canonical.invoiceId !== invoiceId) return false
  if (clientId != null && canonical?.clientId != null && canonical.clientId !== clientId) return false
  if (canonical?.tenantId != null && canonical.tenantId !== userId) return false
  return true
}

export function deriveWorkPhase({ run, proofEvent } = {}) {
  // Only a real persisted `running` run may render as active work. If an
  // explicit active phase is eventually persisted, use it; otherwise the
  // truthful generic active phase is `analyzing`. Completed proof must never
  // be made to look actively verifying/preparing merely from its final state.
  if (run?.status === 'running') {
    const explicit = proofEvent?.proof?.workPhase
    if (Object.values(DW_WORK_PHASE).includes(explicit) && ![DW_WORK_PHASE.HANDLED, DW_WORK_PHASE.BLOCKED].includes(explicit)) return explicit
    return DW_WORK_PHASE.ANALYZING
  }

  const state = proofEvent?.operational_state
  if (state === DW_UI_STATE.HANDLED) return DW_WORK_PHASE.HANDLED
  if (state === DW_UI_STATE.BLOCKED) return DW_WORK_PHASE.BLOCKED
  return DW_WORK_PHASE.WAITING
}

export function deriveNextWorkPhase({ proofEvent } = {}) {
  const state = proofEvent?.operational_state
  if (state === DW_UI_STATE.INVESTIGATING) return DW_WORK_PHASE.VERIFYING
  if (state === DW_UI_STATE.READY) return DW_WORK_PHASE.PREPARING
  if (state === DW_UI_STATE.HANDLED) return DW_WORK_PHASE.HANDLED
  if (state === DW_UI_STATE.BLOCKED) return DW_WORK_PHASE.BLOCKED
  return DW_WORK_PHASE.WAITING
}

function stateMessage(state) {
  switch (state) {
    case DW_UI_STATE.HANDLED: return 'DW handled this safely in sandbox.'
    case DW_UI_STATE.READY: return 'DW has a verified next step ready, but production execution is not authorized.'
    case DW_UI_STATE.APPROVAL: return 'DW finished its review and needs founder approval before anything can execute.'
    case DW_UI_STATE.WATCH: return 'DW is watching this case; no verified action is currently authorized.'
    case DW_UI_STATE.INVESTIGATING: return 'DW found a fact conflict that must be verified before action.'
    case DW_UI_STATE.UNCERTAIN: return 'DW does not have enough reliable support to act automatically.'
    case DW_UI_STATE.BLOCKED: return 'DW stopped this workflow before execution.'
    default: return 'DW state is unavailable.'
  }
}

function evidenceSummary(proof = {}) {
  const records = safeArray(proof.evidence?.records)
  const admitted = records.filter((r) => r.status === 'ADMITTED')
  const contextOnly = records.filter((r) => r.status === 'CONTEXT_ONLY')
  const quarantined = records.filter((r) => r.status === 'QUARANTINED_INSTRUCTION')
  const rejected = records.filter((r) => String(r.status || '').startsWith('REJECTED_'))
  return {
    total: records.length,
    admitted: admitted.length,
    contextOnly: contextOnly.length,
    quarantined: quarantined.length,
    rejected: rejected.length,
    independentStrongRoots: safeArray(proof.evidence?.independentStrongRoots).length,
    records: records.map((r) => {
      const rejected = r.status === 'REJECTED_TENANT' || r.status === 'REJECTED_SCOPE'
      return {
        id: rejected ? null : (r.id ?? null),
        trust: rejected ? null : (r.trust ?? null),
        status: r.status ?? null,
        reason: r.reason ?? null,
        claimType: rejected ? null : (r.claimType ?? null),
        derivedFrom: rejected ? null : (r.derivedFrom ?? null),
        redacted: rejected || r.redacted === true,
      }
    }),
  }
}

function authoritySummary(proof = {}) {
  const a = proof.authority || {}
  return {
    policyAuthorized: a.policyAuthorized === true,
    actual: a.actual === 'GRANTED' ? 'GRANTED' : 'NOT_GRANTED',
    canActAutomatically: a.canActAutomatically === true,
    requiresApproval: a.requiresApproval !== false,
    basis: a.basis ?? null,
    // Display-only. Never interpreted as execution permission.
    executionBoundary: FOUNDER_ACTION_BOUNDARY,
  }
}

function canonicalSummary(proof = {}) {
  const c = proof.canonicalFacts || {}
  return {
    invoiceId: c.invoiceId ?? null,
    clientId: c.clientId ?? null,
    amount: Number.isFinite(Number(c.amount)) ? Number(c.amount) : null,
    amountPaid: Number.isFinite(Number(c.amountPaid)) ? Number(c.amountPaid) : null,
    balance: Number.isFinite(Number(c.balance)) ? Number(c.balance) : null,
    dueDate: c.dueDate ?? null,
    daysOverdue: Number.isFinite(Number(c.daysOverdue)) ? Number(c.daysOverdue) : null,
    canonicalStatus: c.canonicalStatus ?? null,
    paid: c.paid === true,
    settled: c.settled === true,
    lastReminderAt: asIso(c.lastReminderAt),
  }
}

function buildWhy(proof = {}) {
  const items = []
  const c = proof.canonicalFacts || {}
  if (c.canonicalStatus) items.push({ type: 'canonical', text: `Invoice is canonically ${String(c.canonicalStatus).toLowerCase()}.` })
  if (Number.isFinite(Number(c.daysOverdue)) && Number(c.daysOverdue) > 0) items.push({ type: 'canonical', text: `${Number(c.daysOverdue)} days overdue.` })

  const roots = safeArray(proof.evidence?.independentStrongRoots)
  if (roots.length) items.push({ type: 'evidence', text: `${roots.length} independent strong evidence root${roots.length === 1 ? '' : 's'} support this review.` })

  const interpretations = safeArray(proof.interpretations)
  if (interpretations.length) items.push({ type: 'interpretation', text: `${interpretations.length} interpretation${interpretations.length === 1 ? '' : 's'} kept separate from canonical money truth.` })

  const applicable = safeArray(proof.precedent?.applicable)
  if (applicable.length) items.push({ type: 'precedent', text: `${applicable.length} applicable precedent${applicable.length === 1 ? '' : 's'} considered.` })

  if (proof.uncertainty?.actionable === false) items.push({ type: 'uncertainty', text: 'Prediction uncertainty is too high for automatic use.' })
  if (proof.founderQuestion?.asked === true) items.push({ type: 'question', text: 'A founder answer has enough decision value to justify interruption.' })
  if (proof.verifier?.passed === false) items.push({ type: 'verification', text: 'Deterministic verification did not clear execution.' })
  return items
}

function buildTimeline(proofEvent) {
  const proof = proofEvent.proof || {}
  const at = asIso(proofEvent.created_at || proofEvent.occurred_at || proofEvent.timestamp)
  const timeline = []
  const push = (kind, label, detail, status = 'complete') => timeline.push({ kind, label, detail, status, at, timestampKind: 'proof_event_time' })

  const c = proof.canonicalFacts || {}
  push('canonical', 'Canonical invoice checked', c.canonicalStatus ? `Invoice status: ${c.canonicalStatus}` : 'Canonical invoice state inspected')

  const e = evidenceSummary(proof)
  push('evidence', 'Evidence reviewed', `${e.admitted} admitted · ${e.contextOnly} context-only · ${e.quarantined + e.rejected} excluded/quarantined`)

  if (safeArray(proof.memory?.active).length || safeArray(proof.memory?.blocked).length) {
    push('memory', 'Memory checked', `${safeArray(proof.memory?.active).length} active · ${safeArray(proof.memory?.blocked).length} blocked`)
  }

  if (safeArray(proof.precedent?.checked).length) {
    push('precedent', 'Precedent checked', `${safeArray(proof.precedent?.applicable).length} applicable of ${safeArray(proof.precedent?.checked).length} checked`)
  }

  if (proof.pooling) push('learning', 'Payment-pattern evidence evaluated', proof.pooling.strongLocalSupport ? 'Client-local support is strong enough to dominate the prior.' : 'Client-local evidence remains partially pooled.')
  if (proof.uncertainty) push('uncertainty', 'Uncertainty evaluated', proof.uncertainty.actionable ? 'Prediction cleared the configured uncertainty rules.' : `Prediction withheld: ${safeArray(proof.uncertainty.reasons).join(', ') || 'not actionable'}`)

  push('authority', 'Authority checked', proof.authority?.actual === 'GRANTED' ? 'Explicit authority is present for this proof path.' : 'No execution authority is granted by this read model.')
  push('verification', 'Deterministic verification', proof.verifier?.passed === true ? 'Verification passed.' : 'Verification blocked execution.')

  if (proof.stagedAction) push('action', 'Next action evaluated', `${proof.stagedAction.action || 'Action'} · ${proof.stagedAction.status || 'unknown status'}`)
  if (proof.execution?.outcome) push('execution', 'Execution result', `${proof.execution.outcome} · real side effect: ${proof.execution.sideEffect === true ? 'yes' : 'no'}`)

  return timeline
}

export function projectCaseReadModel({ userId, invoice, client, run, proofEvent } = {}) {
  const invoiceId = invoice?.id ?? proofEvent?.invoice_id ?? null
  const clientId = client?.id ?? invoice?.client_id ?? proofEvent?.client_id ?? null
  if (!userId || !invoiceId || !validTenantScope({ userId, invoiceId, clientId, invoice, client, run, proofEvent })) {
    return freezeDeep({
      available: false,
      state: DW_UI_STATE.BLOCKED,
      workPhase: DW_WORK_PHASE.BLOCKED,
      blockedReason: 'READ_MODEL_SCOPE_MISMATCH',
      founderAction: null,
    })
  }

  const proof = proofEvent.proof || {}
  const hardViolations = safeArray(run?.summary?.hard_violations)
  const sandboxIntegrityOk =
    run?.production_execution_authorized !== true &&
    (run?.transport == null || ['sandbox', 'stub', 'none'].includes(run.transport)) &&
    proofEvent.real_side_effect !== true &&
    proof.execution?.sideEffect !== true &&
    hardViolations.length === 0
  const knownState = KNOWN_STATES.has(proofEvent.operational_state)
  const state = knownState && sandboxIntegrityOk ? proofEvent.operational_state : DW_UI_STATE.BLOCKED
  const staged = proof.stagedAction || null
  const needsFounder = sandboxIntegrityOk && (
    state === DW_UI_STATE.APPROVAL ||
    (state === DW_UI_STATE.UNCERTAIN && proof.founderQuestion?.asked === true)
  )
  const founderAction = needsFounder ? {
    kind: state === DW_UI_STATE.APPROVAL ? 'APPROVAL_REQUIRED' : 'ANSWER_REQUIRED',
    label: state === DW_UI_STATE.APPROVAL ? 'Review decision' : 'Answer DW',
    // Critical: UI may request a backend decision; it does not possess one.
    boundary: FOUNDER_ACTION_BOUNDARY,
    directlyExecutable: false,
    stagedAction: staged ? {
      action: staged.action ?? null,
      tone: staged.tone ?? null,
      ruleId: staged.ruleId ?? null,
      status: staged.status ?? null,
    } : null,
    question: proof.founderQuestion?.asked === true ? proof.founderQuestion.question ?? null : null,
  } : null

  const model = {
    available: true,
    runId: run?.id ?? proofEvent.run_id ?? null,
    invoiceId,
    clientId,
    state,
    stateMessage: stateMessage(state),
    workPhase: state === DW_UI_STATE.BLOCKED && !sandboxIntegrityOk ? DW_WORK_PHASE.BLOCKED : deriveWorkPhase({ run, proofEvent }),
    nextWorkPhase: deriveNextWorkPhase({ proofEvent }),
    live: sandboxIntegrityOk && run?.status === 'running',
    lastUpdatedAt: asIso(proofEvent.created_at || run?.completed_at || run?.started_at),
    canonical: canonicalSummary(proof),
    evidence: evidenceSummary(proof),
    authority: authoritySummary(proof),
    recommendation: proof.policy ? {
      action: proof.policy.action ?? null,
      tone: proof.policy.tone ?? null,
      ruleId: proof.policy.ruleId ?? null,
      ruleName: proof.policy.ruleName ?? null,
    } : null,
    stagedAction: staged ? {
      action: staged.action ?? null,
      tone: staged.tone ?? null,
      ruleId: staged.ruleId ?? null,
      status: staged.status ?? null,
    } : null,
    execution: {
      mode: proof.execution?.mode ?? 'none',
      outcome: proof.execution?.outcome ?? null,
      realSideEffect: proof.execution?.sideEffect === true,
    },
    uncertainty: proof.uncertainty ?? null,
    identificationStatus: proof.identificationStatus ?? null,
    why: buildWhy(proof),
    timeline: buildTimeline(proofEvent),
    founderAction,
    needsFounder,
    proofIntegrity: {
      hardViolations,
      sandboxIntegrityOk,
      scopeConsistent: true,
      knownOperationalState: knownState,
      verifierPassed: proof.verifier?.passed === true,
      canonicalTruthReadOnly: true,
      displayGrantsAuthority: false,
      directExecutionAvailable: false,
    },
  }
  return freezeDeep(model)
}

export function projectLivePresenceReadModel({ userId, runs = [] } = {}) {
  const entries = safeArray(runs)
    .filter((run) =>
      run?.user_id === userId &&
      run.status === 'running' &&
      run.production_execution_authorized !== true &&
      ['sandbox', 'stub', 'none'].includes(run.transport) &&
      typeof run.invoice_id === 'string' && run.invoice_id !== '' &&
      typeof run.client_id === 'string' && run.client_id !== ''
    )
    .map((run) => ({
      runId: run.id ?? null,
      invoiceId: run.invoice_id,
      clientId: run.client_id,
      workflow: run.workflow ?? null,
      workPhase: DW_WORK_PHASE.ANALYZING,
      startedAt: asIso(run.started_at),
      transport: run.transport,
      productionExecutionAuthorized: false,
      detail: 'DW has a real persisted run in progress. Detailed step state is not claimed until explicitly persisted.',
    }))
    .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')))
  return freezeDeep({
    userId: userId ?? null,
    live: entries.length > 0,
    count: entries.length,
    entries,
  })
}

export function projectPulseReadModel({ userId, cases = [], activeRuns = [] } = {}) {
  const projected = safeArray(cases).map((c) => projectCaseReadModel({ ...c, userId })).filter((c) => c.available)
  const count = (state) => projected.filter((c) => c.state === state).length
  const totalBalance = projected.reduce((sum, c) => sum + (Number(c.canonical?.balance) || 0), 0)
  const needsYou = projected.filter((c) => c.needsFounder)
  const active = projected.filter((c) => c.live)
  const caseRunIds = new Set(projected.map((c) => c.runId).filter(Boolean))
  const livePresence = projectLivePresenceReadModel({ userId, runs: activeRuns })
  const runOnlyLive = livePresence.entries.filter((r) => !caseRunIds.has(r.runId))
  const liveJobCount = active.length + runOnlyLive.length

  const summary = {
    userId: userId ?? null,
    totalCases: projected.length,
    cashUnderManagement: totalBalance,
    handled: count(DW_UI_STATE.HANDLED),
    ready: count(DW_UI_STATE.READY),
    approval: count(DW_UI_STATE.APPROVAL),
    watching: count(DW_UI_STATE.WATCH),
    investigating: count(DW_UI_STATE.INVESTIGATING),
    uncertain: count(DW_UI_STATE.UNCERTAIN),
    blocked: count(DW_UI_STATE.BLOCKED),
    needsYou: needsYou.length,
    liveJobs: liveJobCount,
    live: liveJobCount > 0,
    livePresence: {
      count: liveJobCount,
      caseBacked: active.map((c) => ({ runId: c.runId, invoiceId: c.invoiceId, clientId: c.clientId, workPhase: c.workPhase })),
      runOnly: runOnlyLive,
    },
    headline: projected.length === 0
      ? 'DW has no proven AR work to summarize.'
      : `DW has ${projected.length} ${projected.length === 1 ? 'case' : 'cases'} under management. ${needsYou.length} ${needsYou.length === 1 ? 'needs' : 'need'} your judgment.`,
    cases: projected,
    needsYouCases: needsYou,
  }
  return freezeDeep(summary)
}

export function projectActivityReadModel({ userId, cases = [] } = {}) {
  const projected = safeArray(cases).map((c) => projectCaseReadModel({ ...c, userId })).filter((c) => c.available)
  const entries = projected.map((c) => ({
    runId: c.runId,
    invoiceId: c.invoiceId,
    clientId: c.clientId,
    at: c.lastUpdatedAt,
    state: c.state,
    workPhase: c.workPhase,
    title: c.state === DW_UI_STATE.HANDLED ? 'DW handled an invoice workflow' : `DW ${c.state.toLowerCase()} an invoice workflow`,
    detail: c.stateMessage,
    authority: c.authority.actual,
    executionOutcome: c.execution.outcome,
    realSideEffect: c.execution.realSideEffect,
    proofAvailable: true,
  })).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
  return freezeDeep({ userId: userId ?? null, entries })
}

export function projectNeedsYouReadModel({ userId, cases = [] } = {}) {
  const projected = safeArray(cases).map((c) => projectCaseReadModel({ ...c, userId })).filter((c) => c.available && c.needsFounder)
  return freezeDeep({
    userId: userId ?? null,
    count: projected.length,
    items: projected.map((c) => ({
      runId: c.runId,
      invoiceId: c.invoiceId,
      clientId: c.clientId,
      state: c.state,
      balance: c.canonical.balance,
      daysOverdue: c.canonical.daysOverdue,
      recommendation: c.recommendation,
      why: c.why,
      founderAction: c.founderAction,
      authority: c.authority,
    })),
  })
}
