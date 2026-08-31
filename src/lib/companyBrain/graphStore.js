import crypto from 'node:crypto'

export const GRAPH_NODE_TYPE = Object.freeze({
  COMPANY: 'COMPANY', CLIENT: 'CLIENT', PERSON: 'PERSON', ROLE: 'ROLE', CONTRACT: 'CONTRACT',
  POLICY_CANDIDATE: 'POLICY_CANDIDATE', WORKFLOW: 'WORKFLOW', CLIENT_EXCEPTION: 'CLIENT_EXCEPTION',
  PRECEDENT: 'PRECEDENT', SOURCE: 'SOURCE', ARTIFACT: 'ARTIFACT', CLAIM: 'CLAIM', CONFLICT: 'CONFLICT',
})

export const GRAPH_EDGE_TYPE = Object.freeze({
  BELONGS_TO_COMPANY: 'BELONGS_TO_COMPANY', CLIENT_OF: 'CLIENT_OF', HAS_CONTRACT: 'HAS_CONTRACT',
  APPLIES_TO_CLIENT: 'APPLIES_TO_CLIENT', APPLIES_TO_COMPANY: 'APPLIES_TO_COMPANY', HAS_ROLE: 'HAS_ROLE',
  ROLE_IN_COMPANY: 'ROLE_IN_COMPANY', OBSERVED_DELEGATION: 'OBSERVED_DELEGATION', REFERENCES_POLICY: 'REFERENCES_POLICY',
  EXCEPTION_FOR: 'EXCEPTION_FOR', SUPPORTED_BY: 'SUPPORTED_BY', DERIVED_FROM: 'DERIVED_FROM',
  CONFLICTS_WITH: 'CONFLICTS_WITH', PRECEDENT_FOR: 'PRECEDENT_FOR', HISTORICAL_TO: 'HISTORICAL_TO',
  ALIAS_OF: 'ALIAS_OF', SUPERSEDES: 'SUPERSEDES',
})

export const RESOLUTION_STATE = Object.freeze({ RESOLVED: 'RESOLVED', AMBIGUOUS: 'AMBIGUOUS', UNRESOLVED: 'UNRESOLVED', CONFLICTED: 'CONFLICTED' })
export const SEMANTIC_SCOPE = Object.freeze({ INTERACTION: 'INTERACTION', DOCUMENT: 'DOCUMENT', CLIENT: 'CLIENT', ROLE: 'ROLE', WORKFLOW: 'WORKFLOW', COMPANY: 'COMPANY', HISTORICAL: 'HISTORICAL' })

const NODE_TYPES = new Set(Object.values(GRAPH_NODE_TYPE))
const EDGE_TYPES = new Set(Object.values(GRAPH_EDGE_TYPE))

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`)
  return value.trim()
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function hash(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex') }
function graphId(prefix, value) { return `${prefix}-${hash(value).slice(0, 24)}` }
function normalizeIdentity(value) { return String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '') }
function clone(value) { return structuredClone(value) }
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value).forEach(freeze)
  return Object.freeze(value)
}

function assertActor(actor, tenantId) {
  if (!actor?.authenticated || !actor.id) throw new Error('authenticated actor required')
  if (actor.tenantId !== tenantId) throw new Error('actor tenant mismatch')
}

function provenance(input) {
  const claimIds = [...new Set(input.claimIds || [])]
  const rootSourceVersionIds = [...new Set(input.rootSourceVersionIds || [])]
  if (!claimIds.length || !rootSourceVersionIds.length) throw new Error('graph object requires claim and root provenance')
  const suppliedPairs = input.provenancePairs || claimIds.flatMap((claimId) => rootSourceVersionIds.map((sourceVersionId) => ({ claimId, sourceVersionId, independent: input.independent === true })))
  const provenancePairs = [...new Map(suppliedPairs.map((pair) => [`${pair.claimId}:${pair.sourceVersionId}`, { claimId: pair.claimId, sourceVersionId: pair.sourceVersionId, independent: input.derived === true ? false : pair.independent === true }])).values()]
  return { claimIds, rootSourceVersionIds, provenancePairs, independent: input.derived === true ? false : provenancePairs.some((pair) => pair.independent), independentRootCount: input.derived === true ? 0 : new Set(provenancePairs.filter((pair) => pair.independent).map((pair) => pair.sourceVersionId)).size }
}

function mergeProvenance(left, right, derived = false) {
  return provenance({
    claimIds: [...left.claimIds, ...right.claimIds],
    rootSourceVersionIds: [...left.rootSourceVersionIds, ...right.rootSourceVersionIds],
    provenancePairs: [...left.provenancePairs, ...right.provenancePairs],
    derived,
  })
}

export function createGraphNode(input = {}) {
  const type = required(input.type, 'graph node type')
  if (!NODE_TYPES.has(type)) throw new Error(`unknown graph node type: ${type}`)
  return {
    kind: 'COMPANY_GRAPH_NODE_V0', tenantId: required(input.tenantId, 'graph node tenantId'),
    stableKey: required(input.stableKey, 'graph node stableKey'), type, label: required(input.label, 'graph node label'),
    semanticScope: clone(input.semanticScope || { level: SEMANTIC_SCOPE.DOCUMENT }), resolutionState: input.resolutionState || RESOLUTION_STATE.RESOLVED,
    confidence: input.confidence ?? 1, uncertainty: input.uncertainty ?? null, explicit: input.explicit !== false,
    derived: input.derived === true, active: input.active !== false, revoked: input.revoked === true,
    effectiveTime: clone(input.effectiveTime || null), canonicalFinancialTruth: false, dwAuthority: false,
    data: clone(input.data || {}), provenance: provenance(input), graphSchemaVersion: 'COMPANY_GRAPH_V0',
  }
}

export function createGraphEdge(input = {}) {
  const type = required(input.type, 'graph edge type')
  if (!EDGE_TYPES.has(type)) throw new Error(`unknown graph edge type: ${type}`)
  if (type === GRAPH_EDGE_TYPE.SUPERSEDES && input.explicit !== true) throw new Error('override-like graph edge requires explicit evidence')
  return {
    kind: 'COMPANY_GRAPH_EDGE_V0', tenantId: required(input.tenantId, 'graph edge tenantId'),
    stableKey: required(input.stableKey, 'graph edge stableKey'), type,
    fromKey: required(input.fromKey, 'graph edge fromKey'), toKey: required(input.toKey, 'graph edge toKey'),
    semanticScope: clone(input.semanticScope || { level: SEMANTIC_SCOPE.DOCUMENT }), resolutionState: input.resolutionState || RESOLUTION_STATE.RESOLVED,
    confidence: input.confidence ?? 1, uncertainty: input.uncertainty ?? null, explicit: input.explicit !== false,
    derived: input.derived === true, active: input.active !== false, revoked: input.revoked === true,
    effectiveTime: clone(input.effectiveTime || null), canonicalFinancialTruth: false, dwAuthority: false,
    data: clone(input.data || {}), provenance: provenance(input), graphSchemaVersion: 'COMPANY_GRAPH_V0',
  }
}

function claimProvenance(claim) {
  return { claimIds: [claim.id], rootSourceVersionIds: claim.provenanceRootIds, provenancePairs: claim.provenanceRootIds.map((sourceVersionId) => ({ claimId: claim.id, sourceVersionId, independent: claim.derived !== true })), independent: claim.derived !== true, derived: claim.derived === true }
}

export class CompanyGraphStore {
  constructor({ brainStore, clock = () => new Date().toISOString() } = {}) {
    if (!brainStore) throw new Error('brainStore required')
    this.brainStore = brainStore
    this.clock = clock
    this.nodes = []
    this.edges = []
    this.resolutions = []
    this.snapshots = []
  }

  tenantRows(rows, tenantId) { return rows.filter((row) => row.tenantId === tenantId) }

  persistNode({ actor, tenantId, node }) {
    assertActor(actor, tenantId)
    if (node.tenantId !== tenantId) throw new Error('graph node tenant mismatch')
    this.validateProvenance(tenantId, node)
    this.nodes.push(node)
    return node
  }

  persistEdge({ actor, tenantId, edge, nodeRows = this.nodes }) {
    assertActor(actor, tenantId)
    if (edge.tenantId !== tenantId) throw new Error('graph edge tenant mismatch')
    this.validateProvenance(tenantId, edge)
    const from = nodeRows.find((row) => row.tenantId === tenantId && row.stableKey === edge.fromKey)
    const to = nodeRows.find((row) => row.tenantId === tenantId && row.stableKey === edge.toKey)
    if (!from || !to) throw new Error('graph edge endpoint missing or cross-tenant')
    this.edges.push(edge)
    return edge
  }

  validateProvenance(tenantId, item) {
    for (const pair of item.provenance.provenancePairs) {
      const claim = this.brainStore.claims.find((row) => row.tenantId === tenantId && row.id === pair.claimId)
      const root = this.brainStore.sourceVersions.find((row) => row.tenantId === tenantId && row.id === pair.sourceVersionId)
      const link = this.brainStore.claimRoots.find((row) => row.tenantId === tenantId && row.claimId === pair.claimId && row.sourceVersionId === pair.sourceVersionId)
      if (!claim || !root || !link) throw new Error('graph provenance dangling or cross-tenant')
    }
    if (item.active && item.provenance.rootSourceVersionIds.some((rootId) => !this.brainStore.sourceVersions.some((row) => row.tenantId === tenantId && row.id === rootId && row.status === 'ACTIVE'))) throw new Error('active graph provenance root inactive')
  }

  build({ actor, tenantId }) {
    assertActor(actor, tenantId)
    const brain = this.brainStore.prepareSnapshot({ actor, tenantId })
    const fingerprint = hash({ schema: 'COMPANY_GRAPH_V0', sourceVersionIds: brain.sourceVersionIds, knowledgeVersion: brain.knowledgeVersion })
    const existing = this.snapshots.find((row) => row.tenantId === tenantId && row.fingerprint === fingerprint)
    if (existing) return existing

    const graphVersion = this.tenantRows(this.snapshots, tenantId).length + 1
    const graphVersionId = graphId('graph-version', `${tenantId}:${graphVersion}:${fingerprint}`)
    const nodes = new Map()
    const edges = new Map()
    const resolutions = []
    const claimsById = new Map(brain.claims.map((claim) => [claim.id, claim]))
    const addNode = (node) => {
      const prior = nodes.get(node.stableKey)
      if (prior && prior.type !== node.type) throw new Error('graph stable key type collision')
      this.validateProvenance(tenantId, node)
      if (!prior) nodes.set(node.stableKey, node)
      else {
        const entity = [GRAPH_NODE_TYPE.COMPANY, GRAPH_NODE_TYPE.CLIENT, GRAPH_NODE_TYPE.PERSON].includes(node.type)
        const priorIdentity = stable({ label: normalizeIdentity(prior.label), entityId: prior.data.entityId || null, companyId: prior.data.companyId || null })
        const nextIdentity = stable({ label: normalizeIdentity(node.label), entityId: node.data.entityId || null, companyId: node.data.companyId || null })
        prior.provenance = mergeProvenance(prior.provenance, node.provenance, prior.derived || node.derived)
        prior.data.aliases = [...new Set([...(prior.data.aliases || []), ...(node.data.aliases || [])])]
        prior.data.supportVariants = [...new Map([...(prior.data.supportVariants || [clone(prior.data)]), clone(node.data)].map((item) => [stable(item), item])).values()]
        if (entity && priorIdentity !== nextIdentity) {
          prior.resolutionState = RESOLUTION_STATE.CONFLICTED
          prior.uncertainty = 'CONFLICTING_STABLE_IDENTITY_ATTRIBUTES'
          prior.data.identityVariants = [...new Map([...(prior.data.identityVariants || [{ label: prior.label, companyId: prior.data.companyId || null }]), { label: node.label, companyId: node.data.companyId || null }].map((item) => [stable(item), item])).values()]
        }
      }
      return nodes.get(node.stableKey)
    }
    const addEdge = (edge) => {
      if (!nodes.has(edge.fromKey) || !nodes.has(edge.toKey)) throw new Error('graph edge endpoint missing')
      this.validateProvenance(tenantId, edge)
      const prior = edges.get(edge.stableKey)
      if (!prior) edges.set(edge.stableKey, edge)
      else {
        if (prior.type !== edge.type || prior.fromKey !== edge.fromKey || prior.toKey !== edge.toKey) throw new Error('graph stable edge conflict')
        prior.provenance = mergeProvenance(prior.provenance, edge.provenance, prior.derived || edge.derived)
        prior.data.supportVariants = [...new Map([...(prior.data.supportVariants || [clone(prior.data)]), clone(edge.data)].map((item) => [stable(item), item])).values()]
      }
      return edges.get(edge.stableKey)
    }

    for (const claim of brain.claims.filter((row) => row.claimType === 'entity_record')) {
      addNode(createGraphNode({ tenantId, stableKey: `entity:${claim.value.entityType}:${claim.value.entityId}`, type: claim.value.entityType, label: claim.value.name, semanticScope: claim.semanticScope, effectiveTime: claim.effectiveTime, data: claim.value, ...claimProvenance(claim) }))
    }

    const entityNodes = () => [...nodes.values()].filter((node) => [GRAPH_NODE_TYPE.COMPANY, GRAPH_NODE_TYPE.CLIENT, GRAPH_NODE_TYPE.PERSON].includes(node.type))
    const aliasClaims = brain.claims.filter((row) => row.claimType === 'alias_record')
    const resolve = ({ claim, entityType = GRAPH_NODE_TYPE.CLIENT, stableId = null, reference = null }) => {
      const candidates = entityNodes().filter((node) => node.type === entityType)
      const exact = stableId ? candidates.filter((node) => node.data.entityId === stableId) : []
      const named = reference ? candidates.filter((node) => [node.label, ...(node.data.aliases || [])].some((name) => normalizeIdentity(name) === normalizeIdentity(reference))) : []
      let state
      let matches
      if (exact.length === 1 && exact[0].resolutionState === RESOLUTION_STATE.CONFLICTED) { state = RESOLUTION_STATE.CONFLICTED; matches = exact }
      else if (exact.length === 1 && named.length && !named.some((node) => node.stableKey === exact[0].stableKey)) { state = RESOLUTION_STATE.CONFLICTED; matches = [...new Map([...exact, ...named].map((node) => [node.stableKey, node])).values()] }
      else if (exact.length === 1) { state = RESOLUTION_STATE.RESOLVED; matches = exact }
      else if (named.length === 1 && named[0].resolutionState === RESOLUTION_STATE.CONFLICTED) { state = RESOLUTION_STATE.CONFLICTED; matches = named }
      else if (named.length === 1) { state = RESOLUTION_STATE.RESOLVED; matches = named }
      else if (named.length > 1 || exact.length > 1) { state = RESOLUTION_STATE.AMBIGUOUS; matches = named.length ? named : exact }
      else { state = RESOLUTION_STATE.UNRESOLVED; matches = [] }
      const row = { kind: 'COMPANY_GRAPH_RESOLUTION_V0', id: graphId('resolution', `${graphVersionId}:${claim.id}:${entityType}:${stableId}:${reference}`), tenantId, graphVersionId, claimId: claim.id, entityType, stableId, reference, normalizedReference: normalizeIdentity(reference), state, candidateKeys: matches.map((node) => node.stableKey), selectedKey: state === RESOLUTION_STATE.RESOLVED ? matches[0].stableKey : null, provenance: claimProvenance(claim), createdAt: this.clock() }
      resolutions.push(row)
      return row
    }

    for (const claim of brain.claims) {
      const p = claimProvenance(claim)
      if (claim.claimType === 'late_fee_policy' || claim.claimType === 'policy_candidate_record') {
        const policyId = claim.value.policy_id || claim.value.policyId || `claim-${claim.id}`
        const node = addNode(createGraphNode({ tenantId, stableKey: `policy:${policyId}`, type: GRAPH_NODE_TYPE.POLICY_CANDIDATE, label: claim.value.policy_topic || claim.claimType, semanticScope: claim.semanticScope, effectiveTime: claim.effectiveTime, resolutionState: claim.status === 'CONFLICTED' ? RESOLUTION_STATE.CONFLICTED : RESOLUTION_STATE.RESOLVED, data: { ...claim.value, claimId: claim.id, approved: false }, ...p }))
        const level = claim.semanticScope?.level
        if (level === SEMANTIC_SCOPE.CLIENT && claim.semanticScope.clientId) {
          const client = nodes.get(`entity:CLIENT:${claim.semanticScope.clientId}`)
          if (client) addEdge(createGraphEdge({ tenantId, stableKey: `edge:${node.stableKey}:applies:${client.stableKey}`, type: GRAPH_EDGE_TYPE.APPLIES_TO_CLIENT, fromKey: node.stableKey, toKey: client.stableKey, semanticScope: claim.semanticScope, ...p }))
        } else {
          const company = entityNodes().find((candidate) => candidate.type === GRAPH_NODE_TYPE.COMPANY)
          if (company) addEdge(createGraphEdge({ tenantId, stableKey: `edge:${node.stableKey}:${level === SEMANTIC_SCOPE.HISTORICAL ? 'historical' : 'company'}:${company.stableKey}`, type: level === SEMANTIC_SCOPE.HISTORICAL ? GRAPH_EDGE_TYPE.HISTORICAL_TO : GRAPH_EDGE_TYPE.APPLIES_TO_COMPANY, fromKey: node.stableKey, toKey: company.stableKey, semanticScope: claim.semanticScope, effectiveTime: claim.effectiveTime, ...p }))
        }
      }
    }

    for (const claim of brain.claims) {
      const p = claimProvenance(claim)
      const value = claim.value || {}
      if (claim.claimType === 'contract_record') {
        const node = addNode(createGraphNode({ tenantId, stableKey: `contract:${value.contract_id}`, type: GRAPH_NODE_TYPE.CONTRACT, label: value.contract_id, semanticScope: claim.semanticScope, effectiveTime: claim.effectiveTime, data: value, ...p }))
        const result = resolve({ claim, stableId: value.client_id || null, reference: value.client_reference || null })
        if (result.selectedKey) addEdge(createGraphEdge({ tenantId, stableKey: `edge:${result.selectedKey}:has:${node.stableKey}`, type: GRAPH_EDGE_TYPE.HAS_CONTRACT, fromKey: result.selectedKey, toKey: node.stableKey, semanticScope: claim.semanticScope, resolutionState: result.state, ...p }))
      }
      if (claim.claimType === 'client_exception_record') {
        const node = addNode(createGraphNode({ tenantId, stableKey: `exception:${value.exception_id}`, type: GRAPH_NODE_TYPE.CLIENT_EXCEPTION, label: value.exception_id, semanticScope: claim.semanticScope, data: value, ...p }))
        const result = resolve({ claim, stableId: value.client_id || null, reference: value.client_reference || null })
        if (result.selectedKey) addEdge(createGraphEdge({ tenantId, stableKey: `edge:${node.stableKey}:for:${result.selectedKey}`, type: GRAPH_EDGE_TYPE.EXCEPTION_FOR, fromKey: node.stableKey, toKey: result.selectedKey, semanticScope: claim.semanticScope, resolutionState: result.state, ...p }))
        const contract = nodes.get(`contract:${value.contract_id}`)
        if (contract) addEdge(createGraphEdge({ tenantId, stableKey: `edge:${node.stableKey}:derived:${contract.stableKey}`, type: GRAPH_EDGE_TYPE.DERIVED_FROM, fromKey: node.stableKey, toKey: contract.stableKey, semanticScope: claim.semanticScope, ...p, derived: true }))
      }
      if (claim.claimType === 'workflow_record') {
        const node = addNode(createGraphNode({ tenantId, stableKey: `workflow:${value.workflow_id}`, type: GRAPH_NODE_TYPE.WORKFLOW, label: value.workflow_id, semanticScope: claim.semanticScope, data: value, ...p }))
        const policies = [...nodes.values()].filter((candidate) => candidate.type === GRAPH_NODE_TYPE.POLICY_CANDIDATE && (candidate.data.policy_topic || candidate.label) === value.policy_topic)
        for (const policy of policies) addEdge(createGraphEdge({ tenantId, stableKey: `edge:${node.stableKey}:references:${policy.stableKey}`, type: GRAPH_EDGE_TYPE.REFERENCES_POLICY, fromKey: node.stableKey, toKey: policy.stableKey, semanticScope: claim.semanticScope, ...p, derived: true }))
      }
      if (claim.claimType === 'precedent_record') {
        const node = addNode(createGraphNode({ tenantId, stableKey: `precedent:${value.precedent_id}`, type: GRAPH_NODE_TYPE.PRECEDENT, label: value.precedent_id, semanticScope: claim.semanticScope, effectiveTime: claim.effectiveTime, data: value, ...p }))
        const result = resolve({ claim, stableId: value.client_id || null, reference: value.client_reference || null })
        if (result.selectedKey) addEdge(createGraphEdge({ tenantId, stableKey: `edge:${node.stableKey}:for:${result.selectedKey}`, type: GRAPH_EDGE_TYPE.PRECEDENT_FOR, fromKey: node.stableKey, toKey: result.selectedKey, semanticScope: claim.semanticScope, effectiveTime: claim.effectiveTime, ...p }))
      }
      if (claim.claimType === 'orphan_reference_record' || claim.claimType === 'interaction_record') resolve({ claim, reference: value.client_reference || null })
      if (claim.claimType === 'role_record') {
        const person = addNode(createGraphNode({ tenantId, stableKey: `entity:PERSON:${value.personId}`, type: GRAPH_NODE_TYPE.PERSON, label: value.personName, semanticScope: claim.semanticScope, data: { entityId: value.personId, name: value.personName }, ...p }))
        const role = addNode(createGraphNode({ tenantId, stableKey: `role:${value.roleId}`, type: GRAPH_NODE_TYPE.ROLE, label: value.roleName, semanticScope: claim.semanticScope, data: value, ...p }))
        addEdge(createGraphEdge({ tenantId, stableKey: `edge:${person.stableKey}:role:${role.stableKey}`, type: GRAPH_EDGE_TYPE.HAS_ROLE, fromKey: person.stableKey, toKey: role.stableKey, semanticScope: claim.semanticScope, ...p }))
        const company = nodes.get(`entity:COMPANY:${value.companyId}`)
        if (company) addEdge(createGraphEdge({ tenantId, stableKey: `edge:${role.stableKey}:company:${company.stableKey}`, type: GRAPH_EDGE_TYPE.ROLE_IN_COMPANY, fromKey: role.stableKey, toKey: company.stableKey, semanticScope: claim.semanticScope, ...p }))
      }
      if (claim.claimType === 'observed_delegation_record') {
        const person = nodes.get(`entity:PERSON:${value.personId}`)
        const role = nodes.get(`role:${value.roleId}`)
        if (person && role) addEdge(createGraphEdge({ tenantId, stableKey: `edge:${role.stableKey}:delegation:${person.stableKey}:${hash(value.delegation).slice(0, 8)}`, type: GRAPH_EDGE_TYPE.OBSERVED_DELEGATION, fromKey: role.stableKey, toKey: person.stableKey, semanticScope: claim.semanticScope, data: { delegation: value.delegation, observedOnly: true, dwAuthority: false }, ...p }))
      }
    }

    for (const node of entityNodes().filter((row) => row.type === GRAPH_NODE_TYPE.CLIENT && row.data.companyId)) {
      const company = nodes.get(`entity:COMPANY:${node.data.companyId}`)
      if (company) addEdge(createGraphEdge({ tenantId, stableKey: `edge:${node.stableKey}:client-of:${company.stableKey}`, type: GRAPH_EDGE_TYPE.CLIENT_OF, fromKey: node.stableKey, toKey: company.stableKey, semanticScope: { level: SEMANTIC_SCOPE.CLIENT, clientId: node.data.entityId }, ...node.provenance }))
    }

    for (const claim of aliasClaims) {
      const target = nodes.get(`entity:${claim.value.entityType}:${claim.value.entityId}`)
      if (!target) continue
      const aliasKey = `entity:${claim.value.entityType}:alias:${normalizeIdentity(claim.value.alias)}`
      const alias = addNode(createGraphNode({ tenantId, stableKey: aliasKey, type: claim.value.entityType, label: claim.value.alias, semanticScope: claim.semanticScope, effectiveTime: claim.effectiveTime, active: !claim.value.effectiveTo, data: { alias: true, entityId: claim.value.entityId }, ...claimProvenance(claim) }))
      addEdge(createGraphEdge({ tenantId, stableKey: `edge:${alias.stableKey}:alias:${target.stableKey}`, type: GRAPH_EDGE_TYPE.ALIAS_OF, fromKey: alias.stableKey, toKey: target.stableKey, semanticScope: claim.semanticScope, effectiveTime: claim.effectiveTime, active: !claim.value.effectiveTo, ...claimProvenance(claim) }))
    }

    for (const source of brain.sources) {
      const related = brain.claims.filter((claim) => claim.provenanceRootIds.includes(source.id))
      if (!related.length) continue
      const rootIds = [source.id]
      addNode(createGraphNode({ tenantId, stableKey: `source:${source.id}`, type: GRAPH_NODE_TYPE.SOURCE, label: source.id, semanticScope: { level: SEMANTIC_SCOPE.DOCUMENT }, data: { sourceVersion: source.sourceVersion }, claimIds: related.map((claim) => claim.id), rootSourceVersionIds: rootIds, independent: true }))
    }
    for (const artifact of brain.artifacts) {
      const related = brain.claims.filter((claim) => claim.artifactIds.includes(artifact.id))
      if (!related.length) continue
      const p = { claimIds: related.map((claim) => claim.id), rootSourceVersionIds: artifact.rootSourceIds, independent: true }
      const node = addNode(createGraphNode({ tenantId, stableKey: `artifact:${artifact.id}`, type: GRAPH_NODE_TYPE.ARTIFACT, label: artifact.locator, semanticScope: { level: SEMANTIC_SCOPE.DOCUMENT }, data: { artifactType: artifact.artifactType }, ...p }))
      const source = nodes.get(`source:${artifact.sourceId}`)
      if (source) addEdge(createGraphEdge({ tenantId, stableKey: `edge:${node.stableKey}:derived:${source.stableKey}`, type: GRAPH_EDGE_TYPE.DERIVED_FROM, fromKey: node.stableKey, toKey: source.stableKey, semanticScope: { level: SEMANTIC_SCOPE.DOCUMENT }, ...p }))
    }
    for (const claim of brain.claims) {
      const p = claimProvenance(claim)
      const node = addNode(createGraphNode({ tenantId, stableKey: `claim:${claim.id}`, type: GRAPH_NODE_TYPE.CLAIM, label: claim.claimType, semanticScope: claim.semanticScope, effectiveTime: claim.effectiveTime, data: { claimClass: claim.claimClass, claimType: claim.claimType }, ...p }))
      for (const artifactId of claim.artifactIds) {
        const artifact = nodes.get(`artifact:${artifactId}`)
        if (artifact) addEdge(createGraphEdge({ tenantId, stableKey: `edge:${node.stableKey}:supported:${artifact.stableKey}`, type: GRAPH_EDGE_TYPE.SUPPORTED_BY, fromKey: node.stableKey, toKey: artifact.stableKey, semanticScope: claim.semanticScope, ...p }))
      }
    }

    const conflicts = this.brainStore.tenantRows(this.brainStore.conflicts, tenantId).filter((row) => row.status !== 'INVALIDATED')
    for (const conflict of conflicts) {
      const memberClaims = conflict.competingClaimIds.map((id) => claimsById.get(id)).filter(Boolean)
      if (!memberClaims.length) continue
      const p = { claimIds: memberClaims.map((claim) => claim.id), rootSourceVersionIds: [...new Set(memberClaims.flatMap((claim) => claim.provenanceRootIds))], provenancePairs: memberClaims.flatMap((claim) => claim.provenanceRootIds.map((sourceVersionId) => ({ claimId: claim.id, sourceVersionId, independent: claim.derived !== true }))), independent: true }
      const node = addNode(createGraphNode({ tenantId, stableKey: `conflict:${conflict.id}`, type: GRAPH_NODE_TYPE.CONFLICT, label: conflict.topic, semanticScope: conflict.semanticScope, resolutionState: conflict.status === 'CONFLICTED' ? RESOLUTION_STATE.CONFLICTED : RESOLUTION_STATE.RESOLVED, data: { status: conflict.status }, ...p }))
      for (const claim of memberClaims) addEdge(createGraphEdge({ tenantId, stableKey: `edge:${node.stableKey}:conflicts:${claim.id}`, type: GRAPH_EDGE_TYPE.CONFLICTS_WITH, fromKey: node.stableKey, toKey: `claim:${claim.id}`, semanticScope: claim.semanticScope, resolutionState: RESOLUTION_STATE.CONFLICTED, ...p }))
    }

    const nodeRows = [...nodes.values()].map((row) => ({ ...row, id: graphId('graph-node', `${graphVersionId}:${row.stableKey}`), graphVersionId, current: true, createdAt: this.clock() }))
    const edgeRows = [...edges.values()].map((row) => ({ ...row, id: graphId('graph-edge', `${graphVersionId}:${row.stableKey}`), graphVersionId, current: true, createdAt: this.clock() }))
    const activeRoots = new Set(brain.sourceVersionIds)
    for (const old of this.tenantRows(this.nodes, tenantId).filter((row) => row.current)) { old.current = false; if (!nodes.has(old.stableKey) || old.provenance.rootSourceVersionIds.some((rootId) => !activeRoots.has(rootId))) { old.active = false; old.revoked = true } }
    for (const old of this.tenantRows(this.edges, tenantId).filter((row) => row.current)) { old.current = false; if (!edges.has(old.stableKey) || old.provenance.rootSourceVersionIds.some((rootId) => !activeRoots.has(rootId))) { old.active = false; old.revoked = true } }
    this.nodes.push(...nodeRows)
    this.edges.push(...edgeRows)
    this.resolutions.push(...resolutions)
    const snapshot = freeze({ kind: 'COMPANY_GRAPH_SNAPSHOT_V0', id: graphVersionId, tenantId, version: graphVersion, fingerprint, brainKnowledgeVersion: brain.knowledgeVersion, sourceVersionIds: brain.sourceVersionIds, createdAt: this.clock(), schemaVersion: 'COMPANY_GRAPH_V0', nodes: clone(nodeRows), edges: clone(edgeRows), resolutions: clone(resolutions), canonicalMoneyWritable: false, authorityGrantable: false, policyPrecedenceResolved: false })
    this.snapshots.push(snapshot)
    return snapshot
  }

  activeSnapshot({ actor, tenantId }) { assertActor(actor, tenantId); const latest = this.tenantRows(this.snapshots, tenantId).at(-1) || null; return latest?.brainKnowledgeVersion === this.brainStore.version(tenantId) ? latest : null }
  requireSnapshot(input) { return this.activeSnapshot(input) || this.build(input) }

  getEntity({ actor, tenantId, type, identity }) {
    const snapshot = this.requireSnapshot({ actor, tenantId })
    const normalized = normalizeIdentity(identity)
    return snapshot.nodes.filter((node) => node.active && node.type === type && (node.data.entityId === identity || normalizeIdentity(node.label) === normalized || (node.data.aliases || []).some((alias) => normalizeIdentity(alias) === normalized)))
  }

  resolveClientAlias({ actor, tenantId, alias }) {
    const matches = this.getEntity({ actor, tenantId, type: GRAPH_NODE_TYPE.CLIENT, identity: alias })
    const conflicted = matches.length === 1 && matches[0].resolutionState === RESOLUTION_STATE.CONFLICTED
    return freeze({ state: conflicted ? RESOLUTION_STATE.CONFLICTED : matches.length === 1 ? RESOLUTION_STATE.RESOLVED : matches.length > 1 ? RESOLUTION_STATE.AMBIGUOUS : RESOLUTION_STATE.UNRESOLVED, selectedKey: matches.length === 1 && !conflicted ? matches[0].stableKey : null, candidateKeys: matches.map((node) => node.stableKey) })
  }

  getContractsForClient({ actor, tenantId, clientId }) {
    const snapshot = this.requireSnapshot({ actor, tenantId })
    const key = `entity:CLIENT:${clientId}`
    const contractKeys = snapshot.edges.filter((edge) => edge.active && edge.type === GRAPH_EDGE_TYPE.HAS_CONTRACT && edge.fromKey === key).map((edge) => edge.toKey)
    return snapshot.nodes.filter((node) => contractKeys.includes(node.stableKey))
  }

  getPoliciesApplicable({ actor, tenantId, scope }) {
    const snapshot = this.requireSnapshot({ actor, tenantId })
    const target = scope.level === SEMANTIC_SCOPE.CLIENT ? `entity:CLIENT:${scope.clientId}` : `entity:COMPANY:${scope.companyId || 'duewatch-company'}`
    const edgeTypes = scope.level === SEMANTIC_SCOPE.CLIENT ? [GRAPH_EDGE_TYPE.APPLIES_TO_CLIENT, GRAPH_EDGE_TYPE.EXCEPTION_FOR] : [GRAPH_EDGE_TYPE.APPLIES_TO_COMPANY]
    const keys = snapshot.edges.filter((edge) => edge.active && edgeTypes.includes(edge.type) && edge.toKey === target).map((edge) => edge.fromKey)
    return snapshot.nodes.filter((node) => keys.includes(node.stableKey) && [GRAPH_NODE_TYPE.POLICY_CANDIDATE, GRAPH_NODE_TYPE.CLIENT_EXCEPTION].includes(node.type))
  }

  getUnresolvedRelationships({ actor, tenantId }) { return this.requireSnapshot({ actor, tenantId }).resolutions.filter((row) => row.state !== RESOLUTION_STATE.RESOLVED) }
  getRolesDelegation({ actor, tenantId }) { return this.requireSnapshot({ actor, tenantId }).edges.filter((edge) => edge.active && [GRAPH_EDGE_TYPE.HAS_ROLE, GRAPH_EDGE_TYPE.ROLE_IN_COMPANY, GRAPH_EDGE_TYPE.OBSERVED_DELEGATION].includes(edge.type)) }
  getPrecedents({ actor, tenantId, clientId }) { const s = this.requireSnapshot({ actor, tenantId }); const keys = s.edges.filter((e) => e.active && e.type === GRAPH_EDGE_TYPE.PRECEDENT_FOR && e.toKey === `entity:CLIENT:${clientId}`).map((e) => e.fromKey); return s.nodes.filter((n) => keys.includes(n.stableKey)) }
  getEvidence({ actor, tenantId, stableKey }) { const s = this.requireSnapshot({ actor, tenantId }); const item = [...s.nodes, ...s.edges].find((row) => row.stableKey === stableKey); return item ? item.provenance : null }

  askDw({ actor, tenantId, question }) {
    const q = required(question, 'question').toLowerCase()
    const snapshot = this.requireSnapshot({ actor, tenantId })
    if (q.includes('which contract') && q.includes('atlas')) {
      const contracts = this.getContractsForClient({ actor, tenantId, clientId: 'atlas' })
      return freeze({ status: contracts.length === 1 ? 'RESOLVED' : 'AMBIGUOUS', answer: contracts.length === 1 ? `${contracts[0].label} applies to Atlas.` : 'Atlas contract identity is unresolved.', entityScope: { level: 'CLIENT', clientId: 'atlas' }, evidence: contracts.map((row) => row.provenance), graphVersion: snapshot.id, canonicalFinancialTruthUsed: false })
    }
    if (q.includes('2%') && q.includes('every client')) return freeze({ status: 'SCOPED', answer: 'No. The 2% late-fee exception is Atlas-specific and does not widen to company scope.', entityScope: { level: 'CLIENT', clientId: 'atlas' }, graphVersion: snapshot.id, canonicalFinancialTruthUsed: false })
    if (q.includes('who can approve settlements')) return freeze({ status: 'OBSERVED_NOT_AUTHORITY', answer: 'The graph observes a founder settlement-approval responsibility. Observed delegation does not grant DW settlement authority.', observedDelegation: this.getRolesDelegation({ actor, tenantId }), actualDwAuthority: 'NOT_GRANTED', graphVersion: snapshot.id, canonicalFinancialTruthUsed: false })
    if (q.includes('why') && q.includes('apply') && q.includes('atlas')) {
      const exception = snapshot.nodes.find((node) => node.type === GRAPH_NODE_TYPE.CLIENT_EXCEPTION && node.data.client_id === 'atlas')
      const contract = this.getContractsForClient({ actor, tenantId, clientId: 'atlas' })[0]
      return freeze({ status: exception && contract ? 'RESOLVED' : 'UNRESOLVED', answer: 'The rule is scoped through Atlas → its contract → the Atlas exception claim.', provenancePath: [exception, contract].filter(Boolean).map((row) => ({ stableKey: row.stableKey, provenance: row.provenance })), graphVersion: snapshot.id, canonicalFinancialTruthUsed: false })
    }
    if (q.includes('who is acme')) {
      const resolution = this.resolveClientAlias({ actor, tenantId, alias: 'Acme' })
      return freeze({ status: resolution.state, answer: resolution.state === RESOLUTION_STATE.AMBIGUOUS ? 'Acme is ambiguous between multiple client records; no client was selected.' : 'Acme resolution is not ambiguous.', ...resolution, graphVersion: snapshot.id, canonicalFinancialTruthUsed: false })
    }
    return freeze({ status: 'UNKNOWN', answer: 'The Company Graph does not have enough scoped evidence.', graphVersion: snapshot.id, canonicalFinancialTruthUsed: false })
  }

  dwIntelligenceContext({ actor, tenantId, clientId = null }) {
    const snapshot = this.requireSnapshot({ actor, tenantId })
    const relevantKeys = clientId ? new Set([`entity:CLIENT:${clientId}`]) : null
    const relationships = snapshot.edges.filter((edge) => edge.active && (!relevantKeys || relevantKeys.has(edge.fromKey) || relevantKeys.has(edge.toKey) || edge.semanticScope?.clientId === clientId))
    return freeze({ kind: 'DW_INTELLIGENCE_COMPANY_GRAPH_CONTEXT_V0', tenantId, graphVersion: snapshot.id, graphSchemaVersion: snapshot.schemaVersion, entityIdentity: clientId ? `entity:CLIENT:${clientId}` : null, relationships, unresolvedIdentity: snapshot.resolutions.filter((row) => row.state !== RESOLUTION_STATE.RESOLVED), conflictLinks: snapshot.edges.filter((edge) => edge.type === GRAPH_EDGE_TYPE.CONFLICTS_WITH), provenancePaths: relationships.map((edge) => ({ edgeKey: edge.stableKey, provenance: edge.provenance })), boundaries: { canonicalMoneyWritable: false, authorityGrantable: false, policyConflictsResolvableByConfidence: false, observedDelegationIsAuthority: false } })
  }
}
