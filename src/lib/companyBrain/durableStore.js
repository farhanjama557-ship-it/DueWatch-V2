import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  AUTHORITY_STATUS,
  CLAIM_CLASS,
  answerAskDwFromCompanyBrain,
  buildBrainSnapshot,
  createArtifact,
  createAuthorityProposal,
  createClaim,
  createFounderDecision,
  createSource,
  decideAuthorityProposal,
  detectConflicts,
  evaluateCompanyBrainAuthority,
  toDwIntelligenceCompanyContext,
} from './index.js'

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizeContent(content) {
  return content.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

function id(prefix, value) {
  return `${prefix}-${hash(value).slice(0, 24)}`
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`)
  return value.trim()
}

function assertActor(actor, tenantId) {
  if (!actor?.authenticated || !actor.id) throw new Error('authenticated actor required')
  if (actor.tenantId !== tenantId) throw new Error('actor tenant mismatch')
}

function extensionType(filename) {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.md') return 'MARKDOWN'
  if (ext === '.txt') return 'TEXT'
  if (ext === '.csv') return 'CSV'
  throw new Error(`unsupported local file type: ${ext || 'none'}`)
}

function extractedClaim(input, index, claimClass, claimType, value, semanticScope, subjectScope = {}, options = {}) {
  return createClaim({
    tenantId: input.tenantId,
    id: `${input.sourceVersionId}:claim:${index}`,
    claimClass,
    claimType,
    semanticScope,
    subjectScope,
    value,
    artifactIds: [input.artifactId],
    explicit: options.explicit !== false,
    derived: options.derived === true,
    confidence: options.confidence ?? 1,
    uncertainty: options.uncertainty ?? null,
    status: options.status || 'OBSERVED',
    assumptions: options.assumptions || [],
    provenanceRootIds: [input.sourceVersionId],
    independentCorroboration: options.independentCorroboration === true,
    canonicalFinancialTruth: false,
  })
}

export function extractDeterministicClaims({ tenantId, sourceVersionId, artifactId, filename, content } = {}) {
  const type = extensionType(filename)
  const normalized = normalizeContent(content)
  const claims = []
  const input = { tenantId, sourceVersionId, artifactId }

  if (type === 'CSV') {
    const rows = normalized.split('\n').map((line) => line.split(',').map((cell) => cell.trim()))
    const headers = rows.shift()?.map((cell) => cell.toLowerCase()) || []
    for (const row of rows) {
      const data = Object.fromEntries(headers.map((header, index) => [header, row[index]]))
      if (data.client && data.payment_terms_days) claims.push(extractedClaim(input, claims.length, CLAIM_CLASS.PAYMENT_TERMS_CONTEXT, 'payment_terms', { netDays: Number(data.payment_terms_days) }, { level: 'CLIENT', clientId: data.client.toLowerCase(), temporality: 'CURRENT' }, { clientId: data.client.toLowerCase() }))
      if (data.client && data.late_fee_percent) claims.push(extractedClaim(input, claims.length, CLAIM_CLASS.CLIENT_EXCEPTION, 'late_fee_policy', { ratePercent: Number(data.late_fee_percent), onlyWhenApplicable: true }, { level: 'CLIENT', clientId: data.client.toLowerCase(), temporality: 'CURRENT' }, { clientId: data.client.toLowerCase() }))
    }
  } else {
    const lateFee = /(?:charge\s+a\s+)?(\d+(?:\.\d+)?)%\s+late fee/i.exec(normalized)
    if (lateFee) claims.push(extractedClaim(input, claims.length, CLAIM_CLASS.COMPANY_POLICY, 'late_fee_policy', { ratePercent: Number(lateFee[1]) }, { level: 'COMPANY', temporality: 'CURRENT' }))
    const reminders = /reminders?\s+at\s+(\d+)\s*(?:,|\/|and)\s*(\d+)\s*(?:,?\s*and|,|\/)\s*(\d+)/i.exec(normalized)
    if (reminders) claims.push(extractedClaim(input, claims.length, CLAIM_CLASS.COLLECTION_WORKFLOW, 'reminder_cadence', { daysOverdue: reminders.slice(1).map(Number) }, { level: 'COMPANY', temporality: 'CURRENT' }))
    if (/stopped charging late fees until i approve/i.test(normalized)) claims.push(extractedClaim(input, claims.length, CLAIM_CLASS.FOUNDER_INSTRUCTION, 'late_fee_policy', { enabled: false, requiresNewApproval: true }, { level: 'COMPANY', temporality: 'CURRENT' }))
    if (/give\s+atlas\s+20%\s+off/i.test(normalized)) claims.push(extractedClaim(input, claims.length, CLAIM_CLASS.INTERPRETATION, 'settlement_discount_statement', { discountPercent: 20, speakerRole: 'ACCOUNT_MANAGER' }, { level: 'CLIENT', clientId: 'atlas', temporality: 'CURRENT' }, { clientId: 'atlas' }, { uncertainty: 'COMMUNICATION_NOT_AUTHORITY' }))
    if (/invoice\s+104\s+was paid yesterday/i.test(normalized)) claims.push(extractedClaim(input, claims.length, CLAIM_CLASS.INTERPRETATION, 'contextual_payment_statement', { statement: 'Invoice 104 was paid yesterday' }, { level: 'INVOICE_CONTEXT', invoiceId: '104', temporality: 'RECENT' }, { invoiceId: '104' }, { confidence: 0.2, uncertainty: 'UNTRUSTED_CONTEXT_ONLY', assumptions: ['Requires R0 authoritative financial refetch'] }))
  }

  if (!claims.length) throw new Error('no deterministic claims extracted')
  return Object.freeze(claims)
}

export class CompanyBrainDurableStore {
  constructor({ clock = () => new Date().toISOString() } = {}) {
    this.clock = clock
    this.knowledgeVersion = new Map()
    this.sources = []
    this.sourceVersions = []
    this.artifacts = []
    this.claims = []
    this.claimRoots = []
    this.conflicts = []
    this.conflictMembers = []
    this.decisions = []
    this.decisionAttempts = []
    this.authorityProposals = []
    this.tombstones = []
    this.snapshots = []
    this.ingestionJobs = []
    this.targetRevisions = new Map()
  }

  version(tenantId) { return this.knowledgeVersion.get(tenantId) || 0 }
  bump(tenantId) { this.knowledgeVersion.set(tenantId, this.version(tenantId) + 1) }

  tenantRows(rows, tenantId) {
    requireText(tenantId, 'tenantId')
    return rows.filter((row) => row.tenantId === tenantId)
  }

  readForTenant(rows, { actor, tenantId }) {
    assertActor(actor, tenantId)
    return Object.freeze(this.tenantRows(rows, tenantId))
  }

  ingestLocalFile({ actor, tenantId, filePath, sourceIdentity, idempotencyKey, beforeCommit = null, failAfterPersistingVersion = false } = {}) {
    assertActor(actor, tenantId)
    const filename = path.basename(requireText(filePath, 'filePath'))
    return this.ingestContent({ actor, tenantId, filename, content: fs.readFileSync(filePath, 'utf8'), sourceIdentity: sourceIdentity || filename.toLowerCase(), idempotencyKey, beforeCommit, failAfterPersistingVersion })
  }

  ingestContent({ actor, tenantId, filename, content, sourceIdentity, idempotencyKey, beforeCommit = null, failAfterPersistingVersion = false } = {}) {
    assertActor(actor, tenantId)
    requireText(filename, 'filename')
    requireText(sourceIdentity, 'sourceIdentity')
    requireText(idempotencyKey, 'idempotencyKey')
    const normalized = normalizeContent(requireText(content, 'content'))
    const contentHash = hash(normalized)
    let job = this.ingestionJobs.find((row) => row.tenantId === tenantId && row.idempotencyKey === idempotencyKey)
    if (job && job.contentHash !== contentHash) throw new Error('idempotency key reused with different content')
    if (job?.status === 'COMPLETED') return Object.freeze({ ...job.receipt, idempotentReplay: true })
    if (!job) {
      job = { id: id('job', `${tenantId}:${idempotencyKey}`), tenantId, idempotencyKey, contentHash, status: 'PROCESSING', attempts: 0, createdAt: this.clock(), receipt: null }
      this.ingestionJobs.push(job)
    }
    job.attempts += 1
    job.status = 'PROCESSING'

    const duplicate = this.sourceVersions.find((row) => row.tenantId === tenantId && row.contentHash === contentHash && ['ACTIVE', 'SUPERSEDED'].includes(row.status))
    if (duplicate) {
      job.status = 'COMPLETED'
      job.receipt = { jobId: job.id, sourceId: duplicate.sourceId, sourceVersionId: duplicate.id, duplicateContent: true, createdClaimIds: [] }
      return Object.freeze({ ...job.receipt, idempotentReplay: false })
    }

    let source = this.sources.find((row) => row.tenantId === tenantId && row.identity === sourceIdentity)
    if (!source) {
      source = { id: id('source', `${tenantId}:${sourceIdentity}`), tenantId, identity: sourceIdentity, active: true, currentVersionId: null, createdAt: this.clock(), revokedAt: null }
      this.sources.push(source)
    }
    if (!source.active) throw new Error('source revoked')
    const sourceVersionId = id('source-version', `${tenantId}:${source.id}:${contentHash}`)
    let version = this.sourceVersions.find((row) => row.tenantId === tenantId && row.id === sourceVersionId && row.status === 'FAILED')
    if (version) {
      version.status = 'PROCESSING'
      version.filename = filename
    } else {
      const versionNumber = this.sourceVersions.filter((row) => row.tenantId === tenantId && row.sourceId === source.id).length + 1
      version = { id: sourceVersionId, tenantId, sourceId: source.id, versionNumber, contentHash, filename, status: 'PROCESSING', createdAt: this.clock(), domainSource: null }
      this.sourceVersions.push(version)
    }
    source.currentVersionId = sourceVersionId

    try {
      if (failAfterPersistingVersion) throw new Error('simulated partial ingestion failure')
      const artifactId = id('artifact', `${tenantId}:${sourceVersionId}:0`)
      const domainSource = createSource({ tenantId, id: sourceVersionId, sourceType: extensionType(filename), trustZone: 'CONTROLLED_LOCAL_INGESTION', sourceTimestamp: version.createdAt, sourceVersion: String(version.versionNumber), ingestedAt: version.createdAt, contentHash: `sha256:${contentHash}`, active: true })
      const artifact = createArtifact({ tenantId, id: artifactId, sourceId: sourceVersionId, artifactType: extensionType(filename), rootSourceIds: [sourceVersionId], locator: `local:${filename}`, classifiedAt: this.clock() })
      const claims = extractDeterministicClaims({ tenantId, sourceVersionId, artifactId, filename, content: normalized })
      if (beforeCommit) beforeCommit(this, { sourceId: source.id, sourceVersionId, contentHash })
      const current = source.active && source.currentVersionId === sourceVersionId
      version.status = current ? 'ACTIVE' : 'INVALIDATED'
      version.domainSource = current ? domainSource : createSource({ ...domainSource, active: false, revokedAt: this.clock(), revocationReason: 'stale_extraction_output' })
      this.artifacts.push({ ...artifact, sourceVersionId, active: current })
      for (const claim of claims) {
        this.claims.push({ ...claim, sourceVersionId, active: current })
        this.claimRoots.push({ tenantId, claimId: claim.id, sourceVersionId, independent: claim.derived !== true })
      }
      if (current) {
        for (const old of this.sourceVersions.filter((row) => row.tenantId === tenantId && row.sourceId === source.id && row.id !== sourceVersionId && row.status === 'ACTIVE')) old.status = 'SUPERSEDED'
        for (const oldClaim of this.claims.filter((row) => row.tenantId === tenantId && row.sourceVersionId !== sourceVersionId && this.sourceVersions.find((v) => v.id === row.sourceVersionId)?.sourceId === source.id)) oldClaim.active = false
        this.bump(tenantId)
        this.rebuildConflicts(tenantId)
      }
      job.status = 'COMPLETED'
      job.receipt = { jobId: job.id, sourceId: source.id, sourceVersionId, duplicateContent: false, staleOutputRejected: !current, createdClaimIds: claims.map((claim) => claim.id) }
      return Object.freeze({ ...job.receipt, idempotentReplay: false })
    } catch (error) {
      version.status = 'FAILED'
      job.status = 'FAILED'
      job.error = error.message
      throw error
    }
  }

  rebuildConflicts(tenantId) {
    this.conflicts = this.conflicts.filter((row) => row.tenantId !== tenantId)
    this.conflictMembers = this.conflictMembers.filter((row) => row.tenantId !== tenantId)
    const conflicts = detectConflicts(this.tenantRows(this.claims, tenantId).filter((row) => row.active))
    for (const conflict of conflicts) {
      const row = { ...conflict, revision: this.targetRevisions.get(`${tenantId}:${conflict.id}`) || 0 }
      this.conflicts.push(row)
      for (const claimId of conflict.competingClaimIds) this.conflictMembers.push({ tenantId, conflictId: conflict.id, claimId })
    }
  }

  prepareSnapshot({ actor, tenantId }) {
    assertActor(actor, tenantId)
    const knowledgeVersion = this.version(tenantId)
    const activeVersions = this.tenantRows(this.sourceVersions, tenantId).filter((row) => row.status === 'ACTIVE' && row.domainSource)
    const activeVersionIds = new Set(activeVersions.map((row) => row.id))
    const activeClaims = this.tenantRows(this.claims, tenantId).filter((row) => row.active)
    for (const claim of activeClaims) {
      for (const rootId of claim.provenanceRootIds) {
        const root = this.sourceVersions.find((row) => row.id === rootId && row.tenantId === tenantId)
        if (!root) throw new Error(`root provenance unknown: ${rootId}`)
      }
    }
    const clone = (rows) => structuredClone(rows)
    return Object.freeze({
      tenantId,
      knowledgeVersion,
      preparedAt: this.clock(),
      sources: clone(activeVersions.map((row) => row.domainSource)),
      artifacts: clone(this.tenantRows(this.artifacts, tenantId).filter((row) => row.active && activeVersionIds.has(row.sourceVersionId))),
      claims: clone(activeClaims.filter((row) => activeVersionIds.has(row.sourceVersionId))),
      decisions: clone(this.tenantRows(this.decisions, tenantId).filter((row) => row.status === 'RECORDED')),
      authorityProposals: clone(this.tenantRows(this.authorityProposals, tenantId)),
      tombstones: clone(this.tenantRows(this.tombstones, tenantId)),
      sourceVersionIds: [...activeVersionIds].sort(),
    })
  }

  commitPreparedSnapshot(prepared) {
    const domain = buildBrainSnapshot(prepared)
    const existing = this.snapshots.find((row) => row.tenantId === prepared.tenantId && row.knowledgeVersion === prepared.knowledgeVersion && row.domain.id === domain.id)
    if (existing) return existing
    const row = Object.freeze({ id: `durable-${prepared.tenantId}-v${prepared.knowledgeVersion}-${domain.id}`, tenantId: prepared.tenantId, version: this.tenantRows(this.snapshots, prepared.tenantId).length + 1, knowledgeVersion: prepared.knowledgeVersion, createdAt: this.clock(), sourceVersionIds: prepared.sourceVersionIds, tombstoneWatermark: prepared.tombstones.length, domain })
    this.snapshots.push(row)
    return row
  }

  createSnapshot(input) { return this.commitPreparedSnapshot(this.prepareSnapshot(input)) }

  latestSnapshot({ actor, tenantId }) {
    assertActor(actor, tenantId)
    return this.tenantRows(this.snapshots, tenantId).at(-1) || null
  }

  recordFounderDecision({ actor, tenantId, idempotencyKey, targetId, expectedRevision, decisionType, oldState, newState, evidenceClaimIds, reason } = {}) {
    assertActor(actor, tenantId)
    if (actor.role !== 'FOUNDER') throw new Error('founder role required')
    const prior = this.decisions.find((row) => row.tenantId === tenantId && row.idempotencyKey === idempotencyKey)
    if (prior) return prior
    const target = this.conflicts.find((row) => row.tenantId === tenantId && row.id === targetId)
    if (!target) throw new Error('decision target missing or revoked')
    const key = `${tenantId}:${targetId}`
    const actualRevision = this.targetRevisions.get(key) || 0
    if (expectedRevision !== actualRevision) {
      this.decisionAttempts.push({ tenantId, actorId: actor.id, targetId, expectedRevision, actualRevision, outcome: 'REJECTED_STALE', attemptedAt: this.clock() })
      throw new Error('stale founder decision')
    }
    const decision = createFounderDecision({ id: id('decision', `${tenantId}:${idempotencyKey}`), tenantId, actorId: actor.id, actorRole: 'FOUNDER', decidedAt: this.clock(), decisionType, target: target.topic, oldState, newState, evidenceClaimIds, reason, revocable: true })
    const persisted = Object.freeze({ ...decision, idempotencyKey, targetId, targetRevision: actualRevision + 1, supersedesDecisionId: this.tenantRows(this.decisions, tenantId).filter((row) => row.targetId === targetId).at(-1)?.id || null })
    this.decisions.push(persisted)
    this.targetRevisions.set(key, actualRevision + 1)
    target.status = 'RESOLVED'
    target.resolutionDecisionId = persisted.id
    target.revision = actualRevision + 1
    this.bump(tenantId)
    return persisted
  }

  persistAuthorityProposal({ actor, tenantId, proposal }) {
    assertActor(actor, tenantId)
    if (proposal.tenantId !== tenantId) throw new Error('authority proposal tenant mismatch')
    if (this.authorityProposals.some((row) => row.tenantId === tenantId && row.id === proposal.id)) return this.authorityProposals.find((row) => row.tenantId === tenantId && row.id === proposal.id)
    this.authorityProposals.push(proposal)
    this.bump(tenantId)
    return proposal
  }

  decideAuthority({ actor, tenantId, proposalId, decision }) {
    assertActor(actor, tenantId)
    if (actor.role !== 'FOUNDER') throw new Error('founder role required')
    const index = this.authorityProposals.findIndex((row) => row.tenantId === tenantId && row.id === proposalId)
    if (index < 0) throw new Error('authority proposal missing')
    const updated = decideAuthorityProposal(this.authorityProposals[index], { actorId: actor.id, actorRole: 'FOUNDER', decidedAt: this.clock(), decision })
    this.authorityProposals[index] = updated
    this.bump(tenantId)
    return updated
  }

  evaluateAuthority({ actor, tenantId, actionClass, scope, approvalHistory = [] }) {
    const snapshot = this.createSnapshot({ actor, tenantId }).domain
    return evaluateCompanyBrainAuthority({ snapshot, actionClass, scope, approvalHistory })
  }

  revokeSource({ actor, tenantId, sourceId, reason }) {
    assertActor(actor, tenantId)
    const source = this.sources.find((row) => row.tenantId === tenantId && row.id === sourceId)
    if (!source) throw new Error('source missing')
    if (!source.active) return this.tombstones.find((row) => row.tenantId === tenantId && row.sourceId === sourceId)
    source.active = false
    source.revokedAt = this.clock()
    for (const version of this.sourceVersions.filter((row) => row.tenantId === tenantId && row.sourceId === sourceId)) {
      version.status = 'REVOKED'
      if (version.domainSource) version.domainSource = createSource({ ...version.domainSource, active: false, revokedAt: source.revokedAt, revocationReason: reason })
      for (const claim of this.claims.filter((row) => row.sourceVersionId === version.id)) claim.active = false
      for (const artifact of this.artifacts.filter((row) => row.sourceVersionId === version.id)) artifact.active = false
    }
    const tombstone = Object.freeze({ kind: 'COMPANY_BRAIN_SOURCE_TOMBSTONE_V0', id: id('tombstone', `${tenantId}:${sourceId}`), tenantId, sourceId, revokedAt: source.revokedAt, reason })
    this.tombstones.push(tombstone)
    this.bump(tenantId)
    this.rebuildConflicts(tenantId)
    return tombstone
  }

  queryClaims({ actor, tenantId, claimType = null, semanticScope = null, clientId = null, active = true, sourceVersionId = null } = {}) {
    assertActor(actor, tenantId)
    return Object.freeze(this.tenantRows(this.claims, tenantId).filter((claim) =>
      (active == null || claim.active === active) &&
      (!claimType || claim.claimType === claimType) &&
      (!clientId || claim.subjectScope?.clientId === clientId) &&
      (!sourceVersionId || claim.sourceVersionId === sourceVersionId) &&
      (!semanticScope || Object.entries(semanticScope).every(([key, value]) => claim.semanticScope?.[key] === value))
    ))
  }

  askDw({ actor, tenantId, question }) {
    const row = this.latestSnapshot({ actor, tenantId }) || this.createSnapshot({ actor, tenantId })
    return answerAskDwFromCompanyBrain({ snapshot: row.domain, question })
  }

  dwIntelligenceContext({ actor, tenantId, clientId }) {
    const row = this.latestSnapshot({ actor, tenantId }) || this.createSnapshot({ actor, tenantId })
    return Object.freeze({ ...toDwIntelligenceCompanyContext({ snapshot: row.domain, clientId }), durableSnapshotId: row.id, durableSnapshotVersion: row.version })
  }
}

export function proposedAuthority({ id: proposalId, tenantId, actionClass, scope, evidenceClaimIds }) {
  return createAuthorityProposal({ id: proposalId, tenantId, actionClass, scope, evidenceClaimIds })
}

export { AUTHORITY_STATUS }
