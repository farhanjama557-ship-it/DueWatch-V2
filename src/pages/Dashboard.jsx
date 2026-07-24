import { useState, useMemo, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Bot, History, CalendarClock, CalendarCheck } from 'lucide-react'
import { useData, isOutstanding, balanceOf, effectiveStatus } from '../context/DataContext'
import Avatar from '../components/Avatar'
import StatusPill from '../components/StatusPill'
import InvoiceDetailPanel from '../components/InvoiceDetailPanel'
import SignatureSection from '../components/SignatureSection'
import CognitiveCompose from '../features/reminders/CognitiveCompose'
import { recommendFor } from '../lib/recommend'
import { ruleTiming } from '../lib/autopilot'
import { nextScheduledAction } from '../lib/ruleSchedule'
import { activityMeta, activityDescription, activityIcon, isPaymentEvent } from '../lib/activity'
import {
  formatMoney,
  formatShortDate,
  formatEventDate,
  daysOverdue,
  daysUntil,
} from '../lib/format'
import {
  OutstandingIcon,
  CollectedIcon,
  AttentionIcon,
  RemindersIcon,
  SparkleIcon,
  ArrowRightIcon,
} from '../components/icons'

const NUDGE_DISMISS_KEY = 'duewatch_autopilot_nudge_dismissed_at'
const NUDGE_DISMISS_DAYS = 7

function KpiCard({ Icon, label, value, valueColor, support, dominant }) {
  return (
    <div className={dominant ? 'kpi-card kpi-dominant' : 'kpi-card'}>
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

// Real Autopilot-rule-aware reason when one genuinely matches; otherwise the
// generic (still honest, just less specific) day-count heuristic.
function reasonFor(inv, autopilotEnabled, autopilotRules) {
  if (autopilotEnabled && autopilotRules.length > 0) {
    const match = nextScheduledAction(autopilotRules, inv)
    if (match?.eligible) {
      const toneTone = { friendly: 'blue', professional: 'blue', firm: 'orange' }
      return {
        action: `Autopilot: ${match.rule.name}`,
        explanation: `Matches your "${match.rule.name}" rule — ${ruleTiming(match.rule)}.`,
        badge: 'Autopilot rule',
        tone: toneTone[match.rule.tone] || 'blue',
      }
    }
  }
  return recommendFor(inv)
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
          {recommendation && (
            <span className="invoice-reason-inline">{recommendation.explanation}</span>
          )}
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
    </li>
  )
}

// Compact ambient status header for the dark rail — count + Active/off only.
// The scheduled-check content itself lives in the "Duewatch will do next"
// panel below, so this doesn't repeat it.
function RailStatus({ autopilotEnabled, outstandingCount, outstandingTotal }) {
  return (
    <section className="rail-status">
      <span className={autopilotEnabled ? 'rail-status-dot active' : 'rail-status-dot off'} aria-hidden="true" />
      <div className="rail-status-body">
        <div className="rail-status-title">
          <Bot size={16} /> Autopilot {autopilotEnabled ? 'is active' : 'is off'}
        </div>
        <div className="rail-status-sub">
          Watching {outstandingCount} {outstandingCount === 1 ? 'invoice' : 'invoices'}
          {' · '}
          {formatMoney(outstandingTotal)} outstanding
        </div>
      </div>
      <Link to="/autopilot" className="rail-status-link">
        Manage
      </Link>
    </section>
  )
}

function SinceLastVisit({ data }) {
  if (!data) return null
  const parts = []
  if (data.checked > 0) {
    parts.push(`Checked ${data.checked} ${data.checked === 1 ? 'invoice' : 'invoices'}`)
  }
  if (data.drafted > 0) {
    parts.push(`Drafted ${data.drafted} ${data.drafted === 1 ? 'reminder' : 'reminders'}`)
  }
  if (parts.length === 0) return null

  return (
    <section className="rail-section">
      <div className="rail-section-head">
        <History size={15} />
        <span>Since your last visit</span>
      </div>
      <p className="rail-section-line">{parts.join('. ')}.</p>
    </section>
  )
}

function WillDoNext({ autopilotEnabled, eligibleCount, outstandingCount }) {
  let line
  if (!autopilotEnabled) {
    line = 'Autopilot is off. Nothing is scheduled.'
  } else if (outstandingCount === 0) {
    line = 'Nothing scheduled beyond tomorrow’s check.'
  } else if (eligibleCount > 0) {
    line = `Next check is tomorrow morning. ${eligibleCount} ${eligibleCount === 1 ? 'invoice is' : 'invoices are'} ready for a reminder.`
  } else {
    line = 'Next check is tomorrow morning. Nothing new expected yet.'
  }

  return (
    <section className="rail-section">
      <div className="rail-section-head">
        <CalendarClock size={15} />
        <span>Duewatch will do next</span>
      </div>
      <p className="rail-section-line">{line}</p>
    </section>
  )
}

function Upcoming({ dueSoon }) {
  const items = dueSoon.slice(0, 4)
  return (
    <section className="rail-section">
      <div className="rail-section-head">
        <CalendarCheck size={15} />
        <span>Upcoming</span>
      </div>
      {items.length === 0 ? (
        <p className="rail-empty">Nothing due in the next 14 days.</p>
      ) : (
        <ul className="rail-upcoming-list">
          {items.map((inv) => {
            const until = daysUntil(inv.due_date)
            return (
              <li key={inv.id} className="rail-upcoming-item">
                <span className="rail-upcoming-client">{inv.clients?.name || 'No client'}</span>
                <span className="rail-upcoming-detail">
                  Due {until === 0 ? 'today' : until === 1 ? 'tomorrow' : `in ${until} days`}
                  {inv.last_reminder ? ' · reminder scheduled' : ''}
                </span>
              </li>
            )
          })}
        </ul>
      )}
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

function RailActivity({ events }) {
  if (events.length === 0) {
    return (
      <section className="rail-section">
        <div className="rail-section-head">
          <span>Evidence</span>
        </div>
        <p className="rail-empty">Everything is handled. Nothing needs your attention today.</p>
      </section>
    )
  }

  const items = pickRecentActivity(events)

  return (
    <section className="rail-section">
      <div className="rail-section-head">
        <span>Evidence</span>
      </div>
      <ul className="rail-activity-list">
        {items.map((e) => {
          const meta = activityMeta(e.event_type)
          const desc = activityDescription(e)
          const { Icon, size, color } = activityIcon(e)
          return (
            <li key={e.id} className="rail-activity-item">
              <span className="rail-activity-icon">
                <Icon size={size} color={color} />
              </span>
              <div className="rail-activity-text">
                <span className="rail-activity-action">{meta.title}</span>
                <span className="rail-activity-context">{desc}</span>
              </div>
              <span className="rail-activity-time">{formatEventDate(e.created_at)}</span>
            </li>
          )
        })}
      </ul>
      <Link to="/activity" className="see-all-link rail-see-all">
        See all activity <ArrowRightIcon width={14} height={14} />
      </Link>
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
    autopilotRules,
    awaitingSignature,
    resolveSignatureLocal,
    sinceLastVisit,
    collectedThisMonth,
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
  // scroll to the "Needs your approval" panel. Clear the state after
  // handling it so navigating away and back doesn't re-trigger the scroll.
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
    const needsAttention = []
    const dueSoon = []

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    let remindersSent = 0
    let eligibleForNextCheck = 0

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
        dueSoon.push(inv)
      }

      if (!inv.autopilot_paused && nextScheduledAction(autopilotRules, inv)?.eligible) {
        eligibleForNextCheck += 1
      }
    }

    needsAttention.sort((a, b) => daysOverdue(b.due_date) - daysOverdue(a.due_date))
    dueSoon.sort((a, b) => daysUntil(a.due_date) - daysUntil(b.due_date))

    return {
      outstandingTotal,
      needsAttention,
      dueSoon,
      remindersSent,
      outstandingCount: outstanding.length,
      eligibleForNextCheck,
    }
  }, [invoices, autopilotRules])

  if (loading) {
    return <div className="brief-loading">Loading your brief…</div>
  }

  if (error) {
    return <div className="brief-error">Couldn&apos;t load your brief: {error}</div>
  }

  const attentionCount = derived.needsAttention.length
  const awaitingCount = awaitingSignature.length
  const decisionsNeeded = attentionCount + awaitingCount

  // Narrative headline (Session 8 Morning Brief redesign) — every number
  // traces to a real query: collectedThisMonth (events.evidence.amount,
  // this calendar month), outstandingTotal (balance of unpaid invoices),
  // outstandingCount (Autopilot's watch list), decisionsNeeded (overdue +
  // awaiting-signature — things that need the founder specifically).
  const headline = `You collected ${formatMoney(collectedThisMonth)} this month. ${formatMoney(
    derived.outstandingTotal
  )} remains outstanding. Duewatch is handling ${derived.outstandingCount}, and ${decisionsNeeded} decision${
    decisionsNeeded === 1 ? '' : 's'
  } need${decisionsNeeded === 1 ? 's' : ''} you.`

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
      <p className="brief-subline">{headline}</p>

      <div className="brief-shell">
        {/* ---- White canvas: the business ---- */}
        <div className="brief-main">
          <section className="kpi-grid">
            <KpiCard
              Icon={OutstandingIcon}
              label="Outstanding"
              value={formatMoney(derived.outstandingTotal)}
              support={`across ${derived.outstandingCount} ${derived.outstandingCount === 1 ? 'invoice' : 'invoices'}`}
              dominant
            />
            <KpiCard
              Icon={CollectedIcon}
              label="Collected"
              value={formatMoney(collectedThisMonth)}
              valueColor="var(--green)"
              support="this month"
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
              {/* Needs Attention — manual/non-Autopilot items, with reasons */}
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
                          recommendation={reasonFor(inv, autopilotEnabled, autopilotRules)}
                        />
                      )
                    })}
                  </ul>
                )}
              </section>

              <AutopilotNudge visible={showNudge} onDismiss={dismissNudge} />

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
        </div>

        {/* ---- Dark rail: Duewatch itself ---- */}
        <aside className="pulse-rail">
          <RailStatus
            autopilotEnabled={autopilotEnabled}
            outstandingCount={derived.outstandingCount}
            outstandingTotal={derived.outstandingTotal}
          />

          <div ref={signatureSectionRef}>
            <SignatureSection
              items={awaitingSignature}
              onResolved={resolveSignatureLocal}
              onEdit={openEditFirst}
              title="Needs your approval"
            />
          </div>

          <SinceLastVisit data={sinceLastVisit} />

          <WillDoNext
            autopilotEnabled={autopilotEnabled}
            eligibleCount={derived.eligibleForNextCheck}
            outstandingCount={derived.outstandingCount}
          />

          <Upcoming dueSoon={derived.dueSoon} />

          <RailActivity events={events} />
        </aside>
      </div>

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
