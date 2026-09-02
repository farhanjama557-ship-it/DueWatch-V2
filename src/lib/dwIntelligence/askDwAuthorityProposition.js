/**
 * M2G-G7 authority proposition parser — a CLOSED typed boundary.
 *
 * The previous guard recognised authority prose with a growing regex catalog
 * and then extracted the action and channel from the whole flattened answer.
 * That let one clause borrow another clause's specifics:
 *
 *   "I am authorized. This email reminder is only a draft."
 *
 * read as a supported EMAIL/SEND_REMINDER authority claim.
 *
 * This module inverts the design. It is deliberately NOT an attempt to
 * recognise every English sentence:
 *
 *   - the TRIGGER is broad, because over-triggering is safe: a triggered
 *     proposition that cannot be mapped exactly is blocked;
 *   - the ACCEPT is narrow and closed: every dimension must map onto an exact
 *     G5 value from a fixed vocabulary, parsed from THAT proposition alone.
 *
 * Nothing is ever borrowed across a sentence, a coordinated clause, a
 * quotation or an answer field. G5 remains the sole owner of authority; this
 * module only decides whether a sentence may be said.
 */

/** Exactly the seven G5 actions. Never widened, never collapsed. */
export const G5_ACTIONS = Object.freeze([
  'SEND_REMINDER', 'SEND_COLLECTION_MESSAGE', 'APPLY_LATE_FEE', 'WAIVE_LATE_FEE',
  'SETTLE_INVOICE', 'WRITE_OFF_INVOICE', 'ISSUE_REFUND',
])

export const ASK_DW_POLARITY = Object.freeze({
  POSITIVE: 'POSITIVE',
  NEGATIVE: 'NEGATIVE',
  AMBIGUOUS: 'AMBIGUOUS',
})

export const ASK_DW_ACTOR = Object.freeze({
  DW: 'DW',
  OTHER: 'OTHER',
  UNKNOWN: 'UNKNOWN',
})

export const ASK_DW_SCOPE_ASSERTION = Object.freeze({
  COMPANY: 'COMPANY',
  CLIENT: 'CLIENT',
  ENTITY: 'ENTITY',
  UNSPECIFIED: 'UNSPECIFIED',
  AMBIGUOUS: 'AMBIGUOUS',
})

/** Sentinels. Any of these on a positive proposition means fail closed. */
export const UNMAPPABLE = Object.freeze({
  ACTION_UNKNOWN: 'ACTION_UNKNOWN',
  ACTION_AMBIGUOUS: 'ACTION_AMBIGUOUS',
  CHANNEL_UNKNOWN: 'CHANNEL_UNKNOWN',
  CHANNEL_AMBIGUOUS: 'AMBIGUOUS_CHANNEL',
})

// ── normalisation ────────────────────────────────────────────────────────────

/**
 * Formatting must not be able to hide or fabricate a claim. Dashes, smart
 * quotes, Markdown emphasis and non-breaking spaces are normalised; sentence
 * structure is preserved so segmentation stays honest.
 */
export function normalizeAuthorityText(value) {
  return String(value || '')
    .replace(/ | | /g, ' ')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—―]/g, ' - ')
    .replace(/\*\*|\*|__|_|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// A discourse marker inside a clause ("I am, however, authorized") must not
// split the proposition; a coordinator between clauses must.
const COORDINATORS = /\s+(?:and|or|nor|yet|but|however|although|though|while|whereas)\s+/gi
const TERMINATORS = /[.!?;\n]+/

function stripDiscourseCommas(value) {
  return value.replace(/,\s*(?:however|therefore|though|nevertheless|nonetheless|in fact|indeed)\s*,/gi, ' ')
}

/**
 * Splits one field into propositions. Quoted spans become their own
 * propositions carrying their attribution, so reported speech can never be
 * read as the assistant asserting anything.
 */
export function segmentPropositions(fieldText, { field = 'unknown' } = {}) {
  const normalized = normalizeAuthorityText(fieldText)
  if (!normalized) return []
  const propositions = []
  let cursor = 0
  const quotePattern = /"([^"]*)"/g

  const pushPlain = (text, attribution) => {
    const cleaned = stripDiscourseCommas(text)
    for (const sentence of cleaned.split(TERMINATORS)) {
      for (const clause of sentence.split(COORDINATORS)) {
        const trimmed = clause.trim()
        if (trimmed) {
          propositions.push({ field, text: trimmed, quoted: false, attributedTo: attribution })
        }
      }
    }
  }

  for (const match of normalized.matchAll(quotePattern)) {
    const before = normalized.slice(cursor, match.index)
    // Attribution is whatever introduced the quotation, e.g. `Atlas wrote:`.
    const attribution = /\b(\w[\w\s]*?)\s+(?:wrote|said|says|states|stated|writes|claims|claimed)\s*:?\s*$/i
      .exec(before.trim())
    pushPlain(before, null)
    const inner = stripDiscourseCommas(match[1])
    for (const sentence of inner.split(TERMINATORS)) {
      for (const clause of sentence.split(COORDINATORS)) {
        const trimmed = clause.trim()
        if (trimmed) {
          propositions.push({
            field,
            text: trimmed,
            quoted: true,
            // null, not a placeholder: an unattributed quotation cannot be
            // told apart from the assistant asserting it, and must fail closed.
            attributedTo: attribution ? attribution[1].trim() : null,
          })
        }
      }
    }
    cursor = match.index + match[0].length
  }
  pushPlain(normalized.slice(cursor), null)
  return propositions
}

// ── closed vocabularies ──────────────────────────────────────────────────────

/**
 * Broad trigger. Over-triggering is safe: anything caught here must then map
 * exactly or be blocked.
 */
const AUTHORITY_TRIGGER = new RegExp([
  'authoris|authoriz|permission|permitted|allowed|entitled|licen[cs]ed',
  'authority|mandate|clearance|cleared to|green ?light|free to|good to go',
  '\\bgrant\\b|\\bgrants\\b|\\bgranted\\b|standing authority',
  '\\bcan\\b|\\bcannot\\b|\\bcan\'t\\b|\\bmay\\b|\\bcould\\b|\\bmight\\b|\\bable to\\b|\\bunable to\\b|\\bcapable of\\b',
  'nothing (?:is )?(?:prevent|stopp|block)',
  '\\bapprovals?\\b|\\bask\\s+(?:you\\s+)?first\\b',
  "don'?t need to ask|do not need to ask|without asking|without approval",
  'covers|covered by|applies to|extends to|encompasses|falls within|pursuant to|within (?:the )?(?:scope|grant)',
].join('|'), 'i')

/**
 * Action vocabulary. Each entry maps to exactly one G5 action. Terms that are
 * genuinely ambiguous between two G5 actions map to ACTION_AMBIGUOUS and are
 * never collapsed — "chase", "nudge", "follow up", "dunning" and "collection
 * reminder" could each mean SEND_REMINDER or SEND_COLLECTION_MESSAGE.
 */
const ACTION_TERMS = Object.freeze([
  // Ambiguous first: these must win over a narrower substring match.
  [/\bcollections?\s+reminders?\b/i, UNMAPPABLE.ACTION_AMBIGUOUS],
  [/\bdunning\b/i, UNMAPPABLE.ACTION_AMBIGUOUS],
  [/\bchase\b|\bchasing\b|\bchased\b/i, UNMAPPABLE.ACTION_AMBIGUOUS],
  [/\bnudge\b|\bnudging\b|\bnudged\b/i, UNMAPPABLE.ACTION_AMBIGUOUS],
  [/\bfollow(?:s|ed|ing)?[- ]ups?\b/i, UNMAPPABLE.ACTION_AMBIGUOUS],
  [/\bcollections?\s+(?:message|notice|letter|email|communication)s?\b/i, 'SEND_COLLECTION_MESSAGE'],
  [/\bcollection\s+messag(?:e|es|ing)\b/i, 'SEND_COLLECTION_MESSAGE'],
  [/\breminders?\b/i, 'SEND_REMINDER'],
  [/\bremind(?:s|ed|ing)?\b/i, 'SEND_REMINDER'],
  [/\bwaiv(?:e|es|ed|ing)\b[^.]{0,24}\blate\s+fees?\b/i, 'WAIVE_LATE_FEE'],
  [/\blate\s+fees?\b[^.]{0,24}\bwaiv(?:e|es|ed|ing|er)\b/i, 'WAIVE_LATE_FEE'],
  [/\b(?:appl(?:y|ies|ied|ying)|charg(?:e|es|ed|ing)|add(?:s|ed|ing)?)\b[^.]{0,24}\blate\s+fees?\b/i, 'APPLY_LATE_FEE'],
  [/\blate\s+fees?\b/i, 'APPLY_LATE_FEE'],
  [/\bsettl(?:e|es|ed|ing|ement)\b/i, 'SETTLE_INVOICE'],
  [/\bwrit(?:e|es|ing|ten)[- ]offs?\b|\bwrote[- ]off\b|\bwrite\s+off\b/i, 'WRITE_OFF_INVOICE'],
  [/\brefunds?\b|\brefund(?:s|ed|ing)\b/i, 'ISSUE_REFUND'],
])

/**
 * Channel vocabulary. Only deliberate, unambiguous aliases normalise. A
 * provider name is NOT a channel: treating Gmail or Teams as a channel is the
 * provider-capability-to-authority leap this gate forbids, so they are
 * recognised and refused rather than silently mapped.
 */
const CHANNEL_TERMS = Object.freeze([
  [/\be-?mails?\b|\be-?mailing\b|\be-?mailed\b/i, 'EMAIL'],
  [/\bsms\b|\btext\s+messages?\b|\btexting\b/i, 'SMS'],
  [/\bwhats\s?app\b/i, 'WHATSAPP'],
  [/\bphone\b|\btelephone\b|\bphone\s+calls?\b/i, 'PHONE'],
  [/\bpostal?\b|\bletters?\b|\bmail\s+merge\b/i, 'POSTAL'],
  [/\bportals?\b/i, 'PORTAL'],
  [/\bgmail\b|\boutlook\b|\bteams\b|\bslack\b|\btwilio\b|\bsendgrid\b/i, UNMAPPABLE.CHANNEL_UNKNOWN],
])

const DW_ACTOR = /\b(?:i|i'm|we|we're|dw|duewatch|due\s?watch)\b/i
const OTHER_ACTOR = /\b(?:the\s+(?:system|assistant|agent|bot|platform|tool|service)|automation|gmail|stripe|quickbooks|the\s+provider)\b/i

// Negation that scopes over an authority predicate.
// Every negator is word-bounded on BOTH sides. Without the trailing boundary
// "no" matched inside "notices" and silently flipped a positive claim's
// polarity, which let an ambiguous action through. The un- stem is matched
// separately because it is a prefix, not a word.
const NEGATORS = /\b(?:not|never|no|none|cannot|can't|cant|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|lacks|lack|lacking|absent|without|unable|incapable)\b|\bun(?:authoris|authoriz)/gi
const DOUBLE_NEGATION_HINT = /\bnot\s+un(?:authoris|authoriz)|\bnot\s+true\s+that\b|\bnot\s+absent\b|\bnever\s+not\b|\bno\s+longer\s+un/i

// ── per-proposition parsing ──────────────────────────────────────────────────

function matchVocabulary(text, table) {
  const found = new Set()
  for (const [pattern, value] of table) {
    if (pattern.test(text)) found.add(value)
  }
  return found
}

function parseAction(text) {
  const found = matchVocabulary(text, ACTION_TERMS)
  if (found.has(UNMAPPABLE.ACTION_AMBIGUOUS)) return UNMAPPABLE.ACTION_AMBIGUOUS
  const actions = [...found].filter((value) => G5_ACTIONS.includes(value))
  if (actions.length === 0) return UNMAPPABLE.ACTION_UNKNOWN
  if (actions.length > 1) return UNMAPPABLE.ACTION_AMBIGUOUS
  return actions[0]
}

function parseChannel(text) {
  const found = matchVocabulary(text, CHANNEL_TERMS)
  if (found.has(UNMAPPABLE.CHANNEL_UNKNOWN)) return UNMAPPABLE.CHANNEL_UNKNOWN
  const channels = [...found]
  if (channels.length === 0) return null
  if (channels.length > 1) return UNMAPPABLE.CHANNEL_AMBIGUOUS
  return channels[0]
}

function parseActor(text) {
  const dw = DW_ACTOR.test(text)
  const other = OTHER_ACTOR.test(text)
  if (other) return ASK_DW_ACTOR.OTHER
  if (dw) return ASK_DW_ACTOR.DW
  return ASK_DW_ACTOR.UNKNOWN
}

/**
 * Scope asserted BY THE TEXT, which is not the same as the conversation's
 * focus. An Atlas grant must not support "for Globex" or "company-wide".
 */
function parseScope(text) {
  const companyWide = /\bcompany[- ]wide\b|\ball\s+clients\b|\bevery\s+client\b|\bacross\s+the\s+portfolio\b|\bportfolio[- ]wide\b/i.test(text)
  const clientMatch = /\b(?:for|with|to|on|against)\s+(?!the\b|all\b|every\b|any\b|this\b|that\b|us\b|them\b|you\b|me\b)([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*)?)/.exec(text)
  const entityMatch = /\b(?:invoice|inv)[-\s#]?([A-Za-z0-9][A-Za-z0-9-]*\d[A-Za-z0-9-]*)\b/i.exec(text)
  if (companyWide && clientMatch) return { scopeType: ASK_DW_SCOPE_ASSERTION.AMBIGUOUS, clientName: null, entityId: null }
  if (companyWide) return { scopeType: ASK_DW_SCOPE_ASSERTION.COMPANY, clientName: null, entityId: null }
  if (entityMatch) return { scopeType: ASK_DW_SCOPE_ASSERTION.ENTITY, clientName: null, entityId: entityMatch[1] }
  if (clientMatch) return { scopeType: ASK_DW_SCOPE_ASSERTION.CLIENT, clientName: clientMatch[1].trim(), entityId: null }
  return { scopeType: ASK_DW_SCOPE_ASSERTION.UNSPECIFIED, clientName: null, entityId: null }
}

/**
 * Polarity. A single scoping negator makes the proposition negative; nested or
 * doubled negation is reported AMBIGUOUS rather than being resolved, because
 * "DW is not unauthorized" must never become a positive claim by arithmetic.
 */
// "No approval is needed" negates the APPROVAL requirement, not the
// authority. It is an authority-bearing POSITIVE claim, and it is validated
// against the grant's approvalRequirement separately.
const APPROVAL_NEGATION = /\bno\s+approval\b|\bapproval\s+is\s+not\s+(?:needed|required)\b|\bwithout\s+(?:asking|approval|checking)\b|\bdon'?t\s+need\s+to\s+ask\b|\bdo\s+not\s+need\s+to\s+ask\b/gi

function parsePolarity(text, approvalState) {
  if (DOUBLE_NEGATION_HINT.test(text)) return ASK_DW_POLARITY.AMBIGUOUS
  // Asserting that approval IS required is a statement that DW cannot act
  // unilaterally, which is a negative authority claim.
  if (approvalState === 'FOUNDER') return ASK_DW_POLARITY.NEGATIVE
  const scoped = String(text).replace(APPROVAL_NEGATION, ' ')
  const negators = scoped.match(NEGATORS) || []
  if (negators.length === 0) return ASK_DW_POLARITY.POSITIVE
  if (negators.length === 1) return ASK_DW_POLARITY.NEGATIVE
  return ASK_DW_POLARITY.AMBIGUOUS
}

function parseApproval(text) {
  if (/\bno\s+approval\b|\bapproval\s+is\s+not\s+(?:needed|required)\b|\bwithout\s+(?:asking|approval)\b|\bdon'?t\s+need\s+to\s+ask\b|\bdo\s+not\s+need\s+to\s+ask\b|\bwithout\s+checking\b/i.test(text)) {
    return 'NONE'
  }
  if (/\bapproval\s+(?:is\s+)?(?:needed|required)\b|\bneed\s+(?:your\s+)?approval\b|\bask\s+(?:you\s+)?first\b/i.test(text)) {
    return 'FOUNDER'
  }
  return null
}

/** Capability language that cannot be mapped onto G5 semantics at all. */
const VAGUE_CAPABILITY = /\bgreen\s?light\b|\bcleared\s+to\b|\bfree\s+to\b|\bgood\s+to\s+go\b|\bnothing\s+(?:is\s+)?(?:prevent|stopp|block)/i

/**
 * Parses ONE proposition. Every dimension comes from this proposition's own
 * text; nothing is inherited from a sibling clause, sentence or field.
 */
export function parseAuthorityProposition(proposition) {
  const text = proposition.text
  const authorityBearing = AUTHORITY_TRIGGER.test(text)
  const base = {
    ...proposition,
    authorityBearing,
    polarity: null, actor: null, canonicalAction: null, scopeType: null,
    clientName: null, entityId: null, channel: null, approvalState: null,
    vagueCapability: false, grantIdentity: null,
  }
  if (!authorityBearing) return Object.freeze(base)

  const scope = parseScope(text)
  const approvalState = parseApproval(text)
  return Object.freeze({
    ...base,
    polarity: parsePolarity(text, approvalState),
    actor: parseActor(text),
    canonicalAction: parseAction(text),
    scopeType: scope.scopeType,
    clientName: scope.clientName,
    entityId: scope.entityId,
    channel: parseChannel(text),
    approvalState,
    vagueCapability: VAGUE_CAPABILITY.test(text),
    // A grant referred to by identity must still match a real current grant.
    grantIdentity: /\bgrant\b|\bauthoris|\bauthoriz|\bpermission\b/i.test(text) ? 'REFERENCED' : null,
  })
}

/**
 * Parses every model-authored field independently. Fields are never joined,
 * so a claim in one field cannot borrow specifics from another.
 */
export function parseCandidateAuthorityPropositions(candidate) {
  const fields = [
    ['executiveConclusion', candidate?.executiveConclusion],
    ...(Array.isArray(candidate?.evidenceBasis) ? candidate.evidenceBasis.map((v, i) => [`evidenceBasis[${i}]`, v]) : []),
    ...(Array.isArray(candidate?.uncertaintyAndLimitations) ? candidate.uncertaintyAndLimitations.map((v, i) => [`uncertaintyAndLimitations[${i}]`, v]) : []),
    ['recommendationOrNextStep', candidate?.recommendationOrNextStep],
    ...(Array.isArray(candidate?.competingExplanations) ? candidate.competingExplanations.map((v, i) => [`competingExplanations[${i}]`, v]) : []),
  ]
  const propositions = []
  for (const [field, value] of fields) {
    if (typeof value !== 'string' || !value.trim()) continue
    for (const segment of segmentPropositions(value, { field })) {
      propositions.push(parseAuthorityProposition(segment))
    }
  }
  return Object.freeze(propositions)
}
