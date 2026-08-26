import {
  projectCaseReadModel,
  DW_UI_STATE,
  FOUNDER_ACTION_BOUNDARY,
} from './phase2bReadModel.js'

const COMPLETE_RUN_STATES = new Set(['completed', 'failed'])

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) freezeDeep(item)
  return value
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function journalKind(state) {
  switch (state) {
    case DW_UI_STATE.HANDLED: return 'HANDLED'
    case DW_UI_STATE.READY: return 'PREPARED'
    case DW_UI_STATE.APPROVAL: return 'ESCALATED'
    case DW_UI_STATE.WATCH: return 'WATCHED'
    case DW_UI_STATE.INVESTIGATING: return 'INVESTIGATED'
    case DW_UI_STATE.UNCERTAIN: return 'ESCALATED'
    case DW_UI_STATE.BLOCKED: return 'WITHHELD'
    default: return 'WITHHELD'
  }
}

function journalTitle(model) {
  switch (model.state) {
    case DW_UI_STATE.HANDLED: return 'DW completed a sandbox workflow'
    case DW_UI_STATE.READY: return 'DW prepared a verified next step'
    case DW_UI_STATE.APPROVAL: return 'DW escalated a decision'
    case DW_UI_STATE.WATCH: return 'DW kept the case under watch'
    case DW_UI_STATE.INVESTIGATING: return 'DW found something to verify'
    case DW_UI_STATE.UNCERTAIN: return 'DW escalated uncertainty'
    case DW_UI_STATE.BLOCKED: return 'DW withheld execution'
    default: return 'DW withheld execution'
  }
}

/**
 * Founder-readable completed-work journal.
 *
 * Only completed/failed runs belong in What's Done. Running work remains a
 * LIVE concern and is deliberately excluded here so the UI never represents
 * in-progress work as completed work.
 */
export function projectWhatsDoneReadModel({ userId, cases = [] } = {}) {
  const entries = []

  for (const input of safeArray(cases)) {
    if (!COMPLETE_RUN_STATES.has(input?.run?.status)) continue
    const model = projectCaseReadModel({ ...input, userId })
    if (!model.available) continue

    entries.push({
      runId: model.runId,
      invoiceId: model.invoiceId,
      clientId: model.clientId,
      at: model.lastUpdatedAt,
      kind: journalKind(model.state),
      state: model.state,
      title: journalTitle(model),
      detail: model.stateMessage,
      workPhase: model.workPhase,
      nextWorkPhase: model.nextWorkPhase,
      recommendation: model.recommendation,
      stagedAction: model.stagedAction,
      authority: model.authority,
      execution: model.execution,
      evidence: {
        admitted: model.evidence.admitted,
        excluded: Number(model.evidence.rejected || 0) + Number(model.evidence.quarantined || 0),
        independentStrongRoots: model.evidence.independentStrongRoots,
      },
      why: model.why,
      proofIntegrity: model.proofIntegrity,
      proofAvailable: true,
      realSideEffect: model.execution.realSideEffect === true,
    })
  }

  entries.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))

  const countKind = (kind) => entries.filter((entry) => entry.kind === kind).length
  const hardViolationCount = entries.reduce(
    (sum, entry) => sum + safeArray(entry.proofIntegrity?.hardViolations).length,
    0
  )
  const realSideEffectCount = entries.filter((entry) => entry.realSideEffect).length

  return freezeDeep({
    userId: userId ?? null,
    total: entries.length,
    summary: {
      handled: countKind('HANDLED'),
      prepared: countKind('PREPARED'),
      investigated: countKind('INVESTIGATED'),
      watched: countKind('WATCHED'),
      escalated: countKind('ESCALATED'),
      withheld: countKind('WITHHELD'),
      hardViolations: hardViolationCount,
      realSideEffects: realSideEffectCount,
      allProofAvailable: entries.every((entry) => entry.proofAvailable === true),
    },
    entries,
  })
}

/**
 * A founder command queue is not an execution queue.
 *
 * Every item here is review-only. Selecting it may open the case or request a
 * future server decision, but the browser receives no permission token and no
 * direct execution capability.
 */
export function projectNeedsYouCommandReadModel({ userId, cases = [] } = {}) {
  const items = []

  for (const input of safeArray(cases)) {
    const model = projectCaseReadModel({ ...input, userId })
    if (!model.available || model.needsFounder !== true) continue

    const commandType = model.state === DW_UI_STATE.APPROVAL ? 'APPROVAL_REVIEW' : 'FOUNDER_ANSWER'
    items.push({
      runId: model.runId,
      invoiceId: model.invoiceId,
      clientId: model.clientId,
      at: model.lastUpdatedAt,
      state: model.state,
      stateMessage: model.stateMessage,
      commandType,
      balance: model.canonical.balance,
      daysOverdue: model.canonical.daysOverdue,
      recommendation: model.recommendation,
      stagedAction: model.stagedAction,
      why: model.why,
      evidence: {
        admitted: model.evidence.admitted,
        independentStrongRoots: model.evidence.independentStrongRoots,
      },
      authority: model.authority,
      founderAction: model.founderAction,
      cta: 'Review case',
      boundary: FOUNDER_ACTION_BOUNDARY,
      directlyExecutable: false,
      browserMayGrantAuthority: false,
    })
  }

  // Recency is a display order, not a financial-priority policy.
  items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))

  return freezeDeep({
    userId: userId ?? null,
    count: items.length,
    items,
    executionAvailable: false,
    authorityCanBeGrantedHere: false,
    boundary: FOUNDER_ACTION_BOUNDARY,
  })
}
