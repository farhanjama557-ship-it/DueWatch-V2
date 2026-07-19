// Shared formatting + date helpers for the dashboard.

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatMoney(value) {
  const n = Number(value) || 0
  return currency.format(n)
}

// Local midnight for "today" so date comparisons ignore time-of-day.
export function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

// Parse a Postgres `date` (YYYY-MM-DD) as a local date, not UTC.
export function parseDate(value) {
  if (!value) return null
  const [y, m, d] = String(value).split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Whole days a due date is past today. Positive = overdue, <=0 = not overdue.
export function daysOverdue(dueValue, today = startOfToday()) {
  const due = parseDate(dueValue)
  if (!due) return 0
  return Math.round((today - due) / MS_PER_DAY)
}

// Whole days until a due date. Positive = upcoming.
export function daysUntil(dueValue, today = startOfToday()) {
  const due = parseDate(dueValue)
  if (!due) return null
  return Math.round((due - today) / MS_PER_DAY)
}
