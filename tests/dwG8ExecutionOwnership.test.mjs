/**
 * G8-CP3 — who owns a completed-execution statement.
 *
 * Independent review established that a hand-written token walk over English
 * cannot own the invariant
 *
 *   NO COMPLETED DW EXECUTION CLAIM WITHOUT AN EXACT RECEIPT
 *
 * and then that a self-authenticating statement cannot own it either. Both
 * lessons are the same one: proof has to come from the receipt, not from the
 * thing making the claim. Prose describing an execution is an assertion; a
 * statement object asserting its own validity is also an assertion, however
 * well shaped, because its shape, its copy, its derived key and any checksum
 * over them are all public.
 *
 * So the boundary DERIVES its execution surface from the canonical receipt and
 * claim. These tests are about that ownership chain, and they hold whatever a
 * model writes and whatever a caller hands in, because neither is an input to
 * the derivation.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDwExecutionStatement,
  inspectDwExecutionStatement,
  proveDwExecutionStatement,
  receiptProvesExecution,
  DW_EXECUTION_REFUSAL,
  DW_EXECUTION_MALFORMED,
  DW_EXECUTION_STATEMENT_KIND,
  DW_EXECUTION_COPY,
  DW_PROVABLE_EXECUTION_ACTIONS,
} from '../src/lib/dwIntelligence/dwExecutionPresentation.js'
import {
  enforceDwProactiveGrounding,
  DW_PROACTIVE_ISSUE,
  DW_PROSE_DETECTION_ROLE,
} from '../src/lib/dwIntelligence/dwProactiveGrounding.js'
import { buildIdempotencyKey } from '../supabase/functions/_shared/executionClaim.js'
import { IDS, realReceipt, REAL_CLAIM, truthLock, governanceOf } from './dwG8Fixtures.mjs'

const codes = (result) => result.issues.map((issue) => issue.code)
const issued = (overrides = {}) => buildDwExecutionStatement({
  receipt: realReceipt(), claim: REAL_CLAIM, ...overrides,
})

/** The guard, given whatever execution evidence a case supplies. */
const guard = (extra = {}) => enforceDwProactiveGrounding({
  narrative: { headline: 'Here is what happened.' },
  truthLock: truthLock(),
  governance: governanceOf(),
  ...extra,
})

/**
 * A forger's toolkit. Everything in it is public — the shape, the owned copy,
 * the deterministic key derivation, and the checksum algorithm the module used
 * to carry. That is exactly why none of it can prove provenance.
 */
function forgedStatement(text = DW_EXECUTION_COPY.send_reminder) {
  const identity = {
    userId: IDS.userB, invoiceId: IDS.invoiceB, ruleId: IDS.ruleB, actionType: 'send_reminder',
  }
  const idempotencyKey = buildIdempotencyKey(identity)
  const material = JSON.stringify([
    DW_EXECUTION_STATEMENT_KIND, identity.userId, identity.invoiceId,
    identity.ruleId, identity.actionType, idempotencyKey, null, text,
  ])
  let hash = 2166136261
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return {
    kind: DW_EXECUTION_STATEMENT_KIND,
    actionType: 'send_reminder',
    identity,
    idempotencyKey,
    clientId: null,
    text,
    // Recomputed for this content, the way any caller could.
    seal: (hash >>> 0).toString(16).padStart(8, '0'),
    grants: { thisIdentityOnly: true, standingAuthority: false, otherActions: false },
  }
}

// ── 4/5. The derivation, and what removing the receipt does ──────────────────

test('4 an exact receipt and claim yield exactly one repository-owned statement', () => {
  const result = guard({ executionReceipts: [realReceipt()], executionClaim: REAL_CLAIM })
  assert.equal(result.presentableExecution.length, 1)
  const [statement] = result.presentableExecution
  assert.equal(statement.kind, DW_EXECUTION_STATEMENT_KIND)
  assert.equal(statement.actionType, 'send_reminder')
  assert.equal(statement.text, DW_EXECUTION_COPY.send_reminder)
  assert.deepEqual(statement.identity, {
    userId: IDS.userA, invoiceId: IDS.invoiceA, ruleId: IDS.ruleA, actionType: 'send_reminder',
  })
  assert.equal(result.boundaries.executionStatementOwner, 'RECEIPT')
  assert.equal(result.boundaries.executionDerivedAtThisBoundary, true)
  assert.equal(result.boundaries.callerStatementsTrusted, false)
})

test('5 removing the receipt removes the ability to state completed execution', () => {
  for (const executionReceipts of [[], null, undefined]) {
    const result = guard({ executionReceipts, executionClaim: REAL_CLAIM })
    assert.deepEqual(result.presentableExecution, [])
  }
  // And removing the claim does too: there is nothing to prove against.
  assert.deepEqual(guard({ executionReceipts: [realReceipt()] }).presentableExecution, [])
})

// ── 6-11. Every canonical identity component is load-bearing ─────────────────

test('6-11 a receipt failing any canonical check yields zero presentable statements', () => {
  const cases = [
    ['wrong tenant', { userId: IDS.userB }],
    ['wrong invoice', { invoiceId: IDS.invoiceB }],
    ['wrong rule', { ruleId: IDS.ruleB }],
    ['wrong action', { actionType: 'issue_refund' }],
    ['wrong idempotency key', { idempotencyKey: 'forged' }],
    ['empty idempotency key', { idempotencyKey: '' }],
    ['null idempotency key', { idempotencyKey: null }],
    ['non-terminal status', { status: 'in_flight' }],
    ['failed status', { status: 'send_failed' }],
    ['uncertain status', { status: 'uncertain' }],
    ['invented status', { status: 'succeeded' }],
  ]
  for (const [label, corruption] of cases) {
    const result = guard({
      executionReceipts: [realReceipt(corruption)], executionClaim: REAL_CLAIM,
    })
    assert.deepEqual(result.presentableExecution, [], label)
  }
})

test('11 an action with no canonical execution contract is never presentable', () => {
  const result = guard({
    executionReceipts: [realReceipt({ actionType: 'issue_refund' })],
    executionClaim: { ...REAL_CLAIM, action: 'issue_refund' },
  })
  assert.deepEqual(result.presentableExecution, [])
  const direct = buildDwExecutionStatement({
    receipt: realReceipt({ actionType: 'issue_refund' }),
    claim: { ...REAL_CLAIM, action: 'issue_refund' },
  })
  assert.equal(direct.refusal, DW_EXECUTION_REFUSAL.ACTION_NOT_PROVABLE)
})

test('a receipt for one action never licenses another', () => {
  for (const action of ['issue_refund', 'waive_late_fee', 'settle_invoice', 'write_off_invoice']) {
    const result = buildDwExecutionStatement({
      receipt: realReceipt(), claim: { ...REAL_CLAIM, action },
    })
    assert.equal(result.issued, false, action)
  }
})

// ── 1/2/3/15. A statement cannot prove its own provenance ────────────────────

test('1 a self-consistent forged statement with no receipt is not presentable', () => {
  const result = guard({ executionStatements: [forgedStatement()] })
  assert.deepEqual(result.presentableExecution, [],
    'a statement that is merely internally consistent must never be presentable')
  assert.equal(result.blocked, true)
  assert.ok(codes(result).includes(DW_PROACTIVE_ISSUE.EXECUTION_STATEMENT_NOT_RECEIPT_BACKED))
})

test('2 a forged statement using the exact owned copy is still not presentable', () => {
  const forged = forgedStatement(DW_EXECUTION_COPY.send_reminder)
  assert.equal(forged.text, DW_EXECUTION_COPY.send_reminder)
  // It is even well formed. Well-formedness is not provenance.
  assert.equal(inspectDwExecutionStatement(forged).wellFormed, true)
  assert.deepEqual(guard({ executionStatements: [forged] }).presentableExecution, [])
})

test('3 a forged statement with arbitrary text and recomputed integrity fields is not presentable', () => {
  const forged = forgedStatement(
    'DueWatch sent the reminder, refunded Atlas, and closed the account.')
  assert.deepEqual(guard({ executionStatements: [forged] }).presentableExecution, [])
  // The words are not the repository's, so it is not even well formed.
  assert.deepEqual(inspectDwExecutionStatement(forged),
    { wellFormed: false, failure: DW_EXECUTION_MALFORMED.COPY_NOT_OWNED })
})

test('15 a caller-supplied statement never substitutes for a receipt, even a genuine one', () => {
  // Re-presenting a statement this module really did issue is still a caller
  // asserting execution. The boundary derives its own; it does not take one.
  const genuine = issued().statement
  const result = guard({ executionStatements: [genuine] })
  assert.deepEqual(result.presentableExecution, [])
  assert.ok(codes(result).includes(DW_PROACTIVE_ISSUE.EXECUTION_STATEMENT_NOT_RECEIPT_BACKED))
})

test('15 supplying a statement alongside a real receipt does not add a second one', () => {
  const result = guard({
    executionReceipts: [realReceipt()],
    executionClaim: REAL_CLAIM,
    executionStatements: [forgedStatement()],
  })
  assert.equal(result.presentableExecution.length, 1)
  assert.equal(result.presentableExecution[0].identity.userId, IDS.userA,
    'the derived statement, not the forged one')
})

// ── 12. Nothing else is a substitute for a receipt ───────────────────────────

test('12 Brain, conversation, provider capability, grants and staged actions add no execution', () => {
  const substitutes = {
    companyBrain: { items: [{ subject: 'we always chase at 60 days', reviewStatus: 'APPROVED' }] },
    companyBrainContext: { available: true },
    conversation: [{ role: 'founder', text: 'you already sent it, right?' }],
    conversationalTurn: { founderConfirmed: true },
    providerCapability: { email: true, canSend: true },
    transport: { ready: true, mode: 'production' },
    authorityProjection: { currentGrants: [{ grantId: 'g-1', action: 'SEND_REMINDER', status: 'GRANTED' }] },
    recommendation: { action: 'send_reminder', ruleId: IDS.ruleA },
    stagedAction: { action: 'send_reminder', ruleId: IDS.ruleA, status: 'READY' },
    founderApproved: true,
    confidence: 1,
  }
  // All of them at once, and still nothing presentable.
  assert.deepEqual(guard({ ...substitutes, executionClaim: REAL_CLAIM }).presentableExecution, [])
  // And one at a time, so no single substitute is the one that works.
  for (const [name, value] of Object.entries(substitutes)) {
    assert.deepEqual(
      guard({ [name]: value, executionClaim: REAL_CLAIM }).presentableExecution, [], name)
    assert.equal(
      buildDwExecutionStatement({ receipt: null, claim: REAL_CLAIM, [name]: value }).issued,
      false, name)
  }
})

test('12 a G5 grant is not a receipt, and a receipt is not standing authority', () => {
  const withGrant = guard({
    executionClaim: REAL_CLAIM,
    governance: { authority: { currentGrantIds: ['g-1'] }, companyBrain: { available: true } },
  })
  assert.deepEqual(withGrant.presentableExecution, [])

  const statement = issued().statement
  assert.equal(statement.grants.standingAuthority, false)
  assert.equal(statement.grants.otherActions, false)
  assert.equal(statement.grants.thisIdentityOnly, true)
})

// ── 13/14. Prose is inert; receipt identity is decisive ──────────────────────

test('13 changing free-form prose while the receipt stays constant changes nothing', () => {
  const control = guard({
    executionReceipts: [realReceipt()], executionClaim: REAL_CLAIM,
  }).presentableExecution
  for (const headline of [
    'DW sent the reminder.',
    'DW refunded Atlas and closed the account.',
    'DW did send everything, urgently, and settled the invoice.',
    '',
  ]) {
    const result = enforceDwProactiveGrounding({
      narrative: { headline },
      truthLock: truthLock(),
      governance: governanceOf(),
      executionReceipts: [realReceipt()],
      executionClaim: REAL_CLAIM,
    })
    assert.deepEqual(result.presentableExecution, control, headline)
  }
})

test('14 changing receipt identity changes the outcome exactly per the canonical contract', () => {
  // A receipt for a different tenant, with a claim that matches it, is a
  // legitimate statement about THAT tenant — and never about this one.
  const otherClaim = {
    tenantId: IDS.userB, invoiceId: IDS.invoiceB, ruleId: IDS.ruleB, action: 'send_reminder',
  }
  const otherReceipt = realReceipt({
    userId: IDS.userB, invoiceId: IDS.invoiceB, ruleId: IDS.ruleB,
  })
  const matched = guard({ executionReceipts: [otherReceipt], executionClaim: otherClaim })
  assert.equal(matched.presentableExecution.length, 1)
  assert.equal(matched.presentableExecution[0].identity.userId, IDS.userB)

  // Crossed over, neither proves the other.
  assert.deepEqual(
    guard({ executionReceipts: [otherReceipt], executionClaim: REAL_CLAIM }).presentableExecution, [])
  assert.deepEqual(
    guard({ executionReceipts: [realReceipt()], executionClaim: otherClaim }).presentableExecution, [])
})

test('14 a pile of near-miss receipts never adds up to one genuine statement', () => {
  const nearMisses = [
    realReceipt({ userId: IDS.userB }), realReceipt({ invoiceId: IDS.invoiceB }),
    realReceipt({ ruleId: IDS.ruleB }), realReceipt({ status: 'in_flight' }),
    realReceipt({ idempotencyKey: 'forged' }),
  ]
  assert.deepEqual(
    guard({ executionReceipts: nearMisses, executionClaim: REAL_CLAIM }).presentableExecution, [])
})

// ── The honest provenance path, for a future consumer ────────────────────────

test('proveDwExecutionStatement demands the claim and the receipt, not the statement alone', () => {
  const statement = issued().statement
  // With everything: true.
  assert.equal(proveDwExecutionStatement({
    statement, claim: REAL_CLAIM, receipt: realReceipt(),
  }), true)
  // Without the receipt: false, however well formed the statement is.
  assert.equal(inspectDwExecutionStatement(statement).wellFormed, true)
  assert.equal(proveDwExecutionStatement({ statement, claim: REAL_CLAIM }), false)
  assert.equal(proveDwExecutionStatement({ statement }), false)
  // A forged statement with a real receipt for a DIFFERENT identity: false.
  assert.equal(proveDwExecutionStatement({
    statement: forgedStatement(), claim: REAL_CLAIM, receipt: realReceipt(),
  }), false)
})

test('well-formedness is documented and behaves as shape-only, never as proof', () => {
  // The forged statement is well formed and proves nothing. Both halves of
  // that sentence are asserted here so the distinction cannot quietly rot.
  const forged = forgedStatement()
  assert.equal(inspectDwExecutionStatement(forged).wellFormed, true)
  assert.equal(proveDwExecutionStatement({
    statement: forged, claim: REAL_CLAIM, receipt: realReceipt(),
  }), false)
})

test('each malformed-statement reason is reachable on its own', () => {
  const statement = issued().statement
  const cases = [
    [null, DW_EXECUTION_MALFORMED.NOT_A_STATEMENT],
    [{ ...statement, kind: 'SOMETHING_ELSE' }, DW_EXECUTION_MALFORMED.NOT_A_STATEMENT],
    [{ ...statement, actionType: 'issue_refund' }, DW_EXECUTION_MALFORMED.ACTION_NOT_PROVABLE],
    [{ ...statement, identity: { ...statement.identity, actionType: 'issue_refund' } },
      DW_EXECUTION_MALFORMED.IDENTITY_ACTION_MISMATCH],
    [{ ...statement, text: 'DW refunded Atlas.' }, DW_EXECUTION_MALFORMED.COPY_NOT_OWNED],
    [{ ...statement, grants: { thisIdentityOnly: true, standingAuthority: true, otherActions: false } },
      DW_EXECUTION_MALFORMED.GRANTS_OVERREACH],
    [{ ...statement, idempotencyKey: 'not-derived' }, DW_EXECUTION_MALFORMED.KEY_NOT_DERIVED],
  ]
  for (const [candidate, expected] of cases) {
    assert.deepEqual(inspectDwExecutionStatement(candidate),
      { wellFormed: false, failure: expected }, expected)
  }
})

// ── The builder's inputs, and the one verifier ───────────────────────────────

test('the builder is a pure function of receipt and claim', () => {
  assert.deepEqual(issued().statement, issued().statement)
  assert.deepEqual(Object.keys(issued().statement).sort(), [
    'actionType', 'clientId', 'grants', 'idempotencyKey', 'identity', 'kind', 'text',
  ], 'no self-authenticating field remains on a statement')
})

test('the words are the repository\'s even when the caller supplies their own', () => {
  // A caller naming `text` beside a genuine receipt must not get their sentence
  // issued under DueWatch's name.
  for (const noise of [
    { text: 'DueWatch sent the reminder, refunded Atlas, and closed the account.' },
    { statementText: 'DW waived the late fee.' },
    { narrative: { headline: 'DW refunded Atlas.' } },
    { modelOutput: 'DW settled everything.' },
  ]) {
    const result = buildDwExecutionStatement({
      receipt: realReceipt(), claim: REAL_CLAIM, ...noise,
    })
    assert.equal(result.issued, true)
    assert.equal(result.statement.text, DW_EXECUTION_COPY.send_reminder, JSON.stringify(noise))
  }
})

test('statement identity comes from the claim, never from the caller or the receipt', () => {
  const result = buildDwExecutionStatement({
    receipt: realReceipt(), claim: REAL_CLAIM,
    userId: IDS.userB, invoiceId: IDS.invoiceB, ruleId: IDS.ruleB,
    identity: { userId: IDS.userB, invoiceId: IDS.invoiceB, ruleId: IDS.ruleB, actionType: 'send_reminder' },
  })
  assert.deepEqual(result.statement.identity, {
    userId: IDS.userA, invoiceId: IDS.invoiceA, ruleId: IDS.ruleA, actionType: 'send_reminder',
  })
})

test('the copy table is repository-owned and closed to provable actions', () => {
  assert.deepEqual(Object.keys(DW_EXECUTION_COPY), [...DW_PROVABLE_EXECUTION_ACTIONS])
  for (const text of Object.values(DW_EXECUTION_COPY)) {
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 0)
  }
})

test('the verifier the builder uses is the one the guard uses — not a second copy', () => {
  assert.equal(receiptProvesExecution({
    receipts: [realReceipt()], claim: REAL_CLAIM, action: 'send_reminder',
  }), true)
  assert.equal(receiptProvesExecution({
    receipts: [realReceipt({ ruleId: IDS.ruleB })], claim: REAL_CLAIM, action: 'send_reminder',
  }), false)
})

// ── The prose detector, honestly labelled ────────────────────────────────────

test('the prose detector is declared defense-in-depth, not a parser', () => {
  assert.equal(DW_PROSE_DETECTION_ROLE, 'DEFENSE_IN_DEPTH')
})

test('the prose detector has known blind spots, and the invariant survives them', () => {
  // The reviewer's counterexamples: sentences a token walk gets wrong in one
  // direction or the other. They are limits of a best-effort layer, not the
  // boundary, and nothing presentable follows from any of them.
  const blindSpots = [
    'DW did send the reminder.',
    'DW did email Atlas.',
    'DW did contact Atlas.',
    'DW was ready and sent the reminder.',
    'DW did not call but emailed Atlas.',
    'DW was contacted earlier, then emailed Atlas.',
    'We confirmed accounting emailed us.',
    'We heard customers contacted support.',
    'DW learned support emailed the customer.',
    'I heard billing called Atlas.',
    'DW got contacted by Atlas.',
  ]
  for (const headline of blindSpots) {
    const result = enforceDwProactiveGrounding({
      narrative: { headline }, truthLock: truthLock(), governance: governanceOf(),
    })
    assert.deepEqual(result.presentableExecution, [], headline)
    assert.equal(result.boundaries.narrativeMayStateExecution, false, headline)
  }
})
