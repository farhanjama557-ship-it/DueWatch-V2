import { DW_WORK_PHASE, FOUNDER_ACTION_BOUNDARY } from './phase2bReadModel.js'

export const DW_LIVE_EVENT = Object.freeze({
  ANALYZING: 'ANALYZING',
  VERIFYING: 'VERIFYING',
  PREPARING: 'PREPARING',
  WAITING: 'WAITING',
  HANDLED: 'HANDLED',
  BLOCKED: 'BLOCKED',
})

const PHASE_BY_EVENT = Object.freeze({
  [DW_LIVE_EVENT.ANALYZING]: DW_WORK_PHASE.ANALYZING,
  [DW_LIVE_EVENT.VERIFYING]: DW_WORK_PHASE.VERIFYING,
  [DW_LIVE_EVENT.PREPARING]: DW_WORK_PHASE.PREPARING,
  [DW_LIVE_EVENT.WAITING]: DW_WORK_PHASE.WAITING,
  [DW_LIVE_EVENT.HANDLED]: DW_WORK_PHASE.HANDLED,
  [DW_LIVE_EVENT.BLOCKED]: DW_WORK_PHASE.BLOCKED,
})

const TERMINAL = new Set([DW_LIVE_EVENT.HANDLED, DW_LIVE_EVENT.BLOCKED])
const ALLOWED = Object.freeze({
  [DW_LIVE_EVENT.ANALYZING]: new Set([DW_LIVE_EVENT.VERIFYING, DW_LIVE_EVENT.PREPARING, DW_LIVE_EVENT.WAITING, DW_LIVE_EVENT.BLOCKED]),
  [DW_LIVE_EVENT.VERIFYING]: new Set([DW_LIVE_EVENT.PREPARING, DW_LIVE_EVENT.WAITING, DW_LIVE_EVENT.BLOCKED]),
  [DW_LIVE_EVENT.PREPARING]: new Set([DW_LIVE_EVENT.WAITING, DW_LIVE_EVENT.HANDLED, DW_LIVE_EVENT.BLOCKED]),
  [DW_LIVE_EVENT.WAITING]: new Set([DW_LIVE_EVENT.ANALYZING, DW_LIVE_EVENT.VERIFYING, DW_LIVE_EVENT.PREPARING, DW_LIVE_EVENT.HANDLED, DW_LIVE_EVENT.BLOCKED]),
  [DW_LIVE_EVENT.HANDLED]: new Set(),
  [DW_LIVE_EVENT.BLOCKED]: new Set(),
})

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) freezeDeep(item)
  return value
}
function iso(value) {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
function safeArray(v) { return Array.isArray(v) ? v : [] }

export function validateLiveTransition(previous, next) {
  if (!Object.values(DW_LIVE_EVENT).includes(next)) return { ok: false, reason: 'UNKNOWN_EVENT' }
  if (!previous) return { ok: next === DW_LIVE_EVENT.ANALYZING, reason: next === DW_LIVE_EVENT.ANALYZING ? null : 'RUN_MUST_START_ANALYZING' }
  if (previous === next) return { ok: false, reason: 'DUPLICATE_TRANSITION' }
  if (TERMINAL.has(previous)) return { ok: false, reason: 'TERMINAL_RUN_CANNOT_TRANSITION' }
  return { ok: ALLOWED[previous]?.has(next) === true, reason: ALLOWED[previous]?.has(next) ? null : 'ILLEGAL_TRANSITION' }
}

export function projectLiveFeedReadModel({ userId, transitions = [], invoicesById = {}, clientsById = {}, now = null, freshnessMs = null } = {}) {
  const accepted = []
  const rejected = []
  const lastByRun = new Map()

  for (const raw of safeArray(transitions).slice().sort((a,b) => String(a.occurred_at || '').localeCompare(String(b.occurred_at || '')))) {
    if (!raw || raw.user_id !== userId || !raw.run_id || !raw.invoice_id) {
      rejected.push({ id: raw?.id ?? null, reason: 'SCOPE_OR_IDENTITY_MISMATCH' })
      continue
    }
    const at = iso(raw.occurred_at)
    if (!at) { rejected.push({ id: raw.id ?? null, reason: 'INVALID_TIME' }); continue }
    const prior = lastByRun.get(raw.run_id)
    const check = validateLiveTransition(prior?.event_type ?? null, raw.event_type)
    if (!check.ok) { rejected.push({ id: raw.id ?? null, reason: check.reason }); continue }

    const invoice = invoicesById[raw.invoice_id]
    if (invoice?.user_id != null && invoice.user_id !== userId) {
      rejected.push({ id: raw.id ?? null, reason: 'INVOICE_TENANT_MISMATCH' }); continue
    }
    const clientId = raw.client_id ?? invoice?.client_id ?? null
    const client = clientId ? clientsById[clientId] : null
    if (client?.user_id != null && client.user_id !== userId) {
      rejected.push({ id: raw.id ?? null, reason: 'CLIENT_TENANT_MISMATCH' }); continue
    }

    const item = freezeDeep({
      id: raw.id ?? `${raw.run_id}:${at}:${raw.event_type}`,
      runId: raw.run_id,
      invoiceId: raw.invoice_id,
      clientId,
      eventType: raw.event_type,
      workPhase: PHASE_BY_EVENT[raw.event_type],
      at,
      detail: raw.detail ?? null,
      page: raw.page ?? 'invoice',
      routeTarget: raw.route_target ?? (raw.invoice_id ? { kind: 'invoice', invoiceId: raw.invoice_id } : null),
      invoiceNumber: invoice?.inv_num ?? null,
      clientName: client?.name ?? null,
      realSideEffect: raw.real_side_effect === true,
      authorityGrantedByTransition: false,
      boundary: FOUNDER_ACTION_BOUNDARY,
    })
    accepted.push(item)
    lastByRun.set(raw.run_id, { ...item, event_type: raw.event_type })
  }

  const nonTerminal = [...lastByRun.values()].filter(x => !TERMINAL.has(x.eventType))
  // WAITING is an open run, but not proof that DW is actively doing work at
  // this instant. Keep it visible without pulsing LIVE.
  const waiting = nonTerminal.filter(x => x.eventType === DW_LIVE_EVENT.WAITING).map(x => ({ ...x, waiting: true }))
  const workCandidates = nonTerminal.filter(x => x.eventType !== DW_LIVE_EVENT.WAITING)
  const nowIso = iso(now)
  const cutoff = nowIso && Number.isFinite(Number(freshnessMs)) && Number(freshnessMs) > 0
    ? new Date(nowIso).getTime() - Number(freshnessMs)
    : null
  const active = []
  const staleActive = []
  for (const item of workCandidates) {
    if (cutoff != null && new Date(item.at).getTime() < cutoff) staleActive.push({ ...item, stale: true })
    else active.push({ ...item, stale: false })
  }
  active.sort((a,b) => String(b.at).localeCompare(String(a.at)))
  staleActive.sort((a,b) => String(b.at).localeCompare(String(a.at)))
  waiting.sort((a,b) => String(b.at).localeCompare(String(a.at)))
  const feed = accepted.slice().sort((a,b) => String(b.at).localeCompare(String(a.at)))

  return freezeDeep({
    live: active.length > 0,
    activeCount: active.length,
    active,
    waitingCount: waiting.length,
    waiting,
    staleActiveCount: staleActive.length,
    staleActive,
    freshnessApplied: cutoff != null,
    feed,
    rejected,
    executionAvailable: false,
    browserMayGrantAuthority: false,
    boundary: FOUNDER_ACTION_BOUNDARY,
  })
}

export function liveTransitionRow({ id, runId, userId, invoiceId, clientId = null, eventType, occurredAt, detail = null, page = 'invoice', routeTarget = null } = {}) {
  if (!runId || !userId || !invoiceId || !Object.values(DW_LIVE_EVENT).includes(eventType) || !iso(occurredAt)) throw new Error('INVALID_LIVE_TRANSITION')
  return freezeDeep({
    id: id ?? null,
    run_id: runId,
    user_id: userId,
    invoice_id: invoiceId,
    client_id: clientId,
    event_type: eventType,
    work_phase: PHASE_BY_EVENT[eventType],
    occurred_at: iso(occurredAt),
    detail,
    page,
    route_target: routeTarget,
    real_side_effect: false,
    production_execution_authorized: false,
  })
}
