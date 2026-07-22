import { LIFECYCLE_ICON, lifecycleKeyFor } from './lifecycle'

// Shared event -> display mapping for Recent Activity (Morning Brief) and
// the Activity Log screen. `actor` distinguishes what Duewatch did on its
// own versus what the founder explicitly did.
export const ACTIVITY_META = {
  reminder_opened: { title: 'Drafted a reminder', actor: 'Duewatch', group: 'reminders' },
  reminder_sent: { title: 'Sent a reminder', actor: 'Duewatch', group: 'reminders' },
  reminder_skipped: { title: 'Skipped a reminder', actor: 'You', group: 'reminders' },
  payment_recorded: { title: 'Recorded a payment', actor: 'You', group: 'payments' },
  invoice_marked_paid: { title: 'Marked invoice paid', actor: 'You', group: 'payments' },
  invoice_created: { title: 'Created an invoice', actor: 'You', group: 'invoices' },
}

export function activityMeta(eventType) {
  return ACTIVITY_META[eventType] || { title: eventType, actor: 'You', group: 'invoices' }
}

// Locked lifecycle icon (Session 7) for this event's stage.
export function activityIcon(event) {
  const key = lifecycleKeyFor(event.event_type)
  return LIFECYCLE_ICON[key] || LIFECYCLE_ICON.system
}

export function activityDescription(event) {
  const client = event.invoices?.clients?.name
  const num = event.invoices?.inv_num
  if (client && num) return `${client} · ${num}`
  return client || num || ''
}

// "Why it happened" — only present on events logged with lifecycle evidence
// (Session 7 onward). Older events degrade gracefully to no "why" line.
export function activityWhy(event) {
  return event.evidence?.reason || event.evidence?.trigger || null
}

export function activityApprovedBy(event) {
  return event.evidence?.approved_by || null
}

export function isPaymentEvent(event) {
  return activityMeta(event.event_type).group === 'payments'
}
