import { supabase } from './supabase'

// Approve & Send: sends the draft as a real email via the send-reminder-email
// Edge Function (the only place RESEND_API_KEY is used — never in the
// browser), then records the reminder and resolves the awaiting_signature
// row. Returns { error } — on send failure, nothing is written, so the card
// can show the error and the founder can retry.
export async function approveSignature({ id, invoiceId, userId, draftContent }) {
  const { data: sendResult, error: sendErr } = await supabase.functions.invoke(
    'send-reminder-email',
    { body: { invoiceId, body: draftContent } }
  )
  if (sendErr || sendResult?.error) {
    return { error: { message: sendResult?.error || sendErr.message } }
  }

  const nowIso = new Date().toISOString()

  const { error: remErr } = await supabase.from('reminders').insert({
    invoice_id: invoiceId,
    user_id: userId,
    title: 'Reminder sent',
    detail: draftContent,
  })
  if (remErr) return { error: remErr }

  const { error: invErr } = await supabase
    .from('invoices')
    .update({ last_reminder: nowIso })
    .eq('id', invoiceId)
  if (invErr) return { error: invErr }

  const { error: sigErr } = await supabase
    .from('awaiting_signature')
    .update({ status: 'approved', resolved_at: nowIso })
    .eq('id', id)
  if (sigErr) return { error: sigErr }

  return { error: null, resendId: sendResult?.id }
}

export async function skipSignature({ id, reason }) {
  const { error } = await supabase
    .from('awaiting_signature')
    .update({
      status: 'skipped',
      founder_note: reason || null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', id)
  return { error }
}
