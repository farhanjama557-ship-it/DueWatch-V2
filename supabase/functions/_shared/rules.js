// Pure rule-matching logic — no Deno/Supabase imports, so this runs and
// tests identically under Node and under the Edge Function's Deno runtime.

export function parseDate(value) {
  if (!value) return null
  const [y, m, d] = String(value).split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

export function daysOverdue(dueValue, today) {
  const due = parseDate(dueValue)
  if (!due) return 0
  return Math.round((today - due) / MS_PER_DAY)
}

export function daysUntil(dueValue, today) {
  const due = parseDate(dueValue)
  if (due == null) return null
  return Math.round((due - today) / MS_PER_DAY)
}

// A rule's eligibility window is open-ended once it starts (>= for after_due,
// <= for before_due while not yet overdue) rather than an exact single day.
// This is what makes the "cap 10 per run, queue the rest for tomorrow" safety
// rail actually work: a deferred match is still eligible on the next run,
// instead of silently missing its one-day window forever.
export function ruleMatches(rule, invoice, today) {
  if (invoice.paid) return false
  if (rule.trigger_type === 'before_due') {
    const until = daysUntil(invoice.due_date, today)
    return until !== null && until >= 0 && until <= rule.trigger_days
  }
  // after_due
  return daysOverdue(invoice.due_date, today) >= rule.trigger_days
}

/**
 * Decides what the scheduler should act on this run.
 *
 * @param invoices - unpaid invoices for one user
 * @param rules - that user's enabled autopilot_rules, in priority order
 * @param handledKeys - Set of "invoiceId:ruleId" already queued/sent before
 *   (from prior awaiting_signature rows or reminder_sent events) — a rule
 *   fires at most once per invoice
 * @param pendingInvoiceIds - Set of invoice ids that already have a pending
 *   awaiting_signature row — only one open ask per invoice at a time
 * @param cap - max new items to act on this run (Resend rate-limit safety rail)
 */
export function planRun({ invoices, rules, handledKeys, pendingInvoiceIds, today, cap }) {
  const toProcess = []
  let deferred = 0

  for (const invoice of invoices) {
    if (invoice.paid) continue
    if (pendingInvoiceIds.has(invoice.id)) continue

    const matchedRule = rules.find(
      (r) => r.enabled && !handledKeys.has(`${invoice.id}:${r.id}`) && ruleMatches(r, invoice, today)
    )
    if (!matchedRule) continue

    if (toProcess.length < cap) {
      toProcess.push({ invoice, rule: matchedRule })
    } else {
      deferred += 1
    }
  }

  return { toProcess, deferred }
}
