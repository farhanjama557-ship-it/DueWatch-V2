import { FOUNDER_ACTION_BOUNDARY } from './phase2bReadModel.js'

const TERMINAL = new Set(['HANDLED', 'BLOCKED'])

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) freezeDeep(item)
  return value
}
function safeArray(v) { return Array.isArray(v) ? v : [] }

/**
 * Replay Shift is a read-only projection over the exact transition history
 * accepted by the LIVE read model. It never re-infers hidden work.
 */
export function projectReplayShift({ liveFeedModel, proofByRunId = {} } = {}) {
  const feed = safeArray(liveFeedModel?.feed)
  const byRun = new Map()
  for (const event of feed.slice().sort((a,b) => String(a.at).localeCompare(String(b.at)))) {
    if (!byRun.has(event.runId)) byRun.set(event.runId, [])
    byRun.get(event.runId).push(event)
  }

  const runs = []
  for (const [runId, events] of byRun.entries()) {
    const first = events[0]
    const last = events[events.length - 1]
    const proof = proofByRunId[runId] ?? null
    const completed = TERMINAL.has(last?.eventType)
    const timeline = events.map((e, index) => ({
      sequence: index + 1,
      at: e.at,
      eventType: e.eventType,
      workPhase: e.workPhase,
      detail: e.detail,
      invoiceId: e.invoiceId,
      clientId: e.clientId,
      routeTarget: e.routeTarget,
      realSideEffect: e.realSideEffect === true,
    }))
    runs.push({
      runId,
      invoiceId: first?.invoiceId ?? null,
      clientId: first?.clientId ?? null,
      startedAt: first?.at ?? null,
      endedAt: completed ? last?.at ?? null : null,
      completed,
      terminalEvent: completed ? last.eventType : null,
      timeline,
      proofAvailable: Boolean(proof),
      proofSummary: proof ? {
        operationalState: proof.operational_state ?? proof.operationalState ?? null,
        realSideEffect: proof.real_side_effect === true || proof.realSideEffect === true,
        hardViolations: safeArray(proof.hard_violations ?? proof.hardViolations),
      } : null,
      reconstructionSource: 'persisted_transition_history',
      inferredHiddenSteps: 0,
    })
  }

  runs.sort((a,b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
  return freezeDeep({
    runCount: runs.length,
    completedRuns: runs.filter(r => r.completed).length,
    openRuns: runs.filter(r => !r.completed).length,
    runs,
    rewritable: false,
    executionAvailable: false,
    browserMayGrantAuthority: false,
    boundary: FOUNDER_ACTION_BOUNDARY,
  })
}
