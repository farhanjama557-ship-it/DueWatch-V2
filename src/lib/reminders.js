import { supabase } from './supabase'

const MANUAL_OPERATION_STORAGE_PREFIX = 'duewatch:manual-reminder-operation:'

function manualOperationFingerprint(invoiceId, subject, draft) {
  const text = `${invoiceId}\n${subject || ''}\n${draft}`
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`
}

function newOperationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  throw new Error('This browser cannot create a safe reminder operation identity.')
}

function manualOperationStorageKey(invoiceId) {
  return `${MANUAL_OPERATION_STORAGE_PREFIX}${invoiceId}`
}

export function getManualReminderOperationId({ invoiceId, subject = '', draft }) {
  if (!invoiceId) throw new Error('An invoice is required for reminder delivery.')
  const fingerprint = manualOperationFingerprint(invoiceId, subject, draft)
  const key = manualOperationStorageKey(invoiceId)

  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(key) || 'null')
    if (stored?.fingerprint === fingerprint && typeof stored?.operationId === 'string') {
      return stored.operationId
    }
  } catch {
    // Corrupt/unavailable storage must never invent success; create a fresh
    // operation identity below and let the server's unresolved-message guard
    // block a duplicate if an earlier provider outcome is still unknown.
  }

  const operationId = newOperationId()
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify({ fingerprint, operationId }))
  } catch {
    // The current in-memory send still has a stable operationId. If storage
    // is unavailable, the server's same-message unresolved guard remains the
    // fail-closed protection across a reload.
  }
  return operationId
}

export function clearManualReminderOperationId(invoiceId, operationId) {
  const key = manualOperationStorageKey(invoiceId)
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(key) || 'null')
    if (!operationId || stored?.operationId === operationId) globalThis.localStorage?.removeItem(key)
  } catch {
    // Nothing else to do: deleting a browser convenience receipt is not a
    // prerequisite for server-side idempotency.
  }
}

export const TONES = ['friendly', 'professional', 'firm']

export function reminderDraft(tone, { clientName, invoiceNumber, balance, dueDate }) {
  const num = invoiceNumber || 'your invoice'
  if (tone === 'professional') {
    return (
      `Dear ${clientName},\n\n` +
      `I hope this finds you well. Our records show invoice ${num} for ${balance}, due ${dueDate}, ` +
      `remains outstanding.\n\n` +
      `Please let us know if you have any questions, or if payment has already been sent.\n\nBest regards.`
    )
  }
  if (tone === 'firm') {
    return (
      `Hi ${clientName},\n\n` +
      `Invoice ${num} for ${balance} was due ${dueDate} and remains unpaid. Please arrange payment ` +
      `as soon as possible.\n\n` +
      `If you believe this is an error, please reach out right away.`
    )
  }
  // friendly (default)
  return (
    `Hi ${clientName},\n\n` +
    `This is a friendly reminder that invoice ${num} for ${balance} was due ${dueDate}.\n\n` +
    `Please let us know if payment is already on its way.\n\nThank you.`
  )
}

/**
 * The one real place a reminder actually gets sent. Shared by
 * InvoiceDetailPanel's "Edit First" flow and CognitiveCompose's
 * manual-draft flow so there is exactly one send path, not two drifting
 * copies of it — but the two flows are NOT the same underlying safety
 * case, so they route differently below.
 *
 * `signatureContext`: pass the awaiting_signature row when this send
 * resolves an Autopilot-recommended draft ("Edit First" — same rule-backed
 * approval flow as unedited "Approve & Send", just with founder-edited
 * wording). Post-2A.1 execution safety checkpoint (second review-fix
 * pass): this now routes through send-reminder-email's approval-backed
 * `{ awaitingSignatureId, editedBody }` path — the SAME durable execution
 * boundary Approve & Send uses — instead of the legacy ad-hoc
 * `{ invoiceId, body }` path. The server loads the tenant/invoice/rule
 * authority basis and re-verifies it (plus the persisted material-fact
 * snapshot) from the awaiting_signature row itself; the browser supplies
 * only the (possibly edited) wording, never identity/authority. The
 * reminders/invoices/awaiting_signature/events writes now happen
 * server-side, atomically with the real outcome — this function no longer
 * performs them or guesses the outcome via a client-side event log.
 *
 * Omit `signatureContext` for a founder-initiated draft with no queued
 * signature request behind it (CognitiveCompose) — that ad-hoc path is
 * explicitly unchanged, out of scope for the execution-claim boundary.
 */
export async function sendReminderNow({ userId, invoice, draft, signatureContext = null }) {
  const trimmed = draft.trim()
  if (!trimmed) return { error: 'The reminder message is empty.' }

  if (signatureContext) {
    const { data: result, error: invokeErr } = await supabase.functions.invoke('send-reminder-email', {
      body: { awaitingSignatureId: signatureContext.id, editedBody: trimmed },
    })
    if (invokeErr || result?.error) {
      return { error: result?.error || invokeErr.message }
    }
    return { sendResult: result, nowIso: new Date().toISOString(), draft: trimmed }
  }

  const operationId = getManualReminderOperationId({
    invoiceId: invoice.id,
    draft: trimmed,
  })
  const { data: sendResult, error: sendErr } = await supabase.functions.invoke(
    'send-reminder-email',
    { body: { invoiceId: invoice.id, body: trimmed, operationId } }
  )
  if (sendErr || sendResult?.error) {
    if (sendResult?.code === 'SEND_FAILED' || sendResult?.code === 'OPERATION_CONFLICT') {
      clearManualReminderOperationId(invoice.id, operationId)
    }
    return { error: sendResult?.error || sendErr.message }
  }

  clearManualReminderOperationId(invoice.id, operationId)

  // The Edge Function now owns the canonical execution receipt AND the
  // reminder/invoice/activity projections. The browser must never perform
  // those writes after an external send, because a browser failure would
  // make a successful email look retryable and could create duplicates.
  return {
    sendResult,
    nowIso: new Date().toISOString(),
    draft: trimmed,
    projectionComplete: sendResult?.projectionComplete !== false,
  }
}
