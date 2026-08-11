import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PERSISTED_REASON_CODES,
  formatRunCounts,
  presentBlockReason,
  presentImportEvent,
  presentRowProvenance,
  presentRunStatus,
} from '../../src/lib/importPersistence/importPresentation.js'

const expectedReasons = [
  'REVIEW_REQUIRED', 'REJECTED', 'UNKNOWN_OUTCOME', 'OUTCOME_ISSUE_MISMATCH', 'UNKNOWN_ISSUE_CODE',
  'BLOCKING_ISSUE_ON_ELIGIBLE_OUTCOME', 'UNAPPROVED_WARNING_CODE', 'WARNINGS_NOT_ACKNOWLEDGED',
  'MISSING_MATERIAL_FIELD', 'INVALID_DATE_VALUE', 'INVALID_AMOUNT_VALUE', 'NON_POSITIVE_AMOUNT',
  'UNSUPPORTED_CURRENCY', 'INVALID_AMOUNT_PAID_VALUE', 'AMOUNT_PAID_OUT_OF_RANGE',
  'UNSUPPORTED_STATUS_VALUE', 'UNKNOWN_STATUS_VALUE', 'PAID_STATUS_AMOUNT_MISMATCH', 'WEAK_CLIENT_IDENTITY',
  'AMBIGUOUS_CLIENT_IDENTITY', 'MISSING_CLIENT_NAME', 'AMBIGUOUS_INVOICE_IDENTITY', 'INVOICE_MATERIAL_CONFLICT',
]

test('all 23 persisted block reasons have explicit customer-safe presentations', () => {
  assert.deepEqual(PERSISTED_REASON_CODES, expectedReasons)
  for (const code of expectedReasons) {
    const result = presentBlockReason(code)
    assert.equal(result.kind, 'known')
    assert.equal(result.code, code)
    assert.ok(result.title)
    assert.ok(result.explanation)
    assert.ok(result.action)
  }
})

test('warning authorization and acknowledgement are distinct persisted reasons', () => {
  const unapproved = presentBlockReason('UNAPPROVED_WARNING_CODE')
  const unacknowledged = presentBlockReason('WARNINGS_NOT_ACKNOWLEDGED')
  assert.notEqual(unapproved.title, unacknowledged.title)
  assert.match(unapproved.explanation, /approved-warning list/)
  assert.match(unacknowledged.explanation, /not explicitly approved/)
})

test('unknown reason preserves its code while absent reasons invent no code', () => {
  assert.equal(presentBlockReason('FUTURE_REASON').technicalDetail, 'Reason code: FUTURE_REASON')
  for (const value of [null, undefined, '', '   ']) {
    const result = presentBlockReason(value)
    assert.equal(result.kind, 'missing')
    assert.equal(result.code, null)
    assert.equal(result.technicalDetail, null)
  }
})

test('active counts say so far and terminal counts do not', () => {
  assert.deepEqual(formatRunCounts({ status: 'in_progress', committedRows: 2, blockedRows: 1, pendingRows: 3 }), {
    saved: '2 saved so far', blocked: '1 blocked so far', pending: '3 pending',
  })
  assert.deepEqual(formatRunCounts({ status: 'cancelled', committedRows: 2, blockedRows: 1, pendingRows: 3 }), {
    saved: '2 saved', blocked: '1 blocked', pending: '3 pending',
  })
})

test('every persisted run status has one authoritative presentation', () => {
  const expected = {
    pending: 'Not started', in_progress: 'In progress', completed: 'Completed',
    partially_completed: 'Finished with blocked rows', failed: 'Failed', cancelled: 'Cancelled',
  }
  for (const [status, label] of Object.entries(expected)) {
    assert.equal(presentRunStatus(status).label, label)
  }
})

test('committed provenance is factual and non-committed rows claim none', () => {
  assert.deepEqual(presentRowProvenance({
    server_status: 'committed', client_result: 'matched', client_id: 'client-1', invoice_result: 'inserted', invoice_id: 'invoice-1',
  }), {
    client: 'Matched existing client', invoice: 'Inserted invoice', clientId: 'client-1', invoiceId: 'invoice-1',
    clientUnavailable: false, invoiceUnavailable: false,
  })
  assert.equal(presentRowProvenance({ server_status: 'blocked', invoice_result: 'inserted' }), null)
})

test('provenance remains truthful when a linked record was later deleted', () => {
  const result = presentRowProvenance({
    server_status: 'committed', client_result: 'created', client_id: null,
    invoice_result: 'already_existed', invoice_id: null,
  })
  assert.equal(result.client, 'Created client')
  assert.equal(result.invoice, 'Invoice already existed')
  assert.equal(result.clientUnavailable, true)
  assert.equal(result.invoiceUnavailable, true)
})

test('event chronology cannot override persisted cancelled lifecycle status', () => {
  assert.equal(presentRunStatus('cancelled').label, 'Cancelled')
  assert.equal(presentImportEvent({ event_type: 'run_completed' }).label, 'Run closed')
  assert.equal(presentImportEvent({ event_type: 'run_failed' }).label, 'Run closed')
})
