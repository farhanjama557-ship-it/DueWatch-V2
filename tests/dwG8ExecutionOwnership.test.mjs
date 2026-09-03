/**
 * G8-CP3 — who owns a completed-execution statement.
 *
 * Independent review established that a hand-written token walk over English
 * cannot own the invariant
 *
 *   NO COMPLETED DW EXECUTION CLAIM WITHOUT AN EXACT RECEIPT
 *
 * and it is right. Subject nouns are an open class; past meaning does not
 * require a past-form verb ("DW did send"); negation, passive and coordination
 * scope are grammatical relations, not adjacency. This repository contains no
 * English parser — only pgsql-parser, for SQL — so every additional rule would
 * be one more approximation guarding a security boundary.
 *
 * So prose no longer owns the boundary. A completed-execution statement is
 * produced by a deterministic, repository-owned builder from an exact receipt,
 * and by nothing else. These tests are about that ownership, and they are the
 * CP3 tests that matter: they hold whatever a model writes, because what a
 * model writes is not an input to the builder at all.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDwExecutionStatement,
  verifyDwExecutionStatement,
  DW_EXECUTION_REFUSAL,
  DW_EXECUTION_STATEMENT_KIND,
  DW_EXECUTION_COPY,
  DW_EXECUTION_VERIFY_FAILURE,
  inspectDwExecutionStatement,
  receiptProvesExecution,
  DW_PROVABLE_EXECUTION_ACTIONS,
} from '../src/lib/dwIntelligence/dwExecutionPresentation.js'
import {
  enforceDwProactiveGrounding,
  DW_PROACTIVE_ISSUE,
  DW_PROSE_DETECTION_ROLE,
} from '../src/lib/dwIntelligence/dwProactiveGrounding.js'

import { IDS, realReceipt, REAL_CLAIM, truthLock, governanceOf } from './dwG8Fixtures.mjs'

const codes = (result) => result.issues.map((issue) => issue.code)
const issued = (overrides = {}) => buildDwExecutionStatement({
  receipt: realReceipt(), claim: REAL_CLAIM, ...overrides,
})

// ── The positive path exists and is deterministic ────────────────────────────

test('a genuine receipt yields exactly one repository-owned statement', () => {
  const result = issued()
  assert.equal(result.issued, true, JSON.stringify(result))
  assert.equal(result.statement.kind, DW_EXECUTION_STATEMENT_KIND)
  assert.equal(result.statement.actionType, 'send_reminder')
  // The words are the repository's, not a model's.
  assert.equal(result.statement.text, DW_EXECUTION_COPY.send_reminder)
  assert.equal(verifyDwExecutionStatement(result.statement), true)
})

test('the builder is a pure function of the receipt — same input, same statement', () => {
  assert.deepEqual(issued().statement, issued().statement)
})

// ── 1. Free-form text cannot create a trusted execution statement ────────────

test('1 arbitrary prose is not an input to the builder and cannot produce a statement', () => {
  // Every parameter the builder accepts is typed. There is no text parameter,
  // so there is no sentence that produces a statement.
  assert.deepEqual(Object.keys(issued().statement).sort(), [
    'actionType', 'clientId', 'grants', 'idempotencyKey', 'identity', 'kind', 'seal', 'text',
  ])
  const forged = {
    ...issued().statement,
    text: 'DW did send the reminder and waived the fee.',
  }
  assert.equal(verifyDwExecutionStatement(forged), false,
    'model text substituted into a sealed statement must not verify')
})

test('1 a hand-built statement object never verifies', () => {
  const handmade = {
    kind: DW_EXECUTION_STATEMENT_KIND,
    actionType: 'send_reminder',
    identity: { userId: IDS.userA, invoiceId: IDS.invoiceA, ruleId: IDS.ruleA, actionType: 'send_reminder' },
    idempotencyKey: realReceipt().idempotencyKey,
    clientId: null,
    text: DW_EXECUTION_COPY.send_reminder,
    seal: 'looks-official',
    grants: { thisIdentityOnly: true, standingAuthority: false, otherActions: false },
  }
  assert.equal(verifyDwExecutionStatement(handmade), false)
})

// ── 2/3. No receipt, or a corrupted one, means no statement ──────────────────

test('2 removing the receipt removes the ability to state completed execution', () => {
  for (const receipts of [[], null, undefined]) {
    const result = buildDwExecutionStatement({ receipt: receipts, claim: REAL_CLAIM })
    assert.equal(result.issued, false)
    assert.equal(result.refusal, DW_EXECUTION_REFUSAL.NO_PROVING_RECEIPT)
    assert.equal(result.statement, null)
  }
})

test('3 corrupting any canonical identity component removes the statement', () => {
  const corruptions = [
    { userId: IDS.userB }, { invoiceId: IDS.invoiceB }, { ruleId: IDS.ruleB },
    { actionType: 'issue_refund' },
    { status: 'in_flight' }, { status: 'send_failed' }, { status: 'uncertain' },
    { status: 'succeeded' },
    { idempotencyKey: 'forged' }, { idempotencyKey: '' }, { idempotencyKey: null },
  ]
  for (const corruption of corruptions) {
    const result = buildDwExecutionStatement({
      receipt: realReceipt(corruption), claim: REAL_CLAIM,
    })
    assert.equal(result.issued, false, JSON.stringify(corruption))
    assert.equal(result.statement, null, JSON.stringify(corruption))
  }
})

// ── 4/5. Prose and confidence cannot increase execution truth ────────────────

test('4 changing the surrounding prose cannot change what is issued', () => {
  const control = issued().statement
  for (const noise of [
    { narrative: { headline: 'DW definitely sent everything and settled the invoice.' } },
    { modelSaid: 'I am certain the refund was issued.' },
    { text: 'DW refunded Atlas.' },
    { statementText: 'DW wrote off the invoice.' },
  ]) {
    const result = buildDwExecutionStatement({ receipt: realReceipt(), claim: REAL_CLAIM, ...noise })
    assert.deepEqual(result.statement, control, JSON.stringify(Object.keys(noise)))
  }
})

test('5 model confidence is not an input and cannot create execution', () => {
  for (const confidence of [1, 0.999, 'HIGH', { certainty: 'absolute' }]) {
    const result = buildDwExecutionStatement({ receipt: null, claim: REAL_CLAIM, confidence })
    assert.equal(result.issued, false)
  }
})

// ── 6-10. Nothing else is a substitute for a receipt ─────────────────────────

test('6-10 Brain, conversation, provider capability, grants and staged actions are not receipts', () => {
  const substitutes = {
    companyBrain: { items: [{ subject: 'we always chase at 60 days', reviewStatus: 'APPROVED' }] },
    companyBrainContext: { available: true },
    conversation: [{ role: 'founder', text: 'you already sent it, right?' }],
    conversationalTurn: { founderConfirmed: true },
    providerCapability: { email: true, canSend: true },
    transport: { ready: true, mode: 'production' },
    authorityProjection: { currentGrants: [{ grantId: 'g-1', action: 'SEND_REMINDER', status: 'GRANTED' }] },
    governance: { authority: { currentGrantIds: ['g-1'] } },
    recommendation: { action: 'send_reminder', ruleId: IDS.ruleA },
    stagedAction: { action: 'send_reminder', ruleId: IDS.ruleA, status: 'READY' },
    founderApproved: true,
  }
  // All of them at once, and still no receipt.
  const result = buildDwExecutionStatement({ receipt: null, claim: REAL_CLAIM, ...substitutes })
  assert.equal(result.issued, false)
  assert.equal(result.refusal, DW_EXECUTION_REFUSAL.NO_PROVING_RECEIPT)
  // And one at a time, so a single substitute cannot be the one that works.
  for (const [name, value] of Object.entries(substitutes)) {
    const one = buildDwExecutionStatement({ receipt: null, claim: REAL_CLAIM, [name]: value })
    assert.equal(one.issued, false, name)
  }
})

test('9 a receipt is not standing authority', () => {
  const statement = issued().statement
  assert.equal(statement.grants.standingAuthority, false)
  assert.equal(statement.grants.otherActions, false)
  assert.equal(statement.grants.thisIdentityOnly, true)
})

// ── 11/12. One receipt, one statement, its own action only ───────────────────

test('11 only the typed path can state completed execution as DueWatch work', () => {
  // The copy is a closed, repository-owned table keyed by provable action.
  assert.deepEqual(Object.keys(DW_EXECUTION_COPY), [...DW_PROVABLE_EXECUTION_ACTIONS])
  for (const text of Object.values(DW_EXECUTION_COPY)) {
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 0)
  }
})

test('12 a receipt produces only its own action, never a second one', () => {
  // A send receipt cannot license a refund or a waiver.
  for (const action of ['issue_refund', 'waive_late_fee', 'settle_invoice', 'write_off_invoice']) {
    const result = buildDwExecutionStatement({
      receipt: realReceipt(), claim: { ...REAL_CLAIM, action },
    })
    assert.equal(result.issued, false, action)
  }
  // And an action with no canonical execution contract can never be issued,
  // even with a perfectly-formed receipt for it.
  const fabricated = buildDwExecutionStatement({
    receipt: realReceipt({ actionType: 'issue_refund' }),
    claim: { ...REAL_CLAIM, action: 'issue_refund' },
  })
  assert.equal(fabricated.issued, false)
  assert.equal(fabricated.refusal, DW_EXECUTION_REFUSAL.ACTION_NOT_PROVABLE)
})

test('12 the verifier the builder uses is the one the guard uses — not a second copy', () => {
  assert.equal(typeof receiptProvesExecution, 'function')
  assert.equal(receiptProvesExecution({
    receipts: [realReceipt()], claim: REAL_CLAIM, action: 'send_reminder',
  }), true)
  assert.equal(receiptProvesExecution({
    receipts: [realReceipt({ ruleId: IDS.ruleB })], claim: REAL_CLAIM, action: 'send_reminder',
  }), false)
})

// ── Each verification mechanism, shown to be load-bearing on its own ─────────

test('3 a substituted sentence fails on the seal, which covers the text', () => {
  const forged = { ...issued().statement, text: 'DW refunded Atlas and closed the account.' }
  assert.deepEqual(inspectDwExecutionStatement(forged),
    { valid: false, failure: DW_EXECUTION_VERIFY_FAILURE.SEAL_MISMATCH })
})

test('3 a substituted clientId fails on the seal too', () => {
  const forged = { ...issued().statement, clientId: 'someone-elses-client' }
  assert.deepEqual(inspectDwExecutionStatement(forged),
    { valid: false, failure: DW_EXECUTION_VERIFY_FAILURE.SEAL_MISMATCH })
})

test('3 a key that the identity does not derive fails as KEY_NOT_DERIVED', () => {
  // Named precisely, so deleting the key derivation cannot be masked by the
  // seal check that would also have caught this forgery.
  const forged = { ...issued().statement, idempotencyKey: 'duewatch-autopilot-send:send_reminder:x:y:z' }
  assert.deepEqual(inspectDwExecutionStatement(forged),
    { valid: false, failure: DW_EXECUTION_VERIFY_FAILURE.KEY_NOT_DERIVED })
})

test('3 an identity whose action disagrees with the statement fails before the seal', () => {
  const statement = issued().statement
  const forged = { ...statement, identity: { ...statement.identity, actionType: 'issue_refund' } }
  assert.deepEqual(inspectDwExecutionStatement(forged),
    { valid: false, failure: DW_EXECUTION_VERIFY_FAILURE.IDENTITY_ACTION_MISMATCH })
})

test('9 overreaching grants fail as GRANTS_OVERREACH, outside the seal', () => {
  const statement = issued().statement
  for (const grants of [
    { thisIdentityOnly: true, standingAuthority: true, otherActions: false },
    { thisIdentityOnly: true, standingAuthority: false, otherActions: true },
    { thisIdentityOnly: false, standingAuthority: false, otherActions: false },
  ]) {
    assert.deepEqual(inspectDwExecutionStatement({ ...statement, grants }),
      { valid: false, failure: DW_EXECUTION_VERIFY_FAILURE.GRANTS_OVERREACH }, JSON.stringify(grants))
  }
})

test('3 statement identity comes from the claim, never from the caller or the receipt', () => {
  // A caller cannot name an identity beside the claim and have it honoured.
  const result = buildDwExecutionStatement({
    receipt: realReceipt(), claim: REAL_CLAIM,
    userId: IDS.userB, invoiceId: IDS.invoiceB, ruleId: IDS.ruleB,
    identity: { userId: IDS.userB, invoiceId: IDS.invoiceB, ruleId: IDS.ruleB, actionType: 'send_reminder' },
  })
  assert.deepEqual(result.statement.identity, {
    userId: IDS.userA, invoiceId: IDS.invoiceA, ruleId: IDS.ruleA, actionType: 'send_reminder',
  })
})

// ── The guard's new role ─────────────────────────────────────────────────────

test('the guard refuses an execution statement that is not receipt-backed', () => {
  const forged = { ...issued().statement, seal: 'forged' }
  const result = enforceDwProactiveGrounding({
    narrative: { headline: 'Here is what happened.' },
    truthLock: truthLock(),
    governance: governanceOf(),
    executionStatements: [forged],
  })
  assert.equal(result.blocked, true)
  assert.ok(codes(result).includes(DW_PROACTIVE_ISSUE.EXECUTION_STATEMENT_NOT_RECEIPT_BACKED))
})

test('the guard passes a genuine sealed statement through as the only execution surface', () => {
  const statement = issued().statement
  const result = enforceDwProactiveGrounding({
    narrative: { headline: 'Here is what happened.' },
    truthLock: truthLock(),
    governance: governanceOf(),
    executionStatements: [statement],
  })
  assert.equal(result.blocked, false, JSON.stringify(result.issues))
  assert.deepEqual(result.presentableExecution, [statement])
  // The contract a consumer must honour, stated in the output itself.
  assert.equal(result.boundaries.narrativeMayStateExecution, false)
  assert.equal(result.boundaries.executionStatementOwner, 'RECEIPT')
})

test('narrative prose is never promoted into the presentable execution surface', () => {
  const result = enforceDwProactiveGrounding({
    narrative: { headline: 'DW sent the reminder.' },
    truthLock: truthLock(),
    governance: governanceOf(),
    executionClaim: REAL_CLAIM,
    executionReceipts: [realReceipt()],
  })
  // Even with a genuine receipt in hand, prose does not become a statement.
  assert.deepEqual(result.presentableExecution, [])
})

// ── The prose detector, honestly labelled ────────────────────────────────────

test('the prose detector is declared defense-in-depth, not a parser', () => {
  assert.equal(DW_PROSE_DETECTION_ROLE, 'DEFENSE_IN_DEPTH')
})

test('the prose detector has known blind spots, and the invariant survives them', () => {
  // These are the reviewer's counterexamples. Each is a sentence a token walk
  // gets wrong, in one direction or the other. They are recorded here as
  // limits of a best-effort layer — NOT as the boundary — and what is asserted
  // is that no execution statement exists for any of them.
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
      narrative: { headline },
      truthLock: truthLock(),
      governance: governanceOf(),
      executionStatements: [],
    })
    // Whatever the walker concluded about the words, nothing presentable as
    // DueWatch's completed work was produced. That is the invariant.
    assert.deepEqual(result.presentableExecution, [], headline)
    assert.equal(result.boundaries.narrativeMayStateExecution, false, headline)
  }
})
