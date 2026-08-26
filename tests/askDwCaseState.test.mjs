import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ASK_DW_ACTION_STATUS,
  ASK_DW_CASE_EVENT,
  applyAskDwCaseEvent,
  assertAskDwActionReadyForExecutionBoundary,
  createAskDwCaseState,
  getAskDwActiveAction,
  getAskDwActiveCase,
  resolveAskDwReference,
  validateAskDwCaseState,
} from '../src/lib/dwIntelligence/askDwCaseState.js'

const T = 'tenant-a'
const at = (n) => `2026-08-26T19:${String(n).padStart(2, '0')}:00.000Z`

function initial(overrides = {}) {
  return createAskDwCaseState({
    tenantId: T,
    conversationId: 'conv-1',
    caseId: 'case-anthony',
    turnId: 'turn-1',
    now: at(0),
    ...overrides,
  })
}

function event(state, type, payload = {}, {
  turnId = `turn-${state.version + 2}`,
  time = state.version + 1,
  tenantId = T,
  expectedVersion = state.version,
} = {}) {
  return applyAskDwCaseEvent(state, {
    type,
    payload,
    tenantId,
    expectedVersion,
    turnId,
    at: at(time),
  })
}

test('case state starts tenant-scoped and stores no canonical financial truth or business authority', () => {
  const state = initial()
  assert.equal(state.tenantId, T)
  assert.equal(state.boundaries.canonicalFinancialTruthStored, false)
  assert.equal(state.boundaries.businessAuthorityStored, false)
  assert.equal(state.boundaries.confirmationNeverEqualsExecution, true)
  assert.equal(validateAskDwCaseState(state), true)
})

test('cross-tenant transitions are rejected before state changes', () => {
  const state = initial()
  assert.throws(
    () => event(state, ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT, {
      clientRef: { kind: 'client', id: 'client-anthony' },
    }, { tenantId: 'tenant-b' }),
    /cross-tenant case event blocked/,
  )
  assert.equal(getAskDwActiveCase(state).focus.clientRef, null)
})

test('optimistic version check rejects stale concurrent transitions', () => {
  const state = initial()
  const next = event(state, ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT, {
    clientRef: { kind: 'client', id: 'client-anthony' },
  })
  assert.throws(
    () => event(next, ASK_DW_CASE_EVENT.SET_PRESENTATION, {
      tone: 'EXECUTIVE',
    }, { expectedVersion: 0 }),
    /stale case state version/,
  )
})

test('Anthony can be resolved to a client reference without copying live client rows', () => {
  let state = initial()
  state = event(state, ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT, {
    clientRef: { kind: 'client', id: 'client-anthony' },
  })
  state = event(state, ASK_DW_CASE_EVENT.RESOLVE_REFERENCE, {
    term: 'anthony',
    ref: { kind: 'client', id: 'client-anthony' },
  })
  state = event(state, ASK_DW_CASE_EVENT.RESOLVE_REFERENCE, {
    term: 'him',
    ref: { kind: 'client', id: 'client-anthony' },
  })

  assert.deepEqual(resolveAskDwReference(state, 'him'), {
    kind: 'client',
    id: 'client-anthony',
  })
})

test('"nah the other invoice" correction changes focus and invalidates invoice-scoped work', () => {
  let state = initial()
  state = event(state, ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT, {
    clientRef: { kind: 'client', id: 'client-anthony' },
  })
  state = event(state, ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES, {
    invoiceRefs: [
      { kind: 'invoice', id: 'inv-1844' },
      { kind: 'invoice', id: 'inv-1902' },
    ],
  })
  state = event(state, ASK_DW_CASE_EVENT.SELECT_INVOICE, {
    invoiceRef: { kind: 'invoice', id: 'inv-1844' },
  })
  state = event(state, ASK_DW_CASE_EVENT.SET_ARTIFACT_REF, {
    artifactRef: { kind: 'artifact', id: 'artifact-1844' },
  })
  state = event(state, ASK_DW_CASE_EVENT.SET_EVIDENCE_REFS, {
    evidenceRefs: [{ kind: 'evidence', id: 'evidence-1844' }],
  })
  state = event(state, ASK_DW_CASE_EVENT.OFFER_ACTION, {
    actionId: 'action-1844',
    actionType: 'ATTACH_EVIDENCE_TO_REMINDER',
    targetRefs: [{ kind: 'invoice', id: 'inv-1844' }],
    scope: 'INVOICE',
  })
  state = event(state, ASK_DW_CASE_EVENT.REQUEST_ACTION_CONFIRMATION, {
    actionId: 'action-1844',
  })

  state = event(state, ASK_DW_CASE_EVENT.CORRECT_ACTIVE_INVOICE, {
    invoiceRef: { kind: 'invoice', id: 'inv-1902' },
  })

  const active = getAskDwActiveCase(state)
  assert.equal(active.focus.invoiceRef.id, 'inv-1902')
  assert.equal(active.artifactRef, null)
  assert.deepEqual(active.evidenceRefs, [])
  assert.equal(active.activeActionId, null)
  assert.equal(active.actions[0].status, ASK_DW_ACTION_STATUS.INVALIDATED)
  assert.equal(active.actions[0].invalidatedReason, 'ACTIVE_INVOICE_CORRECTED')
})

test('invoice correction must use a resolved candidate when a candidate set exists', () => {
  let state = initial()
  state = event(state, ASK_DW_CASE_EVENT.SET_INVOICE_CANDIDATES, {
    invoiceRefs: [{ kind: 'invoice', id: 'inv-1844' }],
  })
  assert.throws(
    () => event(state, ASK_DW_CASE_EVENT.CORRECT_ACTIVE_INVOICE, {
      invoiceRef: { kind: 'invoice', id: 'inv-not-resolved' },
    }),
    /not in resolved candidate set/,
  )
})

test('"dont do it yet" suspends the exact action without executing it', () => {
  let state = initial()
  state = event(state, ASK_DW_CASE_EVENT.OFFER_ACTION, {
    actionId: 'action-1',
    actionType: 'ATTACH_EVIDENCE_TO_REMINDER',
    targetRefs: [{ kind: 'invoice', id: 'inv-1844' }],
    scope: 'INVOICE',
  })
  state = event(state, ASK_DW_CASE_EVENT.REQUEST_ACTION_CONFIRMATION, {
    actionId: 'action-1',
  })
  state = event(state, ASK_DW_CASE_EVENT.SUSPEND_ACTION, {
    actionId: 'action-1',
  })

  const action = getAskDwActiveAction(state)
  assert.equal(action.status, ASK_DW_ACTION_STATUS.SUSPENDED)
  assert.equal(action.executionAuthorized, false)
})

test('"do it" is only a reference confirmation and still requires fresh state plus authority recheck', () => {
  let state = initial()
  state = event(state, ASK_DW_CASE_EVENT.OFFER_ACTION, {
    actionId: 'action-1',
    actionType: 'ATTACH_EVIDENCE_TO_REMINDER',
    targetRefs: [{ kind: 'invoice', id: 'inv-1844' }],
    scope: 'INVOICE',
  }, { turnId: 'turn-offer' })
  state = event(state, ASK_DW_CASE_EVENT.REQUEST_ACTION_CONFIRMATION, {
    actionId: 'action-1',
  }, { turnId: 'turn-confirm-request' })
  state = event(state, ASK_DW_CASE_EVENT.CONFIRM_ACTION_REFERENCE, {
    actionId: 'action-1',
    offeredAtTurnId: 'turn-offer',
  }, { turnId: 'turn-do-it' })

  const boundary = assertAskDwActionReadyForExecutionBoundary(state, 'action-1')
  assert.equal(boundary.executionAuthorized, false)
  assert.equal(boundary.requiresFreshState, true)
  assert.equal(boundary.requiresAuthorityRecheck, true)
  assert.equal(boundary.confirmationTurnId, 'turn-do-it')
})

test('"do it" with the wrong offered-turn anchor is rejected', () => {
  let state = initial()
  state = event(state, ASK_DW_CASE_EVENT.OFFER_ACTION, {
    actionId: 'action-1',
    actionType: 'ATTACH_EVIDENCE_TO_REMINDER',
    targetRefs: [{ kind: 'invoice', id: 'inv-1844' }],
    scope: 'INVOICE',
  }, { turnId: 'turn-offer' })
  state = event(state, ASK_DW_CASE_EVENT.REQUEST_ACTION_CONFIRMATION, {
    actionId: 'action-1',
  })

  assert.throws(
    () => event(state, ASK_DW_CASE_EVENT.CONFIRM_ACTION_REFERENCE, {
      actionId: 'action-1',
      offeredAtTurnId: 'some-other-turn',
    }),
    /turn anchor mismatch/,
  )
})

test('a suspended action can be re-confirmed but never becomes authority by itself', () => {
  let state = initial()
  state = event(state, ASK_DW_CASE_EVENT.OFFER_ACTION, {
    actionId: 'action-1',
    actionType: 'ATTACH_EVIDENCE_TO_REMINDER',
    targetRefs: [{ kind: 'invoice', id: 'inv-1844' }],
    scope: 'INVOICE',
  }, { turnId: 'turn-offer' })
  state = event(state, ASK_DW_CASE_EVENT.REQUEST_ACTION_CONFIRMATION, {
    actionId: 'action-1',
  })
  state = event(state, ASK_DW_CASE_EVENT.SUSPEND_ACTION, {
    actionId: 'action-1',
  })
  state = event(state, ASK_DW_CASE_EVENT.CONFIRM_ACTION_REFERENCE, {
    actionId: 'action-1',
    offeredAtTurnId: 'turn-offer',
  }, { turnId: 'turn-actually-do-it' })

  const action = getAskDwActiveAction(state)
  assert.equal(action.status, ASK_DW_ACTION_STATUS.CONFIRMED_PENDING_REVALIDATION)
  assert.equal(action.executionAuthorized, false)
})

test('tone/detail changes do not rewrite case focus, evidence or action state', () => {
  let state = initial()
  state = event(state, ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT, {
    clientRef: { kind: 'client', id: 'client-anthony' },
  })
  state = event(state, ASK_DW_CASE_EVENT.SET_EVIDENCE_REFS, {
    evidenceRefs: [{ kind: 'evidence', id: 'evidence-1' }],
  })

  const before = getAskDwActiveCase(state)
  state = event(state, ASK_DW_CASE_EVENT.SET_PRESENTATION, {
    tone: 'EXECUTIVE',
    detail: 'BRIEF',
  })
  const after = getAskDwActiveCase(state)

  assert.deepEqual(after.focus, before.focus)
  assert.deepEqual(after.evidenceRefs, before.evidenceRefs)
  assert.equal(state.presentation.tone, 'EXECUTIVE')
  assert.equal(state.presentation.detail, 'BRIEF')
})

test('opening and switching cases preserves bounded conversation threads', () => {
  let state = initial()
  for (const id of ['case-apex', 'case-kevin', 'case-zenith', 'case-fourth']) {
    state = event(state, ASK_DW_CASE_EVENT.OPEN_CASE, { caseId: id })
  }

  assert.equal(state.activeCaseId, 'case-fourth')
  assert.deepEqual(state.recentCaseIds, ['case-zenith', 'case-kevin', 'case-apex'])
  assert.equal(state.recentCaseIds.length, 3)

  state = event(state, ASK_DW_CASE_EVENT.SWITCH_CASE, { caseId: 'case-anthony' })
  assert.equal(state.activeCaseId, 'case-anthony')
  assert.equal(state.recentCaseIds[0], 'case-fourth')
})

test('changing the active client clears invoice-derived context and invalidates client-targeted action', () => {
  let state = initial()
  state = event(state, ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT, {
    clientRef: { kind: 'client', id: 'client-anthony' },
  })
  state = event(state, ASK_DW_CASE_EVENT.OFFER_ACTION, {
    actionId: 'action-client',
    actionType: 'PAUSE_CLIENT_AUTOPILOT',
    targetRefs: [{ kind: 'client', id: 'client-anthony' }],
    scope: 'CLIENT',
  })
  state = event(state, ASK_DW_CASE_EVENT.SET_ACTIVE_CLIENT, {
    clientRef: { kind: 'client', id: 'client-kevin' },
  })

  const current = getAskDwActiveCase(state)
  assert.equal(current.focus.clientRef.id, 'client-kevin')
  assert.equal(current.activeActionId, null)
  assert.equal(current.actions[0].status, ASK_DW_ACTION_STATUS.INVALIDATED)
})

test('TTL expiration fails closed and explicit expiration invalidates active action', () => {
  let state = initial({ expiresAt: at(5) })
  state = event(state, ASK_DW_CASE_EVENT.OFFER_ACTION, {
    actionId: 'action-1',
    actionType: 'ATTACH_EVIDENCE_TO_REMINDER',
    targetRefs: [{ kind: 'invoice', id: 'inv-1844' }],
    scope: 'INVOICE',
  }, { time: 1 })

  assert.throws(
    () => event(state, ASK_DW_CASE_EVENT.SET_PRESENTATION, {
      tone: 'EXECUTIVE',
    }, { time: 5 }),
    /expired by TTL/,
  )

  state = event(state, ASK_DW_CASE_EVENT.EXPIRE_CONVERSATION, {}, { time: 5 })
  assert.equal(state.status, 'EXPIRED')
  assert.equal(getAskDwActiveCase(state).actions[0].status, ASK_DW_ACTION_STATUS.INVALIDATED)
})

test('case state rejects attempts to persist live financial values', () => {
  const state = initial()
  const poisoned = JSON.parse(JSON.stringify(state))
  poisoned.cases['case-anthony'].amount = '2480.00'
  assert.throws(
    () => validateAskDwCaseState(poisoned),
    /forbidden live\/canonical field/,
  )
})

test('returned state is deeply frozen for deterministic consumers', () => {
  const state = initial()
  assert.equal(Object.isFrozen(state), true)
  assert.equal(Object.isFrozen(state.cases['case-anthony']), true)
  assert.equal(Object.isFrozen(state.presentation), true)
})
