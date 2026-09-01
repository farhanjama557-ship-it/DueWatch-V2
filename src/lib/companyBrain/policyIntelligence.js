/**
 * G3 Conflict & Policy Intelligence runtime.
 *
 * A pure reasoning layer over G2 (CompanyBrainDurableStore + CompanyGraphStore).
 * No storage writes, no financial mutations, no provider calls.
 *
 * Core guarantees (R0–R9 invariants enforced structurally):
 *   R0  canonicalMoneyWritable: false on every output
 *   R1  confidence never resolves conflict; classified as CONFIDENCE_DISAGREEMENT
 *   R2  repeated behaviour does not create standing policy
 *   R3  repeated approvals do not create authority
 *   R4  CLIENT-scoped rules never widen to COMPANY scope
 *   R5  HISTORICAL/FUTURE/EXPIRED candidates excluded from active resolution
 *   R6  Revoked / dangling evidence excluded
 *   R7  Observed delegation is not DW authority
 *   R8  Missing precedence → ABSTAIN or CONFLICTED, never fabricated resolution
 *   R9  canActAutomatically: false always; founder decisions must be explicit
 */

import { GRAPH_EDGE_TYPE, GRAPH_NODE_TYPE, RESOLUTION_STATE, SEMANTIC_SCOPE } from './graphStore.js'
import { CLAIM_CLASS } from './index.js'

// ── Enums ─────────────────────────────────────────────────────────────────────

export const TEMPORAL_STATE = Object.freeze({
  CURRENT: 'CURRENT',
  FUTURE: 'FUTURE',
  HISTORICAL: 'HISTORICAL',
  EXPIRED: 'EXPIRED',
  UNKNOWN: 'UNKNOWN',
})

export const CONFLICT_CLASS = Object.freeze({
  SAME_SCOPE_INCOMPATIBLE_VALUES: 'SAME_SCOPE_INCOMPATIBLE_VALUES',
  COMPANY_VS_CLIENT_EXCEPTION: 'COMPANY_VS_CLIENT_EXCEPTION',
  CONTRACT_VS_COMPANY_POLICY: 'CONTRACT_VS_COMPANY_POLICY',
  FOUNDER_INSTRUCTION_VS_PRIOR_POLICY: 'FOUNDER_INSTRUCTION_VS_PRIOR_POLICY',
  CURRENT_VS_HISTORICAL: 'CURRENT_VS_HISTORICAL',
  OVERLAPPING_EFFECTIVE_PERIODS: 'OVERLAPPING_EFFECTIVE_PERIODS',
  AMBIGUOUS_ENTITY_IDENTITY: 'AMBIGUOUS_ENTITY_IDENTITY',
  MISSING_PRECEDENCE: 'MISSING_PRECEDENCE',
  SCOPE_ESCALATION: 'SCOPE_ESCALATION',
  CONFIDENCE_DISAGREEMENT: 'CONFIDENCE_DISAGREEMENT',
  DANGLING_PROVENANCE: 'DANGLING_PROVENANCE',
  DUPLICATE_EVIDENCE: 'DUPLICATE_EVIDENCE',
})

export const CANDIDATE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUPERSEDED: 'SUPERSEDED',
  REVOKED: 'REVOKED',
  HISTORICAL: 'HISTORICAL',
  DANGLING: 'DANGLING',
})

export const G3_RESOLUTION_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  CONFLICTED: 'CONFLICTED',
  ABSTAIN: 'ABSTAIN',
  NO_POLICY: 'NO_POLICY',
})

// Conflict classes that block resolution but can be addressed by an explicit founder decision
const POLICY_RESOLVABLE_CONFLICT_CLASSES = new Set([
  CONFLICT_CLASS.FOUNDER_INSTRUCTION_VS_PRIOR_POLICY,
  CONFLICT_CLASS.OVERLAPPING_EFFECTIVE_PERIODS,
  CONFLICT_CLASS.MISSING_PRECEDENCE,
  CONFLICT_CLASS.SAME_SCOPE_INCOMPATIBLE_VALUES,
  CONFLICT_CLASS.COMPANY_VS_CLIENT_EXCEPTION,
  CONFLICT_CLASS.CONFIDENCE_DISAGREEMENT,
  CONFLICT_CLASS.CONTRACT_VS_COMPANY_POLICY,
  CONFLICT_CLASS.DUPLICATE_EVIDENCE,
])

// Non-blocking conflict classes — detected for audit, never prevent resolution
const NON_BLOCKING_CONFLICT_CLASSES = new Set([
  CONFLICT_CLASS.DANGLING_PROVENANCE,
  CONFLICT_CLASS.CURRENT_VS_HISTORICAL, // historical candidates excluded from active resolution (R5)
])

// ── Internal helpers ──────────────────────────────────────────────────────────

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Canonical validator for a single founder decision, shared by applyFounderDecisions,
 * askDwPolicy, and buildG3DwIntelligenceContext.
 *
 * Validates:
 *   - tenant match
 *   - topic match (null = any topic)
 *   - decision status === 'RECORDED'
 *   - all evidenceClaimIds still active in brain (R6)
 *   - scope match when scope is provided:
 *       COMPANY request → rejects CLIENT-scoped decisions
 *       CLIENT request  → rejects non-CLIENT decisions and wrong clientId
 *   - null scope → tenant/topic/evidence only (no scope filtering)
 *
 * @param {object} d - raw brain.decisions entry
 * @param {{ brain, tenantId, topic?: string|null, scope?: object|null }} opts
 * @returns {boolean}
 */
/**
 * Full 3-phase founder decision evaluation.
 *
 * Phase 1 — structural validity:
 *   tenantId match, topic match (if provided), status === 'RECORDED',
 *   all evidenceClaimIds still active in brain (R6)
 * Phase 2 — scope validation:
 *   decision scope matches the requested scope (R4)
 * Phase 3 — winner-candidate validation (only when candidates !== null):
 *   a non-null governingClaimId must map to an ACTIVE candidate in the provided list;
 *   if it maps to nothing (non-existent or inactive) → invalid.
 *   A null governingClaimId is invalid when Phase 3 runs because it cannot
 *   identify an active governing candidate.
 *
 * @param {object} d - raw brain.decisions entry
 * @param {{ brain, tenantId, topic?, scope?, candidates? }} opts
 *   candidates: null → skip Phase 3 (structural/scope check only)
 *               array (even empty) → Phase 3 runs
 * @returns {{ valid: boolean, winner: PolicyCandidate|null, reason: string }}
 */
function evaluateFounderDecision(d, { brain, tenantId, topic = null, scope = null, candidates = null }) {
  // Phase 1: structural validity
  if (d.tenantId !== tenantId) return { valid: false, winner: null, reason: 'tenantId mismatch' }
  if (topic !== null && d.target !== topic) return { valid: false, winner: null, reason: 'topic mismatch' }
  if (d.status !== 'RECORDED') return { valid: false, winner: null, reason: 'status not RECORDED' }
  if (!(d.evidenceClaimIds ?? []).every((cid) =>
    brain.claims.some((c) => c.id === cid && c.active && c.tenantId === tenantId),
  )) return { valid: false, winner: null, reason: 'evidence claim revoked (R6)' }

  // Phase 2: scope validation
  if (scope !== null) {
    const decisionScope = d.scope ?? { level: SEMANTIC_SCOPE.COMPANY }
    if (scope.level === SEMANTIC_SCOPE.CLIENT) {
      if (decisionScope.level !== SEMANTIC_SCOPE.CLIENT)
        return { valid: false, winner: null, reason: 'decision not CLIENT-scoped for CLIENT request' }
      if (decisionScope.clientId !== scope.clientId)
        return { valid: false, winner: null, reason: 'decision clientId does not match request clientId' }
    } else {
      if (decisionScope.level === SEMANTIC_SCOPE.CLIENT)
        return { valid: false, winner: null, reason: 'CLIENT-scoped decision cannot answer COMPANY request' }
    }
  }

  // Phase 3: winner-candidate validation (only when candidates provided)
  const governingClaimId = d.newState?.governingClaimId ?? null
  if (candidates !== null) {
    if (!governingClaimId) {
      return { valid: false, winner: null, reason: 'missing governingClaimId' }
    }
    const candidate = candidates.find(
      (c) => c.claimId === governingClaimId && c.candidateStatus === CANDIDATE_STATUS.ACTIVE,
    )
    if (!candidate) {
      return {
        valid: false, winner: null,
        reason: `governingClaimId '${governingClaimId}' does not resolve to an active candidate`,
      }
    }
    if (d.target && candidate.topic !== d.target) {
      return {
        valid: false, winner: null,
        reason: `governingClaimId '${governingClaimId}' resolves to topic '${candidate.topic}' but decision.target is '${d.target}'`,
      }
    }
    return { valid: true, winner: candidate, reason: 'ok' }
  }

  return { valid: true, winner: null, reason: 'ok' }
}

/**
 * Scope-aware conflict coverage check: does a valid founder decision cover a G3 policy conflict?
 *
 * A decision covers a conflict when:
 *   - its target topic appears among the conflict's candidate topics
 *   - its scope matches the conflict's candidate scope:
 *       CLIENT/X decision  → covers conflicts where CLIENT/X candidates participate
 *       COMPANY decision   → covers conflicts where only COMPANY candidates participate
 *
 * Mixed-scope conflicts (COMPANY + CLIENT candidates) are covered by the CLIENT decision
 * for the relevant clientId (the client override governs the mixed question for that client).
 *
 * @param {object} decision - validated brain.decisions entry
 * @param {object} pc - policy conflict (from classifyConflicts)
 * @param {PolicyCandidate[]} allCandidates - full candidate list from buildEffectivePolicyCandidates
 * @returns {boolean}
 */
function doesDecisionCoverConflict(decision, pc, allCandidates) {
  // Winner must be present and map to an active candidate
  const governingClaimId = decision.newState?.governingClaimId ?? null
  if (!governingClaimId) return false
  const winnerCandidate = allCandidates.find(
    (c) => c.claimId === governingClaimId && c.candidateStatus === CANDIDATE_STATUS.ACTIVE,
  )
  if (!winnerCandidate) return false
  // Winner must participate in this specific conflict's candidate set
  if (!pc.candidateKeys.includes(winnerCandidate.graphNodeKey)) return false

  const conflictCandidates = pc.candidateKeys
    .map((k) => allCandidates.find((ca) => ca.graphNodeKey === k))
    .filter(Boolean)

  if (conflictCandidates.length === 0) return false

  // Topic must match
  const conflictTopics = conflictCandidates.map((c) => c.topic).filter(Boolean)
  if (!conflictTopics.includes(decision.target)) return false

  const clientIds = new Set(
    conflictCandidates
      .filter((c) => c.scopeLevel === SEMANTIC_SCOPE.CLIENT)
      .map((c) => c.clientId)
      .filter(Boolean),
  )

  const decisionScope = decision.scope ?? { level: SEMANTIC_SCOPE.COMPANY }
  if (decisionScope.level === SEMANTIC_SCOPE.CLIENT) {
    // CLIENT decision covers conflicts that involve candidates for this exact client
    return clientIds.has(decisionScope.clientId)
  } else {
    // COMPANY decision covers only conflicts with no CLIENT candidates
    return clientIds.size === 0
  }
}

/**
 * Canonical founder-decision coverage state for a set of classified conflicts.
 * Both resolvePolicy and DW Intelligence consume this exact derivation.
 */
function deriveFounderConflictCoverage(
  conflicts,
  fullyValidDecisions,
  allCandidates,
  resolutionScope,
) {
  const allBlockingConflicts = conflicts.filter(
    (c) => !NON_BLOCKING_CONFLICT_CLASSES.has(c.conflictClass),
  )

  // Once an exact CLIENT-scoped decision selects an active CLIENT candidate,
  // company-only disagreements remain in detectedConflicts for audit but do
  // not block that client's explicit exception. Conflicts involving another
  // candidate for the same client remain relevant and still require coverage.
  const hasClientGoverningDecision =
    resolutionScope?.level === SEMANTIC_SCOPE.CLIENT &&
    fullyValidDecisions.some((decision) => {
      const winnerId = decision.newState?.governingClaimId ?? null
      const winner = allCandidates.find((candidate) => candidate.claimId === winnerId)
      return (
        decision.scope?.level === SEMANTIC_SCOPE.CLIENT &&
        decision.scope?.clientId === resolutionScope.clientId &&
        winner?.scopeLevel === SEMANTIC_SCOPE.CLIENT &&
        winner.clientId === resolutionScope.clientId
      )
    })

  const blockingConflicts = hasClientGoverningDecision
    ? allBlockingConflicts.filter((conflict) =>
        conflict.candidateKeys.some((key) => {
          const candidate = allCandidates.find((entry) => entry.graphNodeKey === key)
          return (
            candidate?.scopeLevel === SEMANTIC_SCOPE.CLIENT &&
            candidate.clientId === resolutionScope.clientId
          )
        }),
      )
    : allBlockingConflicts
  const coverage = blockingConflicts.map((conflict) => ({
    conflict,
    decisions: POLICY_RESOLVABLE_CONFLICT_CLASSES.has(conflict.conflictClass)
      ? fullyValidDecisions.filter((decision) =>
          doesDecisionCoverConflict(decision, conflict, allCandidates),
        )
      : [],
  }))
  return {
    blockingConflicts,
    unresolvedBlockingConflicts: coverage
      .filter((entry) => entry.decisions.length === 0)
      .map((entry) => entry.conflict),
    resolvedConflictEvidence: [
      ...new Map(
        coverage
          .flatMap((entry) => entry.decisions)
          .map((decision) => [decision.id, decision]),
      ).values(),
    ],
  }
}

// ── Core: Temporal classification ─────────────────────────────────────────────

/**
 * Classify the temporal state of a policy candidate.
 *
 * Rules (in priority order):
 *   1. HISTORICAL_PRECEDENT claim class → always HISTORICAL
 *   2. Explicit temporality === 'HISTORICAL' → HISTORICAL
 *   3. null effectiveTime OR { from: null, to: null } → UNKNOWN
 *   4. to <= queryDate → EXPIRED
 *   5. from > queryDate → FUTURE
 *   6. from <= queryDate (to null or to > queryDate) → CURRENT
 *   7. from null, to > queryDate → UNKNOWN (start not stated)
 *
 * Null dates mean "not stated", never "now" or "forever" (G3 spec §TemporalState).
 *
 * @param {object|null} effectiveTime - { from: string|null, to: string|null } or null
 * @param {string|undefined} temporality - from semanticScope.temporality
 * @param {string|null} claimClass - CLAIM_CLASS value
 * @param {string} queryDate - ISO date (YYYY-MM-DD) representing "now"
 * @returns {string} TEMPORAL_STATE value
 */
export function classifyTemporalState(effectiveTime, temporality, claimClass, queryDate) {
  if (claimClass === CLAIM_CLASS.HISTORICAL_PRECEDENT) return TEMPORAL_STATE.HISTORICAL
  if (temporality === 'HISTORICAL') return TEMPORAL_STATE.HISTORICAL

  if (!effectiveTime) return TEMPORAL_STATE.UNKNOWN

  const { from, to } = effectiveTime
  if (!from && !to) return TEMPORAL_STATE.UNKNOWN

  const qd = new Date(queryDate)
  const fromDate = from ? new Date(from) : null
  const toDate = to ? new Date(to) : null

  if (toDate && toDate <= qd) return TEMPORAL_STATE.EXPIRED
  if (fromDate && fromDate > qd) return TEMPORAL_STATE.FUTURE
  if (fromDate && fromDate <= qd) return TEMPORAL_STATE.CURRENT

  // from null, to set and not yet expired → UNKNOWN (start not stated)
  return TEMPORAL_STATE.UNKNOWN
}

// ── Core: Dangling provenance detection ───────────────────────────────────────

/**
 * Walk active claims for tenantId and identify any whose provenanceRootIds point to
 * source versions that are no longer ACTIVE in the brain.
 *
 * Returns an array of findings — each entry is a claim that has broken provenance.
 * Called before building candidates (R6).
 */
export function detectDanglingProvenance(brain, { tenantId }) {
  const activeSvIds = new Set(
    brain.sourceVersions
      .filter((sv) => sv.tenantId === tenantId && sv.status === 'ACTIVE')
      .map((sv) => sv.id),
  )
  const findings = []
  for (const claim of brain.claims.filter((c) => c.tenantId === tenantId && c.active)) {
    const dangling = (claim.provenanceRootIds || []).filter((id) => !activeSvIds.has(id))
    if (dangling.length > 0) {
      findings.push({
        claimId: claim.id,
        claimClass: claim.claimClass,
        claimType: claim.claimType,
        danglingRootIds: dangling,
        conflictClass: CONFLICT_CLASS.DANGLING_PROVENANCE,
      })
    }
  }
  return findings
}

// ── Core: SUPERSEDES edge freshness validation (D) ────────────────────────────

/**
 * Validate that a SUPERSEDES edge can still be used as precedence evidence.
 *
 * An edge is invalid if:
 *   - it is not active
 *   - it is not explicit (structural requirement on all SUPERSEDES edges)
 *   - tenant does not match
 *   - any of its provenance rootSourceVersionIds are no longer ACTIVE in brain (R6)
 *
 * A supersession backed by revoked evidence cannot be used to resolve a conflict.
 */
function isSupersessionStillValid(edge, brain, tenantId) {
  if (!edge.active) return false
  if (!edge.explicit) return false
  if (edge.tenantId !== tenantId) return false

  const activeSvIds = new Set(
    brain.sourceVersions
      .filter((sv) => sv.tenantId === tenantId && sv.status === 'ACTIVE')
      .map((sv) => sv.id),
  )

  const rootIds = edge.provenance?.rootSourceVersionIds ?? []
  // An edge with no provenance roots cannot be validated — treat as invalid
  if (rootIds.length === 0) return false
  return rootIds.every((id) => activeSvIds.has(id))
}

// ── Core: Build policy candidates ────────────────────────────────────────────

/**
 * Translate G2 graph policy nodes into G3 PolicyCandidate objects.
 *
 * Reads from:
 *   graph.getPoliciesApplicable()   — nodes for the requested scope
 *   graph.edges                     — SUPERSEDES edges (live store, not just snapshot)
 *   brain.claims                    — underlying claim for each node (claimClass, value, etc.)
 *   brain.sourceVersions            — to detect dangling provenance (R6)
 *
 * SUPERSEDES edges are freshness-validated (D): a supersession backed by revoked provenance
 * is discarded so that the superseded candidate is NOT incorrectly removed from the active set.
 *
 * Excludes HISTORICAL, EXPIRED, REVOKED and DANGLING candidates from ACTIVE status.
 * Does NOT exclude UNKNOWN temporal (those must surface so callers can apply R8).
 *
 * @param {CompanyGraphStore} graph
 * @param {CompanyBrainDurableStore} brain
 * @param {{ actor, tenantId, scope, queryDate }} options
 * @returns {PolicyCandidate[]}
 */
export function buildPolicyCandidates(graph, brain, { actor, tenantId, scope, queryDate }) {
  const policyNodes = graph.getPoliciesApplicable({ actor, tenantId, scope })

  const activeSvIds = new Set(
    brain.sourceVersions
      .filter((sv) => sv.tenantId === tenantId && sv.status === 'ACTIVE')
      .map((sv) => sv.id),
  )

  // SUPERSEDES edges from the live graph store — freshness-validated (D)
  const supersededKeys = new Set(
    graph.edges
      .filter(
        (e) =>
          e.type === GRAPH_EDGE_TYPE.SUPERSEDES &&
          isSupersessionStillValid(e, brain, tenantId),
      )
      .map((e) => e.toKey),
  )

  return policyNodes.map((node) => {
    const claimId = node.data?.claimId ?? null
    const claim = claimId ? brain.claims.find((c) => c.id === claimId) : null

    const temporality = claim?.semanticScope?.temporality ?? node.semanticScope?.temporality ?? undefined
    const claimClassStr = claim?.claimClass ?? null
    const effectiveTime = node.effectiveTime ?? claim?.effectiveTime ?? null

    const temporalState = classifyTemporalState(effectiveTime, temporality, claimClassStr, queryDate)

    const nodeRevoked = !node.active || node.revoked === true
    const claimRevoked = claim ? !claim.active || claim.revoked === true : false
    const hasDangling = claim
      ? (claim.provenanceRootIds ?? []).some((id) => !activeSvIds.has(id))
      : false

    let candidateStatus
    if (hasDangling) {
      candidateStatus = CANDIDATE_STATUS.DANGLING
    } else if (nodeRevoked || claimRevoked) {
      candidateStatus = CANDIDATE_STATUS.REVOKED
    } else if (temporalState === TEMPORAL_STATE.HISTORICAL || temporalState === TEMPORAL_STATE.EXPIRED) {
      candidateStatus = CANDIDATE_STATUS.HISTORICAL
    } else if (supersededKeys.has(node.stableKey)) {
      candidateStatus = CANDIDATE_STATUS.SUPERSEDED
    } else {
      candidateStatus = CANDIDATE_STATUS.ACTIVE
    }

    const rootSourceVersionIds = claim?.provenanceRootIds ?? node.provenance?.rootSourceVersionIds ?? []

    return {
      graphNodeKey: node.stableKey,
      claimId,
      claimClass: claimClassStr,
      topic: claim?.claimType ?? node.data?.policy_topic ?? node.label ?? null,
      value: claim?.value ?? node.data ?? null,
      scopeLevel: node.semanticScope?.level ?? scope.level,
      clientId: node.semanticScope?.clientId ?? scope.clientId ?? null,
      temporalState,
      effectiveTime,
      provenance: {
        rootSourceVersionIds,
        independent: rootSourceVersionIds.length > 0 && claim?.derived !== true,
        independentRootCount: new Set(rootSourceVersionIds).size,
      },
      candidateStatus,
      confidence: claim?.confidence ?? node.confidence ?? null,
      explicit: claim?.explicit !== false && node.explicit !== false,
    }
  })
}

// ── A: Effective policy stack composition for a client ────────────────────────

/**
 * Build the full effective policy stack for a client by composing:
 *   - company-wide policy candidates (COMPANY scope)
 *   - client-specific candidates (CLIENT scope)
 *
 * CLIENT candidates are tagged `inheritedFromCompany: false` and must NOT be widened
 * to company scope (R4). COMPANY candidates tagged `inheritedFromCompany: true`.
 *
 * The two sets are kept separate so callers can reason about scope independently.
 *
 * @param {CompanyGraphStore} graph
 * @param {CompanyBrainDurableStore} brain
 * @param {{ actor, tenantId, clientId, queryDate }} options
 * @returns {{ companyCandidates, clientCandidates, allCandidates }}
 */
export function buildEffectivePolicyCandidates(graph, brain, { actor, tenantId, clientId, queryDate }) {
  const companyCandidates = buildPolicyCandidates(graph, brain, {
    actor, tenantId, scope: { level: SEMANTIC_SCOPE.COMPANY }, queryDate,
  }).map((c) => ({ ...c, inheritedFromCompany: true }))

  const clientCandidates = buildPolicyCandidates(graph, brain, {
    actor, tenantId, scope: { level: SEMANTIC_SCOPE.CLIENT, clientId }, queryDate,
  }).map((c) => ({ ...c, inheritedFromCompany: false }))

  // Structural R4 check: CLIENT candidates must not appear in companyCandidates
  // (enforced structurally by G2's getPoliciesApplicable — verified here defensively)
  const clientKeys = new Set(clientCandidates.map((c) => c.graphNodeKey))
  const companyKeys = new Set(companyCandidates.map((c) => c.graphNodeKey))
  const leaked = [...clientKeys].filter((k) => companyKeys.has(k))
  if (leaked.length > 0) {
    throw new Error(`R4 violation: CLIENT candidate(s) leaked into COMPANY scope — keys: ${leaked.join(', ')}`)
  }

  return {
    companyCandidates,
    clientCandidates,
    allCandidates: [...companyCandidates, ...clientCandidates],
  }
}

// ── B: Identity validation ─────────────────────────────────────────────────────

/**
 * Validate that a clientId can be unambiguously resolved in the Company Graph.
 *
 * Uses `graph.resolveClientAlias()` which matches both canonical entity IDs and
 * registered aliases. Returns `valid: true` only when RESOLVED; all other states
 * (AMBIGUOUS, UNRESOLVED, CONFLICTED) return `valid: false` with typed conflict class.
 *
 * R8: Missing or ambiguous identity must produce abstention, not guessing.
 */
export function validateClientIdentity(graph, { actor, tenantId, clientId }) {
  const result = graph.resolveClientAlias({ actor, tenantId, alias: clientId })
  if (result.state === RESOLUTION_STATE.RESOLVED) {
    return { valid: true, resolvedKey: result.selectedKey, state: result.state }
  }
  return {
    valid: false,
    state: result.state,
    candidateKeys: result.candidateKeys ?? [],
    conflictClass: CONFLICT_CLASS.AMBIGUOUS_ENTITY_IDENTITY,
  }
}

// ── C: Founder decision integration ───────────────────────────────────────────

/**
 * Read brain.decisions and apply any valid founder decisions for the given topic.
 *
 * A decision is valid when:
 *   - tenantId matches
 *   - decision.target === topic (topic string, e.g. 'late_fee_policy')
 *   - status === 'RECORDED'
 *   - all evidenceClaimIds are still active in brain (R6: revoked evidence invalidates decision)
 *   - decision scope matches the requested scope (R4/R9):
 *       COMPANY-scope query: only COMPANY-scoped decisions apply
 *       CLIENT-scope query: only decisions scoped to this specific client apply
 *       A company-wide decision does NOT automatically resolve a client-specific conflict
 *       (the client's exception remains a separate unresolved question).
 *       A client-specific decision does NOT resolve company-wide policy.
 *
 * Returns the most recent valid decision's winner candidate if one exists.
 *
 * Invariants enforced:
 *   R9: authorityGrantable always false — a policy decision ≠ DW execution authority
 *   R6: decisions backed by revoked evidence cannot be applied
 */
export function applyFounderDecisions(candidates, { brain, tenantId, topic, scope = null }) {
  // Default scope: COMPANY when none provided
  const requestedScope = scope ?? { level: SEMANTIC_SCOPE.COMPANY }

  // Evaluate all tenant decisions through all three phases. Current governing
  // truth contains only fully valid decisions; every rejection remains
  // separately auditable with its exact invalidation reason.
  const evaluatedDecisions = (brain.decisions ?? [])
    .filter((d) => d.tenantId === tenantId)
    .map((d) => ({
      d,
      result: evaluateFounderDecision(d, {
        brain, tenantId, topic, scope: requestedScope, candidates,
      }),
    }))

  const invalidatedDecisions = evaluatedDecisions
    .filter(({ result }) => !result.valid)
    .map(({ d, result }) => ({ ...d, invalidReason: result.reason }))

  // Keep only fully valid decisions. A newer malformed decision
  // (null/wrong-topic governingClaimId) must not mask an older valid one.
  const fullyValidDecisions = evaluatedDecisions
    .filter(({ result }) => result.valid)
    .sort((a, b) => new Date(b.d.decidedAt) - new Date(a.d.decidedAt))

  if (fullyValidDecisions.length === 0) {
    return {
      applied: false,
      decisions: [],
      invalidatedDecisions,
      winner: null,
      latestDecision: null,
      authorityGrantable: false,
    }
  }

  const { d: latestDecision, result: latestResult } = fullyValidDecisions[0]

  return {
    applied: true,
    decisions: fullyValidDecisions.map(({ d }) => d),
    invalidatedDecisions,
    winner: latestResult.winner,
    latestDecision,
    authorityGrantable: false, // R9: policy decision ≠ DW execution authority
  }
}

// ── Core: Conflict classification ─────────────────────────────────────────────

/**
 * Classify conflicts among a set of policy candidates.
 *
 * Classification priority (per pair of ACTIVE candidates):
 *   1. SCOPE_ESCALATION — CLIENT-scoped candidate in COMPANY-scope request (R4)
 *   2. DANGLING_PROVENANCE — broken provenance chain (R6); NON-BLOCKING
 *   3. CONFIDENCE_DISAGREEMENT — same value, different confidence; must not resolve (R1)
 *   4. DUPLICATE_EVIDENCE — same value, same class, same confidence, independent sources
 *   5. FOUNDER_INSTRUCTION_VS_PRIOR_POLICY — FOUNDER_INSTRUCTION vs COMPANY_POLICY
 *   6. COMPANY_VS_CLIENT_EXCEPTION — scope mismatch (client rule vs company rule)
 *   7. OVERLAPPING_EFFECTIVE_PERIODS — both UNKNOWN temporal (open-ended windows)
 *   8. MISSING_PRECEDENCE — both CURRENT (or FUTURE) with no documented supersession (R8)
 *   9. SAME_SCOPE_INCOMPATIBLE_VALUES — general incompatible-value fallback
 *
 * CURRENT_VS_HISTORICAL is detected in a separate cross-product pass (ACTIVE × HISTORICAL).
 * It is NON-BLOCKING because HISTORICAL candidates are excluded from active resolution (R5).
 *
 * @param {PolicyCandidate[]} candidates
 * @param {{ requestedScope? }} context
 * @returns {ConflictClassification[]}
 */
export function classifyConflicts(candidates, { requestedScope = null } = {}) {
  const conflicts = []

  // (1) SCOPE_ESCALATION: CLIENT-scoped candidate answering a COMPANY-scope question (R4)
  if (requestedScope?.level === SEMANTIC_SCOPE.COMPANY) {
    for (const c of candidates) {
      if (c.scopeLevel === SEMANTIC_SCOPE.CLIENT) {
        conflicts.push({
          conflictClass: CONFLICT_CLASS.SCOPE_ESCALATION,
          candidateKeys: [c.graphNodeKey],
          reason: `CLIENT-scoped candidate ${c.graphNodeKey} cannot answer a COMPANY-scope question (R4)`,
        })
      }
    }
  }

  // (2) DANGLING_PROVENANCE: broken evidence chain (R6) — non-blocking, detected before pairwise
  for (const c of candidates) {
    if (c.candidateStatus === CANDIDATE_STATUS.DANGLING) {
      conflicts.push({
        conflictClass: CONFLICT_CLASS.DANGLING_PROVENANCE,
        candidateKeys: [c.graphNodeKey],
        reason: `Candidate ${c.graphNodeKey} has broken provenance — cannot be used as evidence (R6)`,
      })
    }
  }

  // CURRENT_VS_HISTORICAL: cross-product of ACTIVE × HISTORICAL candidates (R5)
  // Non-blocking — historical candidates are already excluded from resolution.
  // Detected to surface contradiction for audit and DW Intelligence context.
  const active = candidates.filter(
    (c) =>
      c.candidateStatus === CANDIDATE_STATUS.ACTIVE &&
      c.temporalState !== TEMPORAL_STATE.FUTURE,
  )
  const historicalCandidates = candidates.filter(
    (c) => c.candidateStatus === CANDIDATE_STATUS.HISTORICAL,
  )
  for (const a of active) {
    for (const h of historicalCandidates) {
      conflicts.push({
        conflictClass: CONFLICT_CLASS.CURRENT_VS_HISTORICAL,
        candidateKeys: [a.graphNodeKey, h.graphNodeKey],
        reason: `Current candidate ${a.graphNodeKey} contradicts historical precedent ${h.graphNodeKey} — historical excluded from resolution (R5)`,
      })
    }
  }

  // Pairwise classification among ACTIVE candidates
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]
      const b = active[j]

      const aIsFounder = a.claimClass === CLAIM_CLASS.FOUNDER_INSTRUCTION
      const bIsFounder = b.claimClass === CLAIM_CLASS.FOUNDER_INSTRUCTION
      const aIsPolicy = a.claimClass === CLAIM_CLASS.COMPANY_POLICY
      const bIsPolicy = b.claimClass === CLAIM_CLASS.COMPANY_POLICY
      const aIsException = a.claimClass === CLAIM_CLASS.CLIENT_EXCEPTION
      const bIsException = b.claimClass === CLAIM_CLASS.CLIENT_EXCEPTION
      const aUnknown = a.temporalState === TEMPORAL_STATE.UNKNOWN
      const bUnknown = b.temporalState === TEMPORAL_STATE.UNKNOWN

      const sameValue = stableStringify(a.value) === stableStringify(b.value)

      // (3) CONFIDENCE_DISAGREEMENT: same value, different confidence (R1: cannot resolve)
      if (sameValue && a.confidence !== null && b.confidence !== null && a.confidence !== b.confidence) {
        conflicts.push({
          conflictClass: CONFLICT_CLASS.CONFIDENCE_DISAGREEMENT,
          candidateKeys: [a.graphNodeKey, b.graphNodeKey],
          reason: 'Candidates agree on policy value but have different confidence scores; confidence cannot be used to resolve (R1)',
        })
        continue
      }

      // (4) DUPLICATE_EVIDENCE: same value, same class, same (or null) confidence, independent sources
      if (
        sameValue &&
        a.claimClass === b.claimClass &&
        a.confidence === b.confidence &&
        !a.provenance.rootSourceVersionIds.some((id) => b.provenance.rootSourceVersionIds.includes(id))
      ) {
        conflicts.push({
          conflictClass: CONFLICT_CLASS.DUPLICATE_EVIDENCE,
          candidateKeys: [a.graphNodeKey, b.graphNodeKey],
          reason: 'Same policy value extracted from independent sources — verify not redundant ingestion',
        })
        continue
      }

      // (5) FOUNDER_INSTRUCTION_VS_PRIOR_POLICY
      if ((aIsFounder && bIsPolicy) || (aIsPolicy && bIsFounder)) {
        conflicts.push({
          conflictClass: CONFLICT_CLASS.FOUNDER_INSTRUCTION_VS_PRIOR_POLICY,
          candidateKeys: [a.graphNodeKey, b.graphNodeKey],
          reason: 'Founder instruction contradicts standing company policy — explicit founder decision required (R9)',
        })
        continue
      }

      // (6) COMPANY_VS_CLIENT_EXCEPTION (only when both reach the active set — structural gap)
      if ((aIsPolicy && bIsException) || (aIsException && bIsPolicy)) {
        conflicts.push({
          conflictClass: CONFLICT_CLASS.COMPANY_VS_CLIENT_EXCEPTION,
          candidateKeys: [a.graphNodeKey, b.graphNodeKey],
          reason: 'Company policy conflicts with client exception in scope (R4)',
        })
        continue
      }

      // (7) OVERLAPPING_EFFECTIVE_PERIODS: both UNKNOWN temporal → open-ended windows (R8)
      if (aUnknown && bUnknown) {
        conflicts.push({
          conflictClass: CONFLICT_CLASS.OVERLAPPING_EFFECTIVE_PERIODS,
          candidateKeys: [a.graphNodeKey, b.graphNodeKey],
          reason: 'Neither candidate states effective dates; temporal overlap cannot be excluded (R8)',
        })
        continue
      }

      // (8) MISSING_PRECEDENCE: no documented supersession between two CURRENT candidates (R8)
      if (!aUnknown && !bUnknown) {
        conflicts.push({
          conflictClass: CONFLICT_CLASS.MISSING_PRECEDENCE,
          candidateKeys: [a.graphNodeKey, b.graphNodeKey],
          reason: 'Both candidates are temporally applicable but no explicit supersession is documented (R8)',
        })
        continue
      }

      // (9) General fallback
      conflicts.push({
        conflictClass: CONFLICT_CLASS.SAME_SCOPE_INCOMPATIBLE_VALUES,
        candidateKeys: [a.graphNodeKey, b.graphNodeKey],
        reason: 'Incompatible values at the same policy scope with no documented precedence',
      })
    }
  }

  return conflicts
}

// ── Core: Policy resolution ───────────────────────────────────────────────────

/**
 * Resolve the governing policy for a topic + scope.
 *
 * Algorithm:
 *   1. Identity validation for CLIENT scope (B, R8) — abstain if AMBIGUOUS/UNRESOLVED
 *   2. Build PolicyCandidate[] for the requested scope from G2 graph + brain
 *   3. Filter by topic (if specified)
 *   4. Apply SUPERSEDES edges from the live graph store (freshness-validated — D)
 *   5. CONTRACT_VS_COMPANY_POLICY detection for client scopes (E)
 *   6. Classify conflicts (CURRENT_VS_HISTORICAL non-blocking — E fix)
 *   7. Apply founder decisions (C) — if valid decision picks a winner among active candidates
 *   8. Status: NO_POLICY | RESOLVED | CONFLICTED | ABSTAIN
 *
 * Invariants enforced:
 *   - canActAutomatically: false always (R9)
 *   - canonicalMoneyWritable: false always (R0)
 *   - confidence never picks a winner (R1)
 *   - CLIENT-scoped candidates not included in COMPANY-scope resolution (R4, structural via G2)
 *   - HISTORICAL/EXPIRED/FUTURE candidates excluded from active resolution (R5)
 *   - Dangling provenance surfaced as DANGLING_PROVENANCE conflict class (R6)
 *   - Ambiguous/unresolved identity produces ABSTAIN + AMBIGUOUS_ENTITY_IDENTITY (R8)
 *
 * @param {CompanyGraphStore} graph
 * @param {CompanyBrainDurableStore} brain
 * @param {{ actor, tenantId, scope, topic?, queryDate? }} options
 * @returns {G3PolicyResolution}
 */
export function resolvePolicy(graph, brain, {
  actor,
  tenantId,
  scope,
  topic = null,
  queryDate = new Date().toISOString().slice(0, 10),
} = {}) {
  // Capture graphVersion once (before any possible early exit)
  let graphVersion = null
  try {
    const snap = graph.requireSnapshot({ actor, tenantId })
    graphVersion = snap.id
  } catch (_) { /* no snapshot yet */ }

  // (B) Identity validation for CLIENT scope — abstain if ambiguous/unresolved (R8)
  if (scope?.level === SEMANTIC_SCOPE.CLIENT && scope.clientId) {
    const identityCheck = validateClientIdentity(graph, { actor, tenantId, clientId: scope.clientId })
    if (!identityCheck.valid) {
      return {
        kind: 'G3_POLICY_RESOLUTION_V0',
        tenantId, topic, scope, queryDate,
        status: G3_RESOLUTION_STATUS.ABSTAIN,
        winner: null,
        candidates: [],
        conflicts: [{
          conflictClass: CONFLICT_CLASS.AMBIGUOUS_ENTITY_IDENTITY,
          candidateKeys: identityCheck.candidateKeys,
          reason: `Client identity '${scope.clientId}' could not be unambiguously resolved (state: ${identityCheck.state}) — cannot resolve policy without explicit identity (R8)`,
          identityState: identityCheck.state,
        }],
        supersessionEvidence: [],
        founderDecisions: [],
        hasUnknownTemporal: false,
        canActAutomatically: false,
        canonicalMoneyWritable: false,
        authorityGrantable: false,
        policyPrecedenceResolved: false,
        graphVersion,
        provenance: { rootSourceVersionIds: [] },
      }
    }
  }

  // For CLIENT scope: compose the full effective stack (COMPANY + CLIENT candidates) so
  // classifyConflicts can reason over the complete evidence set (Issue 1 — R4 preserved: each
  // candidate retains its original scopeLevel; SCOPE_ESCALATION only fires for COMPANY requests).
  let allCandidates
  if (scope?.level === SEMANTIC_SCOPE.CLIENT && scope.clientId) {
    const effective = buildEffectivePolicyCandidates(graph, brain, {
      actor, tenantId, clientId: scope.clientId, queryDate,
    })
    allCandidates = effective.allCandidates
  } else {
    allCandidates = buildPolicyCandidates(graph, brain, { actor, tenantId, scope, queryDate })
  }

  const topicCandidates = topic ? allCandidates.filter((c) => c.topic === topic) : allCandidates

  // (D) Collect freshness-validated SUPERSEDES edges for these candidates
  const candidateKeys = new Set(topicCandidates.map((c) => c.graphNodeKey))
  const supersedesEdges = graph.edges.filter(
    (e) =>
      e.type === GRAPH_EDGE_TYPE.SUPERSEDES &&
      isSupersessionStillValid(e, brain, tenantId) &&
      candidateKeys.has(e.fromKey) &&
      candidateKeys.has(e.toKey),
  )
  const supersededByExplicit = new Set(supersedesEdges.map((e) => e.toKey))

  // Apply explicit supersession on top of candidates
  const resolved = topicCandidates.map((c) =>
    supersededByExplicit.has(c.graphNodeKey) && c.candidateStatus === CANDIDATE_STATUS.ACTIVE
      ? { ...c, candidateStatus: CANDIDATE_STATUS.SUPERSEDED }
      : c,
  )

  // (E) CONTRACT_VS_COMPANY_POLICY: fires only when BOTH sides have active topic-specific
  // evidence — the contract's existence alone is not sufficient (false-positive guard).
  // Requires: active contract + active CLIENT-scoped candidates for the topic (evidence that
  // the contract carries terms about this topic) + active COMPANY-scoped candidates for the topic.
  // Negative case: a contract with only payment-term dates (no late-fee term) does NOT fire.
  const extraConflicts = []
  if (scope?.level === SEMANTIC_SCOPE.CLIENT && scope.clientId) {
    const contracts = graph.getContractsForClient({ actor, tenantId, clientId: scope.clientId })
    if (contracts.length > 0) {
      const companyActiveForTopic = resolved.filter(
        (c) =>
          c.candidateStatus === CANDIDATE_STATUS.ACTIVE &&
          c.temporalState !== TEMPORAL_STATE.FUTURE &&
          c.scopeLevel === SEMANTIC_SCOPE.COMPANY &&
          (!topic || c.topic === topic),
      )
      const clientActiveForTopic = resolved.filter(
        (c) =>
          c.candidateStatus === CANDIDATE_STATUS.ACTIVE &&
          c.temporalState !== TEMPORAL_STATE.FUTURE &&
          c.scopeLevel === SEMANTIC_SCOPE.CLIENT &&
          (!topic || c.topic === topic),
      )
      // Fire only when an active CLIENT candidate is provenance-linked to contract-derived evidence.
      // A standalone client claim or non-contract-derived exception coexisting with a contract is
      // COMPANY_VS_CLIENT_EXCEPTION or FOUNDER_INSTRUCTION_VS_PRIOR_POLICY, not CONTRACT_VS_COMPANY_POLICY.
      // The provenance link is established by: the CLIENT candidate's rootSourceVersionIds overlap
      // with the rootSourceVersionIds of any CLIENT_EXCEPTION node that has a DERIVED_FROM edge
      // to an active contract (Issue 2 — structural provenance check, not merely contract existence).
      const contractNodeKeys = new Set(contracts.map((c) => c.stableKey))
      const contractKeysByRootId = new Map()
      try {
        const snap = graph.requireSnapshot({ actor, tenantId })
        snap.nodes.forEach((n) => {
          const derivedContractKeys = snap.edges
            .filter(
              (e) =>
                e.active &&
                e.type === GRAPH_EDGE_TYPE.DERIVED_FROM &&
                e.fromKey === n.stableKey &&
                contractNodeKeys.has(e.toKey),
            )
            .map((e) => e.toKey)
          if (
            n.active &&
            n.type === GRAPH_NODE_TYPE.CLIENT_EXCEPTION &&
            n.semanticScope?.clientId === scope.clientId &&
            (!topic || n.data?.policy_topic === topic) &&
            derivedContractKeys.length > 0
          ) {
            ;(n.provenance?.rootSourceVersionIds ?? []).forEach((rootId) => {
              const keys = contractKeysByRootId.get(rootId) ?? new Set()
              derivedContractKeys.forEach((key) => keys.add(key))
              contractKeysByRootId.set(rootId, keys)
            })
          }
        })
      } catch (_) { /* no snapshot — no contract-derived roots */ }
      // CLIENT candidates whose provenance overlaps with contract-derived exception evidence
      const contractDerivedClientCandidates = clientActiveForTopic.filter(
        (c) => c.provenance.rootSourceVersionIds.some((id) => contractKeysByRootId.has(id)),
      )
      if (companyActiveForTopic.length > 0 && contractDerivedClientCandidates.length > 0) {
        const exactContractKeys = [
          ...new Set(
            contractDerivedClientCandidates.flatMap((candidate) =>
              candidate.provenance.rootSourceVersionIds.flatMap((rootId) =>
                [...(contractKeysByRootId.get(rootId) ?? [])],
              ),
            ),
          ),
        ]
        extraConflicts.push({
          conflictClass: CONFLICT_CLASS.CONTRACT_VS_COMPANY_POLICY,
          candidateKeys: [
            ...companyActiveForTopic.map((c) => c.graphNodeKey),
            ...contractDerivedClientCandidates.map((c) => c.graphNodeKey),
          ],
          contractKeys: exactContractKeys,
          reason: `Client ${scope.clientId} has active contract(s) with contract-derived exception evidence for topic '${topic ?? 'any'}' contradicting company policy — explicit founder reconciliation required (R8)`,
        })
      }
    }
  }

  const conflicts = [...classifyConflicts(resolved, { requestedScope: scope }), ...extraConflicts]

  // Active candidates for resolution: ACTIVE status, not FUTURE
  const active = resolved.filter(
    (c) =>
      c.candidateStatus === CANDIDATE_STATUS.ACTIVE &&
      c.temporalState !== TEMPORAL_STATE.FUTURE,
  )

  const supersessionEvidence = supersedesEdges.map((e) => ({
    fromKey: e.fromKey,
    toKey: e.toKey,
    explicit: e.explicit,
    provenance: e.provenance,
  }))

  const hasUnknownTemporal = active.some((c) => c.temporalState === TEMPORAL_STATE.UNKNOWN)

  // (C) Founder decisions: read brain.decisions for this topic, scope-validated (Issue 3)
  const decisionResult = topic
    ? applyFounderDecisions(active, { brain, tenantId, topic, scope })
    : { applied: false, decisions: [], invalidatedDecisions: [], winner: null, authorityGrantable: false }

  const conflictCoverage = deriveFounderConflictCoverage(
    conflicts,
    decisionResult.decisions,
    active,
    scope,
  )
  const { blockingConflicts, unresolvedBlockingConflicts } = conflictCoverage

  let status
  let winner = null

  if (topicCandidates.length === 0) {
    status = G3_RESOLUTION_STATUS.NO_POLICY
  } else if (active.length === 0) {
    // All candidates are historical/superseded/revoked/dangling — no current policy can be stated
    status = G3_RESOLUTION_STATUS.ABSTAIN
  } else if (
    decisionResult.applied &&
    decisionResult.winner &&
    active.some((c) => c.claimId === decisionResult.winner.claimId) &&
    unresolvedBlockingConflicts.length === 0 &&
    blockingConflicts.every((bc) => POLICY_RESOLVABLE_CONFLICT_CLASSES.has(bc.conflictClass))
  ) {
    // Explicit founder decision picks a winner among active candidates, and all blocking
    // conflicts are policy-resolvable (not structural) — founder decision resolves (C, R9)
    status = G3_RESOLUTION_STATUS.RESOLVED
    winner = active.find((c) => c.claimId === decisionResult.winner.claimId)
  } else if (active.length === 1 && blockingConflicts.length === 0) {
    status = G3_RESOLUTION_STATUS.RESOLVED
    winner = active[0]
  } else if (blockingConflicts.length > 0) {
    status = G3_RESOLUTION_STATUS.CONFLICTED
  } else {
    status = G3_RESOLUTION_STATUS.CONFLICTED
  }

  // Typed conflict separation (Issue 4):
  //   detectedConflicts = full audit trail of every classified conflict (for provenance/review)
  //   unresolvedConflicts = blocking conflicts not resolved by a valid founder decision
  //   resolvedConflictEvidence = decisions that resolved blocking conflicts
  const resolvedByFounderDecision =
    status === G3_RESOLUTION_STATUS.RESOLVED &&
    decisionResult.applied &&
    decisionResult.winner !== null

  const unresolvedConflicts = unresolvedBlockingConflicts
  const resolvedConflictEvidence = conflictCoverage.resolvedConflictEvidence

  // policyPrecedenceResolved invariant: true iff RESOLVED and the resolution is backed by
  // explicit evidence (founder decision, explicit supersession, or single uncontested active).
  const policyPrecedenceResolved =
    status === G3_RESOLUTION_STATUS.RESOLVED &&
    (resolvedByFounderDecision ||
      supersessionEvidence.length > 0 ||
      blockingConflicts.length === 0)

  return {
    kind: 'G3_POLICY_RESOLUTION_V0',
    tenantId,
    topic,
    scope,
    queryDate,
    status,
    winner,
    candidates: resolved,
    // conflicts = full audit trail (backward compatible)
    conflicts,
    detectedConflicts: conflicts,
    unresolvedConflicts,
    resolvedConflictEvidence,
    supersessionEvidence,
    founderDecisions: decisionResult.decisions,
    invalidatedFounderDecisions: decisionResult.invalidatedDecisions,
    hasUnknownTemporal,
    // Structural invariants — never negotiable
    canActAutomatically: false,
    canonicalMoneyWritable: false,
    authorityGrantable: false,
    policyPrecedenceResolved,
    graphVersion,
    provenance: {
      rootSourceVersionIds: [
        ...new Set(topicCandidates.flatMap((c) => c.provenance.rootSourceVersionIds)),
      ],
    },
  }
}

// ── F: G3 Ask DW policy ────────────────────────────────────────────────────────

/**
 * Answer a natural-language question about policy using G3 reasoning.
 *
 * Routes the question to the appropriate G3 resolution path, classifies the question
 * type, and returns a typed response. Nine question types are handled:
 *   COMPANY_POLICY, CLIENT_POLICY, SCOPE_INQUIRY, HISTORICAL, WHY_UNRESOLVED,
 *   CONFLICTS, FOUNDER_DECISIONS, DW_AUTHORITY, UNKNOWN
 *
 * Never hallucinates a winner when status is CONFLICTED or ABSTAIN.
 * authorityBoundary.canActAutomatically and authorityGrantable are always false (R9, R7).
 *
 * @param {CompanyGraphStore} graph
 * @param {CompanyBrainDurableStore} brain
 * @param {{ actor, tenantId, question, clientId?, queryDate? }} options
 * @returns {G3AskDwPolicyResponse}
 */
export function askDwPolicy(graph, brain, {
  actor,
  tenantId,
  question,
  clientId = null,
  queryDate = new Date().toISOString().slice(0, 10),
} = {}) {
  const q = (question || '').toLowerCase()

  // Derive topic from question keywords
  const topic = /late.?fee/.test(q) ? 'late_fee_policy' : null

  // Classify the question type (first match wins)
  let questionType
  if (/can dw act|act automatically|automatically|dw authority|dw permission/.test(q)) {
    questionType = 'DW_AUTHORITY'
  } else if (/founder.*decid|what.*founder|decided|founder decision/.test(q)) {
    questionType = 'FOUNDER_DECISIONS'
  } else if (/why.*unresolved|why.*conflict/.test(q)) {
    questionType = 'WHY_UNRESOLVED'
  } else if (/what.*conflict|list.*conflict|conflict exist/.test(q)) {
    questionType = 'CONFLICTS'
  } else if (/what.*unresolved|unresolved about/.test(q)) {
    questionType = 'WHY_UNRESOLVED'
  } else if (/histor|old|previous/.test(q)) {
    questionType = 'HISTORICAL'
  } else if (clientId && /company.?wide|company scope|every client|all client/.test(q)) {
    questionType = 'SCOPE_INQUIRY'
  } else if (clientId) {
    questionType = 'CLIENT_POLICY'
  } else {
    questionType = 'COMPANY_POLICY'
  }

  // Resolve policy for the appropriate scope
  const companyResolution = resolvePolicy(graph, brain, {
    actor, tenantId, scope: { level: SEMANTIC_SCOPE.COMPANY }, topic, queryDate,
  })

  let clientResolution = null
  if (clientId) {
    clientResolution = resolvePolicy(graph, brain, {
      actor, tenantId, scope: { level: SEMANTIC_SCOPE.CLIENT, clientId }, topic, queryDate,
    })
  }

  const primaryResolution = (questionType === 'CLIENT_POLICY' || questionType === 'SCOPE_INQUIRY')
    ? (clientResolution ?? companyResolution)
    : companyResolution

  const applicablePolicyCandidates = primaryResolution.candidates.filter(
    (c) => c.candidateStatus === CANDIDATE_STATUS.ACTIVE,
  )
  const excludedPolicyCandidates = primaryResolution.candidates.filter(
    (c) => c.candidateStatus !== CANDIDATE_STATUS.ACTIVE,
  )

  // Founder decisions: freshness-validated (R6) + scope-filtered (Issue 1/6).
  // Scope = CLIENT/clientId when clientId is provided, COMPANY otherwise.
  // This ensures atlas Ask DW sees only atlas decisions; COMPANY Ask DW sees only COMPANY decisions.
  const questionScope = clientId
    ? { level: SEMANTIC_SCOPE.CLIENT, clientId }
    : { level: SEMANTIC_SCOPE.COMPANY }

  // Phase 3 candidate validation uses scope-appropriate candidates (not questionType-based ones).
  // When questionScope is CLIENT, use clientResolution candidates so CLIENT-scoped governingClaimIds resolve.
  const scopeResolution = questionScope.level === SEMANTIC_SCOPE.CLIENT
    ? (clientResolution ?? companyResolution)
    : companyResolution
  const founderDecisionCandidates = scopeResolution.candidates.filter(
    (c) => c.candidateStatus === CANDIDATE_STATUS.ACTIVE,
  )

  const founderDecisions = (brain.decisions ?? []).filter((d) =>
    evaluateFounderDecision(d, {
      brain, tenantId, topic, scope: questionScope,
      candidates: founderDecisionCandidates,
    }).valid,
  )

  const hasUnknownTemporal = applicablePolicyCandidates.some(
    (c) => c.temporalState === TEMPORAL_STATE.UNKNOWN,
  )
  // Use unresolvedConflicts (Issue 2): detectedConflicts is preserved for audit in the return value,
  // but current-state "is there still a conflict?" uses unresolvedConflicts (empty when resolved by decision).
  const hasUnresolvedConflicts = primaryResolution.unresolvedConflicts.length > 0

  // Build the answer text
  let answer
  switch (questionType) {
    case 'DW_AUTHORITY':
      answer = 'DW cannot act automatically. All policy actions require explicit founder decision. Observed delegation does not grant DW authority (R9, R7).'
      break
    case 'FOUNDER_DECISIONS':
      answer = founderDecisions.length > 0
        ? `${founderDecisions.length} founder decision(s) recorded for this topic.`
        : 'No founder decisions recorded for this topic.'
      break
    case 'CONFLICTS':
    case 'WHY_UNRESOLVED': {
      // Use unresolvedConflicts (Issue 2) for current-state answer; detectedConflicts in return for audit
      const blocking = primaryResolution.unresolvedConflicts
      answer = blocking.length > 0
        ? `${blocking.length} unresolved conflict(s): ${[...new Set(blocking.map((c) => c.conflictClass))].join(', ')}`
        : 'No blocking conflicts detected for this topic.'
      break
    }
    case 'HISTORICAL': {
      const hist = primaryResolution.candidates.filter(
        (c) => c.candidateStatus === CANDIDATE_STATUS.HISTORICAL,
      )
      answer = hist.length > 0
        ? `${hist.length} historical candidate(s) excluded from current resolution (R5).`
        : 'No historical evidence found for this topic.'
      break
    }
    case 'SCOPE_INQUIRY':
      answer = clientId
        ? `Client-specific rules for '${clientId}' apply only to that client and do not widen to company scope (R4).`
        : 'Company-scope rules apply to all clients unless overridden by a client-specific exception.'
      break
    default: {
      if (primaryResolution.status === G3_RESOLUTION_STATUS.RESOLVED && primaryResolution.winner) {
        answer = `Policy resolved: ${JSON.stringify(primaryResolution.winner.value)}`
      } else if (primaryResolution.status === G3_RESOLUTION_STATUS.CONFLICTED) {
        // Use unresolvedConflicts for the count (Issue 2)
        const count = primaryResolution.unresolvedConflicts.length
        answer = `Policy is CONFLICTED — ${count} unresolved conflict(s). Founder decision required.`
      } else if (primaryResolution.status === G3_RESOLUTION_STATUS.ABSTAIN) {
        answer = `Cannot state policy — abstaining. Reason: ${primaryResolution.conflicts.map((c) => c.reason).join('; ')}`
      } else {
        answer = 'No policy evidence found for this topic.'
      }
    }
  }

  return {
    kind: 'G3_ASK_DW_POLICY_RESPONSE_V0',
    tenantId,
    question,
    questionType,
    topic,
    clientId,
    queryDate,
    answer,
    resolutionState: primaryResolution.status,
    scope: primaryResolution.scope,
    temporalApplicability: {
      hasUnknownTemporal,
      unknownTemporalKeys: applicablePolicyCandidates
        .filter((c) => c.temporalState === TEMPORAL_STATE.UNKNOWN)
        .map((c) => c.graphNodeKey),
    },
    applicablePolicyCandidates,
    excludedPolicyCandidates,
    // conflicts = full detected audit trail (backward compat)
    conflicts: primaryResolution.conflicts,
    // typed separation (Issue 2): detectedConflicts preserved for audit, unresolvedConflicts for current state
    detectedConflicts: primaryResolution.detectedConflicts ?? primaryResolution.conflicts,
    unresolvedConflicts: primaryResolution.unresolvedConflicts,
    precedenceEvidence: primaryResolution.supersessionEvidence ?? [],
    founderDecisions,
    provenance: primaryResolution.provenance,
    uncertainty: {
      hasUnknownTemporal,
      hasUnresolvedConflicts,
      hasAmbiguousIdentity: primaryResolution.conflicts.some(
        (c) => c.conflictClass === CONFLICT_CLASS.AMBIGUOUS_ENTITY_IDENTITY,
      ),
    },
    authorityBoundary: {
      canActAutomatically: false,
      authorityGrantable: false,
      reason: 'DW cannot act on policy decisions automatically (R9). All policy actions require explicit founder decision.',
    },
    canonicalMoneyWritable: false,
  }
}

// ── G: G3 DW Intelligence context (expanded) ──────────────────────────────────

/**
 * Build a G3-enhanced DW Intelligence context.
 *
 * Augments G2's `dwIntelligenceContext` with full G3 typed fields:
 *   applicablePolicyCandidates  — active (non-historical, non-revoked, non-future) candidates
 *   excludedPolicyCandidates    — HISTORICAL/FUTURE/REVOKED/DANGLING/SUPERSEDED candidates
 *   unresolvedConflicts         — brain.conflicts with status 'CONFLICTED'
 *   precedenceEvidence          — valid SUPERSEDES edges from live graph store
 *   temporalApplicability       — temporal summary (UNKNOWN, CURRENT, FUTURE, HISTORICAL counts)
 *   clientExceptions            — CLIENT_EXCEPTION candidates for the clientId (if provided)
 *   founderDecisions            — brain.decisions for this tenantId
 *   provenancePaths             — from G2 dwIntelligenceContext
 *   uncertainty                 — typed uncertainty flags
 *   authorityBoundary           — always canActAutomatically: false (R9)
 *
 * Boundary constants (structural, never negotiable):
 *   canonicalMoneyWritable: false (R0)
 *   authorityGrantable: false (R9)
 *   policyConflictsResolvableByConfidence: false (R1)
 *   observedDelegationIsAuthority: false (R7)
 *   behaviorCreatesPolicy: false (R2, R3)
 */
export function buildG3DwIntelligenceContext(graph, brain, {
  actor,
  tenantId,
  clientId = null,
  queryDate = new Date().toISOString().slice(0, 10),
} = {}) {
  const g2ctx = graph.dwIntelligenceContext({ actor, tenantId, clientId })

  // Determine context scope for conflict detection and founder decision filtering
  const contextScope = clientId
    ? { level: SEMANTIC_SCOPE.CLIENT, clientId }
    : { level: SEMANTIC_SCOPE.COMPANY }

  // Use resolvePolicy(topic=null) for consistent conflict detection — same CONTRACT detection
  // and SUPERSEDES application as resolvePolicy (Issue 4). topic=null skips founder decisions.
  const policyResolution = resolvePolicy(graph, brain, {
    actor, tenantId, scope: contextScope, topic: null, queryDate,
  })

  // All candidates from resolvePolicy (SUPERSEDES already applied, CONTRACT detection ran)
  const allCandidates = policyResolution.candidates

  // Split by scope for downstream consumers
  const clientCandidates = clientId
    ? allCandidates.filter((c) => c.scopeLevel === SEMANTIC_SCOPE.CLIENT)
    : []

  const applicablePolicyCandidates = allCandidates.filter(
    (c) =>
      c.candidateStatus === CANDIDATE_STATUS.ACTIVE &&
      c.temporalState !== TEMPORAL_STATE.FUTURE,
  )
  const excludedPolicyCandidates = allCandidates.filter(
    (c) =>
      c.candidateStatus !== CANDIDATE_STATUS.ACTIVE ||
      c.temporalState === TEMPORAL_STATE.FUTURE,
  )

  const clientExceptions = clientCandidates.filter(
    (c) => c.claimClass === CLAIM_CLASS.CLIENT_EXCEPTION,
  )

  // Precedence evidence: freshness-validated SUPERSEDES edges
  const precedenceEvidence = graph.edges
    .filter((e) => e.type === GRAPH_EDGE_TYPE.SUPERSEDES && isSupersessionStillValid(e, brain, tenantId))
    .map((e) => ({
      fromKey: e.fromKey,
      toKey: e.toKey,
      explicit: e.explicit,
      provenance: e.provenance,
    }))

  const hasUnknownTemporal = applicablePolicyCandidates.some(
    (c) => c.temporalState === TEMPORAL_STATE.UNKNOWN,
  )

  // G2 brain conflicts (raw, cross-topic, from durableStore.rebuildConflicts)
  const brainConflicts = brain.conflicts.filter(
    (c) => c.tenantId === tenantId && c.status === 'CONFLICTED',
  )

  // G3 policy conflicts: per-topic resolution to prevent cross-topic CONTRACT pairings
  // (e.g., COMPANY late_fee_policy vs CLIENT contract payment_terms). For every scope+topic,
  // DW Intelligence conflict state === resolvePolicy(scope, topic).detectedConflicts.
  const distinctTopics = [...new Set(allCandidates.map((c) => c.topic).filter(Boolean))]
  const seenConflictKeys = new Set()
  const unresolvedConflictKeys = new Set()
  const policyConflicts = []
  for (const t of distinctTopics) {
    const topicRes = resolvePolicy(graph, brain, {
      actor, tenantId, scope: contextScope, topic: t, queryDate,
    })
    for (const conflict of topicRes.detectedConflicts) {
      const key = `${conflict.conflictClass}:${[...conflict.candidateKeys].sort().join(',')}`
      if (!seenConflictKeys.has(key)) {
        seenConflictKeys.add(key)
        policyConflicts.push(conflict)
      }
    }
    for (const conflict of topicRes.unresolvedConflicts) {
      unresolvedConflictKeys.add(
        `${conflict.conflictClass}:${[...conflict.candidateKeys].sort().join(',')}`,
      )
    }
  }

  // Consume the exact per-topic resolver result instead of independently
  // re-deriving founder coverage. This is the canonical parity invariant.
  const unresolvedPolicyConflicts = policyConflicts.filter((conflict) =>
    unresolvedConflictKeys.has(
      `${conflict.conflictClass}:${[...conflict.candidateKeys].sort().join(',')}`,
    ),
  )

  // unresolvedConflicts kept as the G2 brain conflicts for backward compatibility
  const unresolvedConflicts = brainConflicts
  const hasConflicts = brainConflicts.length > 0 || unresolvedPolicyConflicts.length > 0
  const danglingProvenances = detectDanglingProvenance(brain, { tenantId })

  // Founder decisions: use evaluateFounderDecision with contextScope and active candidates (Issues 1, 5).
  // Only decisions valid for the context scope and with resolvable winner candidates are current.
  // Decisions that fail (revoked evidence, wrong scope, invalid governingClaimId) are invalidated.
  const evaluatedDecisions = (brain.decisions ?? []).map((d) => ({
    d,
    result: evaluateFounderDecision(d, {
      brain, tenantId, topic: null, scope: contextScope,
      candidates: applicablePolicyCandidates,
    }),
  }))
  const founderDecisions = evaluatedDecisions
    .filter(({ result }) => result.valid)
    .map(({ d }) => d)
  const invalidatedFounderDecisions = evaluatedDecisions
    .filter(({ d, result }) => d.tenantId === tenantId && !result.valid)
    .map(({ d, result }) => ({ ...d, invalidReason: result.reason }))

  const canActAutomatically = false // R9: always false

  let canActReason
  if (hasConflicts) {
    canActReason = 'unresolved policy conflicts must be resolved by founder decision (R8, R9)'
  } else if (hasUnknownTemporal) {
    canActReason = 'UNKNOWN temporal state on active candidates — cannot confirm currency (R5)'
  } else {
    canActReason = 'explicit founder decision required for all policy actions (R9)'
  }

  const temporalApplicability = {
    hasUnknownTemporal,
    hasCurrentCandidates: applicablePolicyCandidates.some(
      (c) => c.temporalState === TEMPORAL_STATE.CURRENT,
    ),
    unknownTemporalKeys: applicablePolicyCandidates
      .filter((c) => c.temporalState === TEMPORAL_STATE.UNKNOWN)
      .map((c) => c.graphNodeKey),
    currentKeys: applicablePolicyCandidates
      .filter((c) => c.temporalState === TEMPORAL_STATE.CURRENT)
      .map((c) => c.graphNodeKey),
    historicalKeys: excludedPolicyCandidates
      .filter((c) => c.candidateStatus === CANDIDATE_STATUS.HISTORICAL)
      .map((c) => c.graphNodeKey),
    futureKeys: excludedPolicyCandidates
      .filter((c) => c.temporalState === TEMPORAL_STATE.FUTURE)
      .map((c) => c.graphNodeKey),
  }

  return {
    kind: 'G3_DW_INTELLIGENCE_CONTEXT_V0',
    tenantId,
    graphVersion: g2ctx.graphVersion,
    queryDate,
    // G2 pass-through fields
    relationships: g2ctx.relationships,
    unresolvedIdentity: g2ctx.unresolvedIdentity,
    conflictLinks: g2ctx.conflictLinks,
    provenancePaths: g2ctx.provenancePaths,
    // G3 typed fields (G)
    applicablePolicyCandidates,
    excludedPolicyCandidates,
    clientExceptions,
    founderDecisions,
    invalidatedFounderDecisions,
    precedenceEvidence,
    temporalApplicability,
    danglingProvenance: danglingProvenances,
    conflictSummary: {
      hasUnresolvedConflicts: hasConflicts,
      conflictCount: brainConflicts.length + unresolvedPolicyConflicts.length,
      conflictTopics: [...new Set(brainConflicts.map((c) => c.topic))],
    },
    // G2 brain-level conflicts (raw, cross-topic)
    brainConflicts,
    // G3 policy conflicts — G3-classified from candidate reasoning
    policyConflicts,
    // Unresolved G3 policy conflicts (blocking, not covered by a valid founder decision)
    unresolvedPolicyConflicts,
    // Backward-compat alias
    unresolvedConflicts,
    uncertainty: {
      hasUnknownTemporal,
      hasUnresolvedConflicts: hasConflicts,
      hasDanglingProvenance: danglingProvenances.length > 0,
      hasAmbiguousIdentity: (g2ctx.unresolvedIdentity?.length ?? 0) > 0,
    },
    authorityBoundary: {
      canActAutomatically,
      reason: canActReason,
    },
    // Structural boundary constants — never negotiable (R0, R1, R2, R3, R7)
    boundaries: {
      canonicalMoneyWritable: false,
      authorityGrantable: false,
      policyConflictsResolvableByConfidence: false,
      observedDelegationIsAuthority: false,
      behaviorCreatesPolicy: false,
    },
  }
}
