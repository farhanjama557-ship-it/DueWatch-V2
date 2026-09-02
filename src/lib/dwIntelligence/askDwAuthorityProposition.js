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
  // The subject is the grant/permission itself ("the current grant covers...").
  // G5 grants are always to DW, so the grantee is determinate.
  GRANT_SUBJECT: 'GRANT_SUBJECT',
  OTHER: 'OTHER',
  UNKNOWN: 'UNKNOWN',
})

export const ASK_DW_SCOPE_ASSERTION = Object.freeze({
  COMPANY: 'COMPANY',
  CLIENT: 'CLIENT',
  ENTITY: 'ENTITY',
  // No scope cue at all: the conversation's focus may stand in.
  UNSPECIFIED: 'UNSPECIFIED',
  // A scope IS asserted but cannot be resolved. Focus must never stand in.
  UNKNOWN: 'UNKNOWN',
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
  // A bare modal is handled separately: modality alone is not an authority
  // claim ("I cannot confirm a payment" is not about permission).
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

// First person includes object pronouns: "no approval is needed for me to send".
const DW_ACTOR = /\b(?:i|i'm|me|my|myself|we|we're|us|our|ourselves|dw|duewatch|due\s?watch)\b/i

// Named or generic third parties. Permission attributed to any of these is not
// DW's permission, whatever a grant happens to say.
const OTHER_ACTOR = /\b(?:the\s+(?:system|assistant|agent|bot|platform|tool|service|provider|customer|client|vendor|partner|team)|automation|gmail|stripe|quickbooks|someone|somebody|anyone|anybody|everyone|they|he|she|third\s+part(?:y|ies))\b/i

// The subject is a grant/permission noun rather than an actor.
const GRANT_SUBJECT = /^(?:the|this|that|a|an|our|your)?\s*(?:current|active|standing|explicit)?\s*(?:grant|permission|authori[sz]ation|authority|clearance)\b|\b(?:grant|permission|authori[sz]ation|authority)\s+(?:currently\s+)?(?:covers|allows|permits|authori[sz]es|includes|exists|extends|gives|applies)/i

// A capitalised subject that is neither DW nor a grant noun: "Atlas is allowed
// to send email reminders."
const NAMED_SUBJECT = /^(?:the\s+)?([A-Z][A-Za-z0-9&.'-]*)\s+(?:is|are|was|were|may|can|could|might|will|has|have|holds?|gets?)\b/

// Negation that scopes over an authority predicate.
// Every negator is word-bounded on BOTH sides. Without the trailing boundary
// "no" matched inside "notices" and silently flipped a positive claim's
// polarity, which let an ambiguous action through. The un- stem is matched
// separately because it is a prefix, not a word.
const NEGATORS = /\b(?:not|never|no|none|cannot|can't|cant|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|lacks|lack|lacking|absent|without|unable|incapable)\b|\bun(?:authoris|authoriz)/gi
const DOUBLE_NEGATION_HINT = /\bnot\s+un(?:authoris|authoriz)|\bnot\s+true\s+that\b|\bnot\s+absent\b|\bnever\s+not\b|\bno\s+longer\s+un/i

// ── per-proposition parsing ──────────────────────────────────────────────────

/**
 * A modal only raises an authority question when it governs an accounts-
 * receivable act. This is a closed verb list, not a sentence blacklist: it
 * keeps "I cannot confirm a payment" out while keeping "I cannot contact
 * Atlas" in, so an unmapped denial about a real AR act still fails closed.
 */
const MODAL = /\b(?:can|cannot|can't|cant|may|could|might|able\s+to|unable\s+to|capable\s+of|allowed\s+to|permitted\s+to)\b/i
const AR_ACT = /\b(?:send|sends|sending|sent|email|emails|emailing|text|texts|texting|message|messages|messaging|contact|contacts|contacting|chase|chasing|nudge|nudging|remind|reminds|reminding|reminder|reminders|follow[- ]up|call|calls|calling|apply|applies|applying|waive|waives|waiving|settle|settles|settling|write[- ]?off|wrote[- ]?off|refund|refunds|refunding|charge|charges|charging|collect|collects|collecting|escalate|escalating|dunning|act|acts|acting|handle|handles|handling|do\s+(?:this|that|it))\b/i

function matchVocabulary(text, table) {
  const found = new Set()
  for (const [pattern, value] of table) {
    if (pattern.test(text)) found.add(value)
  }
  return found
}

function parseAction(text) {
  const found = matchVocabulary(text, ACTION_TERMS)
  // "waive late fees" is uniquely WAIVE_LATE_FEE; the bare "late fees" term
  // must not also register APPLY_LATE_FEE and make it look ambiguous.
  if (found.has('WAIVE_LATE_FEE')) found.delete('APPLY_LATE_FEE')
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
  if (OTHER_ACTOR.test(text)) return ASK_DW_ACTOR.OTHER
  const named = NAMED_SUBJECT.exec(text)
  if (named && !/^(?:i|we|dw|duewatch)$/i.test(named[1]) &&
      !/^(?:the|this|that|a|an|our|your|current|active|standing|explicit|grant|permission|authori[sz]ation|authority|clearance|email|sms|sending|no|permission)$/i.test(named[1])) {
    return ASK_DW_ACTOR.OTHER
  }
  if (DW_ACTOR.test(text)) return ASK_DW_ACTOR.DW
  if (GRANT_SUBJECT.test(text)) return ASK_DW_ACTOR.GRANT_SUBJECT
  return ASK_DW_ACTOR.UNKNOWN
}

/**
 * Scope asserted BY THE TEXT, which is not the same as the conversation's
 * focus. An Atlas grant must not support "for Globex" or "company-wide".
 */
/**
 * Words that follow a preposition without naming a scope target. "for SMS
 * reminders" and "for me to send" assert no scope; "for globex" does.
 */
const NON_SCOPE_TOKENS = new Set([
  'email', 'e-mail', 'emails', 'sms', 'text', 'texts', 'whatsapp', 'phone', 'postal',
  'portal', 'reminder', 'reminders', 'message', 'messages', 'notice', 'notices',
  'collection', 'collections', 'fee', 'fees', 'refund', 'refunds', 'approval',
  'permission', 'authority', 'authorisation', 'authorization', 'grant', 'grants',
  'me', 'us', 'you', 'them', 'it', 'this', 'that', 'these', 'those', 'now', 'today',
  'anything', 'something', 'nothing', 'sending', 'emailing', 'texting', 'asking',
  'each', 'every', 'any', 'both',
  // Verbs and function words that can follow a preposition without ever
  // naming a scope target: "to send", "for applying", "to act".
  'send', 'sends', 'sending', 'apply', 'applying', 'waive', 'waiving', 'settle',
  'settling', 'write', 'writing', 'issue', 'issuing', 'charge', 'charging',
  'chase', 'chasing', 'nudge', 'contact', 'contacting', 'remind', 'reminding',
  'do', 'act', 'acting', 'handle', 'handling', 'proceed', 'go', 'be', 'have',
  'a', 'an', 'the', 'my', 'our', 'your', 'their', 'his', 'her', 'its',
])

const COMPANY_SCOPE = /\bcompany[- ]wide\b|\bacross\s+the\s+(?:company|business|portfolio)\b|\bportfolio[- ]wide\b|\bglobally\b|\bcompany\s+level\b|\ball\s+clients\b|\bevery\s+client\b|\ball\s+customers\b|\bacross\s+all\b/i

// An explicitly OTHER target names a scope that by construction is not the one
// in hand, so it can never resolve.
const OTHER_SCOPE = /\b(?:another|other|a\s+different|some\s+other|different)\s+(?:client|customer|account|entity|company)\b|\bother\s+clients\b/i

// Cues that a scope target is being named at all.
const SCOPE_CUE = /\b(?:for|to|on|against|with|at)\s+\S|\bclient\b|\bcustomer\b|\baccount\b|\bcompany\b|\bportfolio\b|\bglobally\b/i

// Global so every candidate target in the sentence is considered: "to send
// ... for globex" must not stop at "send".
const NAMED_TARGET = [
  // "for client Globex", "for the Globex account", "for customer Globex"
  /\b(?:client|customer|account)\s+([A-Za-z][A-Za-z0-9&.'-]*)/gi,
  /\bthe\s+([A-Za-z][A-Za-z0-9&.'-]*)\s+(?:account|client|customer)\b/gi,
  // "for Globex", "to globex"
  /\b(?:for|to|on|against)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9&.'-]*)/gi,
]

/**
 * Scope asserted BY THE TEXT. The distinction that matters is between "no
 * scope was mentioned" (UNSPECIFIED, where conversational focus may stand in)
 * and "a scope was mentioned but could not be resolved" (UNKNOWN, which must
 * fail closed). Letting the second silently become the first is how an Atlas
 * grant came to support "for globex".
 */
function parseScope(text) {
  const none = { scopeType: ASK_DW_SCOPE_ASSERTION.UNSPECIFIED, clientName: null, entityId: null }
  const companyWide = COMPANY_SCOPE.test(text)
  const entityMatch = /\b(?:invoice|inv)[-\s#]?([A-Za-z0-9][A-Za-z0-9-]*\d[A-Za-z0-9-]*)\b/i.exec(text)

  if (OTHER_SCOPE.test(text)) {
    return { scopeType: ASK_DW_SCOPE_ASSERTION.UNKNOWN, clientName: null, entityId: null }
  }
  if (companyWide && entityMatch) {
    return { scopeType: ASK_DW_SCOPE_ASSERTION.AMBIGUOUS, clientName: null, entityId: null }
  }
  if (companyWide) return { scopeType: ASK_DW_SCOPE_ASSERTION.COMPANY, clientName: null, entityId: null }
  if (entityMatch) return { scopeType: ASK_DW_SCOPE_ASSERTION.ENTITY, clientName: null, entityId: entityMatch[1] }

  for (const pattern of NAMED_TARGET) {
    for (const match of text.matchAll(pattern)) {
      const token = match[1]
      if (NON_SCOPE_TOKENS.has(token.toLowerCase())) continue
      return { scopeType: ASK_DW_SCOPE_ASSERTION.CLIENT, clientName: token, entityId: null }
    }
  }
  // A cue with no extractable target still asserts a scope; it must not fall
  // back to focus.
  if (/\b(?:client|customer|account)\b/i.test(text) && SCOPE_CUE.test(text)) {
    return { scopeType: ASK_DW_SCOPE_ASSERTION.UNKNOWN, clientName: null, entityId: null }
  }
  return none
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
  const authorityBearing = AUTHORITY_TRIGGER.test(text) || (MODAL.test(text) && AR_ACT.test(text))
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
