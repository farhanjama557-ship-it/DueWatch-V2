/**
 * Pure presentation helpers for Phase 2B DW Intelligence UI.
 *
 * Input is already-scoped, read-only data from phase2bReadModel.js. These
 * helpers do not fetch, persist, grant authority, or execute anything.
 */

export function formatDwMoney(value, currency = 'USD') {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount)
}

export function presentDwLive(model) {
  if (!model) return null
  // Increment 8: when the persisted-transition Live Feed is present, it is
  // the authoritative UI source for whether the LIVE dot may pulse. The
  // older pulse aggregate remains only a compatibility fallback.
  const transitionModel = model.liveFeed
  const activeCount = transitionModel
    ? Number(transitionModel.activeCount || 0)
    : Number(model.liveJobs || 0)
  const active = transitionModel
    ? transitionModel.live === true && activeCount > 0
    : model.live === true && activeCount > 0
  if (active) {
    return {
      active: true,
      label: 'LIVE',
      detail: `${activeCount} ${activeCount === 1 ? 'job' : 'jobs'} active`,
      ariaLabel: `DW Live, ${activeCount} ${activeCount === 1 ? 'job' : 'jobs'} active`,
    }
  }
  const staleCount = Number(transitionModel?.staleActiveCount || 0)
  const waitingCount = Number(transitionModel?.waitingCount || 0)
  const label = staleCount > 0 ? 'CHECKING' : waitingCount > 0 ? 'WATCHING' : 'CAUGHT UP'
  const detail = staleCount > 0
    ? `${staleCount} ${staleCount === 1 ? 'run has' : 'runs have'} stale activity; LIVE is not asserted`
    : waitingCount > 0
      ? `${waitingCount} ${waitingCount === 1 ? 'run is' : 'runs are'} waiting; LIVE is not asserted`
      : 'No proven DW job is running right now'
  return {
    active: false,
    label,
    detail,
    ariaLabel: staleCount > 0
      ? `DW has ${staleCount} stale ${staleCount === 1 ? 'run' : 'runs'}; Live is not asserted`
      : waitingCount > 0
        ? `DW has ${waitingCount} waiting ${waitingCount === 1 ? 'run' : 'runs'}; Live is not asserted`
        : 'DW caught up, no proven DW job is running right now',
  }
}

export function presentPulseCommand(model) {
  if (!model) return null
  const working = Number(model.investigating || 0) + Number(model.ready || 0)
  return {
    headline: model.headline || 'DW has no proven AR work to summarize.',
    live: presentDwLive(model),
    metrics: [
      { key: 'cash', label: 'Under management', value: formatDwMoney(model.cashUnderManagement) },
      { key: 'handled', label: 'Handled', value: String(model.handled || 0) },
      { key: 'working', label: 'Working', value: String(working) },
      { key: 'needs-you', label: 'Needs you', value: String(model.needsYou || 0), attention: Number(model.needsYou || 0) > 0 },
    ],
  }
}

export function presentCaseState(model) {
  if (!model?.available) return null
  const state = String(model.state || 'BLOCKED')
  const stateLabels = {
    HANDLED: 'Handled',
    READY: 'Ready',
    APPROVAL: 'Needs you',
    WATCH: 'Watching',
    INVESTIGATING: 'Investigating',
    UNCERTAIN: 'Uncertain',
    BLOCKED: 'Blocked',
  }
  return {
    label: stateLabels[state] || 'Blocked',
    state,
    live: model.live === true,
    workPhase: model.workPhase || null,
    message: model.stateMessage || 'DW state is unavailable.',
    authorityLabel:
      model.authority?.actual === 'GRANTED'
        ? 'Explicit authority present'
        : model.needsFounder
          ? 'Founder judgment required'
          : 'No execution authority granted',
    evidenceLabel: `${Number(model.evidence?.admitted || 0)} admitted · ${Number(model.evidence?.rejected || 0) + Number(model.evidence?.quarantined || 0)} excluded`,
    proofMode: model.execution?.realSideEffect === false ? 'Proof mode · no real side effect' : null,
  }
}

export function resolveDwInvoice(invoices, invoiceId) {
  return Array.isArray(invoices) ? invoices.find((invoice) => invoice?.id === invoiceId) ?? null : null
}
