// Pure draft/explanation generation for Autopilot-queued reminders. Mirrors
// the tone templates in src/components/InvoiceDetailPanel.jsx — duplicated
// rather than shared, since this runs in Deno and that runs in the browser
// bundle; keep the two in sync if the wording changes.

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
  return (
    `Hi ${clientName},\n\n` +
    `This is a friendly reminder that invoice ${num} for ${balance} was due ${dueDate}.\n\n` +
    `Please let us know if payment is already on its way.\n\nThank you.`
  )
}

// Plain-language reason shown on the Signature Card ("Autopilot recommends").
export function explainRule(rule, { daysOverdueCount, daysUntilCount }) {
  if (rule.trigger_type === 'before_due') {
    return `Due in ${daysUntilCount} ${daysUntilCount === 1 ? 'day' : 'days'} — a heads-up before the deadline.`
  }
  if (rule.trigger_days >= 30) {
    return `${daysOverdueCount} days overdue. A final notice is recommended.`
  }
  if (rule.trigger_days >= 15) {
    return `${daysOverdueCount} days overdue. A firmer tone is recommended.`
  }
  return `${daysOverdueCount} ${daysOverdueCount === 1 ? 'day' : 'days'} overdue. A follow-up is recommended.`
}
