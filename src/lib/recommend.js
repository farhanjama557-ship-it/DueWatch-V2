import { daysOverdue } from './format'

// Rule-based recommendation for an overdue invoice. No Claude API yet — this
// is a deterministic stand-in that mirrors the eventual AI recommendation
// shape: { action, explanation, badge, tone }.
export function recommendFor(inv) {
  const od = daysOverdue(inv.due_date)
  const hasReminder = Boolean(inv.last_reminder)
  const daysSinceReminder = inv.last_reminder
    ? Math.round((Date.now() - new Date(inv.last_reminder).getTime()) / 86400000)
    : null

  if (od > 30) {
    return {
      action: 'Send a final notice',
      explanation: `${od} days overdue. A final notice is recommended.`,
      badge: 'High priority',
      tone: 'red',
    }
  }

  if (od >= 15) {
    return {
      action: 'Send a firm reminder',
      explanation: `${od} days overdue. A firmer tone is recommended.`,
      badge: 'Firm',
      tone: 'orange',
    }
  }

  // 1–14 days overdue
  if (hasReminder) {
    return {
      action: 'Send a follow-up reminder',
      explanation:
        daysSinceReminder != null
          ? `Last reminder was ${daysSinceReminder} ${daysSinceReminder === 1 ? 'day' : 'days'} ago with no response.`
          : 'A follow-up reminder is recommended.',
      badge: 'Follow up',
      tone: 'amber',
    }
  }

  return {
    action: 'Send a friendly reminder today',
    explanation: `${od} ${od === 1 ? 'day' : 'days'} overdue — a gentle nudge should do it.`,
    badge: 'Low effort',
    tone: 'blue',
  }
}
