import { supabase } from './supabase'

// Approve & Send: routes through the send-reminder-email Edge Function's
// approval-backed path (post-2A.1 execution safety checkpoint, BLOCKER 1).
// Only the awaiting_signature id is sent — the Edge Function loads the
// invoice/rule/draft and re-verifies current authority server-side, never
// trusting a browser-supplied invoiceId/draftContent, and acquires the
// same durable execution claim the scheduler's auto-send uses, so two
// rapid/concurrent approve attempts can send at most once. The Edge
// Function itself writes reminders/invoices.last_reminder/
// awaiting_signature.status/events atomically with the actual outcome —
// the browser no longer performs those writes itself. Returns { error }.
export async function approveSignature({ id }) {
  const { data: result, error: invokeErr } = await supabase.functions.invoke(
    'send-reminder-email',
    { body: { awaitingSignatureId: id } }
  )
  if (invokeErr || result?.error) {
    return { error: { message: result?.error || invokeErr.message } }
  }
  return { error: null, resendId: result?.id }
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
