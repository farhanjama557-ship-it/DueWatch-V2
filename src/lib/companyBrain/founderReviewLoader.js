/**
 * M2G-G6 founder-review loader.
 *
 * Reads durable, tenant-scoped Company Brain state and hands it to the pure G6
 * derivation. Everything here is a read except the two explicit mutations the
 * founder can start from the review surface, and each of those is delegated to
 * the RPC that already owns it:
 *
 *   review decision  -> record_company_brain_founder_review_g6  (grants nothing)
 *   authority grant  -> grant_company_brain_authority_g5        (the only grant path)
 *   authority revoke -> revoke_company_brain_authority_g5
 *
 * The tenant is always the authenticated user id from the Supabase session.
 * A tenant id, founder flag or actor identity supplied by the caller, the UI,
 * a query string or a model is never trusted and never used.
 */

import { supabase as defaultClient } from '../supabase'
import {
  buildFounderReviewItemsFromRecords,
  buildFounderReviewReadModel,
  deriveFounderReviewState,
  FounderReviewStore,
  REVIEW_ACTION,
} from './founderReview'

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(freeze)
  return Object.freeze(value)
}

/** Trusted identity only: the authenticated session decides the tenant. */
export async function resolveReviewActor(client = defaultClient) {
  const { data, error } = await client.auth.getUser()
  if (error) throw new Error('company brain review requires an authenticated session')
  const user = data?.user
  if (!user?.id) throw new Error('company brain review requires an authenticated session')
  return freeze({ id: user.id, tenantId: user.id, role: 'FOUNDER', authenticated: true })
}

function grantFromRow(row) {
  return freeze({
    kind: 'DW_AUTHORITY_GRANT_V0',
    id: row.id,
    tenantId: row.user_id,
    action: row.action,
    scope: row.authority_scope,
    limits: { maxAmountMinor: row.amount_limit_minor ?? null, currency: row.currency ?? null },
    conditions: row.conditions || {},
    effectiveWindow: { effectiveFrom: row.effective_from, expiresAt: row.expires_at ?? null },
    channel: row.channel ?? null,
    approvalRequirement: row.approval_requirement,
    status: row.status,
    revision: row.revision,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
    revocationReason: row.revocation_reason ?? null,
  })
}

/**
 * company_brain_authority_proposals stores an action class, a scope and its
 * evidence claims. It carries no proposed-configuration column, so the
 * remaining G5 dimensions render as "not specified" rather than being invented
 * — an unspecified dimension must never read as an implied permission.
 */
function proposalFromRow(row) {
  return freeze({
    kind: 'DW_AUTHORITY_PROPOSAL_V0',
    id: row.id,
    tenantId: row.user_id,
    action: row.action_class ?? null,
    scope: row.authority_scope || {},
    proposedConfiguration: {},
    evidence: { claimIds: row.evidence_claim_ids || [] },
    status: row.status,
    authorityGranted: false,
    boundaries: { canExecute: false },
  })
}

/** Domain source shape, keyed by source version id exactly as G1 records it. */
function knowledgeFromRows({ tenantId, sourceRows, versionRows, claimRows, rootRows, tombstoneRows }) {
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]))
  const tombstonedSourceIds = new Set(tombstoneRows.map((row) => row.source_id))
  const rootsByClaim = new Map()
  for (const row of rootRows) {
    if (!rootsByClaim.has(row.claim_id)) rootsByClaim.set(row.claim_id, [])
    rootsByClaim.get(row.claim_id).push(row.source_version_id)
  }
  const sources = versionRows
    .filter((row) => row.status === 'ACTIVE')
    .map((row) => {
      const parent = sourceById.get(row.source_id) || null
      return freeze({
        id: row.id,
        tenantId,
        sourceType: parent?.source_type ?? null,
        trustZone: parent?.trust_zone ?? null,
        sourceTimestamp: row.source_timestamp ?? row.created_at ?? null,
        sourceVersion: String(row.version_number),
        contentHash: `sha256:${row.content_hash}`,
        active: parent ? parent.active !== false : false,
        revokedAt: parent?.revoked_at ?? null,
        revocationReason: parent?.revocation_reason ?? null,
      })
    })
  const claims = claimRows.map((row) => freeze({
    id: row.id,
    tenantId,
    claimType: row.claim_type,
    claimClass: row.claim_class,
    value: row.claim_value,
    active: row.active === true,
    derived: row.derived === true,
    explicit: row.explicit === true,
    confidence: row.confidence ?? null,
    provenanceRootIds: rootsByClaim.get(row.id) || [],
  }))
  // Resolve each tombstoned source to the exact source versions it covers, so
  // revoked material is recognised wherever evidence cites a version id.
  const tombstones = versionRows
    .filter((row) => tombstonedSourceIds.has(row.source_id))
    .map((row) => freeze({ tenantId, sourceId: row.source_id, sourceVersionId: row.id }))
  return freeze({ sources, claims, tombstones })
}

/**
 * Durable G3 conflicts with every competing side preserved, built from the
 * conflict rows, their members and those members' claims. Nothing is inferred:
 * a conflict is resolved only when the conflict row itself says so and names
 * the founder decision that resolved it.
 */
function conflictsFromRows({ tenantId, conflictRows, memberRows, claimRows }) {
  const claimById = new Map(claimRows.map((row) => [row.id, row]))
  const membersByConflict = new Map()
  for (const row of memberRows) {
    if (!membersByConflict.has(row.conflict_id)) membersByConflict.set(row.conflict_id, [])
    membersByConflict.get(row.conflict_id).push(row.claim_id)
  }
  return conflictRows
    // An INVALIDATED conflict is not a live disagreement; presenting one as
    // unresolved would overstate what actually needs the founder.
    .filter((row) => row.status === 'CONFLICTED' || row.status === 'RESOLVED')
    .map((row) => {
      const competingClaimIds = (membersByConflict.get(row.id) || []).slice().sort()
      return freeze({
        kind: 'COMPANY_BRAIN_CONFLICT_V0',
        id: row.id,
        tenantId,
        topic: row.topic,
        status: row.status,
        revision: row.revision ?? 0,
        competingClaimIds,
        scopes: competingClaimIds.map((claimId) => claimById.get(claimId)?.semantic_scope || {}),
        preservedValues: competingClaimIds.map((claimId) => claimById.get(claimId)?.claim_value ?? null),
        resolutionDecisionId: row.resolution_decision_id ?? null,
        winnerClaimId: null,
        confidenceResolved: false,
      })
    })
}

/**
 * Projects persisted G5 rows into the exact shape of the G5 read model. It
 * derives no authority of its own: a grant that is not GRANTED in the database
 * is reported in its own bucket, never as current.
 */
function authorityReadModelFromRows({ tenantId, grantRows, proposalRows, evaluatedAt }) {
  const grants = grantRows.map(grantFromRow)
  return freeze({
    kind: 'DW_AUTHORITY_READ_MODEL_V0',
    consumer: 'FOUNDER_REVIEW',
    tenantId,
    evaluatedAt,
    currentAuthorityGrants: grants.filter((grant) => grant.status === 'GRANTED'),
    proposedAuthority: proposalRows.map(proposalFromRow),
    revokedAuthority: grants.filter((grant) => grant.status === 'REVOKED').map((grant) => ({ grant, derivedReason: 'AUTHORITY_REVOKED' })),
    staleAuthority: grants.filter((grant) => grant.status === 'STALE').map((grant) => ({ grant, derivedReason: 'REVIEWED_DEPENDENCY_CHANGED' })),
    supersededAuthority: grants.filter((grant) => grant.status === 'SUPERSEDED').map((grant) => ({ grant, derivedReason: 'SUPERSEDED' })),
    invalidatedAuthority: grants.filter((grant) => grant.status === 'INVALIDATED').map((grant) => ({ grant, derivedReason: 'MALFORMED_GRANT' })),
    boundaries: {
      readOnly: true, canGrant: false, canRevoke: false, canExecute: false,
      modelOutputCanGrant: false, recommendationCanGrant: false, canonicalMoneyWritable: false,
    },
  })
}

function reviewStoreFromRows({ tenantId, itemRows, revisionRows }) {
  const store = new FounderReviewStore()
  const keyByItemId = new Map(itemRows.map((row) => [row.id, row.review_key]))
  for (const row of revisionRows) {
    const reviewKey = keyByItemId.get(row.review_item_id)
    if (!reviewKey) continue
    store.revisions.push(freeze({
      kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_REVISION_V0',
      id: row.id,
      tenantId,
      reviewKey,
      revision: row.revision,
      action: row.review_action,
      status: row.review_status,
      subjectFingerprint: row.subject_fingerprint,
      proposedValue: row.proposed_value ?? null,
      reviewedValue: row.reviewed_value ?? null,
      reason: row.reason ?? null,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      decidedAt: row.decided_at,
      supersedesRevisionId: row.supersedes_revision_id ?? null,
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      authorityGranted: false,
      authorityImpact: 'NONE',
      assertsInverseProposition: false,
      resolvesConflict: false,
      canonicalMoneyMutated: false,
      executed: false,
    }))
  }
  return store
}

function today(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

/**
 * Loads the founder-review read model for the authenticated tenant.
 * Returns `{ readModel: null }` for a tenant with no Company Brain material —
 * a legitimate empty state, never sample data. A failed read raises; the caller
 * renders the error state rather than an optimistic "reviewed".
 */
export async function loadFounderReviewReadModel({ client = defaultClient, now = new Date() } = {}) {
  const actor = await resolveReviewActor(client)
  const tenantId = actor.tenantId
  const generatedAt = now.toISOString()

  const reads = {
    operatingModel: client.from('company_operating_model_proposals')
      .select('id, model_payload, source_state, model_fingerprint, status')
      .in('status', ['PROPOSED', 'BLOCKED'])
      .order('created_at', { ascending: false })
      .limit(1),
    grants: client.from('company_brain_authority_grants_g5').select('*'),
    proposals: client.from('company_brain_authority_proposals').select('*'),
    items: client.from('company_brain_founder_review_items_g6').select('*'),
    revisions: client.from('company_brain_founder_review_revisions_g6').select('*'),
    decisions: client.from('company_brain_founder_decisions').select('*'),
    // G3 conflict intelligence and G2 evidence: without these the surface
    // would silently show zero conflicts and unattributed evidence.
    conflicts: client.from('company_brain_conflicts').select('*'),
    conflictMembers: client.from('company_brain_conflict_members').select('*'),
    claims: client.from('company_brain_claims').select('*'),
    claimRoots: client.from('company_brain_claim_roots').select('*'),
    sources: client.from('company_brain_sources').select('*'),
    sourceVersions: client.from('company_brain_source_versions').select('*'),
    tombstones: client.from('company_brain_source_tombstones').select('*'),
  }
  const names = Object.keys(reads)
  const settled = await Promise.all(names.map((name) => reads[name]))
  const rows = {}
  for (let index = 0; index < names.length; index += 1) {
    const result = settled[index]
    // A read that did not succeed fails the whole load. Rendering a partial
    // Company Brain would understate conflicts and overstate freshness.
    if (result?.error) {
      throw new Error(`company brain review read failed (${names[index]}): ${result.error.message || 'unknown error'}`)
    }
    rows[names[index]] = result?.data || []
  }

  const modelRow = rows.operatingModel[0] || null
  const authorityReadModel = authorityReadModelFromRows({
    tenantId,
    grantRows: rows.grants,
    proposalRows: rows.proposals,
    evaluatedAt: generatedAt,
  })

  const nothingStored = !modelRow &&
    authorityReadModel.currentAuthorityGrants.length === 0 &&
    authorityReadModel.proposedAuthority.length === 0 &&
    rows.conflicts.length === 0 &&
    rows.items.length === 0
  if (nothingStored) return freeze({ readModel: null, actor, empty: true })

  const asOfDate = modelRow?.source_state?.asOfDate || today(now)
  const knowledge = knowledgeFromRows({
    tenantId,
    sourceRows: rows.sources,
    versionRows: rows.sourceVersions,
    claimRows: rows.claims,
    rootRows: rows.claimRoots,
    tombstoneRows: rows.tombstones,
  })
  const conflicts = conflictsFromRows({
    tenantId,
    conflictRows: rows.conflicts,
    memberRows: rows.conflictMembers,
    claimRows: rows.claims,
  })
  // Only a decision a conflict row itself names as its resolution counts. G6
  // does not re-derive founder-decision validity; that is G3's to decide.
  const resolutionDecisionIds = new Set(conflicts.map((row) => row.resolutionDecisionId).filter(Boolean))
  const founderDecisions = rows.decisions
    .filter((row) => resolutionDecisionIds.has(row.id))
    .map((row) => freeze({
      tenantId,
      id: row.id,
      targetId: row.target_id,
      decidedAt: row.created_at,
      decisionType: row.decision_type,
      reason: row.reason,
    }))

  const derivedItems = buildFounderReviewItemsFromRecords({
    actor,
    tenantId,
    knowledge,
    operatingModel: modelRow?.model_payload || { tenantId, blockers: [], clientOverrides: [] },
    conflicts,
    founderDecisions,
    authorityReadModel,
    asOfDate,
    generatedAt,
  })

  const store = reviewStoreFromRows({
    tenantId, itemRows: rows.items, revisionRows: rows.revisions,
  })
  const state = deriveFounderReviewState({
    actor, tenantId, store, items: derivedItems, generatedAt, asOfDate,
  })
  return freeze({
    readModel: buildFounderReviewReadModel({
      actor, tenantId, state, authorityReadModel, store, consumer: 'FOUNDER_REVIEW_UI',
    }),
    actor,
    // The row id of the derivation the items were built from. A review write
    // must cite it so the server can check staleness against its own tables.
    operatingModelRowId: modelRow?.id ?? null,
    operatingModelFingerprint: modelRow?.model_fingerprint ?? null,
    empty: false,
  })
}

/** Outcomes the review RPC returns that are NOT a recorded founder decision. */
export const REVIEW_REJECTION_OUTCOMES = Object.freeze([
  'REJECTED_IDEMPOTENCY_CONFLICT',
  'REJECTED_STALE_REVISION',
  'REJECTED_SUBJECT_CHANGED',
  'REJECTED_ACTION_UNAVAILABLE',
])

/**
 * Records one founder review decision. It calls only the G6 review RPC, and so
 * cannot create, widen or refresh DW authority under any action.
 *
 * The RPC returns a rejection outcome rather than raising, so that a rejected
 * attempt stays durably auditable. That makes it this function's job to fail
 * closed: any outcome that is not an accepted or replayed decision is turned
 * into an error, so a refused write can never be rendered as approved.
 */
export async function submitFounderReviewDecision({
  client = defaultClient, item, action, expectedRevision, subjectFingerprint,
  reviewedValue, reason = null, idempotencyKey,
  operatingModelRowId = null, operatingModelFingerprint = null,
} = {}) {
  if (!item) throw new Error('founder review item required')
  if (!Object.values(REVIEW_ACTION).includes(action)) throw new Error('unknown founder review action')
  // The item must cite the upstream derivation it was built from; the server
  // re-reads that object to decide staleness for itself.
  const bindsOperatingModel = Boolean(item.sourceModelFingerprint)
  const { data, error } = await client.rpc('record_company_brain_founder_review_g6', {
    p_review_key: item.reviewKey,
    p_category: item.category,
    p_item_type: item.itemType,
    p_subject_type: item.subjectType,
    p_subject_id: item.subjectId,
    p_scope_level: item.scope?.level || 'COMPANY',
    p_review_scope: item.scope || {},
    p_client_id: item.clientId ?? null,
    p_conflict_id: item.conflictId ?? null,
    p_conflict_revision: item.conflictId ? (item.conflictRevision ?? 0) : null,
    p_operating_model_id: bindsOperatingModel ? operatingModelRowId : null,
    p_source_model_fingerprint: bindsOperatingModel ? operatingModelFingerprint : null,
    p_authority_proposal_id: item.authorityProposalId ?? null,
    p_authority_grant_id: item.authorityGrantId ?? null,
    p_review_action: action,
    p_expected_revision: expectedRevision,
    p_subject_fingerprint: subjectFingerprint,
    p_proposed_value: item.proposedValue ?? null,
    p_reviewed_value: action === REVIEW_ACTION.EDIT ? reviewedValue : null,
    p_reason: reason,
    p_evidence: (item.claims || []).map((claim) => ({
      claim_id: claim.claimId,
      source_version_id: (claim.rootSourceVersionIds || [])[0] ?? null,
    })).filter((entry) => entry.source_version_id),
    p_idempotency_key: idempotencyKey,
  })
  // A failed write is reported as a failure; it is never rendered as approved.
  if (error) throw new Error(error.message || 'founder review decision failed')
  const outcome = data?.outcome ?? null
  if (REVIEW_REJECTION_OUTCOMES.includes(outcome)) {
    const rejection = new Error(`founder review decision refused: ${outcome}`)
    rejection.outcome = outcome
    rejection.detail = data
    throw rejection
  }
  if (outcome !== 'ACCEPTED' && outcome !== 'IDEMPOTENT_REPLAY') {
    throw new Error('founder review decision returned an unrecognised outcome')
  }
  return freeze({ ...data, authorityGranted: false })
}

/**
 * Explicit authority grant. This is a pass-through to the G5 RPC and nothing
 * else: G6 defines no grant semantics of its own. Every G5 dimension must be
 * supplied explicitly — a missing dimension is refused here rather than
 * defaulted, so an omission can never widen into a wildcard.
 */
export async function requestAuthorityGrant({ client = defaultClient, grant } = {}) {
  if (!grant || grant.explicitGrant !== true) {
    throw new Error('an explicit authority-grant operation is required')
  }
  const required = ['action', 'scopeLevel', 'authorityScope', 'approvalRequirement', 'effectiveFrom', 'idempotencyKey']
  for (const field of required) {
    if (grant[field] == null || grant[field] === '') throw new Error(`authority grant requires an explicit ${field}`)
  }
  const { data, error } = await client.rpc('grant_company_brain_authority_g5', {
    p_idempotency_key: grant.idempotencyKey,
    p_grantee_type: 'DW',
    p_grantee_id: 'DUEWATCH',
    p_action: grant.action,
    p_scope_level: grant.scopeLevel,
    p_authority_scope: grant.authorityScope,
    p_client_id: grant.clientId ?? null,
    p_graph_version_id: grant.graphVersionId ?? null,
    p_entity_node_id: grant.entityNodeId ?? null,
    p_amount_limit_minor: grant.amountLimitMinor ?? null,
    p_currency: grant.currency ?? null,
    p_conditions: grant.conditions ?? {},
    p_effective_from: grant.effectiveFrom,
    p_expires_at: grant.expiresAt ?? null,
    p_channel: grant.channel ?? null,
    p_approval_requirement: grant.approvalRequirement,
    p_provenance: grant.provenance ?? [],
    p_reviewed_state: grant.reviewedState ?? {},
    p_brain_snapshot_id: grant.brainSnapshotId ?? null,
    p_policy_fingerprint: grant.policyFingerprint ?? null,
    p_operating_model_id: grant.operatingModelId ?? null,
    p_operating_model_fingerprint: grant.operatingModelFingerprint ?? null,
    p_graph_fingerprint: grant.graphFingerprint ?? null,
    p_proposal_id: grant.proposalId ?? null,
    p_supersedes_grant_id: grant.supersedesGrantId ?? null,
  })
  // A failed grant is never rendered as active authority.
  if (error) throw new Error(error.message || 'authority grant failed')
  return data
}

/** Explicit authority revocation. Pass-through to the G5 revocation RPC. */
export async function requestAuthorityRevocation({ client = defaultClient, grantId, idempotencyKey, reason } = {}) {
  if (!grantId || !idempotencyKey || !reason) {
    throw new Error('authority revocation requires a grant, an idempotency key and a reason')
  }
  const { data, error } = await client.rpc('revoke_company_brain_authority_g5', {
    p_grant_id: grantId,
    p_idempotency_key: idempotencyKey,
    p_reason: reason,
  })
  if (error) throw new Error(error.message || 'authority revocation failed')
  return data
}
