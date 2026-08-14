import { useState, useMemo, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { History, CalendarClock, CalendarCheck, RefreshCw } from 'lucide-react'
import { useData, isOutstanding, balanceOf } from '../context/DataContext'
import Avatar from '../components/Avatar'
import InvoiceDetailPanel from '../components/InvoiceDetailPanel'
import SignatureSection from '../components/SignatureSection'
import CognitiveCompose from '../features/reminders/CognitiveCompose'
import { ruleTiming } from '../lib/autopilot'
import { evaluatePulseAuthority, isAuthorizedForAutomaticHandling } from '../lib/pulseAuthority'
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
  SearchIcon,
  BellIcon,
} from '../components/icons'

const NUDGE_DISMISS_KEY = 'duewatch_autopilot_nudge_dismissed_at'
const NUDGE_DISMISS_DAYS = 7

function KpiCard({ Icon, label, value, valueColor, trend, support }) {
  return (
    <div className="kpi-card">
      <div className="kpi-top">
        <Icon className="kpi-icon" />
        <span className="kpi-label">{label}</span>
      </div>
      <div className="kpi-value" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </div>
      {trend ? (
        <div className={`kpi-trend kpi-trend-${trend.direction}`}>
          {trend.direction === 'up' ? '↑' : '↓'} {trend.text}
        </div>
      ) : (
        <div className="kpi-support">{support}</div>
      )}
    </div>
  )
}

// Phase 2A.2 — FACTS MAY BE DERIVED. POLICY MUST BE GRANTED. The "Reason"
// column text now comes ONLY from a real authority evaluation — this app's
// old day-count urgency heuristics and its old rule-schedule-lookup helper
// are both gone from this file entirely: an authorized invoice explains
// the exact granted rule and its timing; an unauthorized one gets a plain,
// neutral fact — never a softened or implied recommendation.
// `last_reminder` is surfaced as a bare timestamp fact only — this app has
// no evidence source proving anything about whether a client replied, so
// nothing here is ever derived from that silence.
function reasonFor(evaluation, autopilotRules, invoice) {
  if (evaluation?.authority?.authorized) {
    const rule = autopilotRules.find((r) => r.id === evaluation.authority.basis?.ruleId)
    if (rule) {
      return { text: `${rule.name} — ${ruleTiming(rule)}`, tone: rule.tone === 'firm' ? 'orange' : 'blue' }
    }
  }
  const lastReminderNote = invoice.last_reminder
    ? ` — last reminder ${formatShortDate(invoice.last_reminder)}`
    : ''
  return { text: `No matching rule${lastReminderNote}`, tone: null }
}

// What the Top Invoices row's action column should actually offer, given
// this invoice's real workflow state. "automated" requires a REAL granted
// authorization that also permits automatic execution — never inferred
// from a schedule lookup alone.
function rowActionState(inv, { awaitingInvoiceIds, evaluation }) {
  if (awaitingInvoiceIds.has(inv.id)) return 'awaiting'
  return isAuthorizedForAutomaticHandling(evaluation) ? 'automated' : 'manual'
}

// Real, functional invoice/client search — not a decorative input. The ⌘K
// hint actually focuses this field (see the keydown listener in Dashboard).
function TopSearch({ invoices, onSelect, inputRef }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const results =
    q.length === 0
      ? []
      : invoices
          .filter((inv) => {
            const client = (inv.clients?.name || '').toLowerCase()
            const num = (inv.invoice_number || '').toLowerCase()
            return client.includes(q) || num.includes(q)
          })
          .slice(0, 6)

  return (
    <div className="topbar-search">
      <SearchIcon className="topbar-search-icon" width={15} height={15} />
      <input
        ref={inputRef}
        type="text"
        className="topbar-search-input"
        placeholder="Search invoices, clients…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setQuery('')
            e.currentTarget.blur()
          }
        }}
      />
      <span className="topbar-search-kbd">⌘K</span>
      {results.length > 0 && (
        <ul className="topbar-search-results">
          {results.map((inv) => (
            <li key={inv.id}>
              <button
                type="button"
                onClick={() => {
                  onSelect(inv)
                  setQuery('')
                }}
              >
                <span className="topbar-search-client">{inv.clients?.name || 'No client'}</span>
                <span className="topbar-search-meta">
                  {inv.invoice_number || 'No number'} · {formatMoney(balanceOf(inv))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function InvoiceRow({ invoice, secondary, onClick }) {
  return (
    <li
      className="invoice-row"
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
        <Avatar name={invoice.clients?.name} size={28} />
        <div className="invoice-main">
          <span className="invoice-client">{invoice.clients?.name || 'No client'}</span>
          <span className="invoice-secondary">{secondary}</span>
        </div>
        <span className="invoice-amount">{formatMoney(balanceOf(invoice))}</span>
      </div>
    </li>
  )
}

// "Since your last visit" — relocated from a dark-rail section into the
// north-star mockup's compact banner treatment at the top of the white
// canvas. Same real Checked/Drafted facts, same real-empty-state rule:
// omitted entirely when there's no prior visit to diff against.
function SinceLastVisitBanner({ data }) {
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
    <div className="brief-banner">
      <span className="brief-banner-icon">
        <History size={15} />
      </span>
      <div>
        <div className="brief-banner-title">Since your last visit</div>
        <div className="brief-banner-detail">{parts.join(' · ')}</div>
      </div>
    </div>
  )
}

// Phase 2A.2: the old fixed daily-cadence line is removed — no persisted
// scheduler schedule in this app actually proves when the next run is.
// Every remaining line is grounded in a real authority evaluation
// (eligibleCount counts invoices isAuthorizedForAutomaticHandling() found
// true), never a fabricated cadence claim.
function WorkingOn({ autopilotEnabled, eligibleCount }) {
  const items = []
  if (autopilotEnabled && eligibleCount > 0) {
    items.push({
      Icon: RefreshCw,
      text: `${eligibleCount} ${eligibleCount === 1 ? 'invoice is' : 'invoices are'} authorized for automatic handling`,
    })
  }

  return (
    <section className="rail-section">
      <div className="rail-section-head">
        <CalendarClock size={15} />
        <span>Duewatch Will Do Next</span>
      </div>
      {items.length === 0 ? (
        <p className="rail-section-line">
          {autopilotEnabled ? 'Nothing currently authorized.' : 'Autopilot is off. Nothing is scheduled.'}
        </p>
      ) : (
        <ul className="rail-work-list">
          {items.map((it) => (
            <li key={it.text}>
              <it.Icon size={14} />
              <span>{it.text}</span>
            </li>
          ))}
        </ul>
      )}
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
    userId,
    invoices,
    events,
    name,
    loading,
    error,
    refresh,
    autopilotEnabled,
    autopilotSettings,
    autopilotRules,
    handledKeys,
    pendingInvoiceIds,
    awaitingSignature,
    resolveSignatureLocal,
    sinceLastVisit,
    collectedThisMonth,
    collectedLastMonth,
    collectedLastMonthCount,
  } = useData()
  const [selected, setSelected] = useState(null)
  const [signatureContext, setSignatureContext] = useState(null)
  const [composeInvoice, setComposeInvoice] = useState(null)
  const [nudgeDismissed, setNudgeDismissed] = useState(() => {
    const at = Number(localStorage.getItem(NUDGE_DISMISS_KEY))
    if (!at) return false
    return Date.now() - at < NUDGE_DISMISS_DAYS * 24 * 60 * 60 * 1000
  })

  // Sidebar "Awaiting your signature" indicator (and the topbar bell) both
  // navigate here and ask to scroll to the "Needs your approval" panel.
  // Clear the state after handling it so navigating away and back doesn't
  // re-trigger the scroll.
  const signatureSectionRef = useRef(null)
  const searchInputRef = useRef(null)
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    if (location.state?.scrollToSignature && signatureSectionRef.current) {
      signatureSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
      navigate(location.pathname, { replace: true, state: {} })
    }
  }, [location, navigate])

  // Real keyboard shortcut behind the topbar's "⌘K" hint — it wouldn't be
  // honest to show a shortcut hint that doesn't do anything.
  useEffect(() => {
    function onKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const derived = useMemo(() => {
    const outstanding = invoices.filter(isOutstanding)

    const DUE_SOON_DAYS = 14

    // Phase 2A.2 — ONE authority evaluation per invoice, computed here and
    // reused by every component below (KPIs, the overdue table's Reason/
    // Action columns, the rail) — never independently re-decided. A real
    // handledKeys/pendingInvoiceIds Set means "checked, here's what's
    // true"; null (a failed query — see DataContext) is passed straight
    // through so evaluateNextActionAuthority fails every evaluation closed
    // with execution_history_unavailable, exactly like the Deno execution
    // boundary. This already supersedes the old hand-rolled
    // hasUnresolvedError/hasWorkingAutomation checks: a prior claim (any
    // status, including a failed/uncertain send) durably blocks that exact
    // rule from being selected as authority again via handledKeys, so it
    // can never be miscounted as automated.
    const pulseAuthority = evaluatePulseAuthority({
      userId,
      invoices: outstanding,
      rules: autopilotRules,
      autopilotSettings,
      handledKeys,
      pendingInvoiceIds,
      now: new Date(),
    })

    let outstandingTotal = 0
    const needsAttention = []
    const dueSoon = []

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    let remindersSent = 0
    let eligibleForNextCheck = 0
    let handlingCount = 0

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

      if (isAuthorizedForAutomaticHandling(pulseAuthority.get(inv.id))) {
        eligibleForNextCheck += 1
        handlingCount += 1
      }
    }

    needsAttention.sort((a, b) => daysOverdue(b.due_date) - daysOverdue(a.due_date))
    dueSoon.sort((a, b) => daysUntil(a.due_date) - daysUntil(b.due_date))

    // Of the overdue invoices specifically, the ones NOT authorized for
    // automatic handling are the ones that genuinely need a founder
    // decision — being overdue while Autopilot has real, granted authority
    // over it isn't a decision, it's Autopilot doing its job.
    const blockedCount = needsAttention.filter(
      (inv) => !isAuthorizedForAutomaticHandling(pulseAuthority.get(inv.id))
    ).length

    return {
      outstandingTotal,
      needsAttention,
      dueSoon,
      remindersSent,
      outstandingCount: outstanding.length,
      eligibleForNextCheck,
      handlingCount,
      blockedCount,
      pulseAuthority,
    }
  }, [invoices, autopilotRules, autopilotSettings, handledKeys, pendingInvoiceIds, userId])

  if (loading) {
    return <div className="brief-loading">Loading your brief…</div>
  }

  if (error) {
    return <div className="brief-error">Couldn&apos;t load your brief: {error}</div>
  }

  const attentionCount = derived.needsAttention.length
  const awaitingCount = awaitingSignature.length
  // A genuine human decision is either a draft literally waiting on the
  // founder's approval, or an overdue invoice Autopilot has no real,
  // working path to act on (off, individually paused, no matching rule,
  // or an unresolved send error) — not every overdue invoice. Most overdue
  // invoices are Autopilot's job, not a decision; conflating the two is
  // exactly the overcount this headline used to make.
  const decisionsNeeded = awaitingCount + derived.blockedCount
  // Plain computation, not a hook — safe to sit after the loading/error
  // early returns above.
  const awaitingInvoiceIds = new Set(awaitingSignature.map((a) => a.invoice_id))

  // Real, deterministic status headline — a plain read of already-computed
  // counts, never a fabricated qualitative assessment. Mirrors the same
  // "never faked" rule that ruled out an AI-sentiment "What Duewatch
  // Noticed" feature elsewhere in this app.
  const statusHeadline =
    decisionsNeeded === 0
      ? 'Your receivables are on track.'
      : `${decisionsNeeded} decision${decisionsNeeded === 1 ? '' : 's'} need${decisionsNeeded === 1 ? 's' : ''} your attention.`

  const hasAnyInvoices = invoices.length > 0

  const remindersSentAllTime = events.filter((e) => e.event_type === 'reminder_sent').length
  const showNudge =
    !autopilotEnabled && !nudgeDismissed && invoices.length >= 3 && remindersSentAllTime >= 2

  // Real month-over-month trend — only Collected has a comparable historical
  // query (events are timestamped). Outstanding/Need Attention/Reminders
  // Sent are derived from current invoice state, not logged events, so
  // there's no past snapshot to diff against without new schema — they get
  // their existing plain caption instead of a fabricated trend line.
  //
  // A nonzero sum alone isn't a meaningful baseline: one stray $10 payment
  // last month would make a normal collections month read as a 6,000%
  // swing. Require at least 2 distinct payments last month before showing
  // a percentage at all — below that, the plain "this month" caption
  // (no trend line) is more honest than a dramatic-looking number with
  // nothing real behind its scale.
  const MIN_BASELINE_PAYMENTS = 2
  const collectedTrend =
    collectedLastMonth > 0 && collectedLastMonthCount >= MIN_BASELINE_PAYMENTS
      ? {
          direction: collectedThisMonth >= collectedLastMonth ? 'up' : 'down',
          text: `${Math.abs(Math.round(((collectedThisMonth - collectedLastMonth) / collectedLastMonth) * 100))}% vs last month`,
        }
      : null

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

  function scrollToApprovals() {
    signatureSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="brief">
      <div className="brief-topbar">
        <div>
          <p className="brief-greeting">Good morning, {name}.</p>
          <h1 className="brief-headline">{statusHeadline}</h1>
        </div>
        <div className="brief-topbar-controls">
          <TopSearch invoices={invoices} onSelect={(inv) => setSelected(inv)} inputRef={searchInputRef} />
          <button
            type="button"
            className="topbar-icon-btn"
            aria-label={`${decisionsNeeded} decisions need you`}
            onClick={scrollToApprovals}
          >
            <BellIcon width={17} height={17} />
            {decisionsNeeded > 0 && <span className="topbar-badge">{decisionsNeeded}</span>}
          </button>
        </div>
      </div>

      <div className="brief-header-sub">
        {/* Phase 2A.2: "Duewatch is handling N automatically" implied
            execution that hasn't happened yet — a real granted
            authorization is not the same claim as an action already taken
            (see permission.canActAutomatically). */}
        <p className="brief-subline">
          You collected <b>{formatMoney(collectedThisMonth)}</b> this month. {formatMoney(derived.outstandingTotal)}{' '}
          remains outstanding. {derived.handlingCount} {derived.handlingCount === 1 ? 'is' : 'are'} authorized for
          automatic handling, {awaitingCount} {awaitingCount === 1 ? 'awaits' : 'await'} your approval, and{' '}
          <span className="o">
            {derived.blockedCount} {derived.blockedCount === 1 ? 'needs' : 'need'} you directly
          </span>
          .
        </p>
      </div>

      <div className="brief-shell">
        {/* ---- White canvas: the business ---- */}
        <div className="brief-main">
          <SinceLastVisitBanner data={sinceLastVisit} />

          <section className="kpi-grid">
            <KpiCard
              Icon={CollectedIcon}
              label="Collected"
              value={formatMoney(collectedThisMonth)}
              valueColor="var(--green)"
              trend={collectedTrend}
              support="this month"
            />
            <KpiCard
              Icon={OutstandingIcon}
              label="Outstanding"
              value={formatMoney(derived.outstandingTotal)}
              support={`across ${derived.outstandingCount} ${derived.outstandingCount === 1 ? 'invoice' : 'invoices'}`}
            />
            {/* Phase 2A.2: this counts every overdue invoice, not only ones
                with a genuine authority/workflow reason for founder
                attention — "Overdue" is the honest label for that. */}
            <KpiCard
              Icon={AttentionIcon}
              label="Overdue"
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
              <div className="brief-row-2col">
                {/* Phase 2A.2: renamed from "Top invoices to focus on" — this
                    list is a plain days-overdue sort, not a founder-granted
                    priority policy, and the old title implied the latter. */}
                <section className="brief-card">
                  <div className="section-head">
                    <h2 className="section-title">Most overdue invoices</h2>
                    {attentionCount > 0 && <span className="section-count">{attentionCount}</span>}
                  </div>
                  {attentionCount === 0 ? (
                    <p className="brief-empty">No overdue invoices. You&apos;re all caught up.</p>
                  ) : (
                    <div className="top-invoices-table-wrap">
                      <table className="top-invoices-table">
                        <colgroup>
                          <col className="col-invoice" />
                          <col className="col-client" />
                          <col className="col-amount" />
                          <col className="col-days" />
                          <col className="col-reason" />
                          <col className="col-action" />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>Invoice</th>
                            <th>Client</th>
                            <th>Amount</th>
                            <th>Days</th>
                            <th>Reason</th>
                            <th aria-hidden="true" />
                          </tr>
                        </thead>
                        <tbody>
                          {derived.needsAttention.map((inv) => {
                            const od = daysOverdue(inv.due_date)
                            const evaluation = derived.pulseAuthority.get(inv.id)
                            const reco = reasonFor(evaluation, autopilotRules, inv)
                            const actionState = rowActionState(inv, { awaitingInvoiceIds, evaluation })
                            return (
                              <tr key={inv.id} onClick={() => setSelected(inv)}>
                                <td>{inv.invoice_number || '—'}</td>
                                <td className="top-invoices-table-client">{inv.clients?.name || 'No client'}</td>
                                <td className="top-invoices-table-amount">{formatMoney(balanceOf(inv))}</td>
                                <td>{od}</td>
                                <td>
                                  <span
                                    className={
                                      reco.tone
                                        ? `top-invoices-table-reason tone-${reco.tone}`
                                        : 'top-invoices-table-reason'
                                    }
                                  >
                                    {reco.text}
                                  </span>
                                </td>
                                <td>
                                  {actionState === 'awaiting' ? (
                                    <button
                                      type="button"
                                      className="row-action row-action-passive"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        scrollToApprovals()
                                      }}
                                    >
                                      Awaiting approval
                                    </button>
                                  ) : actionState === 'automated' ? (
                                    // Phase 2A.2: "Autopilot handling" implied
                                    // execution that hasn't happened yet — a
                                    // granted authorization is not itself an
                                    // action taken.
                                    <span className="row-action-label">Authorized: automatic</span>
                                  ) : (
                                    // Phase 2A.2: zero-authority state gets a
                                    // neutral affordance only — never a
                                    // specific action recommendation.
                                    <button
                                      type="button"
                                      className="row-action"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setComposeInvoice(inv)
                                      }}
                                    >
                                      Choose action
                                    </button>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* Due Soon — real scheduled/due invoices occupying the space
                    the north-star grid gives to forecast/pattern content that
                    isn't real yet */}
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
              </div>

              <AutopilotNudge visible={showNudge} onDismiss={dismissNudge} />
            </>
          )}
        </div>

        {/* ---- Dark rail: Duewatch itself ---- */}
        <aside className="pulse-rail">
          <div ref={signatureSectionRef}>
            <SignatureSection
              items={awaitingSignature}
              onResolved={resolveSignatureLocal}
              onEdit={openEditFirst}
              title="Needs your approval"
            />
          </div>

          <WorkingOn autopilotEnabled={autopilotEnabled} eligibleCount={derived.eligibleForNextCheck} />

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
