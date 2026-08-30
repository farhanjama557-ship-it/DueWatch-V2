import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { CLAIM_CLASS, CLAIM_STATUS, createArtifact, createClaim, createSource } from './index.js'

const FIXTURE_FILES = Object.freeze([
  'collections-sop.md',
  'customer-contract-atlas.md',
  'old-ar-rules.csv',
  'founder-note.md',
  'roles.md',
  'atlas-history.md',
  'account-manager-email.md',
  'payment-claim.md',
])

const CAPTURED_AT = '2026-08-30T12:00:00.000Z'

function digest(content) {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`
}

function slug(filename) {
  return filename.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
}

function claim(base, id, claimClass, claimType, value, semanticScope, subjectScope = {}) {
  return createClaim({
    ...base,
    id,
    claimClass,
    claimType,
    value,
    semanticScope,
    subjectScope,
    explicit: true,
    confidence: 1,
    uncertainty: null,
    status: semanticScope.temporality === 'HISTORICAL' ? CLAIM_STATUS.HISTORICAL : CLAIM_STATUS.OBSERVED,
    assumptions: [],
  })
}

function extractClaims({ tenantId, filename, content, sourceId, artifactId }) {
  const base = { tenantId, artifactIds: [artifactId], provenanceRootIds: [sourceId], canonicalFinancialTruth: false }
  if (filename === 'collections-sop.md') {
    if (!content.includes('5%') || !content.includes('7, 14, and 30')) throw new Error('collections SOP fixture drift')
    return [
      claim(base, 'claim-late-fee-sop-5', CLAIM_CLASS.COMPANY_POLICY, 'late_fee_policy', { ratePercent: 5 }, { level: 'COMPANY', temporality: 'CURRENT' }),
      claim(base, 'claim-reminder-cadence-current', CLAIM_CLASS.COLLECTION_WORKFLOW, 'reminder_cadence', { daysOverdue: [7, 14, 30] }, { level: 'COMPANY', temporality: 'CURRENT' }),
      claim(base, 'claim-dispute-controller', CLAIM_CLASS.DISPUTE_PROCESS, 'dispute_process', { escalateToRole: 'CONTROLLER', beforeContact: true }, { level: 'COMPANY', temporality: 'CURRENT' }),
    ]
  }
  if (filename === 'customer-contract-atlas.md') return [
    claim(base, 'claim-atlas-late-fee-2', CLAIM_CLASS.CLIENT_EXCEPTION, 'late_fee_policy', { ratePercent: 2, onlyWhenApplicable: true }, { level: 'CLIENT', clientId: 'atlas', temporality: 'CURRENT' }, { clientId: 'atlas' }),
    claim(base, 'claim-atlas-net-45', CLAIM_CLASS.PAYMENT_TERMS_CONTEXT, 'payment_terms', { netDays: 45 }, { level: 'CLIENT', clientId: 'atlas', temporality: 'CURRENT' }, { clientId: 'atlas' }),
  ]
  if (filename === 'old-ar-rules.csv') return [
    claim(base, 'claim-late-fee-old-10', CLAIM_CLASS.HISTORICAL_PRECEDENT, 'late_fee_policy', { ratePercent: 10 }, { level: 'COMPANY', temporality: 'HISTORICAL' }),
    claim(base, 'claim-reminder-cadence-old', CLAIM_CLASS.HISTORICAL_PRECEDENT, 'reminder_cadence', { daysOverdue: [10, 20, 30] }, { level: 'COMPANY', temporality: 'HISTORICAL' }),
  ]
  if (filename === 'founder-note.md') return [
    claim(base, 'claim-founder-disable-late-fees', CLAIM_CLASS.FOUNDER_INSTRUCTION, 'late_fee_policy', { enabled: false, requiresNewApproval: true }, { level: 'COMPANY', temporality: 'CURRENT' }),
  ]
  if (filename === 'roles.md') return [
    claim(base, 'claim-role-founder', CLAIM_CLASS.ROLE, 'role', { role: 'FOUNDER' }, { level: 'COMPANY', temporality: 'CURRENT' }),
    claim(base, 'claim-delegation-founder-settlement', CLAIM_CLASS.DELEGATION, 'delegation', { role: 'FOUNDER', may: ['APPROVE_SETTLEMENT', 'APPROVE_WRITEOFF'] }, { level: 'COMPANY', temporality: 'CURRENT' }),
    claim(base, 'claim-delegation-account-manager', CLAIM_CLASS.DELEGATION, 'delegation', { role: 'ACCOUNT_MANAGER', may: ['DISCUSS_INVOICES'], mayNot: ['APPROVE_SETTLEMENT', 'APPROVE_WRITEOFF'] }, { level: 'COMPANY', temporality: 'CURRENT' }),
    claim(base, 'claim-delegation-controller', CLAIM_CLASS.DELEGATION, 'delegation', { role: 'CONTROLLER', may: ['CORRECT_ACCOUNTING_THROUGH_AUTHORITATIVE_WORKFLOW'] }, { level: 'COMPANY', temporality: 'CURRENT' }),
  ]
  if (filename === 'atlas-history.md') return [
    claim(base, 'claim-atlas-payment-history', CLAIM_CLASS.HISTORICAL_PRECEDENT, 'payment_behavior_context', { behavior: 'often_pays_after_procurement_reminder' }, { level: 'CLIENT', clientId: 'atlas', temporality: 'HISTORICAL' }, { clientId: 'atlas' }),
  ]
  if (filename === 'account-manager-email.md') return [
    claim(base, 'claim-atlas-discount-email', CLAIM_CLASS.INTERPRETATION, 'settlement_discount_statement', { discountPercent: 20, speakerRole: 'ACCOUNT_MANAGER' }, { level: 'CLIENT', clientId: 'atlas', temporality: 'CURRENT' }, { clientId: 'atlas' }),
  ]
  if (filename === 'payment-claim.md') return [
    createClaim({ ...base, id: 'claim-invoice-104-paid-context', claimClass: CLAIM_CLASS.INTERPRETATION, claimType: 'contextual_payment_statement', semanticScope: { level: 'INVOICE_CONTEXT', invoiceId: '104', temporality: 'RECENT' }, subjectScope: { invoiceId: '104' }, value: { statement: 'Invoice 104 was paid yesterday' }, explicit: true, derived: false, confidence: 0.2, uncertainty: 'UNTRUSTED_CONTEXT_ONLY', status: CLAIM_STATUS.OBSERVED, assumptions: ['Requires R0 authoritative financial refetch'], independentCorroboration: false, canonicalFinancialTruth: false }),
  ]
  throw new Error(`unsupported fixture file: ${filename}`)
}

export function ingestCompanyBrainFixture({ fixtureDirectory, tenantId = 'tenant-acme' } = {}) {
  if (!fixtureDirectory || !tenantId) throw new Error('fixtureDirectory and tenantId required')
  const sources = []
  const artifacts = []
  const claims = []
  for (const filename of FIXTURE_FILES) {
    const absolute = path.join(fixtureDirectory, filename)
    const content = fs.readFileSync(absolute, 'utf8')
    const idSlug = slug(filename)
    const sourceId = `source-${idSlug}`
    const artifactId = `artifact-${idSlug}`
    const source = createSource({
      tenantId,
      id: sourceId,
      sourceType: path.extname(filename) === '.csv' ? 'SPREADSHEET_RULE_ROW_SET' : 'DOCUMENT',
      trustZone: filename === 'founder-note.md' ? 'AUTHENTICATED_FOUNDER_FIXTURE' : filename.includes('contract') ? 'CONTRACT_FIXTURE' : filename.includes('email') || filename.includes('payment-claim') ? 'CONTEXT_ONLY_FIXTURE' : 'CONTROLLED_COMPANY_FIXTURE',
      sourceTimestamp: CAPTURED_AT,
      sourceVersion: 'fixture-v1',
      ingestedAt: CAPTURED_AT,
      contentHash: digest(content),
      active: true,
    })
    const artifact = createArtifact({ tenantId, id: artifactId, sourceId, artifactType: filename, rootSourceIds: [sourceId], locator: `fixtures/company-brain/acme-ar-ops/${filename}`, classifiedAt: CAPTURED_AT })
    sources.push(source)
    artifacts.push(artifact)
    claims.push(...extractClaims({ tenantId, filename, content, sourceId, artifactId }))
  }
  return Object.freeze({ tenantId, capturedAt: CAPTURED_AT, sources: Object.freeze(sources), artifacts: Object.freeze(artifacts), claims: Object.freeze(claims) })
}

export { FIXTURE_FILES }
