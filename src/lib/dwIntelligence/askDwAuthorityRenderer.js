/**
 * M2G-G7 deterministic authority rendering and proposition evaluation.
 *
 * Two jobs, both owned by deterministic code:
 *
 *  A. renderAskDwAuthority — for an explicit authority question, produce the
 *     authority answer itself from the current G5 -> G6 -> G7 projection. The
 *     model may naturalise surrounding explanation; it never decides or
 *     rewrites permission semantics.
 *
 *  B. evaluateAuthorityPropositions — for a spontaneous authority claim
 *     anywhere else in an answer, check each proposition on its own against
 *     that same projection, and block anything that cannot map exactly.
 *
 * This is NOT a second authority engine. It reads the G5 projection and
 * decides only what may be SAID about it. It grants nothing, revokes nothing,
 * evaluates no request for execution, and mutates nothing.
 */

import {
  ASK_DW_ACTOR,
  ASK_DW_POLARITY,
  ASK_DW_SCOPE_ASSERTION,
  G5_ACTIONS,
  UNMAPPABLE,
} from './askDwAuthorityProposition.js'

export const ASK_DW_AUTHORITY_STATUS = Object.freeze({
  GRANTED_ACTIVE: 'GRANTED_ACTIVE',
  GRANTED_APPROVAL_REQUIRED: 'GRANTED_APPROVAL_REQUIRED',
  GRANTED_WITH_LIMITS: 'GRANTED_WITH_LIMITS',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  NO_MATCHING_GRANT: 'NO_MATCHING_GRANT',
  EXPIRED: 'EXPIRED',
  NOT_YET_EFFECTIVE: 'NOT_YET_EFFECTIVE',
  REVOKED: 'REVOKED',
  STALE: 'STALE',
  INVALID: 'INVALID',
  UNREADABLE: 'UNREADABLE',
})

export const ASK_DW_AUTHORITY_ISSUE = Object.freeze({
  UNSUPPORTED_AUTHORITY_CLAIM: 'UNSUPPORTED_AUTHORITY_CLAIM',
  UNMAPPABLE_AUTHORITY_CLAIM: 'UNMAPPABLE_AUTHORITY_CLAIM',
  AMBIGUOUS_AUTHORITY_POLARITY: 'AMBIGUOUS_AUTHORITY_POLARITY',
  AMBIGUOUS_AUTHORITY_ACTOR: 'AMBIGUOUS_AUTHORITY_ACTOR',
  AMBIGUOUS_AUTHORITY_ACTION: 'AMBIGUOUS_AUTHORITY_ACTION',
  AMBIGUOUS_AUTHORITY_CHANNEL: 'AMBIGUOUS_AUTHORITY_CHANNEL',
  UNKNOWN_AUTHORITY_CHANNEL: 'UNKNOWN_AUTHORITY_CHANNEL',
  AUTHORITY_SCOPE_MISMATCH: 'AUTHORITY_SCOPE_MISMATCH',
  VAGUE_CAPABILITY_CLAIM: 'VAGUE_CAPABILITY_CLAIM',
  INACCURATE_AUTHORITY_DENIAL: 'INACCURATE_AUTHORITY_DENIAL',
  QUOTED_AUTHORITY_AS_GOVERNING: 'QUOTED_AUTHORITY_AS_GOVERNING',
})

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function hasMaterialDimensions(value) {
  if (value == null || value === '') return false
  if (Array.isArray(value)) return value.some(hasMaterialDimensions)
  if (typeof value === 'object') return Object.values(value).some(hasMaterialDimensions)
  return true
}

/**
 * A grant governs only inside its effective window. A malformed or missing
 * timestamp is never treated as "always valid": it fails closed.
 */
function timeState(grant, evaluatedAt) {
  const at = Date.parse(evaluatedAt)
  if (!Number.isFinite(at)) return ASK_DW_AUTHORITY_STATUS.INVALID
  const from = Date.parse(grant?.effectiveFrom)
  if (!Number.isFinite(from)) return ASK_DW_AUTHORITY_STATUS.INVALID
  if (grant?.expiresAt != null) {
    const expires = Date.parse(grant.expiresAt)
    if (!Number.isFinite(expires)) return ASK_DW_AUTHORITY_STATUS.INVALID
    if (at >= expires) return ASK_DW_AUTHORITY_STATUS.EXPIRED
  }
  if (at < from) return ASK_DW_AUTHORITY_STATUS.NOT_YET_EFFECTIVE
  return null
}

function scopeMatches(grant, request) {
  const level = String(grant?.scope?.level || '').toUpperCase()
  if (request.scopeType === ASK_DW_SCOPE_ASSERTION.COMPANY) return level === 'COMPANY'
  if (request.scopeType === ASK_DW_SCOPE_ASSERTION.CLIENT) {
    return level === 'CLIENT' && grant?.scope?.clientId === request.clientId
  }
  if (request.scopeType === ASK_DW_SCOPE_ASSERTION.ENTITY) {
    return level === 'ENTITY' &&
      String(grant?.scope?.entityType || '').toUpperCase() === 'INVOICE' &&
      grant?.scope?.entityId === request.entityId
  }
  return false
}

/**
 * Resolves the exact authority for one fully specified request.
 * Every dimension must be supplied; nothing is inferred or defaulted.
 */
export function resolveAskDwAuthority({ authorityProjection, request, evaluatedAt } = {}) {
  if (!authorityProjection) {
    return freeze({
      status: ASK_DW_AUTHORITY_STATUS.UNREADABLE,
      governing: false, grant: null, request: request ?? null,
      reason: 'The current authority state could not be read.',
    })
  }
  const at = evaluatedAt ?? authorityProjection.evaluatedAt
  const grants = safeArray(authorityProjection.currentGrants)
  if (grants.length === 0) {
    return freeze({
      status: ASK_DW_AUTHORITY_STATUS.NOT_CONFIGURED,
      governing: false, grant: null, request,
      reason: 'No standing authority is configured.',
    })
  }

  const candidates = grants.filter((grant) =>
    grant?.action === request.canonicalAction && scopeMatches(grant, request))
  if (candidates.length === 0) {
    return freeze({
      status: ASK_DW_AUTHORITY_STATUS.NO_MATCHING_GRANT,
      governing: false, grant: null, request,
      reason: 'No current grant covers that exact action and scope.',
    })
  }

  for (const grant of candidates) {
    if (grant.status === 'REVOKED') continue
    if (grant.status === 'STALE') continue
    if (grant.status !== 'GRANTED') continue
    // A channel-bound grant governs only the channel it names. A request that
    // names no channel cannot inherit one.
    if (grant.channel != null && grant.channel !== request.channel) continue
    if (grant.channel == null && request.channel != null) continue
    const time = timeState(grant, at)
    if (time) return freeze({ status: time, governing: false, grant, request, reason: `The grant is ${time.toLowerCase().replace(/_/g, ' ')}.` })
    if (grant.approvalRequirement !== 'NONE') {
      return freeze({
        status: ASK_DW_AUTHORITY_STATUS.GRANTED_APPROVAL_REQUIRED,
        governing: false, grant, request,
        reason: 'That grant exists but requires your approval for each action.',
      })
    }
    if (hasMaterialDimensions(grant.conditions) || hasMaterialDimensions(grant.limits)) {
      return freeze({
        status: ASK_DW_AUTHORITY_STATUS.GRANTED_WITH_LIMITS,
        governing: false, grant, request,
        reason: 'That grant carries material conditions or limits that must be evaluated per action.',
      })
    }
    return freeze({
      status: ASK_DW_AUTHORITY_STATUS.GRANTED_ACTIVE,
      governing: true, grant, request,
      reason: 'A current grant covers exactly this action, scope and channel.',
    })
  }

  const blocked = candidates[0]
  const status = blocked.status === 'REVOKED' ? ASK_DW_AUTHORITY_STATUS.REVOKED
    : blocked.status === 'STALE' ? ASK_DW_AUTHORITY_STATUS.STALE
      : ASK_DW_AUTHORITY_STATUS.NO_MATCHING_GRANT
  return freeze({
    status, governing: false, grant: blocked, request,
    reason: `The only matching grant is ${status.toLowerCase()}.`,
  })
}

function describeScope(grant) {
  const level = String(grant?.scope?.level || '').toUpperCase()
  if (level === 'COMPANY') return 'company-wide'
  if (level === 'CLIENT') return `client ${grant.scope.clientId}`
  if (level === 'ENTITY') return `${String(grant.scope.entityType || 'entity').toLowerCase()} ${grant.scope.entityId}`
  return 'an unspecified scope'
}

/**
 * A. The deterministic authority answer for an explicit authority question.
 *
 * Every field here is computed from the projection. Normal and Deep may vary
 * the surrounding explanation but never these values.
 */
export function renderAskDwAuthority({ authorityProjection, evaluatedAt = null } = {}) {
  const at = evaluatedAt ?? authorityProjection?.evaluatedAt ?? null
  if (!authorityProjection) {
    return freeze({
      kind: 'ASK_DW_AUTHORITY_RENDERING_V0',
      status: ASK_DW_AUTHORITY_STATUS.UNREADABLE,
      evaluatedAt: at,
      statement: 'I cannot read the current authority state, so I cannot tell you what I am allowed to do.',
      grants: [], revoked: 0, stale: 0, proposals: 0,
      deterministic: true, modelMayRewrite: false,
    })
  }
  const grants = safeArray(authorityProjection.currentGrants)
  const rendered = grants.map((grant) => {
    const time = timeState(grant, at)
    const status = grant.status !== 'GRANTED' ? String(grant.status).toUpperCase()
      : time || (grant.approvalRequirement !== 'NONE'
        ? ASK_DW_AUTHORITY_STATUS.GRANTED_APPROVAL_REQUIRED
        : (hasMaterialDimensions(grant.conditions) || hasMaterialDimensions(grant.limits))
          ? ASK_DW_AUTHORITY_STATUS.GRANTED_WITH_LIMITS
          : ASK_DW_AUTHORITY_STATUS.GRANTED_ACTIVE)
    return freeze({
      grantId: grant.grantId ?? grant.id ?? null,
      status,
      // The exact G5 dimensions. None of these is the model's to restate.
      canonicalAction: grant.action,
      grantee: 'DW',
      scopeType: String(grant.scope?.level || '').toUpperCase() || null,
      target: grant.scope?.clientId ?? grant.scope?.entityId ?? null,
      scopeLabel: describeScope(grant),
      channel: grant.channel ?? null,
      approvalRequirement: grant.approvalRequirement ?? null,
      limits: grant.limits ?? null,
      conditions: grant.conditions ?? null,
      effectiveFrom: grant.effectiveFrom ?? null,
      expiresAt: grant.expiresAt ?? null,
      governing: status === ASK_DW_AUTHORITY_STATUS.GRANTED_ACTIVE,
    })
  })

  const governing = rendered.filter((entry) => entry.governing)
  const statement = governing.length === 0
    ? (grants.length === 0
      ? 'I have no standing authority configured, so I cannot act on my own.'
      : 'Nothing I hold is currently active on its own; each item still needs you.')
    : `I currently hold ${governing.length} standing ${governing.length === 1 ? 'permission' : 'permissions'}: ${
      governing.map((entry) => `${entry.canonicalAction.toLowerCase().replace(/_/g, ' ')} for ${entry.scopeLabel}${entry.channel ? ` by ${entry.channel.toLowerCase()}` : ''}`).join('; ')}.`

  return freeze({
    kind: 'ASK_DW_AUTHORITY_RENDERING_V0',
    status: governing.length > 0 ? ASK_DW_AUTHORITY_STATUS.GRANTED_ACTIVE : ASK_DW_AUTHORITY_STATUS.NOT_CONFIGURED,
    evaluatedAt: at,
    statement,
    grants: rendered,
    revoked: safeArray(authorityProjection.revokedAuthority).length || authorityProjection.revokedCount || 0,
    stale: safeArray(authorityProjection.staleAuthority).length || authorityProjection.staleCount || 0,
    proposals: authorityProjection.proposalCount ?? safeArray(authorityProjection.proposals).length,
    // The model may phrase the surrounding explanation; these values are fixed.
    deterministic: true,
    modelMayRewrite: false,
    canGrant: false,
    canExecute: false,
  })
}

function resolveClientId(clientName, authorityProjection, companyBrainContext) {
  if (!clientName) return null
  const needle = String(clientName).trim().toLowerCase()
  const known = new Set()
  for (const grant of safeArray(authorityProjection?.currentGrants)) {
    if (grant?.scope?.clientId) known.add(String(grant.scope.clientId))
  }
  for (const item of safeArray(companyBrainContext?.understanding)) {
    if (item?.clientId) known.add(String(item.clientId))
  }
  for (const id of known) {
    if (id.toLowerCase() === needle || id.toLowerCase().replace(/[-_]/g, ' ') === needle) return id
  }
  return null
}

/**
 * B. Evaluates spontaneous authority propositions.
 *
 * A positive or ambiguous authority proposition is allowed ONLY if it maps
 * exactly onto a current grant. A negative one is allowed only if it is
 * accurate — a false denial is corrected too, because an inaccurate statement
 * about permission is still an inaccurate statement.
 */
export function evaluateAuthorityPropositions({
  propositions = [], authorityProjection = null, companyBrainContext = null,
  evaluatedAt = null, caseContext = null,
} = {}) {
  const issues = []
  const at = evaluatedAt ?? authorityProjection?.evaluatedAt ?? null
  const focusClientId = caseContext?.focus?.clientRef?.id ?? null
  const focusInvoiceId = caseContext?.focus?.invoiceRef?.id ?? null

  for (const proposition of propositions) {
    if (!proposition.authorityBearing) continue

    // Reported speech is evidence about what someone SAID, never a grant.
    // A quoted authority sentence is only a problem if it is presented as
    // currently governing; attribution keeps it inert.
    if (proposition.quoted) {
      if (proposition.polarity === ASK_DW_POLARITY.POSITIVE && !proposition.attributedTo) {
        issues.push({
          code: ASK_DW_AUTHORITY_ISSUE.QUOTED_AUTHORITY_AS_GOVERNING,
          detail: `Unattributed quoted authority text presented as governing: "${proposition.text}"`,
          severity: 'BLOCK', field: proposition.field, umbrella: true,
        })
      }
      continue
    }

    // Reported speech outside quotes: "The founder said I could send ..."
    if (/\b(?:said|says|told|wrote|claims?|claimed|states?|stated|according to)\b/i.test(proposition.text)) {
      if (proposition.polarity === ASK_DW_POLARITY.POSITIVE) {
        issues.push({
          code: ASK_DW_AUTHORITY_ISSUE.QUOTED_AUTHORITY_AS_GOVERNING,
          detail: `Reported speech does not create authority: "${proposition.text}"`,
          severity: 'BLOCK', field: proposition.field, umbrella: true,
        })
      }
      continue
    }

    if (proposition.vagueCapability) {
      issues.push({
        code: ASK_DW_AUTHORITY_ISSUE.VAGUE_CAPABILITY_CLAIM,
        detail: `Capability language that does not map to G5 authority: "${proposition.text}"`,
        severity: 'BLOCK', field: proposition.field, umbrella: true,
      })
      continue
    }

    if (proposition.polarity === ASK_DW_POLARITY.AMBIGUOUS) {
      issues.push({
        code: ASK_DW_AUTHORITY_ISSUE.AMBIGUOUS_AUTHORITY_POLARITY,
        detail: `Authority polarity cannot be established deterministically: "${proposition.text}"`,
        severity: 'BLOCK', field: proposition.field, umbrella: true,
      })
      continue
    }

    const positive = proposition.polarity === ASK_DW_POLARITY.POSITIVE

    if (positive && proposition.actor === ASK_DW_ACTOR.OTHER) {
      issues.push({
        code: ASK_DW_AUTHORITY_ISSUE.AMBIGUOUS_AUTHORITY_ACTOR,
        detail: `Authority asserted for an actor that is not the G5 grantee: "${proposition.text}"`,
        severity: 'BLOCK', field: proposition.field, umbrella: true,
      })
      continue
    }

    if (proposition.canonicalAction === UNMAPPABLE.ACTION_AMBIGUOUS) {
      if (positive) {
        issues.push({
          code: ASK_DW_AUTHORITY_ISSUE.AMBIGUOUS_AUTHORITY_ACTION,
          detail: `Action wording maps to more than one G5 action: "${proposition.text}"`,
          severity: 'BLOCK', field: proposition.field, umbrella: true,
        })
      }
      continue
    }
    if (proposition.canonicalAction === UNMAPPABLE.ACTION_UNKNOWN) {
      if (positive) {
        issues.push({
          code: ASK_DW_AUTHORITY_ISSUE.UNMAPPABLE_AUTHORITY_CLAIM,
          detail: `Authority asserted without an identifiable G5 action: "${proposition.text}"`,
          severity: 'BLOCK', field: proposition.field, umbrella: true,
        })
      }
      continue
    }
    if (proposition.channel === UNMAPPABLE.CHANNEL_AMBIGUOUS) {
      if (positive) {
        issues.push({
          code: ASK_DW_AUTHORITY_ISSUE.AMBIGUOUS_AUTHORITY_CHANNEL,
          detail: `More than one channel asserted: "${proposition.text}"`,
          severity: 'BLOCK', field: proposition.field, umbrella: true,
        })
      }
      continue
    }
    if (proposition.channel === UNMAPPABLE.CHANNEL_UNKNOWN) {
      if (positive) {
        issues.push({
          code: ASK_DW_AUTHORITY_ISSUE.UNKNOWN_AUTHORITY_CHANNEL,
          detail: `Channel or provider does not map to a G5 channel: "${proposition.text}"`,
          severity: 'BLOCK', field: proposition.field, umbrella: true,
        })
      }
      continue
    }

    // Scope asserted by the text governs, not the conversation's focus.
    let scopeType = proposition.scopeType
    let clientId = null
    let entityId = null
    if (scopeType === ASK_DW_SCOPE_ASSERTION.AMBIGUOUS) {
      if (positive) {
        issues.push({
          code: ASK_DW_AUTHORITY_ISSUE.AUTHORITY_SCOPE_MISMATCH,
          detail: `More than one scope asserted: "${proposition.text}"`,
          severity: 'BLOCK', field: proposition.field, umbrella: true,
        })
      }
      continue
    }
    if (scopeType === ASK_DW_SCOPE_ASSERTION.CLIENT) {
      clientId = resolveClientId(proposition.clientName, authorityProjection, companyBrainContext)
      if (!clientId) {
        if (positive) {
          issues.push({
            code: ASK_DW_AUTHORITY_ISSUE.AUTHORITY_SCOPE_MISMATCH,
            detail: `Asserted client "${proposition.clientName}" does not resolve to a known client: "${proposition.text}"`,
            severity: 'BLOCK', field: proposition.field, umbrella: true,
          })
        }
        continue
      }
    } else if (scopeType === ASK_DW_SCOPE_ASSERTION.ENTITY) {
      entityId = proposition.entityId
    } else if (scopeType === ASK_DW_SCOPE_ASSERTION.UNSPECIFIED) {
      // Fall back to the conversation's focus only when the text asserts no
      // scope of its own. An asserted scope is never overridden by focus.
      if (focusClientId) { scopeType = ASK_DW_SCOPE_ASSERTION.CLIENT; clientId = focusClientId }
      else if (focusInvoiceId) { scopeType = ASK_DW_SCOPE_ASSERTION.ENTITY; entityId = focusInvoiceId }
      else scopeType = ASK_DW_SCOPE_ASSERTION.COMPANY
    }

    const resolution = resolveAskDwAuthority({
      authorityProjection,
      evaluatedAt: at,
      request: {
        canonicalAction: proposition.canonicalAction,
        scopeType, clientId, entityId,
        channel: proposition.channel ?? null,
      },
    })

    if (positive && !resolution.governing) {
      issues.push({
        code: ASK_DW_AUTHORITY_ISSUE.UNSUPPORTED_AUTHORITY_CLAIM,
        detail: `${resolution.reason} Claim: "${proposition.text}"`,
        severity: 'BLOCK', field: proposition.field, status: resolution.status, umbrella: true,
      })
      continue
    }
    // An approval assertion must match the grant it relies on.
    if (positive && proposition.approvalState === 'NONE' &&
        resolution.grant?.approvalRequirement !== 'NONE') {
      issues.push({
        code: ASK_DW_AUTHORITY_ISSUE.UNSUPPORTED_AUTHORITY_CLAIM,
        detail: `Claim asserts no approval is needed, but the grant requires approval: "${proposition.text}"`,
        severity: 'BLOCK', field: proposition.field, umbrella: true,
      })
      continue
    }
    // A denial is only allowed when it is true.
    if (!positive && resolution.governing) {
      issues.push({
        code: ASK_DW_AUTHORITY_ISSUE.INACCURATE_AUTHORITY_DENIAL,
        detail: `A current grant does cover this, so the denial is inaccurate: "${proposition.text}"`,
        // Not the umbrella: this refuses a false DENIAL, not a claim of authority.
        severity: 'BLOCK', field: proposition.field, umbrella: false,
      })
    }
  }

  return freeze({
    issues: issues.map((issue) => freeze(issue)),
    blocked: issues.some((issue) => issue.severity === 'BLOCK'),
    evaluatedAt: at,
    boundaries: freeze({ canGrant: false, canRevoke: false, canExecute: false, g5RemainsAuthorityOwner: true }),
  })
}

export { G5_ACTIONS }
