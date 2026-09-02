/**
 * M2G-G7 final authority-boundary repair.
 *
 * Two complementary controls are exercised here:
 *
 *  A. deterministic authority rendering for explicit authority questions, and
 *  B. the closed typed proposition boundary for spontaneous authority claims.
 *
 * The tests are written as EQUIVALENCE CLASSES crossed against grant states,
 * not as one-off string patches, because the point of the repair is that an
 * unmapped sentence fails closed rather than that every sentence is known.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ASK_DW_GROUNDING_ISSUE,
  enforceAskDwGrounding,
} from '../src/lib/dwIntelligence/askDwGroundingGuard.js'
import {
  ASK_DW_AUTHORITY_ISSUE,
  ASK_DW_AUTHORITY_STATUS,
  evaluateAuthorityPropositions,
  renderAskDwAuthority,
  resolveAskDwAuthority,
} from '../src/lib/dwIntelligence/askDwAuthorityRenderer.js'
import {
  ASK_DW_POLARITY,
  ASK_DW_SCOPE_ASSERTION,
  G5_ACTIONS,
  parseAuthorityProposition,
  parseCandidateAuthorityPropositions,
  segmentPropositions,
} from '../src/lib/dwIntelligence/askDwAuthorityProposition.js'
import {
  ASK_DW_TURN,
  classifyAskDwConversationalTurn,
} from '../src/lib/dwIntelligence/askDwConversationalTurn.js'
import { createAskDwOrchestrator } from '../src/lib/dwIntelligence/askDwOrchestrator.js'

const AS_OF = '2026-09-02T09:00:00.000Z'
const PASS = Object.freeze({ verdict: 'PASS', issues: [], checkedClaims: [] })

function grant(overrides = {}) {
  return {
    grantId: 'g1', status: 'GRANTED', action: 'SEND_REMINDER',
    scope: { level: 'CLIENT', clientId: 'atlas' }, channel: 'EMAIL',
    approvalRequirement: 'NONE', conditions: {},
    limits: { maxAmountMinor: null, currencyCode: null },
    effectiveFrom: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

function context(grants, { available = true } = {}) {
  return { available, conflicts: [], authority: { evaluatedAt: AS_OF, currentGrants: grants } }
}

function check(text, grants, { clientId = 'atlas', field = 'executiveConclusion' } = {}) {
  const candidate = field === 'executiveConclusion'
    ? { executiveConclusion: text }
    : { executiveConclusion: 'Status noted.', [field]: Array.isArray([]) && field !== 'recommendationOrNextStep' ? [text] : text }
  return enforceAskDwGrounding({
    candidate, verification: PASS, truthLock: { canonicalFacts: { paid: false } },
    companyBrainContext: context(grants),
    caseContext: { focus: { clientRef: clientId ? { kind: 'client', id: clientId } : null, invoiceRef: null } },
  })
}

const blocked = (result) => result.verdict === 'BLOCK'
const umbrella = (result) =>
  result.groundingIssues.includes(ASK_DW_GROUNDING_ISSUE.CLAIMED_AUTHORITY_WITHOUT_GRANT)

// ── grant-state matrix ───────────────────────────────────────────────────────

/** The thirteen grant states the matrix crosses every claim family against. */
const GRANT_STATES = Object.freeze([
  ['zero grants', []],
  ['wrong action', [grant({ action: 'APPLY_LATE_FEE' })]],
  ['wrong channel', [grant({ channel: 'SMS' })]],
  ['wrong scope level', [grant({ scope: { level: 'COMPANY' } })]],
  ['wrong client id', [grant({ scope: { level: 'CLIENT', clientId: 'globex' } })]],
  ['expired', [grant({ expiresAt: '2026-09-02T00:00:00.000Z' })]],
  ['not yet effective', [grant({ effectiveFrom: '2026-12-01T00:00:00.000Z' })]],
  ['revoked', [grant({ status: 'REVOKED' })]],
  ['stale', [grant({ status: 'STALE' })]],
  ['approval required', [grant({ approvalRequirement: 'FOUNDER' })]],
  ['material conditions', [grant({ conditions: { daysOverdue: 7 } })]],
  ['amount limit', [grant({ limits: { maxAmountMinor: 5000, currencyCode: 'USD' } })]],
  ['malformed time', [grant({ effectiveFrom: 'not-a-date' })]],
])

/** Positive authority assertions, one per hostile semantic family. */
const POSITIVE_FAMILIES = Object.freeze([
  ['modal permission', 'I may send email reminders.'],
  ['modal could', 'I could send email reminders.'],
  ['modal entitled', 'I am entitled to send email reminders.'],
  ['active authorization', 'I am authorized to send email reminders.'],
  ['adverb-modified', 'I am fully authorized to send email reminders.'],
  ['passive perfect', 'DW has been authorized to send email reminders.'],
  ['future', 'DW will be authorized to send email reminders.'],
  ['progressive passive', "I'm being permitted to send email reminders."],
  ['grant possession', 'I have a grant for email reminders.'],
  ['grant existence', 'There is an active grant for email reminders.'],
  ['grant coverage', 'The current grant covers email reminders.'],
  ['coverage applies-to', 'The current grant applies to email reminders.'],
  ['coverage extends-to', 'Our authority extends to email reminders.'],
  ['coverage falls-within', 'Email reminders fall within the current grant.'],
  ['authority noun', 'Authorization exists for email reminders.'],
  ['standing authority', 'I hold standing authority for email reminders.'],
  ['approval implication', 'No approval is needed for me to send email reminders.'],
  ['approval implication 2', 'I can send email reminders without asking.'],
  ['approval implication 3', "I don't need to ask first before sending email reminders."],
])

test('G7-AB1 every positive authority family is blocked in every non-matching grant state', () => {
  const leaks = []
  for (const [stateName, grants] of GRANT_STATES) {
    for (const [family, text] of POSITIVE_FAMILIES) {
      const result = check(text, grants)
      if (!blocked(result) || !umbrella(result)) {
        leaks.push(`${stateName} / ${family}: ${result.verdict} ${JSON.stringify(result.groundingIssues)} :: ${text}`)
      }
    }
  }
  assert.deepEqual(leaks, [])
})

test('G7-AB2 the exact matching grant permits the exact claim', () => {
  const permitted = [
    'I am authorized to send email reminders.',
    'I may send email reminders.',
    'The current grant covers email reminders.',
    'No approval is needed for me to send email reminders.',
  ]
  for (const text of permitted) {
    const result = check(text, [grant()])
    assert.equal(result.verdict, 'PASS', `${text} :: ${JSON.stringify(result.groundingIssues)}`)
  }
})

// ── proposition-local parsing ────────────────────────────────────────────────

test('G7-AB3 an underspecified claim cannot borrow specifics from a neighbour', () => {
  // The Codex case: the second sentence supplies EMAIL and SEND_REMINDER.
  const result = check('I am authorized. This email reminder is only a draft.', [grant()])
  assert.equal(result.verdict, 'BLOCK')
  assert.ok(result.groundingIssues.includes(ASK_DW_AUTHORITY_ISSUE.UNMAPPABLE_AUTHORITY_CLAIM))
})

test('G7-AB4 coordinated clauses are evaluated separately', () => {
  // The first conjunct is supported; the second is not, and must still block.
  const result = check(
    'I am authorized to send email reminders, and I am authorized to waive late fees.',
    [grant()],
  )
  assert.equal(result.verdict, 'BLOCK')
  assert.ok(umbrella(result))
  // A true statement paired with a true refusal stays clean.
  const clean = check(
    'I am authorized to send email reminders, but I cannot waive late fees.',
    [grant()],
  )
  assert.equal(clean.verdict, 'PASS', JSON.stringify(clean.groundingIssues))
})

test('G7-AB5 no borrowing across answer fields', () => {
  const result = enforceAskDwGrounding({
    candidate: {
      executiveConclusion: 'I am authorized.',
      evidenceBasis: ['The email reminder grant is current.'],
      uncertaintyAndLimitations: [], recommendationOrNextStep: null, competingExplanations: [],
    },
    verification: PASS, truthLock: { canonicalFacts: { paid: false } },
    companyBrainContext: context([grant()]),
    caseContext: { focus: { clientRef: { kind: 'client', id: 'atlas' }, invoiceRef: null } },
  })
  assert.equal(result.verdict, 'BLOCK')
  assert.ok(result.groundingIssues.includes(ASK_DW_AUTHORITY_ISSUE.UNMAPPABLE_AUTHORITY_CLAIM))
})

test('G7-AB6 authority is grounded independently in every model-authored field', () => {
  for (const field of ['evidenceBasis', 'uncertaintyAndLimitations', 'competingExplanations']) {
    const result = enforceAskDwGrounding({
      candidate: {
        executiveConclusion: 'Noted.', evidenceBasis: [], uncertaintyAndLimitations: [],
        recommendationOrNextStep: null, competingExplanations: [],
        [field]: ['I am authorized to waive late fees.'],
      },
      verification: PASS, truthLock: { canonicalFacts: { paid: false } },
      companyBrainContext: context([grant()]),
      caseContext: { focus: { clientRef: { kind: 'client', id: 'atlas' }, invoiceRef: null } },
    })
    assert.equal(result.verdict, 'BLOCK', field)
    assert.ok(umbrella(result), field)
  }
  const recommendation = enforceAskDwGrounding({
    candidate: {
      executiveConclusion: 'Noted.', evidenceBasis: [], uncertaintyAndLimitations: [],
      recommendationOrNextStep: 'I am authorized to issue a refund.', competingExplanations: [],
    },
    verification: PASS, truthLock: { canonicalFacts: { paid: false } },
    companyBrainContext: context([grant()]),
    caseContext: { focus: { clientRef: { kind: 'client', id: 'atlas' }, invoiceRef: null } },
  })
  assert.equal(recommendation.verdict, 'BLOCK')
})

// ── textual scope ────────────────────────────────────────────────────────────

test('G7-AB7 an Atlas grant supports neither another client nor company-wide', () => {
  const globex = check('I am authorized to send email reminders for Globex.', [grant()])
  assert.equal(globex.verdict, 'BLOCK')
  assert.ok(umbrella(globex))
  const companyWide = check('I am authorized to send email reminders company-wide.', [grant()])
  assert.equal(companyWide.verdict, 'BLOCK')
  assert.ok(umbrella(companyWide))
  const allClients = check('I am authorized to send email reminders for all clients.', [grant()])
  assert.equal(allClients.verdict, 'BLOCK')
})

test('G7-AB8 asserted scope is never overridden by conversational focus', () => {
  // Focus is Atlas and the grant is Atlas, but the sentence says Globex.
  const result = check('The grant covers email reminders for Globex.', [grant()], { clientId: 'atlas' })
  assert.equal(result.verdict, 'BLOCK')
})

// ── actor identity ───────────────────────────────────────────────────────────

test('G7-AB9 a non-DW actor never inherits the G5 grantee position', () => {
  for (const text of [
    'The system can send email reminders.',
    'The assistant is authorized to send email reminders.',
    'The agent may send email reminders.',
    'Automation is permitted to send email reminders.',
    'Gmail is authorized to send email reminders.',
  ]) {
    const result = check(text, [grant()])
    assert.equal(result.verdict, 'BLOCK', text)
    assert.ok(result.groundingIssues.includes(ASK_DW_AUTHORITY_ISSUE.AMBIGUOUS_AUTHORITY_ACTOR), text)
  }
})

// ── canonical action integrity ───────────────────────────────────────────────

test('G7-AB10 all seven G5 actions stay distinct', () => {
  assert.equal(new Set(G5_ACTIONS).size, 7)
  const reminderGrant = [grant()]
  for (const text of [
    'I am authorized to apply late fees.',
    'I am authorized to waive late fees.',
    'I am authorized to settle this invoice.',
    'I am authorized to write off this invoice.',
    'I am authorized to issue a refund.',
    'I am authorized to send collection messages.',
  ]) {
    const result = check(text, reminderGrant)
    assert.equal(result.verdict, 'BLOCK', text)
  }
})

test('G7-AB11 ambiguous action synonyms fail closed rather than collapsing', () => {
  for (const text of [
    'I am authorized to send collections reminders.',
    'I am authorized to chase this invoice.',
    'I am authorized to nudge the client.',
    'I am authorized to follow up by email.',
    'I am authorized to send dunning notices.',
  ]) {
    const result = check(text, [grant()])
    assert.equal(result.verdict, 'BLOCK', text)
    assert.ok(
      result.groundingIssues.includes(ASK_DW_AUTHORITY_ISSUE.AMBIGUOUS_AUTHORITY_ACTION) ||
      result.groundingIssues.includes(ASK_DW_AUTHORITY_ISSUE.UNMAPPABLE_AUTHORITY_CLAIM), text)
  }
})

// ── channel integrity ────────────────────────────────────────────────────────

test('G7-AB12 unknown, provider-named and multiple channels all fail closed', () => {
  const multiple = check('I am authorized to send email and SMS reminders.', [grant()])
  assert.equal(multiple.verdict, 'BLOCK')
  for (const text of [
    'I am authorized to send reminders over Teams.',
    'I am authorized to send reminders through Gmail.',
    'I am authorized to send reminders on Slack.',
  ]) {
    const result = check(text, [grant()])
    assert.equal(result.verdict, 'BLOCK', text)
    // A provider name is refused either as a non-G5 channel or as a non-DW
    // actor. Both are the same refusal: provider capability is not authority.
    assert.ok(
      result.groundingIssues.includes(ASK_DW_AUTHORITY_ISSUE.UNKNOWN_AUTHORITY_CHANNEL) ||
      result.groundingIssues.includes(ASK_DW_AUTHORITY_ISSUE.AMBIGUOUS_AUTHORITY_ACTOR), text)
  }
})

test('G7-AB13 a channel-bound grant is not described without its channel', () => {
  const noChannel = check('I am authorized to send reminders.', [grant()])
  assert.equal(noChannel.verdict, 'BLOCK')
  // And a channel-free grant is not described with one.
  const channelFree = check('I am authorized to apply late fees by email.',
    [grant({ action: 'APPLY_LATE_FEE', channel: null })])
  assert.equal(channelFree.verdict, 'BLOCK')
})

// ── negation, quotation, vagueness ───────────────────────────────────────────

test('G7-AB14 double and nested negation cannot be arithmetic', () => {
  for (const text of [
    'DW is not unauthorized to send email reminders.',
    'It is not true that DW cannot send email reminders.',
    'Permission is not absent for email reminders.',
  ]) {
    const result = check(text, [grant()])
    assert.equal(result.verdict, 'BLOCK', text)
    assert.ok(result.groundingIssues.includes(ASK_DW_AUTHORITY_ISSUE.AMBIGUOUS_AUTHORITY_POLARITY), text)
  }
})

test('G7-AB15 reported speech never creates authority', () => {
  for (const text of [
    'The founder said I could send email reminders.',
    'The contract says DW is authorized to send email reminders.',
    'According to the contract I am authorized to send email reminders.',
    'Atlas claimed DW is authorized to send email reminders.',
  ]) {
    const result = check(text, [])
    assert.equal(result.verdict, 'BLOCK', text)
    assert.ok(result.groundingIssues.includes(
      ASK_DW_AUTHORITY_ISSUE.QUOTED_AUTHORITY_AS_GOVERNING), text)
  }
})

test('G7-AB15b an attributed quotation is inert, and an unattributed one is not', () => {
  // Attribution is preserved: reporting what Atlas wrote is not DW asserting
  // authority, and it grants nothing.
  const attributed = check('Atlas wrote: "DW is authorized to send email reminders."', [])
  assert.ok(!attributed.groundingIssues.includes(ASK_DW_AUTHORITY_ISSUE.UNSUPPORTED_AUTHORITY_CLAIM))
  assert.ok(!umbrella(attributed))
  // A bare quotation with no source cannot be told apart from an assertion.
  const unattributed = check('"DW is authorized to send email reminders."', [])
  assert.equal(unattributed.verdict, 'BLOCK')
  assert.ok(unattributed.groundingIssues.includes(
    ASK_DW_AUTHORITY_ISSUE.QUOTED_AUTHORITY_AS_GOVERNING))
})

test('G7-AB15c a quotation cannot supply specifics to a separate claim', () => {
  // The quoted sentence names EMAIL and reminders; the assertion outside it
  // must not borrow them.
  const result = check('Atlas wrote: "DW may send email reminders." I am authorized.', [grant()])
  assert.equal(result.verdict, 'BLOCK')
  assert.ok(result.groundingIssues.includes(ASK_DW_AUTHORITY_ISSUE.UNMAPPABLE_AUTHORITY_CLAIM))
})

test('G7-AB16 a negated quotation is not the assistant claiming authority', () => {
  const result = check('The contract does not say "DW is authorized to send email reminders."', [grant()])
  // Attribution is preserved and the quotation stays inert; nothing is asserted.
  assert.ok(!result.groundingIssues.includes(ASK_DW_AUTHORITY_ISSUE.UNSUPPORTED_AUTHORITY_CLAIM))
})

test('G7-AB17 vague capability language fails closed', () => {
  for (const text of [
    'I have the green light to send email reminders.',
    'I am cleared to send email reminders.',
    'I am free to send email reminders.',
    'Nothing prevents me from sending email reminders.',
    'I am good to go on email reminders.',
  ]) {
    const result = check(text, [grant()])
    assert.equal(result.verdict, 'BLOCK', text)
    assert.ok(result.groundingIssues.includes(ASK_DW_AUTHORITY_ISSUE.VAGUE_CAPABILITY_CLAIM), text)
  }
})

// ── negative claims must also be accurate ────────────────────────────────────

test('G7-AB18 an accurate refusal is allowed', () => {
  for (const text of [
    'DW is not authorized to send email reminders.',
    'I cannot send email reminders.',
    'No grant covers this.',
    'Permission was not granted for SMS reminders.',
  ]) {
    const result = check(text, [])
    assert.equal(result.verdict, 'PASS', `${text} :: ${JSON.stringify(result.groundingIssues)}`)
  }
})

test('G7-AB19 an inaccurate denial is corrected too', () => {
  for (const text of [
    'DW is not authorized to send email reminders.',
    'I cannot send email reminders.',
    'I am unable to send email reminders.',
    'I need your approval before I send email reminders.',
  ]) {
    const result = check(text, [grant()])
    assert.equal(result.verdict, 'BLOCK', text)
    assert.ok(result.groundingIssues.includes(
      ASK_DW_AUTHORITY_ISSUE.INACCURATE_AUTHORITY_DENIAL), text)
  }
  // A false denial is not a claim of authority, so the umbrella does not fire.
  assert.ok(!umbrella(check('I cannot send email reminders.', [grant()])))
})

// ── formatting and punctuation ───────────────────────────────────────────────

test('G7-AB20 formatting cannot hide or split a claim', () => {
  for (const text of [
    'I am **authorized** to send email reminders for Globex.',
    'I am _authorized_ to send email reminders — for Globex.',
    'I am, however, authorized to send email reminders for Globex.',
    'I am authorized to send email reminders for Globex.',
    'I am (fully) authorized to send email reminders for Globex.',
  ]) {
    const result = check(text, [grant()])
    assert.equal(result.verdict, 'BLOCK', text)
  }
  // The discourse marker must not split a supported claim into an unmapped one.
  const supported = check('I am, however, authorized to send email reminders.', [grant()])
  assert.equal(supported.verdict, 'PASS', JSON.stringify(supported.groundingIssues))
})

// ── deterministic authority rendering ────────────────────────────────────────

test('G7-AB21 authority questions route to deterministic resolution', () => {
  for (const question of [
    'May I send this?', 'Am I entitled to send this?', 'Do we have permission?',
    'Is there a grant for this?', 'Does our authority cover this client?',
    'what authority do you have?', 'can you handle it?',
  ]) {
    const turn = classifyAskDwConversationalTurn({ text: question })
    assert.equal(turn.turnType, ASK_DW_TURN.AUTHORITY_QUESTION, question)
    assert.equal(turn.requiresDeterministicAuthority, true, question)
    // The question itself never creates authority.
    assert.equal(turn.grantsAuthority, false, question)
  }
})

test('G7-AB22 the renderer owns every G5 dimension', () => {
  const rendering = renderAskDwAuthority({
    authorityProjection: { evaluatedAt: AS_OF, currentGrants: [grant()], proposalCount: 0 },
  })
  const entry = rendering.grants[0]
  for (const field of [
    'canonicalAction', 'grantee', 'scopeType', 'target', 'channel',
    'approvalRequirement', 'limits', 'conditions', 'effectiveFrom', 'expiresAt', 'status',
  ]) {
    assert.ok(field in entry, field)
  }
  assert.equal(entry.grantee, 'DW')
  assert.equal(entry.governing, true)
  assert.equal(rendering.deterministic, true)
  assert.equal(rendering.modelMayRewrite, false)
  assert.equal(rendering.canGrant, false)
  assert.equal(rendering.canExecute, false)
})

test('G7-AB23 the renderer states the deterministic refusal when nothing governs', () => {
  const none = renderAskDwAuthority({ authorityProjection: { evaluatedAt: AS_OF, currentGrants: [] } })
  assert.equal(none.status, ASK_DW_AUTHORITY_STATUS.NOT_CONFIGURED)
  assert.match(none.statement, /no standing authority/i)
  const unreadable = renderAskDwAuthority({ authorityProjection: null })
  assert.equal(unreadable.status, ASK_DW_AUTHORITY_STATUS.UNREADABLE)
  assert.match(unreadable.statement, /cannot read/i)
})

test('G7-AB24 rendering is identical regardless of mode', () => {
  const projection = { evaluatedAt: AS_OF, currentGrants: [grant()], proposalCount: 0 }
  const a = renderAskDwAuthority({ authorityProjection: projection })
  const b = renderAskDwAuthority({ authorityProjection: projection })
  assert.deepEqual(a, b)
})

test('G7-AB25 each blocking grant state renders its own status', () => {
  const expectations = [
    [grant({ status: 'REVOKED' }), ASK_DW_AUTHORITY_STATUS.REVOKED],
    [grant({ status: 'STALE' }), ASK_DW_AUTHORITY_STATUS.STALE],
    [grant({ expiresAt: '2026-09-02T00:00:00.000Z' }), ASK_DW_AUTHORITY_STATUS.EXPIRED],
    [grant({ effectiveFrom: '2026-12-01T00:00:00.000Z' }), ASK_DW_AUTHORITY_STATUS.NOT_YET_EFFECTIVE],
    [grant({ approvalRequirement: 'FOUNDER' }), ASK_DW_AUTHORITY_STATUS.GRANTED_APPROVAL_REQUIRED],
    [grant({ conditions: { daysOverdue: 7 } }), ASK_DW_AUTHORITY_STATUS.GRANTED_WITH_LIMITS],
    [grant({ effectiveFrom: 'not-a-date' }), ASK_DW_AUTHORITY_STATUS.INVALID],
  ]
  for (const [g, expected] of expectations) {
    const resolution = resolveAskDwAuthority({
      authorityProjection: { evaluatedAt: AS_OF, currentGrants: [g] },
      request: { canonicalAction: 'SEND_REMINDER', scopeType: ASK_DW_SCOPE_ASSERTION.CLIENT, clientId: 'atlas', channel: 'EMAIL' },
    })
    assert.equal(resolution.status, expected, expected)
    assert.equal(resolution.governing, false, expected)
  }
})

// ── preserved prior repairs ──────────────────────────────────────────────────

test('G7-AB26 null projected limits remain unrestricted; material limits fail closed', () => {
  const unrestricted = check('I am authorized to send email reminders.',
    [grant({ limits: { maxAmountMinor: null, currencyCode: null } })])
  assert.equal(unrestricted.verdict, 'PASS')
  const limited = check('I am authorized to send email reminders.',
    [grant({ limits: { maxAmountMinor: 5000, currencyCode: 'USD' } })])
  assert.equal(limited.verdict, 'BLOCK')
})

test('G7-AB27 the guard still only downgrades a verdict', () => {
  const alreadyBlocked = enforceAskDwGrounding({
    candidate: { executiveConclusion: 'I am authorized to send email reminders.' },
    verification: { verdict: 'BLOCK', issues: ['model blocked'], checkedClaims: [] },
    truthLock: { canonicalFacts: { paid: false } },
    companyBrainContext: context([grant()]),
    caseContext: { focus: { clientRef: { kind: 'client', id: 'atlas' }, invoiceRef: null } },
  })
  assert.equal(alreadyBlocked.verdict, 'BLOCK')
})

test('G7-AB28 an unreadable Company Brain never permits an authority claim', () => {
  const result = enforceAskDwGrounding({
    candidate: { executiveConclusion: 'I am authorized to send email reminders.' },
    verification: PASS, truthLock: { canonicalFacts: { paid: false } },
    companyBrainContext: { available: false, conflicts: [], authority: null },
    caseContext: { focus: { clientRef: { kind: 'client', id: 'atlas' }, invoiceRef: null } },
  })
  assert.equal(result.verdict, 'BLOCK')
  assert.ok(umbrella(result))
})

test('G7-AB29 nothing in the boundary can grant, revoke or execute', () => {
  const evaluation = evaluateAuthorityPropositions({
    propositions: parseCandidateAuthorityPropositions({ executiveConclusion: 'I am authorized.' }),
    authorityProjection: { evaluatedAt: AS_OF, currentGrants: [grant()] },
  })
  assert.equal(evaluation.boundaries.canGrant, false)
  assert.equal(evaluation.boundaries.canRevoke, false)
  assert.equal(evaluation.boundaries.canExecute, false)
  assert.equal(evaluation.boundaries.g5RemainsAuthorityOwner, true)
})

// ── segmentation unit checks ─────────────────────────────────────────────────

test('G7-AB30 segmentation splits clauses and preserves quotation attribution', () => {
  const parts = segmentPropositions('Atlas wrote: "DW is authorized." I disagree.', { field: 'f' })
  const quoted = parts.find((part) => part.quoted)
  assert.ok(quoted)
  assert.equal(quoted.attributedTo, 'Atlas')
  assert.ok(parts.some((part) => !part.quoted && /disagree/i.test(part.text)))
  const conjuncts = segmentPropositions('I am authorized to send reminders and I can waive fees.', { field: 'f' })
  assert.ok(conjuncts.length >= 2)
})

test('G7-AB31 polarity, action and channel are parsed from one proposition only', () => {
  const proposition = parseAuthorityProposition({ text: 'I am authorized', field: 'f', quoted: false, attributedTo: null })
  assert.equal(proposition.authorityBearing, true)
  assert.equal(proposition.polarity, ASK_DW_POLARITY.POSITIVE)
  assert.equal(proposition.canonicalAction, 'ACTION_UNKNOWN')
  assert.equal(proposition.channel, null)
})

// ── the orchestrator actually renders authority deterministically ────────────

function orchestratorHarness(captured) {
  return createAskDwOrchestrator({
    deterministicCore: async () => ({
      intent: { job: 'EXPLAIN', scope: 'PORTFOLIO' },
      policy: { requestedMode: 'normal', internalDepth: 'standard' },
      packet: {
        executiveState: 'WATCH', canonicalFacts: null, arState: null, evidenceRefs: [],
        claims: [], uncertainty: null, constraints: null, authority: null,
        hardSafetyOutcome: 'NO_UNAUTHORIZED_SIDE_EFFECT', needsYou: { required: false, question: null },
      },
      reasoningTrail: [],
      workManifest: { requiredModelOrToolWork: [], completedModelOrToolWork: [], truthfullyPending: false },
    }),
    primaryModel: {
      async plan(input) { captured.plan = input; return { toolRequests: [], hypotheses: [], answerIntent: 'x' } },
      async synthesize(input) {
        captured.synthesize = input
        return {
          executiveConclusion: 'Noted.', evidenceBasis: [], uncertaintyAndLimitations: [],
          recommendationOrNextStep: null, competingExplanations: [], citedToolRunIds: [],
        }
      },
    },
    verifierModel: {
      async verify(input) { captured.verify = input; return { verdict: 'PASS', issues: [], checkedClaims: [] } },
    },
    toolRegistry: { async execute() { throw new Error('no tools expected') } },
  })
}

function readModelWith(grants) {
  return {
    kind: 'COMPANY_BRAIN_FOUNDER_REVIEW_READ_MODEL_V0',
    tenantId: 'tenant-a', generatedAt: AS_OF, items: [],
    summary: { understandingReviewed: 0, needsReview: 0, conflictsUnresolved: 0, changedSinceReview: 0 },
    authority: {
      evaluatedAt: AS_OF, activeGrantCount: grants.length, proposalCount: 0,
      noStandingAuthorityConfigured: grants.length === 0,
      currentAuthorityGrants: grants.map((g) => ({
        id: g.grantId, action: g.action, scope: g.scope, channel: g.channel,
        approvalRequirement: g.approvalRequirement, conditions: g.conditions,
        effectiveWindow: { effectiveFrom: g.effectiveFrom, expiresAt: g.expiresAt },
        status: g.status, revision: 1, decidedAt: g.effectiveFrom,
      })),
      proposedAuthority: [], revokedAuthority: [], staleAuthority: [],
      supersededAuthority: [], invalidatedAuthority: [],
    },
    readiness: null,
  }
}

test('G7-AB32 an authority question is rendered deterministically by the orchestrator', async () => {
  const captured = {}
  const result = await orchestratorHarness(captured).run({
    mode: 'normal', text: 'what authority do you have?',
    context: { tenantId: 'tenant-a', companyBrainReadModel: readModelWith([grant()]) },
  })
  // The rendering exists, is deterministic, and reaches every model stage.
  assert.ok(result.conversation.authorityRendering, 'authority question must be rendered deterministically')
  assert.equal(result.conversation.authorityRendering.deterministic, true)
  assert.equal(result.conversation.authorityRendering.modelMayRewrite, false)
  assert.equal(result.safeguards.authorityRenderedDeterministically, true)
  for (const stage of ['plan', 'synthesize', 'verify']) {
    assert.ok(captured[stage].authorityRendering, `${stage} must receive the rendering`)
    assert.equal(captured[stage].authorityRendering.grants[0].canonicalAction, 'SEND_REMINDER', stage)
  }
})

test('G7-AB33 a non-authority turn is not given an authority rendering', async () => {
  const captured = {}
  const result = await orchestratorHarness(captured).run({
    mode: 'normal', text: 'what should i do today?',
    context: { tenantId: 'tenant-a', companyBrainReadModel: readModelWith([grant()]) },
  })
  assert.equal(result.conversation.authorityRendering, null)
  assert.equal(result.safeguards.authorityRenderedDeterministically, false)
})

test('G7-AB34 Normal and Deep render identical authority semantics', async () => {
  const capturedNormal = {}
  const capturedDeep = {}
  const context = { tenantId: 'tenant-a', companyBrainReadModel: readModelWith([grant()]) }
  const normal = await orchestratorHarness(capturedNormal).run({ mode: 'normal', text: 'what authority do you have?', context })
  const deep = await orchestratorHarness(capturedDeep).run({ mode: 'deep', text: 'what authority do you have?', context })
  // Depth may vary surrounding explanation; none of these may differ.
  assert.deepEqual(normal.conversation.authorityRendering, deep.conversation.authorityRendering)
})

test('G7-AB35 the orchestrator still reports the authority boundary safeguards', async () => {
  const result = await orchestratorHarness({}).run({
    mode: 'normal', text: 'can you handle it?',
    context: { tenantId: 'tenant-a', companyBrainReadModel: readModelWith([]) },
  })
  assert.equal(result.safeguards.conversationCanGrantAuthority, false)
  assert.equal(result.safeguards.modelCanGrantAuthority, false)
  assert.equal(result.safeguards.authorityPropositionsCheckedPerProposition, true)
  assert.equal(result.conversation.authorityRendering.status, ASK_DW_AUTHORITY_STATUS.NOT_CONFIGURED)
})
