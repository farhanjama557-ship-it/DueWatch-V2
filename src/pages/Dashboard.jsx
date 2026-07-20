import { useState, useMemo } from 'react'
import { useData, isOutstanding, balanceOf, effectiveStatus } from '../context/DataContext'
import Avatar from '../components/Avatar'
import StatusPill from '../components/StatusPill'
import InvoiceDetailPanel from '../components/InvoiceDetailPanel'
import { recommendFor } from '../lib/recommend'
import {
  formatMoney,
  formatLongDate,
  formatShortDate,
  daysOverdue,
  daysUntil,
  timeAgo,
} from '../lib/format'
import {
  OutstandingIcon,
  ExpectedIcon,
  AttentionIcon,
  RemindersIcon,
  SparkleIcon,
  CheckIcon,
} from '../components/icons'

function KpiCard({ Icon, label, value, valueColor, support }) {
  return (
    <div className="kpi-card">
      <div className="kpi-top">
        <Icon className="kpi-icon" />
        <span className="kpi-label">{label}</span>
      </div>
      <div className="kpi-value" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </div>
      <div className="kpi-support">{support}</div>
    </div>
  )
}

function InvoiceRow({ invoice, secondary, onClick, onDraft, recommendation }) {
  return (
    <li
      className={recommendation ? 'invoice-row invoice-row-col' : 'invoice-row'}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
    >
      <div className="invoice-row-line">
        <Avatar name={invoice.clients?.name} size={36} />
        <div className="invoice-main">
          <span className="invoice-client">{invoice.clients?.name || 'No client'}</span>
          <span className="invoice-secondary">{secondary}</span>
        </div>
        <StatusPill status={effectiveStatus(invoice)} />
        <span className="invoice-amount">{formatMoney(balanceOf(invoice))}</span>
        {onDraft && (
          <button
            className="row-action"
            onClick={(e) => {
              e.stopPropagation()
              onDraft()
            }}
          >
            Draft Reminder
          </button>
        )}
      </div>

      {recommendation && (
        <div className="invoice-reco">
          <SparkleIcon className="reco-icon" width={16} height={16} />
          <div className="reco-text">
            <span className="reco-action">{recommendation.action}</span>
            <span className="reco-explanation">{recommendation.explanation}</span>
          </div>
          {recommendation.badge && (
            <span className={`reco-badge tone-${recommendation.tone}`}>{recommendation.badge}</span>
          )}
        </div>
      )}
    </li>
  )
}

const HANDLED_LABELS = {
  reminder_sent: 'Reminder sent',
  payment_recorded: 'Payment recorded',
  invoice_marked_paid: 'Invoice marked paid',
}

function WatchingCard({ count, outstandingTotal, remindersSent }) {
  return (
    <section className="watching-card">
      <span className="watching-dot" aria-hidden="true" />
      <div className="watching-body">
        <div className="watching-title">
          Watching {count} {count === 1 ? 'invoice' : 'invoices'}
        </div>
        <div className="watching-sub">
          Monitoring {formatMoney(outstandingTotal)} outstanding
          {' · '}
          {remindersSent} {remindersSent === 1 ? 'reminder' : 'reminders'} sent this week
          {' · '}
          next check tomorrow morning
        </div>
      </div>
      <span className="watching-badge">Active</span>
    </section>
  )
}

function HandledForYou({ events }) {
  const handled = events.filter((e) => HANDLED_LABELS[e.event_type])
  return (
    <section className="brief-card">
      <div className="section-head">
        <h2 className="section-title">Handled for you</h2>
      </div>
      {handled.length === 0 ? (
        <p className="brief-empty">Nothing has been handled yet.</p>
      ) : (
        <ul className="handled-list">
          {handled.map((e) => {
            const client = e.invoices?.clients?.name || 'a client'
            const num = e.invoices?.inv_num
            return (
              <li key={e.id} className="handled-item">
                <span className="handled-check">
                  <CheckIcon width={13} height={13} />
                </span>
                <div className="handled-text">
                  <span className="handled-action">{HANDLED_LABELS[e.event_type]}</span>
                  <span className="handled-context">
                    {client}
                    {num ? ` · ${num}` : ''}
                  </span>
                </div>
                <span className="handled-time">{timeAgo(e.created_at)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export default function Dashboard() {
  const { invoices, events, name, loading, error, refresh } = useData()
  const [selected, setSelected] = useState(null)

  const derived = useMemo(() => {
    const outstanding = invoices.filter(isOutstanding)

    const DUE_SOON_DAYS = 14

    let outstandingTotal = 0
    let expectedSoon = 0
    const needsAttention = []
    const dueSoon = []

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    let remindersSent = 0

    for (const inv of outstanding) {
      const bal = balanceOf(inv)
      outstandingTotal += bal

      if (inv.last_reminder && new Date(inv.last_reminder).getTime() >= weekAgo) {
        remindersSent += 1
      }

      const overdueBy = daysOverdue(inv.due_date)
      const until = daysUntil(inv.due_date)

      if (overdueBy > 0) {
        needsAttention.push(inv)
      } else if (until !== null && until >= 0 && until <= DUE_SOON_DAYS) {
        expectedSoon += bal
        dueSoon.push(inv)
      }
    }

    needsAttention.sort((a, b) => daysOverdue(b.due_date) - daysOverdue(a.due_date))
    dueSoon.sort((a, b) => daysUntil(a.due_date) - daysUntil(b.due_date))

    return {
      outstandingTotal,
      expectedSoon,
      needsAttention,
      dueSoon,
      remindersSent,
      outstandingCount: outstanding.length,
    }
  }, [invoices])

  if (loading) {
    return <div className="brief-loading">Loading your brief…</div>
  }

  if (error) {
    return <div className="brief-error">Couldn&apos;t load your brief: {error}</div>
  }

  const attentionCount = derived.needsAttention.length
  const summary =
    attentionCount === 0
      ? 'Everything is handled — nothing needs a decision.'
      : `${attentionCount} ${attentionCount === 1 ? 'invoice needs' : 'invoices need'} a decision — everything else is handled.`

  const hasAnyInvoices = invoices.length > 0

  return (
    <div className="brief">
      <h1 className="brief-greeting">Good morning, {name}.</h1>
      <p className="brief-subline">
        {formatLongDate()} &nbsp;·&nbsp; {summary}
      </p>

      <WatchingCard
        count={derived.outstandingCount}
        outstandingTotal={derived.outstandingTotal}
        remindersSent={derived.remindersSent}
      />

      {/* KPI cards */}
      <section className="kpi-grid">
        <KpiCard
          Icon={OutstandingIcon}
          label="Outstanding"
          value={formatMoney(derived.outstandingTotal)}
          support={`across ${derived.outstandingCount} ${derived.outstandingCount === 1 ? 'invoice' : 'invoices'}`}
        />
        <KpiCard
          Icon={ExpectedIcon}
          label="Expected Soon"
          value={formatMoney(derived.expectedSoon)}
          valueColor="var(--primary)"
          support="due within 14 days"
        />
        <KpiCard
          Icon={AttentionIcon}
          label="Need Attention"
          value={attentionCount}
          valueColor="var(--amber)"
          support={attentionCount === 1 ? 'overdue invoice' : 'overdue invoices'}
        />
        <KpiCard
          Icon={RemindersIcon}
          label="Reminders Sent"
          value={derived.remindersSent}
          support="this week"
        />
      </section>

      {!hasAnyInvoices ? (
        <section className="brief-card">
          <p className="brief-empty">No invoices yet.</p>
        </section>
      ) : (
        <>
          {/* Needs Attention — with rule-based recommendations */}
          <section className="brief-card">
            <div className="section-head">
              <h2 className="section-title">Needs attention</h2>
              {attentionCount > 0 && <span className="section-count">{attentionCount}</span>}
            </div>
            {attentionCount === 0 ? (
              <p className="brief-empty">No overdue invoices. You&apos;re all caught up.</p>
            ) : (
              <ul className="invoice-list">
                {derived.needsAttention.map((inv) => {
                  const od = daysOverdue(inv.due_date)
                  return (
                    <InvoiceRow
                      key={inv.id}
                      invoice={inv}
                      secondary={`${od} ${od === 1 ? 'day' : 'days'} overdue · ${inv.invoice_number || 'No number'}`}
                      onClick={() => setSelected(inv)}
                      onDraft={() => setSelected(inv)}
                      recommendation={recommendFor(inv)}
                    />
                  )
                })}
              </ul>
            )}
          </section>

          {/* Handled for you */}
          <HandledForYou events={events} />

          {/* Due Soon */}
          <section className="brief-card">
            <div className="section-head">
              <h2 className="section-title">Due Soon</h2>
            </div>
            {derived.dueSoon.length === 0 ? (
              <p className="brief-empty">Nothing due in the next 14 days.</p>
            ) : (
              <ul className="invoice-list">
                {derived.dueSoon.map((inv) => (
                  <InvoiceRow
                    key={inv.id}
                    invoice={inv}
                    secondary={`Due ${formatShortDate(inv.due_date)} · ${inv.invoice_number || 'No number'} · reminder scheduled`}
                    onClick={() => setSelected(inv)}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <InvoiceDetailPanel invoice={selected} onClose={() => setSelected(null)} onMutated={refresh} />
    </div>
  )
}
