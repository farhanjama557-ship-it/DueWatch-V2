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

import { GRAPH_EDGE_TYPE, SEMANTIC_SCOPE } from './graphStore.js'
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

// ── Internal helpers ──────────────────────────────────────────────────────────

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
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

  // SUPERSEDES edges from the live graph store (includes manually persisted edges)
  const supersededKeys = new Set(
    graph.edges
      .filter((e) => e.tenantId === tenantId && e.type === GRAPH_EDGE_TYPE.SUPERSEDES && e.active)
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
      topic: claim?.claimType ?? node.label ?? null,
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

// ── Core: Conflict classification ─────────────────────────────────────────────

/**
 * Classify conflicts among a set of policy candidates.
 *
 * Classification priority (per pair of ACTIVE candidates):
 *   1. SCOPE_ESCALATION — CLIENT-scoped candidate in COMPANY-scope request (R4)
 *   2. DANGLING_PROVENANCE — broken provenance chain (R6)
 *   3. CONFIDENCE_DISAGREEMENT — same value, different confidence; must not resolve (R1)
 *   4. FOUNDER_INSTRUCTION_VS_PRIOR_POLICY — FOUNDER_INSTRUCTION vs COMPANY_POLICY
 *   5. COMPANY_VS_CLIENT_EXCEPTION — scope mismatch (client rule vs company rule)
 *   6. CURRENT_VS_HISTORICAL — one HISTORICAL, one not
 *   7. OVERLAPPING_EFFECTIVE_PERIODS — both UNKNOWN temporal (open-ended windows)
 *   8. MISSING_PRECEDENCE — both CURRENT (or FUTURE) with no documented supersession (R8)
 *   9. SAME_SCOPE_INCOMPATIBLE_VALUES — general incompatible-value fallback
 *
 * @param {PolicyCandidate[]} candidates
 * @param {{ requestedScope?, snapshot?, edges? }} context
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

  // (2) DANGLING_PROVENANCE: broken evidence chain (R6)
  for (const c of candidates) {
    if (c.candidateStatus === CANDIDATE_STATUS.DANGLING) {
      conflicts.push({
        conflictClass: CONFLICT_CLASS.DANGLING_PROVENANCE,
        candidateKeys: [c.graphNodeKey],
        reason: `Candidate ${c.graphNodeKey} has broken provenance — cannot be used as evidence (R6)`,
      })
    }
  }

  // Pairwise classification among ACTIVE candidates only
  // (FUTURE candidates are present but excluded from resolution — R5)
  const active = candidates.filter(
    (c) =>
      c.candidateStatus === CANDIDATE_STATUS.ACTIVE &&
      c.temporalState !== TEMPORAL_STATE.FUTURE,
  )

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
      const aHist = a.temporalState === TEMPORAL_STATE.HISTORICAL
      const bHist = b.temporalState === TEMPORAL_STATE.HISTORICAL
      const aUnknown = a.temporalState === TEMPORAL_STATE.UNKNOWN
      const bUnknown = b.temporalState === TEMPORAL_STATE.UNKNOWN

      // (3) CONFIDENCE_DISAGREEMENT: same value, different confidence (R1: cannot resolve)
      const sameValue = stableStringify(a.value) === stableStringify(b.value)
      if (sameValue && a.confidence !== null && b.confidence !== null && a.confidence !== b.confidence) {
        conflicts.push({
          conflictClass: CONFLICT_CLASS.CONFIDENCE_DISAGREEMENT,
          candidateKeys: [a.graphNodeKey, b.graphNodeKey],
          reason: 'Candidates agree on policy value but have different confidence scores; confidence cannot be used to resolve (R1)',
        })
        continue
      }

      // (4) FOUNDER_INSTRUCTION_VS_PRIOR_POLICY
      if ((aIsFounder && bIsPolicy) || (aIsPolicy && bIsFounder)) {
        conflicts.push({
          conflictClass: CONFLICT_CLASS.FOUNDER_INSTRUCTION_VS_PRIOR_POLICY,
          candidateKeys: [a.graphNodeKey, b.graphNodeKey],
          reason: 'Founder instruction contradicts standing company policy — explicit founder decision required (R9)',
        })
        continue
      }

      // (5) COMPANY_VS_CLIENT_EXCEPTION (only when both reach the active set — structural gap)
      if ((aIsPolicy && bIsException) || (aIsException && bIsPolicy)) {
        conflicts.push({
          conflictClass: CONFLICT_CLASS.COMPANY_VS_CLIENT_EXCEPTION,
          candidateKeys: [a.graphNodeKey, b.graphNodeKey],
          reason: 'Company policy conflicts with client exception in scope (R4)',
        })
        continue
      }

      // (6) CURRENT_VS_HISTORICAL: one HISTORICAL, one not
      if ((aHist && !bHist) || (!aHist && bHist)) {
        conflicts.push({
          conflictClass: CONFLICT_CLASS.CURRENT_VS_HISTORICAL,
          candidateKeys: [a.graphNodeKey, b.graphNodeKey],
          reason: 'Both a historical and a current candidate are active for the same topic (R5)',
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
      if (!aUnknown && !bUnknown && !aHist && !bHist) {
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
 *   1. Build PolicyCandidate[] for the requested scope from G2 graph + brain
 *   2. Filter by topic (if specified)
 *   3. Apply SUPERSEDES edges from the live graph store (not just snapshot)
 *   4. Classify conflicts among non-superseded, non-historical, non-revoked candidates
 *   5. Status: NO_POLICY | RESOLVED | CONFLICTED | ABSTAIN
 *
 * Invariants enforced:
 *   - canActAutomatically: false always (R9)
 *   - canonicalMoneyWritable: false always (R0)
 *   - confidence never picks a winner (R1)
 *   - CLIENT-scoped candidates not included in COMPANY-scope resolution (R4, structural via G2)
 *   - HISTORICAL/EXPIRED/FUTURE candidates excluded from active resolution (R5)
 *   - Dangling provenance surfaced as DANGLING_PROVENANCE conflict class (R6)
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
  const allCandidates = buildPolicyCandidates(graph, brain, { actor, tenantId, scope, queryDate })
  const topicCandidates = topic ? allCandidates.filter((c) => c.topic === topic) : allCandidates

  // Collect SUPERSEDES edges for these candidates (live store, not just snapshot)
  const candidateKeys = new Set(topicCandidates.map((c) => c.graphNodeKey))
  const supersedesEdges = graph.edges.filter(
    (e) =>
      e.tenantId === tenantId &&
      e.type === GRAPH_EDGE_TYPE.SUPERSEDES &&
      e.active &&
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

  const conflicts = classifyConflicts(resolved, { requestedScope: scope })

  // Active candidates for resolution: ACTIVE status, not FUTURE, not HISTORICAL
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

  // Non-provenance conflicts that block resolution
  const blockingConflicts = conflicts.filter(
    (c) => c.conflictClass !== CONFLICT_CLASS.DANGLING_PROVENANCE,
  )

  let status
  let winner = null

  if (topicCandidates.length === 0) {
    status = G3_RESOLUTION_STATUS.NO_POLICY
  } else if (active.length === 0) {
    // All candidates are historical/superseded/revoked/dangling → no current policy can be stated
    status = G3_RESOLUTION_STATUS.ABSTAIN
  } else if (active.length === 1 && blockingConflicts.length === 0) {
    status = G3_RESOLUTION_STATUS.RESOLVED
    winner = active[0]
  } else {
    status = G3_RESOLUTION_STATUS.CONFLICTED
  }

  const snapshot = graph.requireSnapshot({ actor, tenantId })

  return {
    kind: 'G3_POLICY_RESOLUTION_V0',
    tenantId,
    topic,
    scope,
    queryDate,
    status,
    winner,
    candidates: resolved,
    conflicts,
    supersessionEvidence,
    hasUnknownTemporal,
    // Structural invariants — never negotiable
    canActAutomatically: false,
    canonicalMoneyWritable: false,
    authorityGrantable: false,
    policyPrecedenceResolved: status === G3_RESOLUTION_STATUS.RESOLVED && blockingConflicts.length === 0,
    graphVersion: snapshot.id,
    provenance: {
      rootSourceVersionIds: [
        ...new Set(topicCandidates.flatMap((c) => c.provenance.rootSourceVersionIds)),
      ],
    },
  }
}

// ── G3 DW Intelligence context ────────────────────────────────────────────────

/**
 * Build a G3-enhanced DW Intelligence context.
 *
 * Augments G2's `dwIntelligenceContext` with:
 *   - G3 temporal classification of all policy candidates
 *   - authorityBoundary.canActAutomatically: false (always — R9)
 *   - conflict summary with count of unresolved conflicts
 *   - dangling provenance findings (R6)
 *
 * canActAutomatically is false when:
 *   - any G2 conflict is unresolved (R8, R9)
 *   - any candidate has UNKNOWN temporal state (R5)
 *   - always per R9 (founder decisions must remain explicit and revocable)
 *
 * @param {CompanyGraphStore} graph
 * @param {CompanyBrainDurableStore} brain
 * @param {{ actor, tenantId, clientId?, queryDate? }} options
 * @returns {G3DwIntelligenceContext}
 */
export function buildG3DwIntelligenceContext(graph, brain, {
  actor,
  tenantId,
  clientId = null,
  queryDate = new Date().toISOString().slice(0, 10),
} = {}) {
  const g2ctx = graph.dwIntelligenceContext({ actor, tenantId, clientId })

  const companyCandidates = buildPolicyCandidates(graph, brain, {
    actor, tenantId, scope: { level: SEMANTIC_SCOPE.COMPANY }, queryDate,
  })
  const clientCandidates = clientId
    ? buildPolicyCandidates(graph, brain, {
        actor, tenantId, scope: { level: SEMANTIC_SCOPE.CLIENT, clientId }, queryDate,
      })
    : []
  const allCandidates = [...companyCandidates, ...clientCandidates]

  const hasUnknownTemporal = allCandidates.some((c) => c.temporalState === TEMPORAL_STATE.UNKNOWN)
  const unresolvedConflicts = brain.conflicts.filter(
    (c) => c.tenantId === tenantId && c.status === 'CONFLICTED',
  )
  const hasConflicts = unresolvedConflicts.length > 0
  const danglingProvenances = detectDanglingProvenance(brain, { tenantId })

  const canActAutomatically = false // R9: always false; founder decisions must be explicit

  let canActReason
  if (hasConflicts) canActReason = 'unresolved policy conflicts must be resolved by founder decision (R8, R9)'
  else if (hasUnknownTemporal) canActReason = 'UNKNOWN temporal state on active candidates — cannot confirm currency (R5)'
  else canActReason = 'explicit founder decision required for all policy actions (R9)'

  return {
    kind: 'G3_DW_INTELLIGENCE_CONTEXT_V0',
    tenantId,
    graphVersion: g2ctx.graphVersion,
    queryDate,
    relationships: g2ctx.relationships,
    unresolvedIdentity: g2ctx.unresolvedIdentity,
    conflictLinks: g2ctx.conflictLinks,
    provenancePaths: g2ctx.provenancePaths,
    policyCandidates: allCandidates,
    danglingProvenance: danglingProvenances,
    temporalSummary: {
      hasUnknownTemporal,
      unknownTemporalKeys: allCandidates
        .filter((c) => c.temporalState === TEMPORAL_STATE.UNKNOWN)
        .map((c) => c.graphNodeKey),
      currentKeys: allCandidates
        .filter((c) => c.temporalState === TEMPORAL_STATE.CURRENT)
        .map((c) => c.graphNodeKey),
    },
    conflictSummary: {
      hasUnresolvedConflicts: hasConflicts,
      conflictCount: unresolvedConflicts.length,
      conflictTopics: [...new Set(unresolvedConflicts.map((c) => c.topic))],
    },
    authorityBoundary: {
      canActAutomatically,
      reason: canActReason,
    },
    // Structural boundary constants — never negotiable (R0, R1, R7)
    boundaries: {
      canonicalMoneyWritable: false,
      authorityGrantable: false,
      policyConflictsResolvableByConfidence: false,
      observedDelegationIsAuthority: false,
    },
  }
}
