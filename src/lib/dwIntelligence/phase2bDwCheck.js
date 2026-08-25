import { FOUNDER_ACTION_BOUNDARY } from './phase2bReadModel.js'

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) freezeDeep(item)
  return value
}
function safeArray(v) { return Array.isArray(v) ? v : [] }

/**
 * Compare an explicit run plan/manifest against observed proof checkpoints.
 * "0 silently skipped" is emitted only when a concrete expected manifest was
 * supplied and every required checkpoint has observable evidence.
 */
export function projectDwCheck({ runId, expected = [], observed = [], proof = null } = {}) {
  const expectedRows = safeArray(expected).map((x, i) => ({
    id: x?.id ?? `expected-${i}`,
    label: x?.label ?? x?.id ?? `Step ${i+1}`,
    required: x?.required !== false,
  }))
  const observedIds = new Set(safeArray(observed).map(x => typeof x === 'string' ? x : x?.id).filter(Boolean))
  const checks = expectedRows.map(step => ({ ...step, observed: observedIds.has(step.id) }))
  const missingRequired = checks.filter(x => x.required && !x.observed)
  const manifestProvided = expectedRows.length > 0
  const proofHardViolations = safeArray(proof?.hard_violations ?? proof?.hardViolations)
  const realSideEffect = proof?.real_side_effect === true || proof?.realSideEffect === true

  return freezeDeep({
    runId: runId ?? null,
    manifestProvided,
    checks,
    expectedRequired: checks.filter(x => x.required).length,
    observedRequired: checks.filter(x => x.required && x.observed).length,
    silentlySkipped: manifestProvided ? missingRequired.length : null,
    canClaimZeroSilentlySkipped: manifestProvided && missingRequired.length === 0,
    missingRequired,
    proofAvailable: Boolean(proof),
    hardViolations: proofHardViolations,
    realSideEffect,
    healthy: manifestProvided && missingRequired.length === 0 && proofHardViolations.length === 0,
    executionAvailable: false,
    browserMayGrantAuthority: false,
    boundary: FOUNDER_ACTION_BOUNDARY,
  })
}

export function phase2bRequiredManifest() {
  return freezeDeep([
    { id: 'canonical', label: 'Canonical invoice checked', required: true },
    { id: 'evidence', label: 'Evidence admission evaluated', required: true },
    { id: 'authority', label: 'Authority checked', required: true },
    { id: 'verification', label: 'Deterministic verification recorded', required: true },
    { id: 'proof', label: 'Proof event persisted', required: true },
  ])
}
