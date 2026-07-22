import { supabase } from './supabase'

/**
 * Fire-and-forget usage logging. Never blocks or throws in the caller —
 * a missing events table or a failed insert is swallowed with a warning.
 *
 * Event types: invoice_created, reminder_opened, reminder_sent,
 * reminder_skipped, payment_recorded, invoice_marked_paid.
 *
 * `lifecycleStage`/`lifecycleState`/`evidence` are optional (Session 7) —
 * omitting them leaves those columns null, so existing call sites are
 * unaffected. Evidence shape: { reason, trigger, approved_by }.
 */
export function logEvent(
  eventType,
  { userId, invoiceId = null, lifecycleStage = null, lifecycleState = null, evidence = null } = {}
) {
  if (!userId || !eventType) return
  const payload = { user_id: userId, event_type: eventType, invoice_id: invoiceId }
  if (lifecycleStage) payload.lifecycle_stage = lifecycleStage
  if (lifecycleState) payload.lifecycle_state = lifecycleState
  if (evidence) payload.evidence = evidence
  supabase
    .from('events')
    .insert(payload)
    .then(({ error }) => {
      if (error) console.warn('event log failed:', error.message)
    })
}
