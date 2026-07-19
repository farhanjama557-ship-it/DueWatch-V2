// Exact pill styles from the design spec, keyed by normalized status.
const STYLES = {
  sent: { label: 'Sent', color: '#3B82F6', bg: '#EBF2FE' },
  overdue: { label: 'Overdue', color: '#B45309', bg: '#FEF5E7' },
  firm: { label: 'Firm', color: '#C2540A', bg: '#FEF0E6' },
  final_notice: { label: 'Final Notice', color: '#C22B2B', bg: '#FDECEC' },
  paid: { label: 'Paid', color: '#15803D', bg: '#EAFAF0' },
}

function normalize(status) {
  return String(status || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
}

export default function StatusPill({ status, label }) {
  const key = normalize(status)
  const style = STYLES[key] || {
    label: label || status || 'Unknown',
    color: '#6B7280',
    bg: '#F1F2F4',
  }

  return (
    <span
      className="pill"
      style={{ color: style.color, background: style.bg }}
    >
      {label || style.label}
    </span>
  )
}
