import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ASK_DW_ACTION_STATUS,
  ASK_DW_CASE_EVENT,
  applyAskDwCaseEvent,
  createAskDwCaseState,
  getAskDwActiveAction,
  getAskDwActiveCase,
  validateAskDwCaseState,
} from '../src/lib/dwIntelligence/askDwCaseState.js'
import {
  buildAskDwCaseContext,
  createAskDwCaseAwareRuntime,
} from '../src/lib/dwIntelligence/askDwConversationRuntime.js'

const TENANT = 'tenant-anthony-golden'
const CLIENT = 'client-anthony'
const FIRST_INVOICE = 'inv-1844'
const OTHER_INVOICE = 'inv-1902'

const iso = (minute) => `2026-08-26T21:${String(minute).padStart(2, '0')}:00.000Z`

function initialState() {
  return createAskDwCaseState({
    tenantId: TENANT,
    conversationId: 'conv-anthony-golden',
    caseId: 'case-anthony',
    turnId: 'turn-bootstrap',
    now: iso(0),
    expiresAt: '2026-08-27T21:00:00.000Z',
  })
}

function apply(state, type, payload = {}, { turnId, minute } = {}) {
  return applyAskDwCaseEvent(state, {
    type,
    payload,
    tenantId: TENANT,
    expectedVersion: state.version,
    turnId: turnId || `setup-${state.version + 1}`,
    at: iso(minute ?? state.version + 1),
  })
}

function makeFreshInvoiceRunner(callLog) {
  const balances = {
    [FIRST_INVOICE]: [850],
    [OTHER_INVOICE]: [640, 625, 610, 590],
  }

  return async (args) => {
    const sequence = balances[args.invoiceId]
    assert.ok(sequence, `unexpected invoice read: ${args.invoiceId}`)
    const index = callLog.filter((call) => call.invoiceId === args.invoiceId).length
    const balance = sequence[Math.min(index, sequence.length - 1)]
    const authorityActual = args.text.toLowerCase().includes('actually do it')
      ? 'FOUNDER_CONFIRMATION_REQUIRED'
      : 'NOT_GRANTED'

    callLog.push({
      tenantId: args.tenantId,
      invoiceId: args.invoiceId,
      text: args.text,
      balance,
      authorityActual,
      caseContext: args.caseContext,
    })

    return {
      truthLock: {
        canonicalFacts: {
          invoiceId: args.invoiceId,
          balance,
        },
        authority: {
          actual: authorityActual,
          policyAuthorized: false,
        },
      },
      core: {
        intelligence: {
          execution: {
            sideEffect: false,
          },
        },
      },
      liveReadReceipt: {
        writesPerformed: false,
        source: 'golden-fixture-fresh-read',
      },
      answer: {
        executiveConclusion: `Fresh answer for ${args.invoiceId}.`,
      },
    }
  }
}

test('M1F Anthony golden conversation preserves continuity while re-reading truth every turn', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: makeFreshInvoiceRunner(calls),
  })

  let state = initialState()

  const anthony = await runtime.runTurn({
    tenantId: TENANT,
    caseState: state,
    turnId: 'turn-anthony',
    text: "What's going on with Anthony?",
    now: new Date(iso(10)),
    proposedResolverEvents: [
      {
        type: ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT,
        payload: { clientRef: { kind: 'client', id: CLIENT } },
      },
      {
        type: ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES,
        payload: {
          invoiceRefs: [
            { kind: 'invoice', id: FIRST_INVOICE },
            { kind: 'invoice', id: OTHER_INVOICE },
          ],
        },
      },
      {
        type: ASK_DW_CASE_EVENT.SELECT_INVOICE,
        payload: { invoiceRef: { kind: 'invoice', id: FIRST_INVOICE } },
      },
      {
        type: ASK_DW_CASE_EVENT.RESOLVE_REFERENCE,
        payload: { term: 'anthony', ref: { kind: 'client', id: CLIENT } },
      },
      {
        type: ASK_DW_CASE_EVENT.RESOLVE_REFERENCE,
        payload: { term: 'him', ref: { kind: 'client', id: CLIENT } },
      },
    ],
  })

  assert.equal(anthony.status, 'ANSWERED')
  assert.equal(anthony.caseContext.focus.clientRef.id, CLIENT)
  assert.equal(anthony.caseContext.focus.invoiceRef.id, FIRST_INVOICE)
  assert.equal(calls.at(-1).invoiceId, FIRST_INVOICE)
  assert.equal(calls.at(-1).balance, 850)
  state = anthony.caseState

  state = apply(state, ASK_DW_CASE_EVENT.SET_ARTIFACT_REF, {
    artifactRef: { kind: 'artifact', id: 'artifact-inv-1844' },
  }, { turnId: 'turn-artifact', minute: 11 })
  state = apply(state, ASK_DW_CASE_EVENT.SET_EVIDENCE_REFS, {
    evidenceRefs: [{ kind: 'evidence', id: 'evidence-inv-1844' }],
  }, { turnId: 'turn-evidence', minute: 12 })

  const other = await runtime.runTurn({
    tenantId: TENANT,
    caseState: state,
    turnId: 'turn-other-invoice',
    text: 'What about the other invoice?',
    now: new Date(iso(20)),
    proposedResolverEvents: [{
      type: ASK_DW_CASE_EVENT.CORRECT_ACTIVE_INVOICE,
      payload: { invoiceRef: { kind: 'invoice', id: OTHER_INVOICE } },
    }],
  })

  assert.equal(other.status, 'ANSWERED')
  assert.equal(other.caseContext.focus.invoiceRef.id, OTHER_INVOICE)
  assert.equal(other.caseContext.artifactRef, null)
  assert.deepEqual(other.caseContext.evidenceRefs, [])
  assert.equal(calls.at(-1).invoiceId, OTHER_INVOICE)
  assert.equal(calls.at(-1).balance, 640)
  state = other.caseState

  const shorter = await runtime.runTurn({
    tenantId: TENANT,
    caseState: state,
    turnId: 'turn-shorter',
    text: 'Make that shorter.',
    now: new Date(iso(30)),
    proposedResolverEvents: [{
      type: ASK_DW_CASE_EVENT.SET_PRESENTATION,
      payload: { detail: 'BRIEF' },
    }],
  })

  assert.equal(shorter.status, 'ANSWERED')
  assert.equal(shorter.caseContext.presentation.detail, 'BRIEF')
  assert.equal(shorter.caseContext.focus.invoiceRef.id, OTHER_INVOICE)
  assert.equal(calls.at(-1).invoiceId, OTHER_INVOICE)
  assert.equal(calls.at(-1).balance, 625)
  state = shorter.caseState

  state = apply(state, ASK_DW_CASE_EVENT.OFFER_ACTION, {
    actionId: 'action-anthony-inv-1902',
    actionType: 'ATTACH_EVIDENCE_TO_REMINDER',
    targetRefs: [{ kind: 'invoice', id: OTHER_INVOICE }],
    scope: 'INVOICE',
  }, { turnId: 'turn-offer-action', minute: 31 })
  state = apply(state, ASK_DW_CASE_EVENT.REQUEST_ACTION_CONFIRMATION, {
    actionId: 'action-anthony-inv-1902',
  }, { turnId: 'turn-request-confirmation', minute: 32 })

  const held = await runtime.runTurn({
    tenantId: TENANT,
    caseState: state,
    turnId: 'turn-hold',
    text: "Don't do it yet.",
    now: new Date(iso(40)),
  })

  assert.equal(held.status, 'ANSWERED')
  assert.equal(getAskDwActiveAction(held.caseState).status, ASK_DW_ACTION_STATUS.SUSPENDED)
  assert.equal(held.executionBoundary, null)
  assert.equal(held.safeguards.directExecutionPerformed, false)
  assert.equal(calls.at(-1).balance, 610)
  state = held.caseState

  const confirmed = await runtime.runTurn({
    tenantId: TENANT,
    caseState: state,
    turnId: 'turn-actually-do-it',
    text: 'Actually do it.',
    now: new Date(iso(50)),
  })

  const finalAction = getAskDwActiveAction(confirmed.caseState)
  assert.equal(confirmed.status, 'ANSWERED')
  assert.equal(finalAction.status, ASK_DW_ACTION_STATUS.CONFIRMED_PENDING_REVALIDATION)
  assert.equal(finalAction.executionAuthorized, false)
  assert.equal(confirmed.executionBoundary.executionAuthorized, false)
  assert.equal(confirmed.executionBoundary.requiresFreshState, true)
  assert.equal(confirmed.executionBoundary.requiresAuthorityRecheck, true)
  assert.equal(confirmed.executionBoundary.revalidation.freshStateRefetched, true)
  assert.equal(confirmed.executionBoundary.revalidation.freshAuthorityRechecked, true)
  assert.equal(confirmed.executionBoundary.revalidation.authorityActual, 'FOUNDER_CONFIRMATION_REQUIRED')
  assert.equal(confirmed.executionBoundary.revalidation.executionAuthorizedByCaseState, false)
  assert.equal(confirmed.executionBoundary.revalidation.directExecutionPerformed, false)
  assert.equal(calls.at(-1).invoiceId, OTHER_INVOICE)
  assert.equal(calls.at(-1).balance, 590)

  assert.deepEqual(calls.map((call) => call.invoiceId), [
    FIRST_INVOICE,
    OTHER_INVOICE,
    OTHER_INVOICE,
    OTHER_INVOICE,
    OTHER_INVOICE,
  ])

  const persisted = JSON.stringify(confirmed.caseState)
  assert.equal(persisted.includes('"balance"'), false)
  assert.equal(persisted.includes('"canonicalFacts"'), false)
  assert.equal(persisted.includes('"policyAuthorized"'), false)
  assert.equal(validateAskDwCaseState(confirmed.caseState), true)
})

test('M1F Anthony correction invalidates an action anchored to the old invoice', async () => {
  const calls = []
  const runtime = createAskDwCaseAwareRuntime({
    runInvoiceQuestion: makeFreshInvoiceRunner(calls),
  })

  let state = initialState()
  state = apply(state, ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT, {
    clientRef: { kind: 'client', id: CLIENT },
  })
  state = apply(state, ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES, {
    invoiceRefs: [
      { kind: 'invoice', id: FIRST_INVOICE },
      { kind: 'invoice', id: OTHER_INVOICE },
    ],
  })
  state = apply(state, ASK_DW_CASE_EVENT.SELECT_INVOICE, {
    invoiceRef: { kind: 'invoice', id: FIRST_INVOICE },
  })
  state = apply(state, ASK_DW_CASE_EVENT.OFFER_ACTION, {
    actionId: 'action-old-invoice',
    actionType: 'ATTACH_EVIDENCE_TO_REMINDER',
    targetRefs: [{ kind: 'invoice', id: FIRST_INVOICE }],
    scope: 'INVOICE',
  }, { turnId: 'turn-old-offer', minute: 5 })
  state = apply(state, ASK_DW_CASE_EVENT.REQUEST_ACTION_CONFIRMATION, {
    actionId: 'action-old-invoice',
  }, { turnId: 'turn-old-request', minute: 6 })

  const corrected = await runtime.runTurn({
    tenantId: TENANT,
    caseState: state,
    turnId: 'turn-correct-old-action',
    text: 'nah the other invoice',
    now: new Date(iso(20)),
  })

  const active = getAskDwActiveCase(corrected.caseState)
  assert.equal(corrected.caseContext.focus.invoiceRef.id, OTHER_INVOICE)
  assert.equal(active.activeActionId, null)
  assert.equal(active.actions[0].status, ASK_DW_ACTION_STATUS.INVALIDATED)
  assert.equal(active.actions[0].invalidatedReason, 'ACTIVE_INVOICE_CORRECTED')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].invoiceId, OTHER_INVOICE)
})

test('M1F Anthony golden fixture is reference-only at the model boundary', () => {
  let state = initialState()
  state = apply(state, ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT, {
    clientRef: { kind: 'client', id: CLIENT },
  })
  state = apply(state, ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES, {
    invoiceRefs: [
      { kind: 'invoice', id: FIRST_INVOICE },
      { kind: 'invoice', id: OTHER_INVOICE },
    ],
  })
  state = apply(state, ASK_DW_CASE_EVENT.SELECT_INVOICE, {
    invoiceRef: { kind: 'invoice', id: FIRST_INVOICE },
  })

  const context = buildAskDwCaseContext(state)
  assert.equal(context.focus.clientRef.id, CLIENT)
  assert.equal(context.focus.invoiceRef.id, FIRST_INVOICE)
  assert.equal(context.boundaries.referenceOnly, true)
  assert.equal(context.boundaries.canonicalFinancialTruthStored, false)
  assert.equal(context.boundaries.businessAuthorityStored, false)

  const serialized = JSON.stringify(context)
  assert.equal(serialized.includes('"balance"'), false)
  assert.equal(serialized.includes('"amount"'), false)
  assert.equal(serialized.includes('"canonicalFacts"'), false)
})
