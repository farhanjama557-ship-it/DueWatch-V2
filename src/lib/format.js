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

// "Saturday, July 19, 2026"
export function formatLongDate(date = new Date()) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

// "Jul 19, 2026" — accepts a YYYY-MM-DD string or a Date.
export function formatShortDate(value) {
  const d = value instanceof Date ? value : parseDate(value)
  if (!d) return '—'
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// "Jul 19" — timeline-style, includes time if there is a timestamp.
export function formatEventDate(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Relative time: "just now", "3h ago", "2d ago".
export function timeAgo(value) {
  if (!value) return ''
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return ''
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

// Two-letter initials from a name: "Acme Corp" -> "AC", "Nova" -> "NO".
export function initials(name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return '—'
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase()
  }
  return (parts[0][0] + parts[1][0]).toUpperCase()
}
