import { daysOverdue, daysUntil } from './format.js'

// Mirrors the eligibility semantics in supabase/functions/_shared/rules.js
// (duplicated — that file runs in Deno, this runs in the browser). A rule's
// window opens and stays open (>= for after_due) rather than firing on a
// single exact day; a before_due rule closes permanently once the invoice
// goes overdue.
export function ruleMatches(rule, invoice, today) {
  if (invoice.paid) return false
  if (rule.trigger_type === 'before_due') {
    const until = daysUntil(invoice.due_date, today)
    return until !== null && until >= 0 && until <= rule.trigger_days
  }
  return daysOverdue(invoice.due_date, today) >= rule.trigger_days
}

/**
 * What Autopilot will do next for this invoice, given the founder's current
 * rule set — for the Invoice Detail panel's "next scheduled action" line
 * (and, as of Session 8, the Morning Brief's Top Invoices reason text).
 * Returns null if there's nothing to show (no enabled rules, or the invoice
 * is paid). `eligible: true` means the next daily check will act on it;
 * `eligible: false` means it's still `daysAway` days out.
 *
 * Among multiple currently-eligible rules (e.g. a 32-day-overdue invoice is
 * technically past its 5-day *and* 15-day *and* 30-day after-due
 * thresholds), this returns the most advanced one (largest trigger_days) —
 * not the first one in rule order. The real scheduler (_shared/rules.js)
 * additionally excludes rules already fired for this specific invoice via
 * `handledKeys`, which this browser-side mirror has no access to; picking
 * the most-advanced match is the closest honest approximation without that
 * history, and avoids describing a deeply overdue invoice as merely due for
 * its first follow-up.
 */
export function nextScheduledAction(rules, invoice, today = new Date()) {
  if (invoice.paid || !invoice.due_date) return null
  const enabled = (rules || []).filter((r) => r.enabled)
  if (enabled.length === 0) return null

  let soonest = null
  let mostAdvanced = null
  for (const rule of enabled) {
    if (rule.trigger_type === 'before_due') {
      const until = daysUntil(invoice.due_date, today)
      if (until === null || until < 0) continue // window has permanently closed
      if (until <= rule.trigger_days) {
        if (!mostAdvanced || rule.trigger_days > mostAdvanced.rule.trigger_days) {
          mostAdvanced = { rule, daysAway: 0, eligible: true }
        }
        continue
      }
      const daysAway = until - rule.trigger_days
      if (!soonest || daysAway < soonest.daysAway) soonest = { rule, daysAway, eligible: false }
    } else {
      const overdue = daysOverdue(invoice.due_date, today)
      if (overdue >= rule.trigger_days) {
        if (!mostAdvanced || rule.trigger_days > mostAdvanced.rule.trigger_days) {
          mostAdvanced = { rule, daysAway: 0, eligible: true }
        }
        continue
      }
      const daysAway = rule.trigger_days - overdue
      if (!soonest || daysAway < soonest.daysAway) soonest = { rule, daysAway, eligible: false }
    }
  }
  return mostAdvanced || soonest
}
