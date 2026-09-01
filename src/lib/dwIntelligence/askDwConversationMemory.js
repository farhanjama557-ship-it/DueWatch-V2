import {
  ASK_DW_CASE_EVENT,
  applyAskDwCaseEvent,
  normalizeAskDwConversationNicknameTerm,
} from './askDwCaseState.js'
import { classifyAskDwConversationalTurn } from './askDwConversationalTurn.js'

const UNRESOLVED_STATUSES = new Set([
  'NEEDS_CLIENT_RESOLUTION',
  'CLIENT_NOT_FOUND',
  'CLIENT_HAS_NO_INVOICES',
  'NEEDS_INVOICE_RESOLUTION',
  'INVOICE_NOT_FOUND',
  'NEEDS_REFERENCE_RESOLUTION',
])

export const ASK_DW_CONVERSATION_MEMORY_PROFILE = Object.freeze({
  id: 'ASK_DW_CONVERSATION_MEMORY_V0',
  deterministicStructuredSummary: true,
  storesTranscript: false,
  storesRawFounderAssertions: false,
  canonicalFinancialTruthStored: false,
  companyPolicyStored: false,
  evidenceStored: false,
  authorityStored: false,
  conversationCanGrantAuthority: false,
  nicknamesConversationScoped: true,
  nicknamesRequireVerifiedReference: true,
  liveReferenceRevalidationRequired: true,
  companyVocabularySource: 'COMPANY_BRAIN_CONTEXT_ONLY',
})

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) freeze(nested)
  return value
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[!?.,]+$/g, '')
    .replace(/\s+/g, ' ')
}

function safeNickname(value) {
  try {
    return normalizeAskDwConversationNicknameTerm(normalize(value))
  } catch {
    return null
  }
}

function nicknameDeclaration(text, focus) {
  const value = normalize(text)
  const patterns = [
    {
      expression: /^(?:call|refer to) (?:them|him|her|that client|this client) (?:as )?(.+)$/,
      ref: focus?.clientRef ?? null,
    },
    {
      expression: /^when i say (.+?) i mean (?:them|him|her|that client|this client)$/,
      ref: focus?.clientRef ?? null,
    },
    {
      expression: /^(?:call|refer to) (?:that invoice|this invoice) (?:as )?(.+)$/,
      ref: focus?.invoiceRef ?? null,
    },
    {
      expression: /^when i say (.+?) i mean (?:that invoice|this invoice)$/,
      ref: focus?.invoiceRef ?? null,
    },
  ]

  for (const { expression, ref } of patterns) {
    const match = expression.exec(value)
    const term = match ? safeNickname(match[1]) : null
    if (term && ref) return freeze({ term, ref: clone(ref) })
  }
  return null
}

export function isAskDwConversationNicknameDeclaration(text) {
  const value = normalize(text)
  return /^(?:call|refer to) (?:them|him|her|that client|this client|that invoice|this invoice)(?: as)? .+$/.test(value) ||
    /^when i say .+? i mean (?:them|him|her|that client|this client|that invoice|this invoice)$/.test(value)
}

function referenceResolution(result) {
  const status = String(result?.resolver?.status || result?.status || '').trim()
  if (result?.resolver?.blocked === true || UNRESOLVED_STATUSES.has(status)) {
    return { state: 'UNRESOLVED', status: status || 'NEEDS_REFERENCE_RESOLUTION' }
  }
  if (result?.resolver && result.resolver.blocked !== true) {
    return { state: 'RESOLVED', status: status || 'RESOLVED' }
  }
  return { state: 'UNCHANGED', status: status || null }
}

/**
 * Finds only conversation-scoped nicknames already bound to a durable
 * reference. The entity resolver must still live-read that reference before
 * it can become current focus again.
 */
export function findAskDwConversationNickname(caseContext, text) {
  const value = normalize(text)
  if (!value) return null
  const candidates = (caseContext?.memory?.conversationalNicknames || [])
    .filter((item) => {
      const term = safeNickname(item?.term)
      return term && (` ${value} `).includes(` ${term} `) && item?.ref
    })
    .sort((left, right) => right.term.length - left.term.length)

  if (candidates.length === 0) return null
  const longest = candidates[0].term.length
  const best = candidates.filter((item) => item.term.length === longest)
  const distinctRefs = new Set(best.map((item) => `${item.ref.kind}:${item.ref.id}`))
  if (distinctRefs.size !== 1) return freeze({ ambiguous: true, term: null, ref: null })
  return freeze({ ambiguous: false, term: best[0].term, ref: clone(best[0].ref) })
}

/**
 * Records a bounded, structured summary after a completed durable turn.
 * Raw text, claims, answers, tool output, policy and authority never enter the
 * event payload. The resulting state remains reference workflow state only.
 */
export function recordAskDwConversationMemory({
  state,
  tenantId,
  turnId,
  text,
  mode = 'normal',
  at,
  result,
} = {}) {
  const currentCase = state?.cases?.[state.activeCaseId] ?? null
  const caseContext = currentCase ? { focus: currentCase.focus } : null
  const turn = classifyAskDwConversationalTurn({ text, caseContext })
  const resolution = referenceResolution(result)
  const nickname = nicknameDeclaration(text, currentCase?.focus)

  return applyAskDwCaseEvent(state, {
    type: ASK_DW_CASE_EVENT.RECORD_CONVERSATION_MEMORY,
    tenantId,
    expectedVersion: state.version,
    turnId,
    at,
    payload: {
      turnType: turn.turnType,
      correctionKind: turn.correctionKind,
      mode: String(mode || 'normal').toLowerCase(),
      referenceResolution: resolution.state,
      resolutionStatus: resolution.status,
      nickname,
    },
  })
}
