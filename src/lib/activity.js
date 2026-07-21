// Shared event -> display mapping for Recent Activity (Morning Brief) and
// the Activity Log screen. `actor` distinguishes what Duewatch did on its
// own versus what the founder explicitly did.
export const ACTIVITY_META = {
  reminder_opened: { title: 'Drafted a reminder', actor: 'Duewatch', tone: 'blue', group: 'reminders' },
  reminder_sent: { title: 'Sent a reminder', actor: 'Duewatch', tone: 'blue', group: 'reminders' },
  payment_recorded: { title: 'Recorded a payment', actor: 'You', tone: 'green', group: 'payments' },
  invoice_marked_paid: { title: 'Marked invoice paid', actor: 'You', tone: 'green', group: 'payments' },
  invoice_created: { title: 'Created an invoice', actor: 'You', tone: 'blue', group: 'invoices' },
}

export function activityMeta(eventType) {
  return ACTIVITY_META[eventType] || { title: eventType, actor: 'You', tone: 'blue', group: 'invoices' }
}

export function activityDescription(event) {
  const client = event.invoices?.clients?.name
  const num = event.invoices?.inv_num
  if (client && num) return `${client} · ${num}`
  return client || num || ''
}

export function isPaymentEvent(event) {
  return activityMeta(event.event_type).group === 'payments'
}
