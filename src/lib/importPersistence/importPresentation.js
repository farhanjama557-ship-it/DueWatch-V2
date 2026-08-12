export const RUN_STATUS_PRESENTATION = Object.freeze({
  pending: { label: 'Not started', description: 'This import has not started processing yet.', terminal: false },
  in_progress: { label: 'In progress', description: 'Duewatch still has rows left to process.', terminal: false },
  completed: { label: 'Completed', description: 'Duewatch finished processing this import.', terminal: true },
  partially_completed: {
    label: 'Finished with blocked rows',
    description: 'Duewatch saved the rows it could and left other rows unchanged.',
    terminal: true,
  },
  failed: { label: 'Failed', description: 'This import ended before it could finish.', terminal: true },
  cancelled: {
    label: 'Cancelled',
    description: 'Cancellation is complete. Rows saved before cancellation remain saved.',
    terminal: true,
  },
})

const UNKNOWN_STATUS = Object.freeze({
  label: 'Unrecognized status',
  description: 'Duewatch does not recognize this persisted run status. No conclusion has been inferred.',
  terminal: false,
})

export function presentRunStatus(status) {
  return RUN_STATUS_PRESENTATION[status] || { ...UNKNOWN_STATUS, code: status || null }
}

export function isTerminalRunStatus(status) {
  return RUN_STATUS_PRESENTATION[status]?.terminal === true
}

export function formatRunCounts({ status, committedRows = 0, blockedRows = 0, pendingRows = 0 }) {
  const suffix = isTerminalRunStatus(status) ? '' : ' so far'
  return {
    saved: `${committedRows} saved${suffix}`,
    blocked: `${blockedRows} blocked${suffix}`,
    pending: `${pendingRows} pending`,
  }
}

const REASON_PRESENTATION = Object.freeze({
  REVIEW_REQUIRED: ['Review needed', 'This row was marked for review before saving, so Duewatch made no change.', 'Correct or confirm the source data, then import it again.'],
  REJECTED: ['Row rejected', 'The preview determined this row could not safely be imported.', 'Fix the source row and import it again.'],
  UNKNOWN_OUTCOME: ['Unrecognized row state', "Duewatch did not recognize the row's processing state and stopped it.", 'Retry with the current importer. Contact support if it repeats.'],
  OUTCOME_ISSUE_MISMATCH: ['Inconsistent row state', 'The row was marked ready but also contained issues inconsistent with that state.', 'Run the preview again from the source file.'],
  UNKNOWN_ISSUE_CODE: ['Unrecognized import issue', 'Duewatch received an issue code this version does not understand.', 'Retry with the current importer. Contact support if it remains.'],
  BLOCKING_ISSUE_ON_ELIGIBLE_OUTCOME: ['Blocking issue found', 'The row was described as eligible but contained an issue that prevents saving.', 'Review and correct the source row.'],
  UNAPPROVED_WARNING_CODE: ['Warning not approved for saving', "Duewatch recognized a nonblocking warning, but that warning is not on the server's approved-warning list.", 'Review the warning and import the row again after correcting the source if needed.'],
  WARNINGS_NOT_ACKNOWLEDGED: ['Warnings not confirmed', 'This row was ready with warnings, but saving those warnings was not explicitly approved for this import.', 'Start a new import and acknowledge the warnings if that is appropriate.'],
  MISSING_MATERIAL_FIELD: ['Required invoice information missing', 'Invoice number, invoice date, or amount was missing.', 'Add the missing information and import the row again.'],
  INVALID_DATE_VALUE: ['Invalid date', 'At least one required invoice, due, or payment date was invalid.', 'Correct the dates and import the row again.'],
  INVALID_AMOUNT_VALUE: ['Invalid invoice amount', 'The invoice amount was not in the supported numeric format.', 'Correct the amount and import the row again.'],
  NON_POSITIVE_AMOUNT: ['Amount must be above zero', 'The invoice amount was zero or negative.', 'Correct the amount and import the row again.'],
  UNSUPPORTED_CURRENCY: ['Currency not supported', 'The row used a currency the persistence contract does not support.', 'Select a supported currency and import the row again.'],
  INVALID_AMOUNT_PAID_VALUE: ['Invalid paid amount', 'The paid amount was not in the supported numeric format.', 'Correct the paid amount and import the row again.'],
  AMOUNT_PAID_OUT_OF_RANGE: ['Paid amount is out of range', 'The paid amount was negative or greater than the invoice amount.', 'Correct the payment amount and import the row again.'],
  UNSUPPORTED_STATUS_VALUE: ['Status cannot be saved', 'The status is known but has no safe Duewatch persistence representation.', 'Change the status only if that is factually correct, then import the row again.'],
  UNKNOWN_STATUS_VALUE: ['Status not recognized', 'Duewatch did not recognize the invoice status and made no change.', 'Correct the status and import the row again.'],
  PAID_STATUS_AMOUNT_MISMATCH: ['Payment details conflict', 'The row said paid, but its paid amount did not equal the invoice amount.', 'Correct the status or payment amount and import the row again.'],
  WEAK_CLIENT_IDENTITY: ['Stronger client identity required', 'The row lacked a client email or a complete external source identity.', 'Add a client email or source-system client ID, then import the row again.'],
  AMBIGUOUS_CLIENT_IDENTITY: ['Multiple clients could match', 'More than one client matched, so Duewatch selected none.', 'Review the Clients list, resolve the duplicate identity, then import the row again.'],
  MISSING_CLIENT_NAME: ['Client name missing', 'The canonical client flow could not create a client without a usable name.', 'Add the client name and import the row again.'],
  AMBIGUOUS_INVOICE_IDENTITY: ['Multiple invoices could match', 'More than one source-less invoice matched this client and invoice number, so Duewatch made no change.', 'Review the invoices, resolve the duplicate identity, then import the row again.'],
  INVOICE_MATERIAL_CONFLICT: ['Existing invoice has different details', 'The same invoice identity already exists with different material facts. Duewatch did not overwrite it.', 'Compare the existing invoice and source data before deciding what to change.'],
})

export const PERSISTED_REASON_CODES = Object.freeze(Object.keys(REASON_PRESENTATION))

export function presentBlockReason(code) {
  const normalized = typeof code === 'string' ? code.trim() : ''
  if (!normalized) {
    return {
      kind: 'missing',
      code: null,
      title: 'Reason not available',
      explanation: 'Duewatch stopped this row, but a structured reason is not available for this record.',
      action: 'Review the source data before trying again.',
      technicalDetail: null,
    }
  }

  const known = REASON_PRESENTATION[normalized]
  if (!known) {
    return {
      kind: 'unknown',
      code: normalized,
      title: 'Duewatch stopped this row',
      explanation: 'Duewatch stopped this row for a reason this version of the app does not recognize.',
      action: 'Review the source data and contact support before trying again.',
      technicalDetail: `Reason code: ${normalized}`,
    }
  }

  return {
    kind: 'known',
    code: normalized,
    title: known[0],
    explanation: known[1],
    action: known[2],
    technicalDetail: `Reason code: ${normalized}`,
  }
}

export function presentRowProvenance(row) {
  if (row?.server_status !== 'committed') return null
  const client = row.client_result === 'created'
    ? 'Created client'
    : row.client_result === 'matched'
      ? 'Matched existing client'
      : 'Client result not recorded'
  const invoice = row.invoice_result === 'inserted'
    ? 'Inserted invoice'
    : row.invoice_result === 'already_existed'
      ? 'Invoice already existed'
      : 'Invoice result not recorded'
  return {
    client,
    invoice,
    clientId: row.client_id || null,
    invoiceId: row.invoice_id || null,
    clientUnavailable: row.client_result != null && row.client_id == null,
    invoiceUnavailable: row.invoice_result != null && row.invoice_id == null,
  }
}

const EVENT_PRESENTATION = Object.freeze({
  run_created: 'Run created',
  batch_started: 'Batch started',
  client_matched: 'Existing client linked',
  client_created: 'Client created',
  invoice_inserted: 'Invoice inserted',
  invoice_already_existed: 'Existing invoice linked',
  row_blocked: 'Row blocked',
  batch_committed: 'Batch saved',
  batch_failed: 'Batch stopped',
  cancellation_requested: 'Cancellation requested',
  run_partially_completed: 'Run closed',
  run_completed: 'Run closed',
  run_failed: 'Run closed',
})

export function presentImportEvent(event) {
  const type = event?.event_type
  return {
    label: EVENT_PRESENTATION[type] || 'Import activity recorded',
    type: type || null,
    createdAt: event?.created_at || null,
  }
}
