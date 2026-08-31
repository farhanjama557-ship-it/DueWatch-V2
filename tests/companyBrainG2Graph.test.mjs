import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CompanyBrainDurableStore } from '../src/lib/companyBrain/durableStore.js'
import { CompanyGraphStore, GRAPH_EDGE_TYPE, GRAPH_NODE_TYPE, RESOLUTION_STATE, SEMANTIC_SCOPE, createGraphEdge, createGraphNode } from '../src/lib/companyBrain/graphStore.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.resolve(here, '../fixtures/company-brain')
const tenantA = 'tenant-a'
const tenantB = 'tenant-b'
const founderA = { id: tenantA, tenantId: tenantA, role: 'FOUNDER', authenticated: true }
const founderB = { id: tenantB, tenantId: tenantB, role: 'FOUNDER', authenticated: true }
const workerA = { id: 'worker-a', tenantId: tenantA, role: 'INGESTION_WORKER', authenticated: true }
const workerB = { id: 'worker-b', tenantId: tenantB, role: 'INGESTION_WORKER', authenticated: true }
const graphFiles = ['entity-registry.csv', 'atlas-contract.md', 'acme-us-contract.md', 'people-roles.csv', 'historical-late-fee-policy.md', 'atlas-exception.md', 'collections-workflow.md', 'atlas-precedent.md', 'orphan-reference.md', 'historical-aliases.csv', 'acme-account-manager-note.md']

function clocks() { let tick = 0; return () => `2026-08-30T14:${String(tick++).padStart(2, '0')}:00.000Z` }
function ingest(brain, actor, tenantId, folder, filename, identity = filename, suffix = '') { return brain.ingestLocalFile({ actor, tenantId, filePath: path.join(fixtureRoot, folder, filename), sourceIdentity: identity, idempotencyKey: `${tenantId}:${filename}:${suffix || 'v1'}` }) }

function seeded(tenantId = tenantA, actor = workerA, founder = founderA) {
  const clock = clocks()
  const brain = new CompanyBrainDurableStore({ clock })
  ingest(brain, actor, tenantId, 'g1-realistic', 'collections-policy.md')
  ingest(brain, actor, tenantId, 'g1-realistic', 'atlas-terms.csv')
  ingest(brain, actor, tenantId, 'g1-realistic', 'founder-instruction.txt')
  for (const filename of graphFiles) ingest(brain, actor, tenantId, 'g2-graph', filename)
  const graph = new CompanyGraphStore({ brainStore: brain, clock })
  const snapshot = graph.build({ actor: founder, tenantId })
  return { brain, graph, snapshot }
}

test('G2 fixture produces every required graph node type', () => {
  const { snapshot } = seeded()
  for (const type of Object.values(GRAPH_NODE_TYPE)) assert.ok(snapshot.nodes.some((node) => node.type === type), `${type} missing`)
})

test('every operational node and edge exposes exact claim and root provenance', () => {
  const { snapshot } = seeded()
  for (const item of [...snapshot.nodes, ...snapshot.edges].filter((row) => row.active)) {
    assert.ok(item.provenance.claimIds.length > 0)
    assert.ok(item.provenance.rootSourceVersionIds.length > 0)
  }
})

test('cross-tenant entity collision never merges', () => {
  const { brain, graph } = seeded()
  ingest(brain, workerB, tenantB, 'g2-graph', 'entity-registry.csv')
  graph.build({ actor: founderB, tenantId: tenantB })
  const atlasA = graph.getEntity({ actor: founderA, tenantId: tenantA, type: GRAPH_NODE_TYPE.CLIENT, identity: 'atlas' })[0]
  const atlasB = graph.getEntity({ actor: founderB, tenantId: tenantB, type: GRAPH_NODE_TYPE.CLIENT, identity: 'atlas' })[0]
  assert.equal(atlasA.tenantId, tenantA)
  assert.equal(atlasB.tenantId, tenantB)
  assert.equal(atlasA.stableKey, atlasB.stableKey)
  assert.notEqual(atlasA.id, atlasB.id)
  assert.throws(() => graph.getEntity({ actor: founderB, tenantId: tenantA, type: GRAPH_NODE_TYPE.CLIENT, identity: 'atlas' }), /tenant mismatch/)
})

test('same normalized client names in one tenant remain distinct', () => {
  const { graph } = seeded()
  const matches = graph.getEntity({ actor: founderA, tenantId: tenantA, type: GRAPH_NODE_TYPE.CLIENT, identity: 'Acme Ltd' })
  assert.equal(matches.length, 2)
  assert.deepEqual(new Set(matches.map((row) => row.data.entityId)), new Set(['acme-us', 'acme-eu']))
})

test('exact stable client identifier beats an ambiguous shortened name', () => {
  const { snapshot } = seeded()
  const resolution = snapshot.resolutions.find((row) => row.stableId === 'acme-us')
  assert.equal(resolution.state, RESOLUTION_STATE.RESOLVED)
  assert.equal(resolution.selectedKey, 'entity:CLIENT:acme-us')
})

test('Atlas alias resolves only because the registry supplies deterministic support', () => {
  const { graph } = seeded()
  assert.deepEqual(graph.resolveClientAlias({ actor: founderA, tenantId: tenantA, alias: 'Atlas Co' }), { state: RESOLUTION_STATE.RESOLVED, selectedKey: 'entity:CLIENT:atlas', candidateKeys: ['entity:CLIENT:atlas'] })
})

test('ambiguous Acme alias remains ambiguous', () => {
  const { graph } = seeded()
  const result = graph.resolveClientAlias({ actor: founderA, tenantId: tenantA, alias: 'Acme' })
  assert.equal(result.state, RESOLUTION_STATE.AMBIGUOUS)
  assert.equal(result.candidateKeys.length, 2)
})

test('orphaned Northwind reference remains unresolved', () => {
  const { graph } = seeded()
  assert.ok(graph.getUnresolvedRelationships({ actor: founderA, tenantId: tenantA }).some((row) => row.reference === 'Northwind West' && row.state === RESOLUTION_STATE.UNRESOLVED))
})

test('person and client names never collide across entity types', () => {
  const { graph } = seeded()
  assert.equal(graph.getEntity({ actor: founderA, tenantId: tenantA, type: GRAPH_NODE_TYPE.PERSON, identity: 'Acme' }).length, 1)
  assert.equal(graph.resolveClientAlias({ actor: founderA, tenantId: tenantA, alias: 'Acme' }).state, RESOLUTION_STATE.AMBIGUOUS)
})

test('stale historical alias is non-operational for current resolution', () => {
  const { graph, snapshot } = seeded()
  assert.equal(graph.resolveClientAlias({ actor: founderA, tenantId: tenantA, alias: 'Old Atlas' }).state, RESOLUTION_STATE.UNRESOLVED)
  assert.ok(snapshot.edges.some((edge) => edge.type === GRAPH_EDGE_TYPE.ALIAS_OF && edge.active === false))
})

test('duplicate Atlas documents resolve to one stable client', () => {
  const { snapshot } = seeded()
  const selected = snapshot.resolutions.filter((row) => row.reference?.startsWith('Atlas') && row.state === RESOLUTION_STATE.RESOLVED).map((row) => row.selectedKey)
  assert.ok(selected.length >= 3)
  assert.deepEqual(new Set(selected), new Set(['entity:CLIENT:atlas']))
})

test('client exception never widens to company scope', () => {
  const { graph, snapshot } = seeded()
  const exception = snapshot.nodes.find((node) => node.type === GRAPH_NODE_TYPE.CLIENT_EXCEPTION)
  assert.equal(exception.semanticScope.level, SEMANTIC_SCOPE.CLIENT)
  assert.ok(snapshot.edges.some((edge) => edge.fromKey === exception.stableKey && edge.type === GRAPH_EDGE_TYPE.EXCEPTION_FOR && edge.toKey === 'entity:CLIENT:atlas'))
  assert.equal(snapshot.edges.some((edge) => edge.fromKey === exception.stableKey && edge.type === GRAPH_EDGE_TYPE.APPLIES_TO_COMPANY), false)
  assert.equal(graph.getPoliciesApplicable({ actor: founderA, tenantId: tenantA, scope: { level: SEMANTIC_SCOPE.COMPANY } }).some((node) => node.stableKey === exception.stableKey), false)
})

test('historical policy remains historical and never becomes current by graph position', () => {
  const { snapshot } = seeded()
  const historical = snapshot.nodes.find((node) => node.stableKey === 'policy:policy-late-fee-2022')
  assert.equal(historical.semanticScope.level, SEMANTIC_SCOPE.HISTORICAL)
  assert.ok(snapshot.edges.some((edge) => edge.fromKey === historical.stableKey && edge.type === GRAPH_EDGE_TYPE.HISTORICAL_TO))
  assert.equal(snapshot.edges.some((edge) => edge.fromKey === historical.stableKey && edge.type === GRAPH_EDGE_TYPE.APPLIES_TO_COMPANY), false)
})

test('explicit scope survives durable persistence and graph rebuild', () => {
  const { graph } = seeded()
  const first = graph.build({ actor: founderA, tenantId: tenantA })
  const second = graph.build({ actor: founderA, tenantId: tenantA })
  const exception = second.nodes.find((node) => node.type === GRAPH_NODE_TYPE.CLIENT_EXCEPTION)
  assert.equal(first.id, second.id)
  assert.deepEqual(exception.semanticScope, { level: 'CLIENT', clientId: 'atlas', temporality: 'CURRENT' })
})

test('account-manager interaction remains interaction scoped and ambiguous', () => {
  const { brain, snapshot } = seeded()
  const interaction = brain.claims.find((row) => row.claimType === 'interaction_record')
  const claimResolution = snapshot.resolutions.find((row) => row.claimId === interaction.id)
  assert.equal(claimResolution.state, RESOLUTION_STATE.AMBIGUOUS)
  assert.equal(snapshot.edges.some((edge) => edge.semanticScope.level === SEMANTIC_SCOPE.INTERACTION && edge.type === GRAPH_EDGE_TYPE.APPLIES_TO_COMPANY), false)
})

test('repetition of client-local evidence does not create a company policy edge', () => {
  const { snapshot } = seeded()
  const atlasEdges = snapshot.edges.filter((edge) => edge.semanticScope.clientId === 'atlas')
  assert.equal(atlasEdges.some((edge) => edge.type === GRAPH_EDGE_TYPE.APPLIES_TO_COMPANY), false)
})

test('observed role and delegation never grant DW authority', () => {
  const { graph } = seeded()
  for (const edge of graph.getRolesDelegation({ actor: founderA, tenantId: tenantA })) {
    assert.equal(edge.dwAuthority, false)
    if (edge.type === GRAPH_EDGE_TYPE.OBSERVED_DELEGATION) assert.equal(edge.data.observedOnly, true)
  }
})

test('account manager cannot create settlement authority', () => {
  const { graph } = seeded()
  const answer = graph.askDw({ actor: founderA, tenantId: tenantA, question: 'Who can approve settlements?' })
  assert.equal(answer.status, 'OBSERVED_NOT_AUTHORITY')
  assert.equal(answer.actualDwAuthority, 'NOT_GRANTED')
})

test('graph node without provenance is rejected', () => {
  assert.throws(() => createGraphNode({ tenantId: tenantA, stableKey: 'bad', type: GRAPH_NODE_TYPE.CLIENT, label: 'Bad' }), /requires claim and root provenance/)
})

test('graph edge without provenance is rejected', () => {
  assert.throws(() => createGraphEdge({ tenantId: tenantA, stableKey: 'bad-edge', type: GRAPH_EDGE_TYPE.CLIENT_OF, fromKey: 'a', toKey: 'b' }), /requires claim and root provenance/)
})

test('cross-tenant graph edge insertion is blocked', () => {
  const { graph, snapshot } = seeded()
  const from = snapshot.nodes.find((node) => node.type === GRAPH_NODE_TYPE.CLIENT)
  const foreign = createGraphNode({ tenantId: tenantB, stableKey: 'entity:COMPANY:foreign', type: GRAPH_NODE_TYPE.COMPANY, label: 'Foreign', claimIds: ['foreign-claim'], rootSourceVersionIds: ['foreign-root'] })
  graph.nodes.push(foreign)
  const edge = createGraphEdge({ tenantId: tenantA, stableKey: 'cross-edge', type: GRAPH_EDGE_TYPE.CLIENT_OF, fromKey: from.stableKey, toKey: foreign.stableKey, claimIds: from.provenance.claimIds, rootSourceVersionIds: from.provenance.rootSourceVersionIds })
  assert.throws(() => graph.persistEdge({ actor: founderA, tenantId: tenantA, edge }), /endpoint missing or cross-tenant/)
})

test('graph rebuild is idempotent for the same Brain version set', () => {
  const { graph, snapshot } = seeded()
  const replay = graph.build({ actor: founderA, tenantId: tenantA })
  assert.equal(replay.id, snapshot.id)
  assert.equal(graph.snapshots.length, 1)
})

test('source-version change creates a distinguishable graph version', () => {
  const { brain, graph, snapshot } = seeded()
  brain.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'atlas-contract.md', sourceIdentity: 'atlas-contract.md', idempotencyKey: 'atlas-contract-v2', content: '---\ndocument_type: contract\ncontract_id: contract-atlas-2027\nclient_id: atlas\nclient_reference: Atlas\nscope: CLIENT\neffective_from: 2027-01-01\n---\n# Renewed Atlas contract' })
  const next = graph.build({ actor: founderA, tenantId: tenantA })
  assert.notEqual(next.id, snapshot.id)
  assert.notDeepEqual(next.sourceVersionIds, snapshot.sourceVersionIds)
})

test('graph snapshot retrieval is tenant-bound', () => {
  const { graph } = seeded()
  assert.throws(() => graph.activeSnapshot({ actor: founderB, tenantId: tenantA }), /tenant mismatch/)
})

test('revoked source invalidates dependent current graph structure only', () => {
  const { brain, graph, snapshot } = seeded()
  const source = brain.sources.find((row) => row.identity === 'atlas-exception.md')
  const exceptionKey = snapshot.nodes.find((node) => node.type === GRAPH_NODE_TYPE.CLIENT_EXCEPTION).stableKey
  brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: source.id, reason: 'withdrawn' })
  const next = graph.build({ actor: founderA, tenantId: tenantA })
  assert.equal(next.nodes.some((node) => node.stableKey === exceptionKey), false)
  assert.equal(graph.nodes.find((node) => node.graphVersionId === snapshot.id && node.stableKey === exceptionKey).active, false)
  assert.ok(next.nodes.some((node) => node.stableKey === 'entity:CLIENT:acme-us' && node.active))
  assert.ok(snapshot.nodes.some((node) => node.stableKey === exceptionKey), 'historical snapshot remains auditable')
})

test('derived graph edge cannot become independent corroboration', () => {
  const { snapshot } = seeded()
  const derived = snapshot.edges.filter((edge) => edge.derived)
  assert.ok(derived.length > 0)
  assert.ok(derived.every((edge) => edge.provenance.independent === false))
})

test('Ask DW contract lookup returns exact client scope and provenance', () => {
  const { graph } = seeded()
  const answer = graph.askDw({ actor: founderA, tenantId: tenantA, question: 'Which contract applies to Atlas?' })
  assert.equal(answer.status, 'RESOLVED')
  assert.equal(answer.entityScope.clientId, 'atlas')
  assert.ok(answer.evidence[0].rootSourceVersionIds.length > 0)
})

test('Ask DW refuses Atlas scope widening', () => {
  const { graph } = seeded()
  const answer = graph.askDw({ actor: founderA, tenantId: tenantA, question: "Does Atlas's 2% late fee apply to every client?" })
  assert.equal(answer.status, 'SCOPED')
  assert.match(answer.answer, /does not widen/)
})

test('Ask DW explains Atlas applicability through a provenance path', () => {
  const { graph } = seeded()
  const answer = graph.askDw({ actor: founderA, tenantId: tenantA, question: 'Why does this rule apply to Atlas?' })
  assert.equal(answer.status, 'RESOLVED')
  assert.ok(answer.provenancePath.every((item) => item.provenance.rootSourceVersionIds.length > 0))
})

test('Ask DW surfaces Acme ambiguity instead of guessing', () => {
  const { graph } = seeded()
  const answer = graph.askDw({ actor: founderA, tenantId: tenantA, question: 'Who is Acme?' })
  assert.equal(answer.status, RESOLUTION_STATE.AMBIGUOUS)
  assert.equal(answer.selectedKey, null)
})

test('DW Intelligence receives typed versioned graph context', () => {
  const { graph, snapshot } = seeded()
  const context = graph.dwIntelligenceContext({ actor: founderA, tenantId: tenantA, clientId: 'atlas' })
  assert.equal(context.kind, 'DW_INTELLIGENCE_COMPANY_GRAPH_CONTEXT_V0')
  assert.equal(context.graphVersion, snapshot.id)
  assert.ok(context.relationships.length > 0)
  assert.ok(context.provenancePaths.every((path) => path.provenance.rootSourceVersionIds.length > 0))
})

test('graph context cannot mutate canonical financial truth, grant authority, or resolve conflicts by confidence', () => {
  const { graph, snapshot } = seeded()
  const context = graph.dwIntelligenceContext({ actor: founderA, tenantId: tenantA, clientId: 'atlas' })
  assert.deepEqual(context.boundaries, { canonicalMoneyWritable: false, authorityGrantable: false, policyConflictsResolvableByConfidence: false, observedDelegationIsAuthority: false })
  assert.equal(snapshot.canonicalMoneyWritable, false)
  assert.equal(snapshot.authorityGrantable, false)
  assert.equal(snapshot.policyPrecedenceResolved, false)
  assert.ok(snapshot.nodes.some((node) => node.type === GRAPH_NODE_TYPE.CONFLICT && node.resolutionState === RESOLUTION_STATE.CONFLICTED))
})

test('Ask DW never consumes a stale graph after source revocation', () => {
  const { brain, graph, snapshot } = seeded()
  const source = brain.sources.find((row) => row.identity === 'atlas-exception.md')
  brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: source.id, reason: 'withdrawn before query' })
  assert.equal(graph.activeSnapshot({ actor: founderA, tenantId: tenantA }), null)
  const answer = graph.askDw({ actor: founderA, tenantId: tenantA, question: 'Why does this rule apply to Atlas?' })
  assert.equal(answer.status, 'UNRESOLVED')
  assert.notEqual(answer.graphVersion, snapshot.id)
  assert.equal(graph.activeSnapshot({ actor: founderA, tenantId: tenantA }).brainKnowledgeVersion, brain.version(tenantA))
})

test('DW Intelligence deterministically rebuilds after a new source version', () => {
  const { brain, graph, snapshot } = seeded()
  brain.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'atlas-contract.md', sourceIdentity: 'atlas-contract.md', idempotencyKey: 'freshness-contract-v2', content: '---\ndocument_type: contract\ncontract_id: contract-atlas-2027\nclient_id: atlas\nclient_reference: Atlas\nscope: CLIENT\neffective_from: 2027-01-01\n---\n# Renewed contract' })
  const context = graph.dwIntelligenceContext({ actor: founderA, tenantId: tenantA, clientId: 'atlas' })
  assert.notEqual(context.graphVersion, snapshot.id)
  assert.equal(graph.activeSnapshot({ actor: founderA, tenantId: tenantA }).brainKnowledgeVersion, brain.version(tenantA))
})

test('same stable graph object merges every independent claim root into node and edge provenance', () => {
  const { brain, graph } = seeded()
  brain.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'atlas-registry-confirmation.csv', sourceIdentity: 'atlas-registry-confirmation.csv', idempotencyKey: 'atlas-confirmation', content: 'entity_type,entity_id,name,aliases,company_id\nCLIENT,atlas,Atlas Group,Atlas|Atlas Co,duewatch-company' })
  const next = graph.build({ actor: founderA, tenantId: tenantA })
  const atlas = next.nodes.find((node) => node.stableKey === 'entity:CLIENT:atlas')
  const membership = next.edges.find((edge) => edge.fromKey === atlas.stableKey && edge.type === GRAPH_EDGE_TYPE.CLIENT_OF)
  assert.ok(atlas.provenance.rootSourceVersionIds.length >= 2)
  assert.ok(atlas.provenance.independentRootCount >= 2)
  assert.deepEqual(new Set(membership.provenance.rootSourceVersionIds), new Set(atlas.provenance.rootSourceVersionIds))
})

test('conflicting attributes for one stable entity ID remain inspectable and conflicted', () => {
  const { brain, graph } = seeded()
  brain.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'atlas-conflict.csv', sourceIdentity: 'atlas-conflict.csv', idempotencyKey: 'atlas-conflict', content: 'entity_type,entity_id,name,aliases,company_id\nCLIENT,atlas,Atlas Impostor,Atlas,duewatch-company' })
  const next = graph.build({ actor: founderA, tenantId: tenantA })
  const atlas = next.nodes.find((node) => node.stableKey === 'entity:CLIENT:atlas')
  assert.equal(atlas.resolutionState, RESOLUTION_STATE.CONFLICTED)
  assert.equal(atlas.data.identityVariants.length, 2)
  const resolution = graph.resolveClientAlias({ actor: founderA, tenantId: tenantA, alias: 'Atlas' })
  assert.equal(resolution.state, RESOLUTION_STATE.CONFLICTED)
  assert.equal(resolution.selectedKey, null)
})

test('name-only downstream relationship stays conflicted when its sole stable entity candidate is conflicted', () => {
  const { brain, graph } = seeded()
  brain.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'atlas-conflict.csv', sourceIdentity: 'atlas-conflict-name-only.csv', idempotencyKey: 'atlas-conflict-name-only', content: 'entity_type,entity_id,name,aliases,company_id\nCLIENT,atlas,Atlas Impostor,Atlas,duewatch-company' })
  const downstream = brain.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'atlas-name-only-contract.md', sourceIdentity: 'atlas-name-only-contract.md', idempotencyKey: 'atlas-name-only-contract', content: '---\ndocument_type: contract\ncontract_id: contract-atlas-name-only\nclient_reference: Atlas\nscope: DOCUMENT\n---\n# Name-only downstream contract reference' })
  const next = graph.build({ actor: founderA, tenantId: tenantA })
  const claim = brain.claims.find((row) => row.tenantId === tenantA && row.provenanceRootIds.includes(downstream.sourceVersionId))
  const resolution = next.resolutions.find((row) => row.claimId === claim.id)
  const contract = next.nodes.find((row) => row.stableKey === 'contract:contract-atlas-name-only')
  assert.equal(resolution.state, RESOLUTION_STATE.CONFLICTED)
  assert.equal(resolution.selectedKey, null)
  assert.deepEqual(resolution.candidateKeys, ['entity:CLIENT:atlas'])
  assert.equal(next.edges.some((edge) => edge.type === GRAPH_EDGE_TYPE.HAS_CONTRACT && edge.toKey === contract.stableKey), false)
})

test('revoking a non-primary root invalidates the old graph object and rebuilds from remaining support', () => {
  const { brain, graph } = seeded()
  const confirmation = brain.ingestContent({ actor: workerA, tenantId: tenantA, filename: 'atlas-registry-confirmation.csv', sourceIdentity: 'atlas-registry-confirmation.csv', idempotencyKey: 'atlas-confirmation-revoke', content: 'entity_type,entity_id,name,aliases,company_id\nCLIENT,atlas,Atlas Group,Atlas|Atlas Co,duewatch-company' })
  const before = graph.build({ actor: founderA, tenantId: tenantA })
  const oldNode = graph.nodes.find((node) => node.graphVersionId === before.id && node.stableKey === 'entity:CLIENT:atlas')
  assert.ok(oldNode.provenance.rootSourceVersionIds.includes(confirmation.sourceVersionId))
  brain.revokeSource({ actor: founderA, tenantId: tenantA, sourceId: confirmation.sourceId, reason: 'secondary evidence withdrawn' })
  const answer = graph.askDw({ actor: founderA, tenantId: tenantA, question: 'Which contract applies to Atlas?' })
  const current = graph.activeSnapshot({ actor: founderA, tenantId: tenantA })
  const currentNode = current.nodes.find((node) => node.stableKey === 'entity:CLIENT:atlas')
  assert.equal(answer.status, 'RESOLVED')
  assert.equal(oldNode.active, false)
  assert.equal(oldNode.revoked, true)
  assert.ok(currentNode)
  assert.equal(currentNode.provenance.rootSourceVersionIds.includes(confirmation.sourceVersionId), false)
})

test('cross-tenant and dangling graph provenance are rejected before persistence', () => {
  const { brain, graph } = seeded()
  const receipt = ingest(brain, workerB, tenantB, 'g2-graph', 'entity-registry.csv', 'tenant-b-registry')
  const foreignClaim = brain.claims.find((claim) => claim.tenantId === tenantB)
  const foreignNode = createGraphNode({ tenantId: tenantA, stableKey: 'entity:CLIENT:forged', type: GRAPH_NODE_TYPE.CLIENT, label: 'Forged', claimIds: [foreignClaim.id], rootSourceVersionIds: [receipt.sourceVersionId], provenancePairs: [{ claimId: foreignClaim.id, sourceVersionId: receipt.sourceVersionId, independent: true }] })
  assert.throws(() => graph.persistNode({ actor: founderA, tenantId: tenantA, node: foreignNode }), /dangling or cross-tenant/)
  const dangling = createGraphNode({ tenantId: tenantA, stableKey: 'entity:CLIENT:dangling', type: GRAPH_NODE_TYPE.CLIENT, label: 'Dangling', claimIds: ['missing-claim'], rootSourceVersionIds: ['missing-root'] })
  assert.throws(() => graph.persistNode({ actor: founderA, tenantId: tenantA, node: dangling }), /dangling or cross-tenant/)
})

test('same-tenant claim paired with a different valid same-tenant source root is rejected', () => {
  const { brain, graph } = seeded()
  const claim = brain.claims.find((row) => row.tenantId === tenantA)
  const unrelatedRoot = brain.sourceVersions.find((row) => row.tenantId === tenantA && !claim.provenanceRootIds.includes(row.id))
  assert.ok(unrelatedRoot)
  const mismatched = createGraphNode({ tenantId: tenantA, stableKey: 'entity:CLIENT:mismatched-root', type: GRAPH_NODE_TYPE.CLIENT, label: 'Mismatched Root', claimIds: [claim.id], rootSourceVersionIds: [unrelatedRoot.id], provenancePairs: [{ claimId: claim.id, sourceVersionId: unrelatedRoot.id, independent: true }] })
  assert.throws(() => graph.persistNode({ actor: founderA, tenantId: tenantA, node: mismatched }), /dangling or cross-tenant/)
})
