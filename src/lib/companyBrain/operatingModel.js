/**
 * M2G-G4 Company Operating Model.
 *
 * This layer describes evidence-backed AR operations. It consumes frozen G2/G3
 * truth and cannot approve policy, grant authority, execute actions, or write
 * canonical financial state.
 */

import crypto from 'node:crypto'

import { CLAIM_CLASS } from './index.js'
import { GRAPH_NODE_TYPE, SEMANTIC_SCOPE } from './graphStore.js'
import {
  G3_RESOLUTION_STATUS,
  TEMPORAL_STATE,
  classifyTemporalState,
  resolvePolicy,
} from './policyIntelligence.js'

export const OPERATING_STATEMENT_STATE = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  OBSERVED: 'OBSERVED',
  PROPOSED: 'PROPOSED',
  UNRESOLVED: 'UNRESOLVED',
  CONFLICTED: 'CONFLICTED',
  HISTORICAL_ONLY: 'HISTORICAL_ONLY',
})

export const OPERATING_MODEL_STATUS = Object.freeze({
  PROPOSED: 'PROPOSED',
  BLOCKED: 'BLOCKED',
  STALE: 'STALE',
  SUPERSEDED: 'SUPERSEDED',
})

const POLICY_CLASSES = new Set([
  CLAIM_CLASS.COMPANY_POLICY,
  CLAIM_CLASS.CLIENT_EXCEPTION,
  CLAIM_CLASS.FOUNDER_INSTRUCTION,
])

const SECTION_BY_CLAIM_TYPE = Object.freeze({
  reminder_cadence: ['collections', 'reminders'],
  workflow_record: ['collections'],
  payment_terms: ['billing', 'clientHandling'],
  contract_record: ['billing', 'clientHandling'],
  dispute_process: ['disputes', 'escalation'],
  settlement_discount_statement: ['communication'],
  interaction_record: ['communication'],
  contextual_payment_statement: ['communication'],
  payment_behavior_context: ['clientHandling'],
  precedent_record: ['clientHandling'],
  role: ['rolesAndResponsibilities'],
  role_record: ['rolesAndResponsibilities'],
  delegation: ['rolesAndResponsibilities'],
  observed_delegation_record: ['rolesAndResponsibilities'],
})

function assertActor(actor, tenantId) {
  if (!actor?.authenticated || !actor.id) throw new Error('authenticated actor required')
  if (actor.tenantId !== tenantId) throw new Error('actor tenant mismatch')
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex')
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(freeze)
  return Object.freeze(value)
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => value != null))].sort()
}

function isCanonicalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function scopeOf(claim) {
  return freeze({ ...(claim.semanticScope || { level: SEMANTIC_SCOPE.COMPANY }) })
}

function statementId({ topic, state, scope, clientId, roleId, sourceClaimIds, value, effectiveTime, temporalState }) {
  return `operating-statement-${hash({
    topic, state, scope, clientId, roleId, sourceClaimIds, value, effectiveTime, temporalState,
  }).slice(0, 24)}`
}

function graphKeysForClaims(graphSnapshot, claimIds) {
  const wanted = new Set(claimIds)
  return sortedUnique(
    graphSnapshot.nodes
      .filter((node) =>
        node.active && node.provenance?.claimIds?.some((claimId) => wanted.has(claimId)),
      )
      .map((node) => node.stableKey),
  )
}

function claimStatement(claim, graphSnapshot, state, explanation, temporalState) {
  const sourceClaimIds = [claim.id]
  const scope = scopeOf(claim)
  const effectiveTime = claim.effectiveTime ? freeze({ ...claim.effectiveTime }) : null
  const currentApplicable = state === OPERATING_STATEMENT_STATE.CONFIRMED && temporalState === TEMPORAL_STATE.CURRENT
  return freeze({
    kind: 'OPERATING_MODEL_STATEMENT_V0',
    id: statementId({
      topic: claim.claimType,
      state,
      scope,
      clientId: scope.clientId,
      roleId: scope.roleId,
      sourceClaimIds,
      value: claim.value,
      effectiveTime,
      temporalState,
    }),
    topic: claim.claimType,
    value: claim.value,
    state,
    effectiveTime,
    temporalState,
    currentApplicable,
    scope,
    clientId: scope.clientId ?? claim.subjectScope?.clientId ?? null,
    roleId: scope.roleId ?? claim.subjectScope?.roleId ?? claim.value?.roleId ?? null,
    sourceClaimIds,
    sourceGraphNodeKeys: graphKeysForClaims(graphSnapshot, sourceClaimIds),
    rootSourceVersionIds: sortedUnique(claim.provenanceRootIds || []),
    policyResolutionStatus: null,
    conflictKeys: [],
    derived: claim.derived === true,
    explicit: claim.explicit === true,
    confidence: claim.confidence ?? null,
    explanation,
    founderReviewRequired: false,
  })
}

function policyStatement(resolution, graphSnapshot) {
  const evidenceCandidates = resolution.status === G3_RESOLUTION_STATUS.RESOLVED && resolution.winner
    ? [resolution.winner]
    : resolution.candidates
  const sourceClaimIds = sortedUnique(evidenceCandidates.map((candidate) => candidate.claimId))
  const rootSourceVersionIds = sortedUnique(
    evidenceCandidates.flatMap((candidate) => candidate.provenance?.rootSourceVersionIds || []),
  )
  const conflictKeys = sortedUnique(
    resolution.unresolvedConflicts.map((conflict) =>
      `${conflict.conflictClass}:${[...conflict.candidateKeys].sort().join(',')}`,
    ),
  )
  let state
  if (resolution.status === G3_RESOLUTION_STATUS.CONFLICTED) state = OPERATING_STATEMENT_STATE.CONFLICTED
  else if (resolution.status === G3_RESOLUTION_STATUS.ABSTAIN || resolution.hasUnknownTemporal) {
    state = OPERATING_STATEMENT_STATE.UNRESOLVED
  } else state = OPERATING_STATEMENT_STATE.CONFIRMED
  const value = state === OPERATING_STATEMENT_STATE.CONFIRMED ? resolution.winner?.value ?? null : null
  const effectiveTime = resolution.winner?.effectiveTime
    ? freeze({ ...resolution.winner.effectiveTime })
    : null
  const candidateTemporalStates = sortedUnique(
    evidenceCandidates.map((candidate) => candidate.temporalState),
  )
  const temporalState = resolution.winner?.temporalState ?? (
    candidateTemporalStates.length === 1 ? candidateTemporalStates[0] : TEMPORAL_STATE.UNKNOWN
  )
  const scope = freeze({ ...resolution.scope })
  const explanation = state === OPERATING_STATEMENT_STATE.CONFIRMED
    ? `G3 resolved ${resolution.topic} for the exact ${scope.level} scope.`
    : `G3 returned ${resolution.status}${resolution.hasUnknownTemporal ? ' with unknown temporal applicability' : ''}; G4 preserves the unresolved state.`
  return freeze({
    kind: 'OPERATING_MODEL_STATEMENT_V0',
    id: statementId({
      topic: resolution.topic,
      state,
      scope,
      clientId: scope.clientId,
      sourceClaimIds,
      value,
      effectiveTime,
      temporalState,
    }),
    topic: resolution.topic,
    value,
    state,
    effectiveTime,
    temporalState,
    currentApplicable: state === OPERATING_STATEMENT_STATE.CONFIRMED && temporalState === TEMPORAL_STATE.CURRENT,
    scope,
    clientId: scope.clientId ?? null,
    roleId: null,
    sourceClaimIds,
    sourceGraphNodeKeys: graphKeysForClaims(graphSnapshot, sourceClaimIds),
    rootSourceVersionIds,
    policyResolutionStatus: resolution.status,
    conflictKeys,
    derived: true,
    explicit: resolution.winner?.explicit === true,
    confidence: resolution.winner?.confidence ?? null,
    explanation,
    founderReviewRequired: state !== OPERATING_STATEMENT_STATE.CONFIRMED,
  })
}

function unresolvedQuestion(statement) {
  const label = statement.clientId ? ` for client ${statement.clientId}` : ''
  return freeze({
    id: `operating-question-${hash({ statementId: statement.id }).slice(0, 24)}`,
    topic: statement.topic,
    scope: statement.scope,
    whyUnresolved: statement.explanation,
    sourceClaimIds: statement.sourceClaimIds,
    conflictKeys: statement.conflictKeys,
    suggestedFounderReviewQuestion:
      `What should govern ${statement.topic}${label}, and which cited evidence establishes precedence and effective time?`,
  })
}

function missingQuestion(topic, scope = { level: SEMANTIC_SCOPE.COMPANY }) {
  return freeze({
    id: `operating-question-${hash({ topic, scope, missing: true }).slice(0, 24)}`,
    topic,
    scope: freeze({ ...scope }),
    whyUnresolved: 'No active, provenance-backed evidence describes this operating area.',
    sourceClaimIds: [],
    conflictKeys: [],
    suggestedFounderReviewQuestion: `How does the company handle ${topic.replaceAll('_', ' ')}?`,
  })
}

function semanticProposal(proposal) {
  const {
    generatedAt: _generatedAt,
    proposalId: _proposalId,
    revision: _revision,
    fingerprint: _fingerprint,
    storageRevision: _storageRevision,
    persistedAt: _persistedAt,
    supersededByProposalId: _supersededByProposalId,
    invalidatedAt: _invalidatedAt,
    status: _lifecycleStatus,
    ...semantic
  } = proposal
  return {
    ...semantic,
    status: proposal.blockers?.length
      ? OPERATING_MODEL_STATUS.BLOCKED
      : OPERATING_MODEL_STATUS.PROPOSED,
  }
}

function validateProposal(proposal) {
  if (proposal?.kind !== 'COMPANY_OPERATING_MODEL_PROPOSAL_V0') throw new Error('trusted G4 proposal required')
  if (!isCanonicalDate(proposal.asOfDate)) throw new Error('valid operating model as-of date required')
  if (proposal.sourceState?.asOfDate !== proposal.asOfDate) throw new Error('operating model as-of state mismatch')
  if (proposal.revision !== proposal.sourceState?.knowledgeVersion) throw new Error('operating model revision/source mismatch')
  const b = proposal.boundaries || {}
  if (
    b.canonicalMoneyWritable !== false ||
    b.authorityGrantable !== false ||
    b.canActAutomatically !== false ||
    b.operatingModelApproved !== false ||
    b.observedDelegationIsAuthority !== false ||
    b.dwAuthorityDerived !== false
  ) throw new Error('G4 safety boundaries required')
  const sectionNames = [
    'collections', 'billing', 'reminders', 'promisesToPay', 'escalation', 'disputes',
    'clientHandling', 'rolesAndResponsibilities', 'communication', 'policyOperatingRules',
  ]
  const statements = [
    ...sectionNames.flatMap((name) => proposal[name] || []),
    ...(proposal.clientOverrides || []).flatMap((entry) => entry.statements || []),
  ]
  for (const statement of statements) {
    if (statement?.kind !== 'OPERATING_MODEL_STATEMENT_V0') throw new Error('invalid operating statement')
    if (!Object.values(TEMPORAL_STATE).includes(statement.temporalState)) {
      throw new Error('operating statement temporal state required')
    }
    if (statement.currentApplicable !== (
      statement.state === OPERATING_STATEMENT_STATE.CONFIRMED &&
      statement.temporalState === TEMPORAL_STATE.CURRENT
    )) throw new Error('operating statement temporal applicability mismatch')
    if (
      (statement.state === OPERATING_STATEMENT_STATE.CONFIRMED || statement.currentApplicable) &&
      (!statement.sourceClaimIds?.length ||
        !statement.sourceGraphNodeKeys?.length ||
        !statement.rootSourceVersionIds?.length)
    ) throw new Error('current operating statement requires exact provenance')
    if (statement.state === OPERATING_STATEMENT_STATE.CONFIRMED || statement.currentApplicable) {
      const evidence = statement.sourceClaimIds.map((claimId) => proposal.evidenceIndex?.[claimId])
      if (evidence.some((entry) => !entry || entry.active !== true)) {
        throw new Error('current operating statement requires indexed evidence')
      }
      const indexedRoots = sortedUnique(evidence.flatMap((entry) => entry.rootSourceVersionIds || []))
      const indexedNodes = sortedUnique(evidence.flatMap((entry) => entry.graphNodeKeys || []))
      if (stable(indexedRoots) !== stable(sortedUnique(statement.rootSourceVersionIds))) {
        throw new Error('operating statement root provenance mismatch')
      }
      if (stable(indexedNodes) !== stable(sortedUnique(statement.sourceGraphNodeKeys))) {
        throw new Error('operating statement graph provenance mismatch')
      }
    }
  }
  const recomputed = hash(semanticProposal(proposal))
  if (proposal.fingerprint !== recomputed) throw new Error('operating model semantic fingerprint mismatch')
  if (proposal.proposalId !== `operating-model-${recomputed.slice(0, 24)}`) {
    throw new Error('operating model proposal identity mismatch')
  }
  return true
}

/** Build a deterministic, unapproved proposal from the current G2/G3 state. */
export function buildOperatingModelProposal({
  actor,
  tenantId,
  brain,
  graph,
  queryDate = new Date().toISOString().slice(0, 10),
  generatedAt = new Date().toISOString(),
} = {}) {
  assertActor(actor, tenantId)
  if (!brain || !graph) throw new Error('brain and graph required')
  if (!isCanonicalDate(queryDate)) throw new Error('valid operating model query date required')
  const brainSnapshot = brain.prepareSnapshot({ actor, tenantId })
  const graphSnapshot = graph.requireSnapshot({ actor, tenantId })
  if (graphSnapshot.brainKnowledgeVersion !== brain.version(tenantId)) {
    throw new Error('fresh graph snapshot required')
  }

  const activeClaims = [...brainSnapshot.claims].sort((a, b) => a.id.localeCompare(b.id))
  const sections = {
    collections: [], billing: [], reminders: [], promisesToPay: [], escalation: [], disputes: [],
    clientHandling: [], rolesAndResponsibilities: [], communication: [], policyOperatingRules: [],
  }

  for (const claim of activeClaims) {
    if (POLICY_CLASSES.has(claim.claimClass)) continue
    const targetSections = SECTION_BY_CLAIM_TYPE[claim.claimType]
    if (!targetSections) continue
    const temporalState = classifyTemporalState(
      claim.effectiveTime,
      claim.semanticScope?.temporality,
      claim.claimClass,
      queryDate,
    )
    const historical = [TEMPORAL_STATE.HISTORICAL, TEMPORAL_STATE.EXPIRED].includes(temporalState)
    const temporallyUnresolved = [TEMPORAL_STATE.FUTURE, TEMPORAL_STATE.UNKNOWN].includes(temporalState)
    const roleLike = claim.claimClass === CLAIM_CLASS.ROLE || claim.claimClass === CLAIM_CLASS.DELEGATION
    const communication = claim.claimClass === CLAIM_CLASS.INTERPRETATION
    const state = historical
      ? OPERATING_STATEMENT_STATE.HISTORICAL_ONLY
      : roleLike || communication
        ? OPERATING_STATEMENT_STATE.OBSERVED
        : temporallyUnresolved
          ? OPERATING_STATEMENT_STATE.UNRESOLVED
          : OPERATING_STATEMENT_STATE.CONFIRMED
    const explanation = historical
      ? 'Historical evidence is retained as context and is not a current operating rule.'
      : temporalState === TEMPORAL_STATE.FUTURE
        ? `Operating evidence is not applicable as of ${queryDate}; its effective period begins later.`
        : temporalState === TEMPORAL_STATE.UNKNOWN
          ? 'Operating evidence has unknown temporal applicability and is not treated as current.'
      : roleLike
        ? 'Human participation is observed; it does not create DW authority.'
        : communication
          ? 'Communication/context is observed evidence only and is not policy or authority.'
          : 'Current explicit operating evidence supports this descriptive statement.'
    const statement = claimStatement(claim, graphSnapshot, state, explanation, temporalState)
    for (const section of targetSections) {
      sections[section].push(statement)
    }
  }

  const policyTopics = sortedUnique(
    activeClaims.filter((claim) => POLICY_CLASSES.has(claim.claimClass)).map((claim) => claim.claimType),
  )
  const clients = graphSnapshot.nodes
    .filter((node) => node.active && node.type === GRAPH_NODE_TYPE.CLIENT && node.data?.entityId)
    .sort((a, b) => a.stableKey.localeCompare(b.stableKey))
  const clientIds = sortedUnique([
    ...clients.map((node) => node.data.entityId),
    ...activeClaims.map((claim) => claim.semanticScope?.clientId || claim.subjectScope?.clientId),
  ])

  for (const topic of policyTopics) {
    const resolution = resolvePolicy(graph, brain, {
      actor, tenantId, scope: { level: SEMANTIC_SCOPE.COMPANY }, topic, queryDate,
    })
    if (resolution.status !== G3_RESOLUTION_STATUS.NO_POLICY) {
      sections.policyOperatingRules.push(policyStatement(resolution, graphSnapshot))
    }
  }

  const clientOverrides = []
  for (const clientId of clientIds) {
    const statements = []
    for (const topic of policyTopics) {
      const resolution = resolvePolicy(graph, brain, {
        actor, tenantId, scope: { level: SEMANTIC_SCOPE.CLIENT, clientId }, topic, queryDate,
      })
      if (resolution.status !== G3_RESOLUTION_STATUS.NO_POLICY) {
        statements.push(policyStatement(resolution, graphSnapshot))
      }
    }
    const contextualStatements = Object.values(sections)
      .flat()
      .filter((statement) => statement.clientId === clientId)
    if (statements.length || contextualStatements.length) {
      clientOverrides.push(freeze({
        clientId,
        statements: [...new Map([...statements, ...contextualStatements].map((s) => [s.id, s])).values()]
          .sort((a, b) => a.id.localeCompare(b.id)),
        widenedToCompany: false,
      }))
    }
  }

  for (const section of Object.values(sections)) section.sort((a, b) => a.id.localeCompare(b.id))
  clientOverrides.sort((a, b) => a.clientId.localeCompare(b.clientId))

  const allStatements = [...new Map([
    ...Object.values(sections).flat(),
    ...clientOverrides.flatMap((entry) => entry.statements),
  ].map((statement) => [statement.id, statement])).values()]
  const unresolvedQuestions = allStatements
    .filter((statement) => [
      OPERATING_STATEMENT_STATE.CONFLICTED,
      OPERATING_STATEMENT_STATE.UNRESOLVED,
    ].includes(statement.state))
    .map(unresolvedQuestion)
  for (const resolution of graphSnapshot.resolutions.filter((entry) => entry.state !== 'RESOLVED')) {
    const claim = activeClaims.find((entry) => entry.id === resolution.claimId)
    const scope = freeze({ ...(claim?.semanticScope || { level: SEMANTIC_SCOPE.COMPANY }) })
    unresolvedQuestions.push(freeze({
      id: `operating-question-${hash({ resolutionId: resolution.id }).slice(0, 24)}`,
      topic: 'entity_identity',
      scope,
      whyUnresolved: `G2 entity resolution is ${resolution.state} for '${resolution.reference || resolution.stableId || 'unknown reference'}'.`,
      sourceClaimIds: claim ? [claim.id] : [],
      conflictKeys: [`ENTITY_${resolution.state}:${[...resolution.candidateKeys].sort().join(',')}`],
      suggestedFounderReviewQuestion: `Which exact ${resolution.entityType.toLowerCase()} does '${resolution.reference || resolution.stableId || 'this reference'}' identify?`,
    }))
  }
  if (sections.promisesToPay.length === 0) unresolvedQuestions.push(missingQuestion('promises_to_pay'))
  if (sections.disputes.length === 0) unresolvedQuestions.push(missingQuestion('dispute_process'))
  unresolvedQuestions.sort((a, b) => a.id.localeCompare(b.id))

  const blockers = unresolvedQuestions
    .filter((question) => question.conflictKeys.length > 0)
    .map((question) => freeze({
      id: `operating-blocker-${hash(question).slice(0, 24)}`,
      topic: question.topic,
      scope: question.scope,
      conflictKeys: question.conflictKeys,
      reason: question.whyUnresolved,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  const evidenceIndex = Object.fromEntries(activeClaims.map((claim) => [claim.id, freeze({
    claimId: claim.id,
    rootSourceVersionIds: sortedUnique(claim.provenanceRootIds || []),
    graphNodeKeys: graphKeysForClaims(graphSnapshot, [claim.id]),
    active: true,
  })]))
  const provenance = freeze({
    sourceClaimIds: sortedUnique(allStatements.flatMap((statement) => statement.sourceClaimIds)),
    sourceGraphNodeKeys: sortedUnique(allStatements.flatMap((statement) => statement.sourceGraphNodeKeys)),
    rootSourceVersionIds: sortedUnique(allStatements.flatMap((statement) => statement.rootSourceVersionIds)),
  })

  const sourceFingerprint = hash({
    tenantId,
    asOfDate: queryDate,
    knowledgeVersion: brainSnapshot.knowledgeVersion,
    graphFingerprint: graphSnapshot.fingerprint,
    graphVersion: graphSnapshot.id,
    sourceVersionIds: brainSnapshot.sourceVersionIds,
    decisions: brainSnapshot.decisions,
    policyStatements: sections.policyOperatingRules,
    clientPolicyStatements: clientOverrides.flatMap((entry) => entry.statements.filter((s) => s.policyResolutionStatus)),
  })
  const draft = {
    kind: 'COMPANY_OPERATING_MODEL_PROPOSAL_V0',
    tenantId,
    proposalId: null,
    revision: brainSnapshot.knowledgeVersion,
    generatedAt,
    asOfDate: queryDate,
    sourceState: freeze({
      brainSnapshotId: brainSnapshot.id,
      knowledgeVersion: brainSnapshot.knowledgeVersion,
      graphVersion: graphSnapshot.id,
      graphFingerprint: graphSnapshot.fingerprint,
      asOfDate: queryDate,
      fingerprint: sourceFingerprint,
    }),
    fingerprint: null,
    status: blockers.length ? OPERATING_MODEL_STATUS.BLOCKED : OPERATING_MODEL_STATUS.PROPOSED,
    company: freeze({
      graphNodeKeys: graphSnapshot.nodes
        .filter((node) => node.active && node.type === GRAPH_NODE_TYPE.COMPANY)
        .map((node) => node.stableKey)
        .sort(),
    }),
    ...sections,
    clientOverrides,
    unresolvedQuestions,
    blockers,
    evidenceIndex: freeze(evidenceIndex),
    provenance,
    boundaries: freeze({
      canonicalMoneyWritable: false,
      authorityGrantable: false,
      canActAutomatically: false,
      operatingModelApproved: false,
      observedDelegationIsAuthority: false,
      dwAuthorityDerived: false,
      repeatedBehaviorIsPolicy: false,
      confidenceCreatesPrecedence: false,
      actionExecutionAvailable: false,
      schedulingAvailable: false,
    }),
  }
  const fingerprint = hash(semanticProposal(draft))
  const proposal = freeze({
    ...draft,
    proposalId: `operating-model-${fingerprint.slice(0, 24)}`,
    fingerprint,
  })
  validateProposal(proposal)
  return proposal
}

/** Read-only freshness check. It never rebuilds a graph or mutates persistence. */
export function isOperatingModelStale({
  proposal, actor, tenantId, brain, graph, asOfDate = proposal?.asOfDate,
} = {}) {
  assertActor(actor, tenantId)
  if (!brain || !graph) throw new Error('brain and graph required for freshness evaluation')
  if (proposal?.tenantId !== tenantId) throw new Error('operating model tenant mismatch')
  validateProposal(proposal)
  const activeGraph = graph.activeSnapshot({ actor, tenantId })
  return (
    asOfDate !== proposal.asOfDate ||
    proposal.sourceState.knowledgeVersion !== brain.version(tenantId) ||
    !activeGraph ||
    proposal.sourceState.graphVersion !== activeGraph.id ||
    proposal.sourceState.graphFingerprint !== activeGraph.fingerprint
  )
}

export class OperatingModelProposalStore {
  constructor({ clock = () => new Date().toISOString() } = {}) {
    this.clock = clock
    this.rows = []
  }
}

export function persistOperatingModelProposal(store, {
  actor, tenantId, proposal, brain, graph, asOfDate = proposal?.asOfDate,
} = {}) {
  assertActor(actor, tenantId)
  if (!(store instanceof OperatingModelProposalStore)) throw new Error('operating model store required')
  if (proposal?.tenantId !== tenantId) throw new Error('operating model tenant mismatch')
  validateProposal(proposal)
  const expectedStatus = proposal.blockers?.length
    ? OPERATING_MODEL_STATUS.BLOCKED
    : OPERATING_MODEL_STATUS.PROPOSED
  if (proposal.status !== expectedStatus) throw new Error('current operating model status required')
  if (isOperatingModelStale({ proposal, actor, tenantId, brain, graph, asOfDate })) {
    const invalidatedAt = store.clock()
    for (let index = 0; index < store.rows.length; index += 1) {
      const row = store.rows[index]
      if (
        row.tenantId === tenantId &&
        row.fingerprint === proposal.fingerprint &&
        [OPERATING_MODEL_STATUS.PROPOSED, OPERATING_MODEL_STATUS.BLOCKED].includes(row.status)
      ) {
        store.rows[index] = freeze({
          ...structuredClone(row),
          status: OPERATING_MODEL_STATUS.STALE,
          invalidatedAt,
        })
      }
    }
    throw new Error('stale operating model cannot be persisted as current')
  }
  const existing = store.rows.find(
    (row) => row.tenantId === tenantId && row.fingerprint === proposal.fingerprint,
  )
  if (existing) return existing
  const currentStatuses = new Set([OPERATING_MODEL_STATUS.PROPOSED, OPERATING_MODEL_STATUS.BLOCKED])
  const storageRevision = store.rows.filter((row) => row.tenantId === tenantId).length + 1
  const row = {
    ...structuredClone(proposal),
    storageRevision,
    persistedAt: store.clock(),
  }
  for (let index = 0; index < store.rows.length; index += 1) {
    const prior = store.rows[index]
    if (prior.tenantId === tenantId && currentStatuses.has(prior.status)) {
      store.rows[index] = freeze({
        ...structuredClone(prior),
        status: OPERATING_MODEL_STATUS.SUPERSEDED,
        supersededByProposalId: proposal.proposalId,
        invalidatedAt: row.persistedAt,
      })
    }
  }
  const persisted = freeze({
    ...row,
    supersededByProposalId: null,
    invalidatedAt: null,
  })
  store.rows.push(persisted)
  return persisted
}

export function getOperatingModelProposal(store, { actor, tenantId, proposalId = null } = {}) {
  assertActor(actor, tenantId)
  if (!(store instanceof OperatingModelProposalStore)) throw new Error('operating model store required')
  if (proposalId) {
    return store.rows.find((row) => row.tenantId === tenantId && row.proposalId === proposalId) || null
  }
  return store.rows.filter((row) => row.tenantId === tenantId).at(-1) || null
}

export function toOperatingModelReviewContext(proposal, {
  actor, tenantId, brain, graph, asOfDate = proposal?.asOfDate,
} = {}) {
  validateProposal(proposal)
  const stale = isOperatingModelStale({ proposal, actor, tenantId, brain, graph, asOfDate })
  return freeze({
    kind: 'COMPANY_OPERATING_MODEL_REVIEW_CONTEXT_V0',
    tenantId: proposal.tenantId,
    proposalId: proposal.proposalId,
    revision: proposal.revision,
    sourceState: proposal.sourceState,
    asOfDate: proposal.asOfDate,
    status: stale ? OPERATING_MODEL_STATUS.STALE : proposal.status,
    stale,
    reviewBlocked: stale,
    sections: {
      collections: proposal.collections,
      billing: proposal.billing,
      reminders: proposal.reminders,
      promisesToPay: proposal.promisesToPay,
      escalation: proposal.escalation,
      disputes: proposal.disputes,
      clientHandling: proposal.clientHandling,
      rolesAndResponsibilities: proposal.rolesAndResponsibilities,
      communication: proposal.communication,
      policyOperatingRules: proposal.policyOperatingRules,
    },
    clientOverrides: proposal.clientOverrides,
    unresolvedQuestions: proposal.unresolvedQuestions,
    blockers: proposal.blockers,
    evidenceIndex: proposal.evidenceIndex,
    boundaries: proposal.boundaries,
    reviewOnly: true,
    approvalCapabilityAvailable: false,
  })
}
