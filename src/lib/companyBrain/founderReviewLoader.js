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

function proposalFromRow(row) {
  return freeze({
    kind: 'DW_AUTHORITY_PROPOSAL_V0',
    id: row.id,
    tenantId: row.user_id,
    action: row.action_class ?? row.action ?? null,
    scope: row.scope || {},
    proposedConfiguration: row.proposed_configuration || {},
    status: row.status,
    authorityGranted: false,
    boundaries: { canExecute: false },
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

  const [operatingModel, grants, proposals, items, revisions, decisions] = await Promise.all([
    client.from('company_operating_model_proposals')
      .select('id, model_payload, source_state, status')
      .in('status', ['PROPOSED', 'BLOCKED'])
      .order('created_at', { ascending: false })
      .limit(1),
    client.from('company_brain_authority_grants_g5').select('*'),
    client.from('company_brain_authority_proposals').select('*'),
    client.from('company_brain_founder_review_items_g6').select('*'),
    client.from('company_brain_founder_review_revisions_g6').select('*'),
    client.from('company_brain_founder_decisions').select('*'),
  ])

  for (const result of [operatingModel, grants, proposals, items, revisions, decisions]) {
    if (result?.error) throw new Error(result.error.message || 'company brain review read failed')
  }

  const modelRow = (operatingModel.data || [])[0] || null
  const authorityReadModel = authorityReadModelFromRows({
    tenantId,
    grantRows: grants.data || [],
    proposalRows: proposals.data || [],
    evaluatedAt: generatedAt,
  })

  if (!modelRow && authorityReadModel.currentAuthorityGrants.length === 0 &&
      authorityReadModel.proposedAuthority.length === 0 && (items.data || []).length === 0) {
    return freeze({ readModel: null, actor, empty: true })
  }

  const asOfDate = modelRow?.source_state?.asOfDate || today(now)
  const derivedItems = modelRow
    ? buildFounderReviewItemsFromRecords({
      actor,
      tenantId,
      knowledge: { sources: [], claims: [], tombstones: [] },
      operatingModel: modelRow.model_payload,
      conflicts: [],
      founderDecisions: (decisions.data || []).map((row) => ({
        tenantId, targetId: row.target_id, id: row.id, decidedAt: row.created_at,
      })),
      authorityReadModel,
      asOfDate,
      generatedAt,
    })
    : buildFounderReviewItemsFromRecords({
      actor,
      tenantId,
      knowledge: { sources: [], claims: [], tombstones: [] },
      operatingModel: { tenantId, blockers: [], clientOverrides: [] },
      authorityReadModel,
      asOfDate,
      generatedAt,
    })

  const store = reviewStoreFromRows({
    tenantId, itemRows: items.data || [], revisionRows: revisions.data || [],
  })
  const state = deriveFounderReviewState({
    actor, tenantId, store, items: derivedItems, generatedAt, asOfDate,
  })
  return freeze({
    readModel: buildFounderReviewReadModel({
      actor, tenantId, state, authorityReadModel, store, consumer: 'FOUNDER_REVIEW_UI',
    }),
    actor,
    empty: false,
  })
}

/**
 * Records one founder review decision. It calls only the G6 review RPC, and so
 * cannot create, widen or refresh DW authority under any action.
 */
export async function submitFounderReviewDecision({
  client = defaultClient, item, action, expectedRevision, subjectFingerprint,
  reviewedValue, reason = null, idempotencyKey,
} = {}) {
  if (!item) throw new Error('founder review item required')
  if (!Object.values(REVIEW_ACTION).includes(action)) throw new Error('unknown founder review action')
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
    p_operating_model_id: item.operatingModelId ?? null,
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
