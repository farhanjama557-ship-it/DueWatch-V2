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
  ASK_DW_PARSE_MODE,
  ASK_DW_QUESTION_SEMANTIC,
  ASK_DW_POLARITY,
  ASK_DW_SCOPE_ASSERTION,
  G5_ACTIONS,
  UNMAPPABLE,
  classifyAskDwAuthorityRequest,
  collectAskDwKnownEntities,
  normalizeAuthorityText,
  parseAuthorityProposition,
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
  AUTHORITY_ACTOR_NOT_GRANTEE: 'AUTHORITY_ACTOR_NOT_GRANTEE',
})

/**
 * QUOTATION OWNERSHIP.
 *
 * There is no endorsement detector here any more, and there must never be one.
 * Detecting agreement was a losing game: "Exactly.", "Correct.", "Yes.",
 * "I concur.", "That remains true.", "That still holds." and every future way
 * of agreeing with a sentence all had to be enumerated, and each miss turned a
 * quoted permission into governing authority.
 *
 * The structural closure is to remove the capability instead of policing it:
 * an authority-bearing quotation in FREE MODEL PROSE can never become
 * governing authority. It is grounded against G5 exactly like an assertion,
 * whatever surrounds it and whoever it is attributed to. Attribution stops
 * being an escape hatch, so nothing has to be detected.
 *
 * Genuine reported authority is not lost: it belongs in the typed, deterministic
 * evidence structure built by buildAskDwReportedAuthorityEvidence below, which
 * is marked nonGoverning and rendered separately from model prose.
 */

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

function resolveClientId(clientName, authorityProjection, companyBrainContext, knownEntities = []) {
  if (!clientName) return null
  const needle = String(clientName).trim().toLowerCase()
  const known = new Set()
  for (const grant of safeArray(authorityProjection?.currentGrants)) {
    if (grant?.scope?.clientId) known.add(String(grant.scope.clientId))
  }
  for (const item of safeArray(companyBrainContext?.understanding)) {
    if (item?.clientId) known.add(String(item.clientId))
  }
  // The conversation's own admitted references count as known: a question can
  // name a client the current grants do not mention, and answering "I need the
  // exact scope" there hides the real answer, which is that no grant covers it.
  for (const entity of safeArray(knownEntities)) {
    if (entity?.id) known.add(String(entity.id))
  }
  for (const id of known) {
    const normalized = id.toLowerCase()
    if (normalized === needle || normalized.replace(/[-_]/g, ' ') === needle) return id
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
      // A POSITIVE authority quotation in model prose is refused outright.
      // Attribution is not an escape hatch, because nothing in free prose can
      // establish that a quoted permission is current -- and asking the guard
      // to notice agreement meant enumerating every way of agreeing.
      // Reported authority belongs in the typed non-governing evidence
      // structure, not in a sentence the model wrote.
      if (proposition.polarity === ASK_DW_POLARITY.POSITIVE) {
        issues.push({
          code: ASK_DW_AUTHORITY_ISSUE.QUOTED_AUTHORITY_AS_GOVERNING,
          detail: proposition.attributedTo
            ? `Quoted authority text cannot establish current authority in model prose: "${proposition.text}"`
            : `Unattributed quoted authority text presented as governing: "${proposition.text}"`,
          severity: 'BLOCK', field: proposition.field, umbrella: true,
        })
      }
      // A negated or non-positive quotation asserts no permission and stays inert.
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

    // A governing claim must identify the G5 grantee unambiguously. UNKNOWN
    // must never silently become DW, so "Email reminders are permitted." and
    // "Atlas is allowed to send email reminders." both fail closed.
    // The grantee must be DETERMINATE. It is when the actor is explicitly DW,
    // and when the subject is the grant itself (a G5 grant is always to DW).
    // It is not when a third party, an unnamed subject, or a bare passive is
    // given the permission.
    const granteeDeterminate =
      proposition.actor === ASK_DW_ACTOR.DW ||
      proposition.actor === ASK_DW_ACTOR.GRANT_SUBJECT
    // Determinacy is required in BOTH polarities. A denial resolved against
    // DW's grants is a statement about DW, so "Atlas is not allowed to send
    // email reminders." and "Someone is not permitted to issue refunds."
    // must not silently inherit DW's G5 state and be judged accurate by it.
    if (!granteeDeterminate) {
      issues.push({
        code: ASK_DW_AUTHORITY_ISSUE.AMBIGUOUS_AUTHORITY_ACTOR,
        detail: proposition.actor === ASK_DW_ACTOR.OTHER
          ? `Authority asserted for an actor that is not the G5 grantee: "${proposition.text}"`
          : `Authority asserted without identifying the G5 grantee: "${proposition.text}"`,
        // A refused DENIAL is not a claim of authority, so the umbrella only
        // fires on the positive side.
        severity: 'BLOCK', field: proposition.field, umbrella: positive,
      })
      continue
    }

    if (proposition.canonicalAction === UNMAPPABLE.ACTION_AMBIGUOUS) {
      // A negative claim needs the same complete mapping before its accuracy
      // can be judged; an unmapped denial is not "safe because it is a denial".
      issues.push({
        code: ASK_DW_AUTHORITY_ISSUE.AMBIGUOUS_AUTHORITY_ACTION,
        detail: `Action wording maps to more than one G5 action: "${proposition.text}"`,
        severity: 'BLOCK', field: proposition.field, umbrella: positive,
      })
      continue
    }
    if (proposition.canonicalAction === UNMAPPABLE.ACTION_UNKNOWN) {
      // A negative claim needs the same complete mapping before its accuracy
      // can be judged; an unmapped denial is not "safe because it is a denial".
      issues.push({
        code: ASK_DW_AUTHORITY_ISSUE.UNMAPPABLE_AUTHORITY_CLAIM,
        detail: `Authority asserted without an identifiable G5 action: "${proposition.text}"`,
        severity: 'BLOCK', field: proposition.field, umbrella: positive,
      })
      continue
    }
    if (proposition.channel === UNMAPPABLE.CHANNEL_AMBIGUOUS) {
      // A negative claim needs the same complete mapping before its accuracy
      // can be judged; an unmapped denial is not "safe because it is a denial".
      issues.push({
        code: ASK_DW_AUTHORITY_ISSUE.AMBIGUOUS_AUTHORITY_CHANNEL,
        detail: `More than one channel asserted: "${proposition.text}"`,
        severity: 'BLOCK', field: proposition.field, umbrella: positive,
      })
      continue
    }
    if (proposition.channel === UNMAPPABLE.CHANNEL_UNKNOWN) {
      // A negative claim needs the same complete mapping before its accuracy
      // can be judged; an unmapped denial is not "safe because it is a denial".
      issues.push({
        code: ASK_DW_AUTHORITY_ISSUE.UNKNOWN_AUTHORITY_CHANNEL,
        detail: `Channel or provider does not map to a G5 channel: "${proposition.text}"`,
        severity: 'BLOCK', field: proposition.field, umbrella: positive,
      })
      continue
    }

    // Scope asserted by the text governs, not the conversation's focus.
    let scopeType = proposition.scopeType
    let clientId = null
    let entityId = null
    if (scopeType === ASK_DW_SCOPE_ASSERTION.AMBIGUOUS ||
        scopeType === ASK_DW_SCOPE_ASSERTION.UNKNOWN) {
      issues.push({
        code: ASK_DW_AUTHORITY_ISSUE.AUTHORITY_SCOPE_MISMATCH,
        detail: scopeType === ASK_DW_SCOPE_ASSERTION.AMBIGUOUS
          ? `More than one scope asserted: "${proposition.text}"`
          : `A scope is asserted but cannot be resolved: "${proposition.text}"`,
        severity: 'BLOCK', field: proposition.field, umbrella: positive,
      })
      continue
    }
    if (scopeType === ASK_DW_SCOPE_ASSERTION.CLIENT) {
      clientId = resolveClientId(proposition.clientName, authorityProjection, companyBrainContext)
      if (!clientId) {
        // An asserted target that does not resolve is refused. It must never
        // fall back to the conversation's focused client.
        issues.push({
          code: ASK_DW_AUTHORITY_ISSUE.AUTHORITY_SCOPE_MISMATCH,
          detail: `Asserted client "${proposition.clientName}" does not resolve to a known client: "${proposition.text}"`,
          severity: 'BLOCK', field: proposition.field, umbrella: positive,
        })
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

/**
 * TYPED NON-GOVERNING REPORTED AUTHORITY.
 *
 * Historical statements about permission are legitimate evidence — what a
 * founder wrote, what a contract said — and removing them from model prose
 * must not delete the capability. It relocates it: reported authority becomes
 * a typed structure, produced deterministically, every entry marked
 * governing:false and authorityEffect:'NONE', rendered separately from the
 * model's own sentences.
 *
 * Nothing here reads or writes G5. It records that something was SAID.
 */
export function buildAskDwReportedAuthorityEvidence({ propositions = [] } = {}) {
  const entries = []
  for (const proposition of propositions) {
    if (!proposition?.quoted || !proposition.authorityBearing) continue
    entries.push(freeze({
      kind: 'ASK_DW_REPORTED_AUTHORITY_V0',
      text: proposition.text,
      attributedTo: proposition.attributedTo ?? null,
      field: proposition.field,
      polarity: proposition.polarity,
      // The whole point of the structure: it can never be current authority.
      governing: false,
      authorityEffect: 'NONE',
      grantsAuthority: false,
      supersedesG5: false,
      renderedSeparatelyFromModelProse: true,
    }))
  }
  return freeze({
    kind: 'ASK_DW_REPORTED_AUTHORITY_SET_V0',
    entries: freeze(entries),
    governing: false,
    g5RemainsAuthorityOwner: true,
  })
}

export { G5_ACTIONS }

// ── deterministic authority ANSWER ownership ─────────────────────────────────

export const ASK_DW_AUTHORITY_QUESTION_MODE = Object.freeze({
  OVERVIEW: 'OVERVIEW',
  EXACT: 'EXACT',
  UNRESOLVABLE: 'UNRESOLVABLE',
  // The question is about someone other than the G5 grantee, so no grant can
  // answer it. This is decided BEFORE any resolution is attempted.
  ACTOR_NOT_GRANTEE: 'ACTOR_NOT_GRANTEE',
})

const ASK_DW_AUTHORITY_QUESTION_SEMANTIC_DEFAULT = ASK_DW_QUESTION_SEMANTIC.CAN_ACT

export { ASK_DW_QUESTION_SEMANTIC }

/**
 * Reads the founder's authority question into a typed request.
 *
 * An overview ("what authority do you have?") lists current standing
 * authority. An exact check ("may you send email reminders for Atlas?")
 * resolves that specific action/scope/channel. A question whose dimensions
 * cannot be mapped is UNRESOLVABLE and is answered by asking for the missing
 * dimension rather than by listing unrelated grants.
 */
export function parseAuthorityQuestion(text, {
  authorityProjection = null, companyBrainContext = null, caseContext = null,
  knownEntities = null,
} = {}) {
  const entities = knownEntities ??
    collectAskDwKnownEntities({ authorityProjection, companyBrainContext, caseContext })
  // The SAME shared typed boundary the orchestrator routes with. Reading the
  // question twice, with two recognisers, is how routing and answering drifted
  // apart in the first place.
  const request = classifyAskDwAuthorityRequest(text, {
    knownEntities: entities, caseContext, allowContextualEllipsis: true,
  })
  const proposition = parseAuthorityProposition({
    text: normalizeAuthorityText(text), field: 'question', quoted: false, attributedTo: null,
  }, {
    knownEntities: entities, mode: ASK_DW_PARSE_MODE.QUESTION, caseContext,
    allowContextualEllipsis: true,
  })
  const semantic = request.semantic ?? ASK_DW_AUTHORITY_QUESTION_SEMANTIC_DEFAULT

  // ACTOR FIRST, before any G5 resolution. A G5 grant is held by DW. If the
  // founder asks about themselves, the client, the system or a provider, no
  // grant can answer it, and resolving one anyway is how "Can I send email
  // reminders for Atlas?" was answered "Yes" out of DW's own permission.
  const actor = request.actor ?? proposition.actor
  const granteeDeterminate =
    actor === ASK_DW_ACTOR.DW || actor === ASK_DW_ACTOR.GRANT_SUBJECT || actor == null
  if (!granteeDeterminate) {
    return freeze({
      mode: ASK_DW_AUTHORITY_QUESTION_MODE.ACTOR_NOT_GRANTEE,
      semantic, actor, missing: freeze([]),
    })
  }

  const overview = semantic === ASK_DW_QUESTION_SEMANTIC.AUTHORITY_OVERVIEW
  const namesAction = proposition.canonicalAction !== UNMAPPABLE.ACTION_UNKNOWN &&
    proposition.canonicalAction != null
  if (overview && !namesAction) {
    return freeze({
      mode: ASK_DW_AUTHORITY_QUESTION_MODE.OVERVIEW, semantic, actor, missing: freeze([]),
    })
  }
  const missing = []
  if (proposition.canonicalAction == null ||
      proposition.canonicalAction === UNMAPPABLE.ACTION_UNKNOWN) missing.push('action')
  if (proposition.canonicalAction === UNMAPPABLE.ACTION_AMBIGUOUS) missing.push('action')
  if (proposition.channel === UNMAPPABLE.CHANNEL_AMBIGUOUS ||
      proposition.channel === UNMAPPABLE.CHANNEL_UNKNOWN) missing.push('channel')
  if (proposition.scopeType === ASK_DW_SCOPE_ASSERTION.AMBIGUOUS ||
      proposition.scopeType === ASK_DW_SCOPE_ASSERTION.UNKNOWN) missing.push('scope')
  if (missing.length > 0) {
    if (overview) {
      return freeze({
        mode: ASK_DW_AUTHORITY_QUESTION_MODE.OVERVIEW, semantic, actor, missing: freeze([]),
      })
    }
    return freeze({
      mode: ASK_DW_AUTHORITY_QUESTION_MODE.UNRESOLVABLE,
      semantic, actor, missing: freeze(missing),
    })
  }
  let scopeType = proposition.scopeType
  let clientId = null
  const entityId = proposition.entityId
  if (scopeType === ASK_DW_SCOPE_ASSERTION.CLIENT) {
    clientId = resolveClientId(proposition.clientName, authorityProjection, companyBrainContext, entities)
    if (!clientId) {
      return freeze({
        mode: ASK_DW_AUTHORITY_QUESTION_MODE.UNRESOLVABLE,
        semantic, actor, missing: freeze(['scope']),
      })
    }
  } else if (scopeType === ASK_DW_SCOPE_ASSERTION.UNSPECIFIED) {
    scopeType = null
  }
  return freeze({
    mode: ASK_DW_AUTHORITY_QUESTION_MODE.EXACT,
    semantic, actor,
    missing: freeze([]),
    request: freeze({
      canonicalAction: proposition.canonicalAction,
      scopeType, clientId, entityId,
      channel: proposition.channel ?? null,
    }),
  })
}

function describeGrantLine(entry) {
  const parts = [
    entry.canonicalAction.toLowerCase().replace(/_/g, ' '),
    `for ${entry.scopeLabel}`,
  ]
  if (entry.channel) parts.push(`by ${entry.channel.toLowerCase()}`)
  if (entry.approvalRequirement === 'FOUNDER') parts.push('with your approval each time')
  return parts.join(' ')
}

/**
 * THE authority answer. For an authority question the returned proposition
 * comes from here, not from the model: the model may not replace, contradict,
 * summarise away or answer around it.
 */
export function buildAskDwAuthorityAnswer({
  question, authorityProjection = null, companyBrainContext = null,
  caseContext = null, evaluatedAt = null, knownEntities = null,
} = {}) {
  const rendering = renderAskDwAuthority({ authorityProjection, evaluatedAt })
  const parsed = parseAuthorityQuestion(question, {
    authorityProjection, companyBrainContext, caseContext, knownEntities,
  })

  const answer = (conclusion, extra = {}) => freeze({
    executiveConclusion: conclusion,
    evidenceBasis: freeze(rendering.grants.filter((entry) => entry.governing).map(describeGrantLine)),
    uncertaintyAndLimitations: freeze([]),
    recommendationOrNextStep: null,
    competingExplanations: freeze([]),
    citedToolRunIds: freeze([]),
    // Provenance of the proposition itself, so an auditor can see it was not
    // produced by a model.
    authoritySource: 'DETERMINISTIC_G5_PROJECTION',
    authorityStatus: rendering.status,
    modelOwnsAuthorityProposition: false,
    ...extra,
  })

  if (rendering.status === ASK_DW_AUTHORITY_STATUS.UNREADABLE) {
    return answer(rendering.statement, { authorityStatus: ASK_DW_AUTHORITY_STATUS.UNREADABLE })
  }

  // The question is not about DW. No G5 grant can answer it, and none is read.
  if (parsed.mode === ASK_DW_AUTHORITY_QUESTION_MODE.ACTOR_NOT_GRANTEE) {
    return answer(
      'My standing authority is held by me, not by you or anyone else, so it cannot answer what someone else is allowed to do.',
      {
        evidenceBasis: freeze([]),
        authorityStatus: 'ACTOR_NOT_GRANTEE',
        questionSemantic: parsed.semantic,
        actor: parsed.actor,
        governing: false,
      },
    )
  }

  if (parsed.mode === ASK_DW_AUTHORITY_QUESTION_MODE.UNRESOLVABLE) {
    // Never answer an under-specified check by listing unrelated authority.
    const missing = parsed.missing.join(' and ')
    return answer(
      `I need the exact ${missing} before I can tell you whether I am allowed to do that.`,
      {
        evidenceBasis: freeze([]), authorityStatus: 'CLARIFICATION_REQUIRED',
        clarificationNeeded: parsed.missing, questionSemantic: parsed.semantic,
      },
    )
  }

  if (parsed.mode === ASK_DW_AUTHORITY_QUESTION_MODE.OVERVIEW) {
    return answer(rendering.statement, { questionSemantic: parsed.semantic })
  }

  const request = parsed.request
  const scoped = request.scopeType
    ? request
    : {
      ...request,
      ...(caseContext?.focus?.clientRef?.id
        ? { scopeType: ASK_DW_SCOPE_ASSERTION.CLIENT, clientId: caseContext.focus.clientRef.id }
        : caseContext?.focus?.invoiceRef?.id
          ? { scopeType: ASK_DW_SCOPE_ASSERTION.ENTITY, entityId: caseContext.focus.invoiceRef.id }
          : { scopeType: ASK_DW_SCOPE_ASSERTION.COMPANY }),
    }
  const resolution = resolveAskDwAuthority({ authorityProjection, request: scoped, evaluatedAt })
  const label = `${scoped.canonicalAction.toLowerCase().replace(/_/g, ' ')}${scoped.channel ? ` by ${scoped.channel.toLowerCase()}` : ''}`
  const forScope = scoped.clientId ? ` for ${scoped.clientId}` : ''

  // EACH SEMANTIC IS ANSWERED IN ITS OWN TERMS. Collapsing them all onto
  // "governing ? Yes : No" inverted every question whose surface polarity was
  // not plain, and answered an approval question with a capability fact.
  //
  // The wording is declarative wherever a bare yes/no would be ambiguous
  // against a negative question, so the founder never has to work out which
  // proposition the "yes" attaches to.
  if (parsed.semantic === ASK_DW_QUESTION_SEMANTIC.APPROVAL_REQUIRED) {
    // Answered from approvalRequirement, never from whether a grant governs.
    const grantFound = resolution.grant != null &&
      resolution.status !== ASK_DW_AUTHORITY_STATUS.NO_MATCHING_GRANT &&
      resolution.status !== ASK_DW_AUTHORITY_STATUS.NOT_CONFIGURED
    const approvalConclusion = !grantFound
      ? 'There is no matching current grant; approval alone would not authorize that action.'
      : resolution.grant.approvalRequirement !== 'NONE'
        ? 'Yes — the current grant requires your approval each time.'
        : 'The current grant does not require your approval for that action.'
    return answer(approvalConclusion, {
      evidenceBasis: resolution.grant ? freeze([describeGrantLine({
        canonicalAction: resolution.grant.action,
        scopeLabel: describeScope(resolution.grant),
        channel: resolution.grant.channel,
        approvalRequirement: resolution.grant.approvalRequirement,
      })]) : freeze([]),
      authorityStatus: resolution.status,
      questionSemantic: parsed.semantic,
      approvalRequirement: resolution.grant?.approvalRequirement ?? null,
      governing: resolution.governing,
    })
  }

  const conclusion = parsed.semantic === ASK_DW_QUESTION_SEMANTIC.NEGATED_CAPABILITY
    // A negative question gets a declarative answer, so polarity survives.
    ? (resolution.governing
      ? `I can: a current grant covers ${label}${forScope}.`
      : `I cannot. ${resolution.reason}`)
    : parsed.semantic === ASK_DW_QUESTION_SEMANTIC.FUTURE_CONTROLLED_ACTION
      // A commitment to act needs the same authority as acting. Saying what DW
      // is permitted to do is not the same as scheduling it, so the answer says
      // so rather than implying an action has been queued.
      ? (resolution.governing
        ? `A current grant covers ${label}${forScope}, so I can — but I do not act from this conversation alone.`
        : `No. ${resolution.reason}`)
      : (resolution.governing
        ? `Yes — a current grant covers ${label}${forScope}.`
        : `No. ${resolution.reason}`)
  return answer(conclusion, {
    evidenceBasis: resolution.grant
      ? freeze([describeGrantLine({
        canonicalAction: resolution.grant.action,
        scopeLabel: describeScope(resolution.grant),
        channel: resolution.grant.channel,
        approvalRequirement: resolution.grant.approvalRequirement,
      })])
      : freeze([]),
    authorityStatus: resolution.status,
    questionSemantic: parsed.semantic,
    governing: resolution.governing,
  })
}
