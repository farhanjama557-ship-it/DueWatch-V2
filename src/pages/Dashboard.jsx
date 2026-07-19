import { useMorningBrief } from '../hooks/useMorningBrief'
import { formatMoney } from '../lib/format'

function KpiCard({ label, value, accent }) {
  return (
    <div className="kpi-card">
      <div className="kpi-value" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      <div className="kpi-label">{label}</div>
    </div>
  )
}

function CheckIcon() {
  return (
    <svg
      className="check-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

export default function Dashboard() {
  const {
    loading,
    error,
    name,
    kpis,
    handled,
    needsAttention,
    dueIn7Days,
  } = useMorningBrief()

  if (loading) {
    return <div className="brief-loading">Loading your brief…</div>
  }

  if (error) {
    return (
      <div className="brief-error">
        Couldn&apos;t load your brief: {error}
      </div>
    )
  }

  return (
    <div className="brief">
      <h1 className="brief-greeting">Good morning, {name}.</h1>

      {/* KPI cards */}
      <section className="kpi-grid">
        <KpiCard label="Outstanding" value={formatMoney(kpis.outstanding)} />
        <KpiCard
          label="Expected This Week"
          value={formatMoney(kpis.expectedThisWeek)}
        />
        <KpiCard
          label="Invoices Need Attention"
          value={kpis.needAttention}
          accent={kpis.needAttention > 0 ? 'var(--red)' : undefined}
        />
        <KpiCard label="Reminders Sent" value={kpis.remindersSent} />
      </section>

      {/* Handled for you */}
      <section className="brief-card">
        <h2 className="brief-card-title">Handled for you</h2>
        {handled.length === 0 ? (
          <p className="brief-empty">Nothing handled automatically yet.</p>
        ) : (
          <ul className="handled-list">
            {handled.map((item, i) => (
              <li key={i} className="handled-item">
                <CheckIcon />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Needs Attention */}
      <section className="brief-card">
        <h2 className="brief-card-title">Needs Attention</h2>
        {needsAttention.length === 0 ? (
          <p className="brief-empty">No overdue invoices. You&apos;re all caught up.</p>
        ) : (
          <ul className="invoice-list">
            {needsAttention.map((inv) => (
              <li key={inv.id} className="invoice-row">
                <span className="invoice-client">{inv.clientName}</span>
                <span className="invoice-meta invoice-overdue">
                  {inv.overdueBy} {inv.overdueBy === 1 ? 'day' : 'days'} overdue
                </span>
                <span className="invoice-amount">{formatMoney(inv.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Due in 7 Days */}
      <section className="brief-card">
        <h2 className="brief-card-title">Due in 7 Days</h2>
        {dueIn7Days.length === 0 ? (
          <p className="brief-empty">Nothing due in the next 7 days.</p>
        ) : (
          <ul className="invoice-list">
            {dueIn7Days.map((inv) => (
              <li key={inv.id} className="invoice-row">
                <span className="invoice-client">{inv.clientName}</span>
                <span className="invoice-meta">
                  {inv.until === 0
                    ? 'Due today'
                    : `Due in ${inv.until} ${inv.until === 1 ? 'day' : 'days'}`}
                </span>
                <span className="invoice-amount">{formatMoney(inv.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
