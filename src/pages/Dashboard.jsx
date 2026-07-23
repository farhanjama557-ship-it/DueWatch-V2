import { useState, useMemo, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useData, isOutstanding, balanceOf, effectiveStatus } from '../context/DataContext'
import Avatar from '../components/Avatar'
import StatusPill from '../components/StatusPill'
import InvoiceDetailPanel from '../components/InvoiceDetailPanel'
import SignatureSection from '../components/SignatureSection'
import CognitiveCompose from '../features/reminders/CognitiveCompose'
import { recommendFor } from '../lib/recommend'
import { activityMeta, activityDescription, activityIcon, isPaymentEvent } from '../lib/activity'
import {
  formatMoney,
  formatLongDate,
  formatShortDate,
  formatEventDate,
  daysOverdue,
  daysUntil,
} from '../lib/format'
import {
  OutstandingIcon,
  ExpectedIcon,
  AttentionIcon,
  RemindersIcon,
  SparkleIcon,
  ChevronDownIcon,
  ArrowRightIcon,
} from '../components/icons'

const NUDGE_DISMISS_KEY = 'duewatch_autopilot_nudge_dismissed_at'
const NUDGE_DISMISS_DAYS = 7

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
  // Collapsed by default — with several overdue invoices, an always-expanded
  // recommendation under every row made the section take up the whole page.
  const [expanded, setExpanded] = useState(false)

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
        {recommendation && (
          <button
            type="button"
            className="reco-toggle"
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((v) => !v)
            }}
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide recommendation' : 'Show recommendation'}
          >
            <SparkleIcon width={14} height={14} />
            <ChevronDownIcon
              className={expanded ? 'chevron chevron-open' : 'chevron'}
              width={13}
              height={13}
            />
          </button>
        )}
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

      {recommendation && expanded && (
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

// Autopilot Status card — ambient reassurance (Section 7 of the Session 7
// spec upgrades this with live scheduler data; that's a later build-order
// item, so this keeps its existing Session 6 content for now).
function WatchingCard({ count, outstandingTotal }) {
  return (
    <section className="watching-card">
      <span className="watching-dot" aria-hidden="true" />
      <div className="watching-body">
        <div className="watching-title">Everything else is handled.</div>
        <div className="watching-sub">
          {count} {count === 1 ? 'invoice' : 'invoices'} active
          {' · '}
          {formatMoney(outstandingTotal)} outstanding
          {' · '}
          Next check: Tomorrow morning
        </div>
      </div>
      <span className="watching-badge">Active</span>
      {/* Safety rail: the pause/kill switch must be reachable from here at
          all times — links to the management view with "Turn off Autopilot". */}
      <Link to="/autopilot" className="watching-manage-link">
        Manage
      </Link>
    </section>
  )
}

// Last 5 events, newest first, with payment events bubbled to the top of
// that recent window (still newest-first within each group).
function pickRecentActivity(events) {
  const recent = events.slice(0, 8)
  const payments = recent.filter(isPaymentEvent)
  const rest = recent.filter((e) => !isPaymentEvent(e))
  return [...payments, ...rest].slice(0, 5)
}

function RecentActivity({ events }) {
  const [expanded, setExpanded] = useState(false)

  if (events.length === 0) {
    return (
      <section className="brief-card">
        <div className="section-head">
          <h2 className="section-title">Recent Activity</h2>
        </div>
        <p className="brief-empty">Everything is handled. Nothing needs your attention today.</p>
      </section>
    )
  }

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const thisWeek = events.filter((e) => new Date(e.created_at).getTime() >= weekAgo)
  const reminderCount = thisWeek.filter((e) => e.event_type === 'reminder_sent').length
  const paymentCount = thisWeek.filter(isPaymentEvent).length

  const items = pickRecentActivity(events)

  return (
    <section className="brief-card">
      <button
        type="button"
        className="recent-activity-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="activity-summary">
          Duewatch drafted {reminderCount} {reminderCount === 1 ? 'reminder' : 'reminders'} and
          tracked {paymentCount} {paymentCount === 1 ? 'payment' : 'payments'} this week
        </span>
        <ChevronDownIcon className={expanded ? 'chevron chevron-open' : 'chevron'} width={18} height={18} />
      </button>

      {expanded && (
        <>
          <ul className="handled-list">
            {items.map((e) => {
              const meta = activityMeta(e.event_type)
              const desc = activityDescription(e)
              const { Icon, size, color } = activityIcon(e)
              return (
                <li key={e.id} className="handled-item">
                  <span className="handled-check">
                    <Icon size={size} color={color} />
                  </span>
                  <div className="handled-text">
                    <span className="handled-action">{meta.title}</span>
                    <span className="handled-context">{desc}</span>
                  </div>
                  <span className="handled-time">{formatEventDate(e.created_at)}</span>
                </li>
              )
            })}
          </ul>
          <Link to="/activity" className="see-all-link">
            See all activity <ArrowRightIcon width={14} height={14} />
          </Link>
        </>
      )}
    </section>
  )
}

function AutopilotNudge({ visible, onDismiss }) {
  if (!visible) return null
  return (
    <section className="autopilot-nudge">
      <span className="autopilot-nudge-icon">
        <SparkleIcon width={18} height={18} />
      </span>
      <div className="autopilot-nudge-text">
        <span className="autopilot-nudge-title">Duewatch can send reminders automatically</span>
      </div>
      <div className="autopilot-nudge-actions">
        <Link to="/autopilot" className="btn-terracotta btn-inline">
          Set up Autopilot
        </Link>
        <button type="button" className="nudge-dismiss" onClick={onDismiss}>
          Maybe later
        </button>
      </div>
    </section>
  )
}

export default function Dashboard() {
  const {
    invoices,
    events,
    name,
    loading,
    error,
    refresh,
    autopilotEnabled,
    awaitingSignature,
    resolveSignatureLocal,
  } = useData()
  const [selected, setSelected] = useState(null)
  const [signatureContext, setSignatureContext] = useState(null)
  const [composeInvoice, setComposeInvoice] = useState(null)
  const [nudgeDismissed, setNudgeDismissed] = useState(() => {
    const at = Number(localStorage.getItem(NUDGE_DISMISS_KEY))
    if (!at) return false
    return Date.now() - at < NUDGE_DISMISS_DAYS * 24 * 60 * 60 * 1000
  })

  // Sidebar "Awaiting your signature" indicator navigates here and asks to
  // scroll to the Signature section. Clear the state after handling it so
  // navigating away and back doesn't re-trigger the scroll.
  const signatureSectionRef = useRef(null)
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    if (location.state?.scrollToSignature && signatureSectionRef.current) {
      signatureSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
      navigate(location.pathname, { replace: true, state: {} })
    }
  }, [location, navigate])

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
  const awaitingCount = awaitingSignature.length

  // Locked subline hierarchy (Session 7 §2): Autopilot copy takes priority
  // whenever there's something awaiting signature; otherwise falls back to
  // the Session 6 needs-attention / all-handled copy.
  let summary
  if (awaitingCount > 0) {
    summary = `Autopilot is handling ${derived.outstandingCount} ${derived.outstandingCount === 1 ? 'invoice' : 'invoices'}. ${awaitingCount} need${awaitingCount === 1 ? 's' : ''} your signature.`
  } else if (attentionCount > 0) {
    summary = `${attentionCount} ${attentionCount === 1 ? 'invoice needs' : 'invoices need'} your attention. Everything else is handled.`
  } else {
    summary = 'Everything is handled. No follow-ups needed today.'
  }

  const hasAnyInvoices = invoices.length > 0

  const remindersSentAllTime = events.filter((e) => e.event_type === 'reminder_sent').length
  const showNudge =
    !autopilotEnabled && !nudgeDismissed && invoices.length >= 3 && remindersSentAllTime >= 2

  function dismissNudge() {
    localStorage.setItem(NUDGE_DISMISS_KEY, String(Date.now()))
    setNudgeDismissed(true)
  }

  function openEditFirst(item) {
    setSignatureContext(item)
    setSelected(item.invoice)
  }

  function closeDetailPanel() {
    setSelected(null)
    setSignatureContext(null)
  }

  return (
    <div className="brief">
      <h1 className="brief-greeting">Good morning, {name}.</h1>
      <p className="brief-subline">
        {formatLongDate()} &nbsp;·&nbsp; {summary}
      </p>

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

      {/* 1. Awaiting Your Signature — always first, hidden if empty. The
          wrapper (not SignatureSection itself, which renders null when
          empty) is the scroll target for the sidebar indicator. */}
      <div ref={signatureSectionRef}>
        <SignatureSection
          items={awaitingSignature}
          onResolved={resolveSignatureLocal}
          onEdit={openEditFirst}
        />
      </div>

      {!hasAnyInvoices ? (
        <section className="brief-card">
          <p className="brief-empty">No invoices yet.</p>
        </section>
      ) : (
        <>
          {/* 2. Needs Attention — manual/non-Autopilot items, with recommendations */}
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
                      onDraft={() => setComposeInvoice(inv)}
                      recommendation={recommendFor(inv)}
                    />
                  )
                })}
              </ul>
            )}
          </section>

          <AutopilotNudge visible={showNudge} onDismiss={dismissNudge} />

          {/* 3. Autopilot Status card — ambient reassurance */}
          <WatchingCard count={derived.outstandingCount} outstandingTotal={derived.outstandingTotal} />

          {/* 4. Recent Activity — collapsible, last 5 */}
          <RecentActivity events={events} />

          {/* Due Soon (pre-Session-7, kept as-is) */}
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

      <InvoiceDetailPanel
        invoice={selected}
        onClose={closeDetailPanel}
        onMutated={refresh}
        signatureContext={signatureContext}
        onSignatureResolved={resolveSignatureLocal}
      />

      {composeInvoice && (
        <CognitiveCompose
          invoice={composeInvoice}
          onClose={() => setComposeInvoice(null)}
          onSent={() => refresh()}
        />
      )}
    </div>
  )
}
