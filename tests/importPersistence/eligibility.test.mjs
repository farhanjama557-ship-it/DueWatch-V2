import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateRowEligibility,
  evaluateFileEligibility,
  evaluateAllRows,
  APPROVED_WARNING_CODES,
  BLOCK_REASONS,
} from '../../src/lib/importPersistence/eligibility.js'

function readyRow(overrides = {}) {
  return {
    outcome: 'ready',
    issues: [],
    normalized: {
      invoice_number: 'INV-1',
      invoice_date: '2026-01-01',
      amount: '100.00',
      client_email: 'billing@acme.test',
    },
    ...overrides,
  }
}

test('a clean ready row with a strong identity is eligible', () => {
  const result = evaluateRowEligibility(readyRow())
  assert.equal(result.eligible, true)
})

test('review_required is never eligible', () => {
  const result = evaluateRowEligibility(readyRow({ outcome: 'review_required' }))
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.REVIEW_REQUIRED)
})

test('rejected is never eligible', () => {
  const result = evaluateRowEligibility(readyRow({ outcome: 'rejected' }))
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.REJECTED)
})

test('an unrecognized outcome string is blocked, not treated as eligible', () => {
  const result = evaluateRowEligibility(readyRow({ outcome: 'somehow_fine' }))
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.UNKNOWN_OUTCOME)
})

test('a missing row is blocked', () => {
  assert.equal(evaluateRowEligibility(null).eligible, false)
  assert.equal(evaluateRowEligibility(undefined).eligible, false)
})

test('a "ready" row carrying any issue code is internally contradictory and blocks', () => {
  const result = evaluateRowEligibility(
    readyRow({ issues: [{ code: 'PAID_WITHOUT_PAYMENT_DATE' }] })
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.OUTCOME_ISSUE_MISMATCH)
})

test('an unknown issue code blocks even on a claimed ready_with_warnings row', () => {
  const result = evaluateRowEligibility(
    readyRow({ outcome: 'ready_with_warnings', issues: [{ code: 'SOME_FUTURE_CODE_NOT_YET_TAUGHT' }] }),
    { warningsAcknowledged: true }
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.UNKNOWN_ISSUE_CODE)
})

test('every currently-approved warning code is individually eligible on ready_with_warnings, once acknowledged', () => {
  for (const code of APPROVED_WARNING_CODES) {
    const result = evaluateRowEligibility(
      readyRow({ outcome: 'ready_with_warnings', issues: [{ code }] }),
      { warningsAcknowledged: true }
    )
    assert.equal(result.eligible, true, `expected ${code} to be eligible`)
  }
})

test('ready_with_warnings without explicit acknowledgement blocks even with an approved code', () => {
  const result = evaluateRowEligibility(
    readyRow({ outcome: 'ready_with_warnings', issues: [{ code: 'PAID_WITHOUT_PAYMENT_DATE' }] })
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.WARNINGS_NOT_ACKNOWLEDGED)
})

test('a real blocking code contradicting a claimed ready_with_warnings outcome is blocked, not trusted', () => {
  const result = evaluateRowEligibility(
    readyRow({ outcome: 'ready_with_warnings', issues: [{ code: 'AMOUNT_PAID_EXCEEDS_AMOUNT' }] }),
    { warningsAcknowledged: true }
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.BLOCKING_ISSUE_ON_ELIGIBLE_OUTCOME)
})

test('a non-blocking code that is not on the approved list still blocks ready_with_warnings', () => {
  // DUPLICATE_IN_UPLOAD is a real, known code but it blocksImport=true —
  // this specifically exercises the branch where the code IS known and IS
  // blocking, distinguishing it from the unknown-code case above.
  const result = evaluateRowEligibility(
    readyRow({ outcome: 'ready_with_warnings', issues: [{ code: 'DUPLICATE_IN_UPLOAD' }] }),
    { warningsAcknowledged: true }
  )
  assert.equal(result.eligible, false)
})

test('missing a required material field blocks even with a clean outcome/issues', () => {
  for (const field of ['invoice_number', 'invoice_date', 'amount']) {
    const normalized = { invoice_number: 'INV-1', invoice_date: '2026-01-01', amount: '100.00', client_email: 'x@example.test' }
    normalized[field] = null
    const result = evaluateRowEligibility(readyRow({ normalized }))
    assert.equal(result.eligible, false, `expected missing ${field} to block`)
    assert.equal(result.reasonCode, BLOCK_REASONS.MISSING_MATERIAL_FIELD)
  }
})

test('status "void" is blocked explicitly, never silently converted', () => {
  const result = evaluateRowEligibility(
    readyRow({ normalized: { ...readyRow().normalized, status: 'void' } })
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.UNSUPPORTED_STATUS_VALUE)
})

test('an unknown status value blocks, distinct from the void case', () => {
  const result = evaluateRowEligibility(
    readyRow({ normalized: { ...readyRow().normalized, status: 'cancelled' } })
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.UNKNOWN_STATUS_VALUE)
})

test('other known status values (draft/sent/paid/partial/overdue) are not blocked by the status check', () => {
  for (const status of ['draft', 'sent', 'partial', 'overdue', null]) {
    const result = evaluateRowEligibility(
      readyRow({ normalized: { ...readyRow().normalized, status } })
    )
    assert.equal(result.eligible, true, `expected status=${status} to be eligible`)
  }
  const paidResult = evaluateRowEligibility(
    readyRow({ normalized: { ...readyRow().normalized, status: 'paid', amount_paid: '100.00' } })
  )
  assert.equal(paidResult.eligible, true)
})

test('an invalid invoice_date value blocks', () => {
  const result = evaluateRowEligibility(
    readyRow({ normalized: { ...readyRow().normalized, invoice_date: '2026-13-40' } })
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.INVALID_DATE_VALUE)
})

test('an invalid due_date or payment_date value blocks even though those fields are optional', () => {
  const badDue = evaluateRowEligibility(
    readyRow({ normalized: { ...readyRow().normalized, due_date: 'not-a-date' } })
  )
  assert.equal(badDue.eligible, false)
  assert.equal(badDue.reasonCode, BLOCK_REASONS.INVALID_DATE_VALUE)

  const badPayment = evaluateRowEligibility(
    readyRow({ normalized: { ...readyRow().normalized, status: 'paid', amount_paid: '100.00', payment_date: '02/30/2026' } })
  )
  assert.equal(badPayment.eligible, false)
  assert.equal(badPayment.reasonCode, BLOCK_REASONS.INVALID_DATE_VALUE)
})

test('a non-decimal-string amount blocks', () => {
  for (const amount of ['100', '100.0', '100.000', 'abc', '1,000.00']) {
    const result = evaluateRowEligibility(readyRow({ normalized: { ...readyRow().normalized, amount } }))
    assert.equal(result.eligible, false, `expected amount=${amount} to block`)
    assert.equal(result.reasonCode, BLOCK_REASONS.INVALID_AMOUNT_VALUE)
  }
})

test('a zero or negative amount blocks', () => {
  for (const amount of ['0.00', '-5.00']) {
    const result = evaluateRowEligibility(readyRow({ normalized: { ...readyRow().normalized, amount } }))
    assert.equal(result.eligible, false, `expected amount=${amount} to block`)
    assert.equal(result.reasonCode, BLOCK_REASONS.NON_POSITIVE_AMOUNT)
  }
})

test('an unsupported currency blocks', () => {
  const result = evaluateRowEligibility(readyRow({ normalized: { ...readyRow().normalized, currency: 'XYZ' } }))
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.UNSUPPORTED_CURRENCY)
})

test('every supported currency is accepted', () => {
  for (const currency of ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD']) {
    const result = evaluateRowEligibility(readyRow({ normalized: { ...readyRow().normalized, currency } }))
    assert.equal(result.eligible, true, `expected currency=${currency} to be eligible`)
  }
})

test('amount_paid greater than amount blocks', () => {
  const result = evaluateRowEligibility(
    readyRow({ normalized: { ...readyRow().normalized, amount: '100.00', amount_paid: '150.00' } })
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.AMOUNT_PAID_OUT_OF_RANGE)
})

test('a negative amount_paid blocks', () => {
  const result = evaluateRowEligibility(
    readyRow({ normalized: { ...readyRow().normalized, amount_paid: '-10.00' } })
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.AMOUNT_PAID_OUT_OF_RANGE)
})

test('a malformed amount_paid value blocks', () => {
  const result = evaluateRowEligibility(
    readyRow({ normalized: { ...readyRow().normalized, amount_paid: 'lots' } })
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.INVALID_AMOUNT_PAID_VALUE)
})

test('status paid with a partial amount_paid is a contradiction and blocks', () => {
  const result = evaluateRowEligibility(
    readyRow({ normalized: { ...readyRow().normalized, amount: '100.00', status: 'paid', amount_paid: '40.00' } })
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.PAID_STATUS_AMOUNT_MISMATCH)
})

test('status paid with no amount_paid supplied is not a contradiction (defaults to full amount downstream)', () => {
  const result = evaluateRowEligibility(
    readyRow({ normalized: { ...readyRow().normalized, amount: '100.00', status: 'paid' } })
  )
  assert.equal(result.eligible, true)
})

test('weak identity (name/company/phone only, no email, no source identity) blocks', () => {
  const result = evaluateRowEligibility(
    readyRow({ normalized: { invoice_number: 'INV-1', invoice_date: '2026-01-01', amount: '100.00', client_name: 'Acme', client_company: 'Acme Co', client_phone: '555-1234' } })
  )
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.WEAK_CLIENT_IDENTITY)
})

test('strong identity via source_system + source_client_id is sufficient without an email', () => {
  const result = evaluateRowEligibility(
    readyRow({
      normalized: {
        invoice_number: 'INV-1',
        invoice_date: '2026-01-01',
        amount: '100.00',
        source_system: 'stripe',
        source_client_id: 'cus_123',
      },
    })
  )
  assert.equal(result.eligible, true)
})

test('source_system without source_client_id (or vice versa) is not strong identity', () => {
  const onlySystem = evaluateRowEligibility(
    readyRow({
      normalized: { invoice_number: 'INV-1', invoice_date: '2026-01-01', amount: '100.00', source_system: 'stripe' },
    })
  )
  assert.equal(onlySystem.eligible, false)
  assert.equal(onlySystem.reasonCode, BLOCK_REASONS.WEAK_CLIENT_IDENTITY)

  const onlyExternalId = evaluateRowEligibility(
    readyRow({
      normalized: { invoice_number: 'INV-1', invoice_date: '2026-01-01', amount: '100.00', source_client_id: 'cus_123' },
    })
  )
  assert.equal(onlyExternalId.eligible, false)
  assert.equal(onlyExternalId.reasonCode, BLOCK_REASONS.WEAK_CLIENT_IDENTITY)
})

test('file-level rejected blocks persistence regardless of any row', () => {
  const result = evaluateFileEligibility({ outcome: 'rejected', fileIssues: [{ code: 'EMPTY_FILE' }], rows: [] })
  assert.equal(result.eligible, false)
  assert.equal(result.reasonCode, BLOCK_REASONS.FILE_LEVEL_REJECTED)
})

test('file-level rejected via non-empty fileIssues (outcome null) also blocks', () => {
  const result = evaluateFileEligibility({ outcome: null, fileIssues: [{ code: 'DUPLICATE_HEADER' }], rows: [] })
  assert.equal(result.eligible, false)
})

test('a normal per-row file passes the file-level gate', () => {
  const result = evaluateFileEligibility({ outcome: null, fileIssues: [], rows: [readyRow()] })
  assert.equal(result.eligible, true)
})

test('evaluateAllRows splits eligible/blocked correctly and short-circuits on file rejection', () => {
  const fileRejected = evaluateAllRows({ outcome: 'rejected', fileIssues: [{ code: 'EMPTY_FILE' }], rows: [readyRow()] })
  assert.equal(fileRejected.eligible.length, 0)
  assert.equal(fileRejected.blocked.length, 0)
  assert.ok(fileRejected.fileBlocked)

  const mixed = evaluateAllRows(
    {
      outcome: null,
      fileIssues: [],
      rows: [
        readyRow(),
        readyRow({ outcome: 'review_required' }),
        readyRow({ outcome: 'ready_with_warnings', issues: [{ code: 'FORMULA_CACHED_VALUE_USED' }] }),
      ],
    },
    { warningsAcknowledged: true }
  )
  assert.equal(mixed.eligible.length, 2)
  assert.equal(mixed.blocked.length, 1)
  assert.equal(mixed.blocked[0].reasonCode, BLOCK_REASONS.REVIEW_REQUIRED)
  assert.equal(mixed.fileBlocked, null)
})
