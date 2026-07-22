import { supabase } from './supabase'

// Approve & Send: sends the draft as a real reminder, then resolves the
// awaiting_signature row. Does not log the event — the caller does, since
// the evidence (reason/trigger) differs between the card and the Edit-First
// drawer.
export async function approveSignature({ id, invoiceId, userId, draftContent }) {
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

  return { error: null }
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
