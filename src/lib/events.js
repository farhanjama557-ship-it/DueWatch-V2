import { supabase } from './supabase'

/**
 * Fire-and-forget usage logging. Never blocks or throws in the caller —
 * a missing events table or a failed insert is swallowed with a warning.
 *
 * Event types: invoice_created, reminder_opened, reminder_sent,
 * payment_recorded, invoice_marked_paid.
 */
export function logEvent(eventType, { userId, invoiceId = null } = {}) {
  if (!userId || !eventType) return
  supabase
    .from('events')
    .insert({ user_id: userId, event_type: eventType, invoice_id: invoiceId })
    .then(({ error }) => {
      if (error) console.warn('event log failed:', error.message)
    })
}
