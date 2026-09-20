const CLAIM_STATUSES = new Set(['in_flight', 'sent', 'send_failed', 'uncertain'])
const APPROVAL_STATUSES = new Set(['pending', 'approved', 'skipped'])

function isoInstant(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function inInstantRange(value, startAt, endAt) {
  const instant = isoInstant(value)
  if (!instant) return false
  return (!startAt || instant >= startAt) && (!endAt || instant < endAt)
}

function inc(object, key) {
  object[key] = (object[key] || 0) + 1
}

export function classifyExecutionClaim(claim) {
  if (!claim) return { reportable: false, reason: 'missing_claim' }

  const status = String(claim.status ?? '')
  if (!CLAIM_STATUSES.has(status)) {
    return { reportable: false, reason: 'unsupported_status' }
  }

  const actionType = String(claim.action_type ?? '').trim()
  if (!actionType) return { reportable: false, reason: 'missing_action_type' }

  const claimedAt = isoInstant(claim.claimed_at)
  if (!claimedAt) return { reportable: false, reason: 'missing_claimed_at' }

  return {
    reportable: true,
    id: claim.id ?? null,
    status,
    actionType,
    provider: String(claim.provider ?? '').trim() || null,
    providerMessageId: claim.provider_message_id ?? null,
    claimedAt,
    resolvedAt: isoInstant(claim.resolved_at),
  }
}

export function buildExecutionSummary(
  executionClaims = [],
  { startAt = null, endAt = null } = {}
) {
  const byStatus = {
    in_flight: 0,
    sent: 0,
    send_failed: 0,
    uncertain: 0,
  }
  const byActionType = {}
  const byProvider = {}
  const dataQuality = {
    missing_claim: 0,
    unsupported_status: 0,
    missing_action_type: 0,
    missing_claimed_at: 0,
    duplicateIdentityCount: 0,
  }

  const seen = new Set()
  let claimCount = 0
  let providerAcceptedCount = 0

  for (const claim of executionClaims || []) {
    const id = claim?.id ?? null
    if (id && seen.has(id)) {
      dataQuality.duplicateIdentityCount += 1
      continue
    }
    if (id) seen.add(id)

    const classified = classifyExecutionClaim(claim)
    if (!classified.reportable) {
      inc(dataQuality, classified.reason)
      continue
    }

    if (!inInstantRange(classified.claimedAt, startAt, endAt)) continue

    claimCount += 1
    inc(byStatus, classified.status)
    inc(byActionType, classified.actionType)
    if (classified.provider) inc(byProvider, classified.provider)

    // "sent" proves the provider accepted the send request and returned
    // through the execution boundary. It does NOT prove recipient delivery,
    // opening, reading, payment, or causation.
    if (classified.status === 'sent') providerAcceptedCount += 1
  }

  return {
    period: { startAt, endAt },
    claimCount,
    providerAcceptedCount,
    byStatus,
    byActionType,
    byProvider,
    dataQuality,
    semantics: {
      providerAcceptedIsDelivery: false,
      providerAcceptedIsPaymentCausation: false,
    },
  }
}

export function buildApprovalSummary(
  rows = [],
  { startAt = null, endAt = null } = {}
) {
  const byStatus = {
    pending: 0,
    approved: 0,
    skipped: 0,
    other: 0,
  }
  const dataQuality = {
    duplicateIdentityCount: 0,
    missingCreatedAtCount: 0,
  }

  const seen = new Set()
  let requestCount = 0

  for (const row of rows || []) {
    const id = row?.id ?? null
    if (id && seen.has(id)) {
      dataQuality.duplicateIdentityCount += 1
      continue
    }
    if (id) seen.add(id)

    const createdAt = isoInstant(row?.created_at)
    if (!createdAt) {
      dataQuality.missingCreatedAtCount += 1
      continue
    }
    if (!inInstantRange(createdAt, startAt, endAt)) continue

    requestCount += 1
    const status = String(row?.status ?? '')
    if (APPROVAL_STATUSES.has(status)) inc(byStatus, status)
    else inc(byStatus, 'other')
  }

  return {
    period: { startAt, endAt },
    requestCount,
    byStatus,
    dataQuality,
  }
}

export function buildActivityEvidenceSummary(
  events = [],
  { startAt = null, endAt = null } = {}
) {
  const byType = {}
  let eventCount = 0
  let duplicateIdentityCount = 0
  let missingCreatedAtCount = 0

  const seen = new Set()
  for (const event of events || []) {
    const id = event?.id ?? null
    if (id && seen.has(id)) {
      duplicateIdentityCount += 1
      continue
    }
    if (id) seen.add(id)

    const createdAt = isoInstant(event?.created_at)
    if (!createdAt) {
      missingCreatedAtCount += 1
      continue
    }
    if (!inInstantRange(createdAt, startAt, endAt)) continue

    eventCount += 1
    inc(byType, String(event?.event_type ?? 'unknown'))
  }

  return {
    period: { startAt, endAt },
    eventCount,
    byType,
    dataQuality: {
      duplicateIdentityCount,
      missingCreatedAtCount,
    },
    semantics: {
      eventsAreExecutionAuthority: false,
      executionClaimsRemainCanonicalForExternalSendAttempt: true,
    },
  }
}

export function buildOperationalReportingContract({
  executionClaims = [],
  approvals = [],
  events = [],
  startAt = null,
  endAt = null,
} = {}) {
  const range = { startAt, endAt }

  return Object.freeze({
    schemaVersion: 'reports-r4-v1',
    execution: buildExecutionSummary(executionClaims, range),
    approvals: buildApprovalSummary(approvals, range),
    activity: buildActivityEvidenceSummary(events, range),
    capabilities: {
      executionReceipts: true,
      approvalQueue: true,
      activityEvidence: true,
      timeSaved: false,
      recoveredCashAttribution: false,
      autopilotROI: false,
      deliveryProof: false,
    },
  })
}
