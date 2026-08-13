import { supabase } from './supabase'
import { logEvent } from './events'

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

  const { data: sendResult, error: sendErr } = await supabase.functions.invoke(
    'send-reminder-email',
    { body: { invoiceId: invoice.id, body: trimmed } }
  )
  if (sendErr || sendResult?.error) {
    return { error: sendResult?.error || sendErr.message }
  }

  const nowIso = new Date().toISOString()
  const { error: remErr } = await supabase.from('reminders').insert({
    invoice_id: invoice.id,
    user_id: userId,
    title: 'Reminder sent',
    detail: trimmed,
  })
  if (remErr) return { error: remErr.message }

  await supabase.from('invoices').update({ last_reminder: nowIso }).eq('id', invoice.id)

  logEvent('reminder_sent', {
    userId,
    invoiceId: invoice.id,
    lifecycleStage: 'sent',
    lifecycleState: 'completed',
    evidence: { resend_id: sendResult?.id || null, delivery_status: 'sent' },
  })

  return { sendResult, nowIso, draft: trimmed }
}
