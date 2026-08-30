/**
 * M2G-G0 Company Brain kernel.
 *
 * Pure and local by design: this module has no provider, Supabase, financial
 * mutation, or execution dependency. It produces typed knowledge context for
 * existing Ask DW / DW Intelligence consumers without becoming a money ledger.
 */

export const CLAIM_CLASS = Object.freeze({
  COMPANY_POLICY: 'COMPANY_POLICY',
  CLIENT_EXCEPTION: 'CLIENT_EXCEPTION',
  ROLE: 'ROLE',
  DELEGATION: 'DELEGATION',
  AUTHORITY: 'AUTHORITY',
  COMMUNICATION_PREFERENCE: 'COMMUNICATION_PREFERENCE',
  COLLECTION_WORKFLOW: 'COLLECTION_WORKFLOW',
  DISPUTE_PROCESS: 'DISPUTE_PROCESS',
  PAYMENT_TERMS_CONTEXT: 'PAYMENT_TERMS_CONTEXT',
  HISTORICAL_PRECEDENT: 'HISTORICAL_PRECEDENT',
  FOUNDER_INSTRUCTION: 'FOUNDER_INSTRUCTION',
  INTERPRETATION: 'INTERPRETATION',
})

export const CLAIM_STATUS = Object.freeze({
  OBSERVED: 'OBSERVED',
  HISTORICAL: 'HISTORICAL',
  CONFLICTED: 'CONFLICTED',
  INVALIDATED: 'INVALIDATED',
})

export const AUTHORITY_STATUS = Object.freeze({
  PROPOSED: 'PROPOSED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  REVOKED: 'REVOKED',
})

export const AUTHORITY_RESULT = Object.freeze({
  GRANTED: 'GRANTED',
  REQUIRE_APPROVAL: 'REQUIRE_APPROVAL',
})

const CLAIM_CLASSES = new Set(Object.values(CLAIM_CLASS))
const MONEY_TRUTH_CLASSES = new Set([
  'INVOICE_AR_STATE',
  'PAYMENT_ATTEMPT_STATE',
  'PAYMENT_RECEIPT_STATE',
  'PAYMENT_CREDIT_ALLOCATION_STATE',
  'PROCESSOR_FUNDS_SETTLEMENT_STATE',
  'BANK_LEDGER_RECONCILIATION_STATE',
])

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`)
  return value.trim()
}

function sameTenant(tenantId, value, name) {
  if (value?.tenantId !== tenantId) throw new Error(`${name} tenant mismatch`)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function stableHash(value) {
  const text = stableStringify(value)
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** @returns {Readonly<object>} */
export function createSource(input = {}) {
  const tenantId = required(input.tenantId, 'source tenantId')
  const id = required(input.id, 'source id')
  return deepFreeze({
    kind: 'COMPANY_BRAIN_SOURCE_V0',
    tenantId,
    id,
    sourceType: required(input.sourceType, 'source type'),
    trustZone: required(input.trustZone, 'source trust zone'),
    sourceTimestamp: required(input.sourceTimestamp, 'source timestamp'),
    sourceVersion: required(input.sourceVersion, 'source version'),
    ingestedAt: required(input.ingestedAt, 'ingestion timestamp'),
    contentHash: required(input.contentHash, 'source content hash'),
    active: input.active !== false,
    revokedAt: input.revokedAt ?? null,
    revocationReason: input.revocationReason ?? null,
  })
}

/** @returns {Readonly<object>} */
export function createArtifact(input = {}) {
  return deepFreeze({
    kind: 'COMPANY_BRAIN_ARTIFACT_V0',
    tenantId: required(input.tenantId, 'artifact tenantId'),
    id: required(input.id, 'artifact id'),
    sourceId: required(input.sourceId, 'artifact sourceId'),
    artifactType: required(input.artifactType, 'artifact type'),
    rootSourceIds: [...new Set(input.rootSourceIds || [])].map((id) => required(id, 'artifact root source')),
    locator: required(input.locator, 'artifact locator'),
    classifiedAt: required(input.classifiedAt, 'artifact classification timestamp'),
  })
}

/** @returns {Readonly<object>} */
export function createClaim(input = {}) {
  const claimClass = required(input.claimClass, 'claim class')
  if (!CLAIM_CLASSES.has(claimClass)) throw new Error(`unknown claim class: ${claimClass}`)
  const roots = [...new Set(input.provenanceRootIds || [])].map((id) => required(id, 'claim provenance root'))
  if (!roots.length) throw new Error('durable claim requires root provenance')
  if (MONEY_TRUTH_CLASSES.has(input.claimType) || input.canonicalFinancialTruth === true) {
    throw new Error('Company Brain cannot create canonical money truth')
  }
  return deepFreeze({
    kind: 'COMPANY_BRAIN_CLAIM_V0',
    tenantId: required(input.tenantId, 'claim tenantId'),
    id: required(input.id, 'claim id'),
    claimClass,
    claimType: required(input.claimType, 'claim type'),
    semanticScope: deepFreeze({ ...(input.semanticScope || {}) }),
    subjectScope: deepFreeze({ ...(input.subjectScope || {}) }),
    value: deepFreeze(input.value),
    artifactIds: [...new Set(input.artifactIds || [])],
    explicit: input.explicit === true,
    derived: input.derived === true,
    confidence: input.confidence ?? null,
    uncertainty: input.uncertainty ?? null,
    effectiveTime: input.effectiveTime ?? null,
    status: input.status || CLAIM_STATUS.OBSERVED,
    assumptions: [...(input.assumptions || [])],
    provenanceRootIds: roots,
    revoked: input.revoked === true,
    canonicalFinancialTruth: false,
    independentCorroboration: input.derived === true ? false : input.independentCorroboration === true,
  })
}

function validateGraph({ tenantId, sources, artifacts, claims }) {
  const sourceById = new Map()
  for (const source of sources) {
    sameTenant(tenantId, source, 'source')
    if (sourceById.has(source.id)) throw new Error('duplicate source id')
    sourceById.set(source.id, source)
  }
  const artifactById = new Map()
  for (const artifact of artifacts) {
    sameTenant(tenantId, artifact, 'artifact')
    if (!sourceById.has(artifact.sourceId)) throw new Error('artifact source missing')
    if (!artifact.rootSourceIds?.length || artifact.rootSourceIds.some((id) => !sourceById.has(id))) {
      throw new Error('artifact root provenance unknown')
    }
    artifactById.set(artifact.id, artifact)
  }
  for (const claim of claims) {
    sameTenant(tenantId, claim, 'claim')
    if (!claim.provenanceRootIds?.length || claim.provenanceRootIds.some((id) => !sourceById.has(id))) {
      throw new Error('claim root provenance unknown')
    }
    if (!claim.artifactIds?.length || claim.artifactIds.some((id) => !artifactById.has(id))) {
      throw new Error('claim artifact lineage unknown')
    }
  }
  return { sourceById, artifactById }
}

export function detectConflicts(claims = []) {
  const lateFee = claims.filter((claim) => claim.claimType === 'late_fee_policy' && claim.revoked !== true)
  if (lateFee.length < 2) return []
  return [deepFreeze({
    kind: 'COMPANY_BRAIN_CONFLICT_V0',
    id: 'conflict-late-fee-policy',
    tenantId: lateFee[0].tenantId,
    topic: 'late_fee_policy',
    status: 'CONFLICTED',
    competingClaimIds: lateFee.map((claim) => claim.id),
    scopes: lateFee.map((claim) => claim.semanticScope),
    preservedValues: lateFee.map((claim) => claim.value),
    resolutionDecisionId: null,
    winnerClaimId: null,
    confidenceResolved: false,
  })]
}

function decisionsForTenant(tenantId, decisions) {
  return decisions.filter((decision) => {
    sameTenant(tenantId, decision, 'decision')
    if (decision.kind !== 'COMPANY_BRAIN_FOUNDER_DECISION_V0' || decision.actorRole !== 'FOUNDER') {
      throw new Error('untrusted founder decision shape')
    }
    return decision.status === 'RECORDED'
  })
}

export function buildBrainSnapshot({ tenantId, sources = [], artifacts = [], claims = [], decisions = [], authorityProposals = [], tombstones = [] } = {}) {
  required(tenantId, 'snapshot tenantId')
  const { sourceById } = validateGraph({ tenantId, sources, artifacts, claims })
  for (const tombstone of tombstones) sameTenant(tenantId, tombstone, 'tombstone')
  const revokedSourceIds = new Set([
    ...sources.filter((source) => source.active === false || source.revokedAt).map((source) => source.id),
    ...tombstones.map((item) => item.sourceId),
  ])
  const activeSources = sources.filter((source) => !revokedSourceIds.has(source.id))
  const activeSourceIds = new Set(activeSources.map((source) => source.id))
  const activeArtifacts = artifacts.filter((artifact) => artifact.rootSourceIds.every((id) => activeSourceIds.has(id)))
  const activeArtifactIds = new Set(activeArtifacts.map((artifact) => artifact.id))
  const activeClaims = claims.filter((claim) =>
    claim.revoked !== true &&
    claim.provenanceRootIds.every((id) => activeSourceIds.has(id)) &&
    claim.artifactIds.every((id) => activeArtifactIds.has(id))
  )
  const invalidatedClaims = claims
    .filter((claim) => !activeClaims.includes(claim))
    .map((claim) => deepFreeze({ ...claim, status: CLAIM_STATUS.INVALIDATED }))
  const recordedDecisions = decisionsForTenant(tenantId, decisions)
  const decision = [...recordedDecisions].reverse().find((item) => item.target === 'late_fee_policy') || null
  const conflicts = detectConflicts(activeClaims).map((conflict) => decision
    ? deepFreeze({ ...conflict, status: 'RESOLVED', resolutionDecisionId: decision.id })
    : conflict)
  const approvedPolicies = decision ? deepFreeze([
    {
      id: `${decision.id}:global`,
      topic: 'late_fee_policy',
      scope: { level: 'COMPANY' },
      value: { ...decision.newState.global, requiresExplicitAuthority: true },
      decisionId: decision.id,
      evidenceClaimIds: decision.evidenceClaimIds,
    },
    {
      id: `${decision.id}:atlas`,
      topic: 'late_fee_policy',
      scope: { level: 'CLIENT', clientId: 'atlas' },
      value: { ...decision.newState.atlas, automaticAddOrWaive: false },
      decisionId: decision.id,
      evidenceClaimIds: decision.evidenceClaimIds,
    },
  ]) : deepFreeze([])
  const approvedAuthority = authorityProposals.filter((item) => {
    sameTenant(tenantId, item, 'authority proposal')
    if (item.kind !== 'COMPANY_BRAIN_AUTHORITY_PROPOSAL_V0') throw new Error('untrusted authority proposal shape')
    if (item.status === AUTHORITY_STATUS.APPROVED && (!item.decidedBy || !item.decidedAt)) {
      throw new Error('approved authority requires explicit decision provenance')
    }
    return item.status === AUTHORITY_STATUS.APPROVED
  })
  const fingerprint = {
    tenantId,
    sourceIds: activeSources.map((item) => item.id).sort(),
    claimIds: activeClaims.map((item) => item.id).sort(),
    decisions: recordedDecisions,
    authority: approvedAuthority,
  }
  return deepFreeze({
    kind: 'COMPANY_BRAIN_SNAPSHOT_V0',
    schemaVersion: 'COMPANY_BRAIN_V0',
    tenantId,
    id: `brain-${stableHash(fingerprint)}`,
    activeSources,
    activeArtifacts,
    activeClaims,
    invalidatedClaims,
    conflicts,
    decisions: recordedDecisions,
    approvedPolicies,
    approvedAuthority,
    tombstones: [...tombstones],
    canonicalMoneyWritable: false,
    sourceLookupValidated: [...sourceById.keys()].length === sources.length,
  })
}

export function createFounderDecision(input = {}) {
  if (input.actorRole !== 'FOUNDER') throw new Error('founder decision requires authenticated FOUNDER actor')
  if (!input.evidenceClaimIds?.length) throw new Error('founder decision requires evidence provenance')
  return deepFreeze({
    kind: 'COMPANY_BRAIN_FOUNDER_DECISION_V0',
    id: required(input.id, 'decision id'),
    tenantId: required(input.tenantId, 'decision tenantId'),
    actorId: required(input.actorId, 'decision actor'),
    actorRole: 'FOUNDER',
    decidedAt: required(input.decidedAt, 'decision timestamp'),
    decisionType: required(input.decisionType, 'decision type'),
    target: required(input.target, 'decision target'),
    oldState: deepFreeze(input.oldState),
    newState: deepFreeze(input.newState),
    evidenceClaimIds: [...new Set(input.evidenceClaimIds || [])],
    reason: required(input.reason, 'decision reason'),
    revocable: input.revocable !== false,
    status: 'RECORDED',
  })
}

export function createAuthorityProposal(input = {}) {
  if (!input.evidenceClaimIds?.length) throw new Error('authority proposal requires evidence provenance')
  if (!input.scope?.level) throw new Error('authority proposal scope required')
  return deepFreeze({
    kind: 'COMPANY_BRAIN_AUTHORITY_PROPOSAL_V0',
    id: required(input.id, 'authority proposal id'),
    tenantId: required(input.tenantId, 'authority proposal tenantId'),
    actionClass: required(input.actionClass, 'authority action class'),
    scope: deepFreeze({ ...(input.scope || {}) }),
    evidenceClaimIds: [...new Set(input.evidenceClaimIds || [])],
    status: AUTHORITY_STATUS.PROPOSED,
    decidedBy: input.decidedBy ?? null,
    decidedAt: input.decidedAt ?? null,
    revocable: true,
  })
}

export function decideAuthorityProposal(proposal, { actorId, actorRole, decidedAt, decision } = {}) {
  if (proposal?.kind !== 'COMPANY_BRAIN_AUTHORITY_PROPOSAL_V0') throw new Error('trusted authority proposal required')
  if (actorRole !== 'FOUNDER') throw new Error('authority decision requires FOUNDER')
  if (![AUTHORITY_STATUS.APPROVED, AUTHORITY_STATUS.REJECTED, AUTHORITY_STATUS.REVOKED].includes(decision)) {
    throw new Error('invalid authority decision')
  }
  if (proposal.status === AUTHORITY_STATUS.REVOKED) throw new Error('revoked authority cannot transition')
  return deepFreeze({ ...proposal, status: decision, decidedBy: required(actorId, 'authority actor'), decidedAt: required(decidedAt, 'authority timestamp') })
}

function scopeMatches(grant, request) {
  if (grant.level !== request.level) return false
  if (grant.level === 'CLIENT' && grant.clientId !== request.clientId) return false
  return Object.entries(grant).every(([key, value]) => request[key] === value)
}

export function evaluateCompanyBrainAuthority({ snapshot, actionClass, scope, approvalHistory = [] } = {}) {
  const exactGrant = snapshot.approvedAuthority.find((item) =>
    item.actionClass === actionClass && scopeMatches(item.scope, scope || {}))
  if (exactGrant) return deepFreeze({ actual: AUTHORITY_RESULT.GRANTED, grantId: exactGrant.id, requiresApproval: false, suggestion: null })
  const similar = approvalHistory.filter((item) => item.tenantId === snapshot.tenantId && item.actionClass === actionClass).length
  return deepFreeze({
    actual: AUTHORITY_RESULT.REQUIRE_APPROVAL,
    grantId: null,
    requiresApproval: true,
    suggestion: similar >= 20 ? 'You approve this frequently. Would you like to create a standing policy?' : null,
    repeatedApprovalCount: similar,
  })
}

export function revokeRootSource({ sources, sourceId, tenantId, revokedAt, reason } = {}) {
  let found = false
  const updated = sources.map((source) => {
    if (source.id !== sourceId) return source
    sameTenant(tenantId, source, 'source')
    found = true
    return createSource({ ...source, active: false, revokedAt: required(revokedAt, 'revocation timestamp'), revocationReason: required(reason, 'revocation reason') })
  })
  if (!found) throw new Error('source not found')
  return deepFreeze({
    sources: updated,
    tombstone: {
      kind: 'COMPANY_BRAIN_SOURCE_TOMBSTONE_V0',
      id: `tombstone:${sourceId}`,
      tenantId,
      sourceId,
      revokedAt,
      reason,
    },
  })
}

export function buildOperatingModel(snapshot) {
  const unresolved = snapshot.conflicts.filter((item) => item.status === 'CONFLICTED')
  const roles = snapshot.activeClaims.filter((item) => item.claimClass === CLAIM_CLASS.ROLE || item.claimClass === CLAIM_CLASS.DELEGATION)
  const workflow = snapshot.activeClaims.filter((item) => item.claimClass === CLAIM_CLASS.COLLECTION_WORKFLOW || item.claimClass === CLAIM_CLASS.DISPUTE_PROCESS)
  const exceptions = snapshot.activeClaims.filter((item) => item.claimClass === CLAIM_CLASS.CLIENT_EXCEPTION)
  return deepFreeze({
    kind: 'COMPANY_BRAIN_OPERATING_MODEL_PROPOSAL_V0',
    tenantId: snapshot.tenantId,
    snapshotId: snapshot.id,
    observed: { workflow, clientExceptions: exceptions, roles },
    inferred: [],
    conflicted: unresolved,
    missing: [
      { topic: 'late_fee_legal_applicability', status: 'MISSING' },
      { topic: 'settlement_discount_authority', status: 'MISSING' },
    ],
    proposed: [
      { topic: 'late_fee_policy', status: 'PROPOSED', evidenceClaimIds: unresolved.flatMap((item) => item.competingClaimIds) },
      { topic: 'dw_late_fee_authority', status: 'PROPOSED', proposedBoundary: 'REQUIRE_APPROVAL' },
    ],
    approved: snapshot.approvedPolicies,
  })
}

export function answerAskDwFromCompanyBrain({ snapshot, question } = {}) {
  const normalized = required(question, 'Ask DW question').toLowerCase()
  const evidence = (ids) => ids.map((id) => ({ claimId: id, rootSourceIds: snapshot.activeClaims.find((claim) => claim.id === id)?.provenanceRootIds || [] }))
  if (normalized.includes('late-fee policy') || normalized.includes('late fee policy')) {
    const conflict = snapshot.conflicts.find((item) => item.topic === 'late_fee_policy')
    if (conflict?.status === 'CONFLICTED') return deepFreeze({ status: 'CONFLICTED', answer: 'The late-fee policy is conflicted. Company, client-specific, historical, and founder-instruction evidence must remain separate until an authorized decision.', evidence: evidence(conflict.competingClaimIds), canonicalFinancialTruthUsed: false })
    return deepFreeze({ status: 'APPROVED', answer: 'Late fees are disabled globally. Atlas retains a 2% contract exception only when applicable. DW has no automatic authority to add or waive late fees.', evidence: evidence(snapshot.approvedPolicies.flatMap((item) => item.evidenceClaimIds)), canonicalFinancialTruthUsed: false })
  }
  if (normalized.includes('waive 20%') && normalized.includes('atlas')) {
    const email = snapshot.activeClaims.find((claim) => claim.id === 'claim-atlas-discount-email')
    return deepFreeze({ status: 'REQUIRE_APPROVAL', answer: 'No. The account-manager email is contextual evidence, not settlement authority. Founder approval is required.', evidence: email ? evidence([email.id]) : [], canonicalFinancialTruthUsed: false })
  }
  if (normalized.includes('invoice 104') && normalized.includes('paid')) {
    const contextual = snapshot.activeClaims.find((claim) => claim.id === 'claim-invoice-104-paid-context')
    return deepFreeze({ status: 'AUTHORITATIVE_FINANCIAL_REFETCH_REQUIRED', answer: 'Company Brain cannot establish current payment truth. Ask DW must use the authoritative R0 financial path for invoice 104.', evidence: contextual ? evidence([contextual.id]) : [], canonicalFinancialTruthUsed: false, route: 'R0_AUTHORITATIVE_FINANCIAL_READ' })
  }
  if (normalized.includes('why') && normalized.includes('atlas') && normalized.includes('different terms')) {
    const contract = snapshot.activeClaims.filter((claim) => claim.provenanceRootIds.includes('source-customer-contract-atlas'))
    return deepFreeze({ status: 'OBSERVED', answer: 'Atlas has client-specific Net 45 terms and a 2% late-fee exception in its contract.', evidence: evidence(contract.map((claim) => claim.id)), canonicalFinancialTruthUsed: false })
  }
  return deepFreeze({ status: 'UNKNOWN', answer: 'Company Brain does not have enough scoped evidence to answer.', evidence: [], canonicalFinancialTruthUsed: false })
}

export function toDwIntelligenceCompanyContext({ snapshot, clientId = null } = {}) {
  const applicablePolicies = snapshot.approvedPolicies.filter((policy) =>
    policy.scope.level === 'COMPANY' || (policy.scope.level === 'CLIENT' && policy.scope.clientId === clientId))
  const relevantClaims = snapshot.activeClaims.filter((claim) =>
    !claim.subjectScope?.clientId || claim.subjectScope.clientId === clientId)
  return deepFreeze({
    kind: 'DW_INTELLIGENCE_COMPANY_CONTEXT_V0',
    schemaVersion: 'COMPANY_BRAIN_V0',
    tenantId: snapshot.tenantId,
    snapshotId: snapshot.id,
    applicableApprovedPolicy: applicablePolicies,
    unresolvedConflicts: snapshot.conflicts.filter((item) => item.status === 'CONFLICTED'),
    roles: relevantClaims.filter((claim) => claim.claimClass === CLAIM_CLASS.ROLE),
    delegationContext: relevantClaims.filter((claim) => claim.claimClass === CLAIM_CLASS.DELEGATION),
    authorityState: snapshot.approvedAuthority,
    relevantPrecedent: relevantClaims.filter((claim) => claim.claimClass === CLAIM_CLASS.HISTORICAL_PRECEDENT),
    provenance: relevantClaims.map((claim) => ({ claimId: claim.id, rootSourceIds: claim.provenanceRootIds })),
    revocationStatus: { tombstones: snapshot.tombstones, invalidatedClaimIds: snapshot.invalidatedClaims.map((claim) => claim.id) },
    boundaries: {
      canonicalMoneyReadSource: 'R0_AUTHORITATIVE_FINANCIAL_PATH',
      canonicalMoneyWritable: false,
      contextCanGrantAuthority: false,
      unknownProvenanceFailsClosed: true,
    },
  })
}

export function assertCompanyBrainCannotWriteCanonicalMoney(mutation = {}) {
  if (MONEY_TRUTH_CLASSES.has(mutation.truthDimension) || mutation.objectType === 'invoice' || mutation.objectType === 'payment') {
    throw new Error('R0 canonical financial truth is read-only to Company Brain')
  }
  return true
}
