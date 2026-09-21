import { useMemo, useState } from 'react'
import { ChevronDown, Mic, MoreHorizontal } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { balanceOf, isOutstanding, useData } from '../context/DataContext'
import { daysOverdue, formatLongDate, formatMoney, timeAgo } from '../lib/format'
import { supabase } from '../lib/supabase'
import { OverhaulIcon } from './OverhaulIconSystem'
import { createPulseAskDwRuntime } from './integration/pulseAskDw'

function TinySpark({ tone = 'green', variant = 'up' }) {
  const d = variant === 'flat'
    ? 'M1 12 L6 9 L11 11 L16 7 L21 9 L26 7'
    : 'M1 13 L6 11 L10 12 L15 6 L20 8 L25 3'
  return (
    <svg className={`ov-spark ov-spark--${tone}`} viewBox="0 0 27 16" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StatusChip({ children, tone = 'neutral' }) {
  return <span className={`ov-chip ov-chip--${tone}`}>{children}</span>
}

function clientNameOf(invoice) {
  return invoice?.clients?.name || 'Client'
}

function eventClientName(event) {
  return event?.invoices?.clients?.name || 'DueWatch'
}

function eventTitle(event) {
  const raw = String(event?.event_type || 'Activity recorded')
  return raw
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function isPaymentEvent(event) {
  return /payment/i.test(String(event?.event_type || ''))
}

function isDwAction(event) {
  return /(reminder|follow|autopilot|escalat|signature|outreach|email)/i.test(String(event?.event_type || ''))
}

function OrbitCard({ title, value, note, icon, tone, className }) {
  return (
    <div className={`ov-orbit-card ${className}`}>
      <span className={`ov-orbit-icon ov-orbit-icon--${tone}`}>
        <OverhaulIcon name={icon} size={20} />
      </span>
      <div className="ov-orbit-copy-block">
        <span className="ov-orbit-label">{title}</span>
        <strong>{value}</strong>
        <small>{note}</small>
      </div>
      <span className={`ov-orbit-dot ov-orbit-dot--${tone}`} />
      <TinySpark tone={tone === 'blue' ? 'blue' : tone === 'orange' ? 'orange' : 'green'} />
    </div>
  )
}

function PulseCore({
  outstanding,
  paymentCount,
  totalEventsCount,
  reminderCount,
  clientsCount,
  recentEventsCount,
}) {
  return (
    <div className="ov-pulse-stage">
      <svg className="ov-pulse-lines" viewBox="0 0 780 340" preserveAspectRatio="none" aria-hidden="true">
        <path d="M390 172 C315 142 258 82 186 58" />
        <path d="M390 172 C315 166 245 168 171 170" />
        <path d="M390 172 C315 198 253 250 183 281" />
        <path d="M390 172 C465 142 522 82 594 58" />
        <path d="M390 172 C465 166 535 168 609 170" />
        <path d="M390 172 C465 198 527 250 597 281" />
      </svg>

      <OrbitCard
        className="cash"
        icon="cashAwareness"
        tone="green"
        title="Cash awareness"
        value={formatMoney(outstanding)}
        note="open receivables"
      />
      <OrbitCard
        className="payments"
        icon="payments"
        tone="orange"
        title="Payments"
        value={String(paymentCount)}
        note="recent payment events"
      />
      <OrbitCard
        className="evidence"
        icon="evidence"
        tone="blue"
        title="Evidence"
        value={String(totalEventsCount)}
        note="actions recorded"
      />
      <OrbitCard
        className="reminders"
        icon="reminders"
        tone="orange"
        title="Reminders & follow-ups"
        value={String(reminderCount)}
        note="recent DW actions"
      />
      <OrbitCard
        className="memory"
        icon="memory"
        tone="green"
        title="Client memory"
        value={String(clientsCount)}
        note="client records"
      />
      <OrbitCard
        className="activity"
        icon="activityStream"
        tone="orange"
        title="Activity stream"
        value={String(recentEventsCount)}
        note="recent events"
      />

      <div className="ov-orb-wrap" aria-label="DW Pulse resting">
        <div className="ov-orb-ring ov-orb-ring-one" />
        <div className="ov-orb-ring ov-orb-ring-two" />
        <div className="ov-orb-ring ov-orb-ring-three" />
        <div className="ov-orb">
          <span className="ov-orb-highlight" />
          <span className="ov-orb-core" />
        </div>
        <div className="ov-orb-copy">
          <strong>DW PULSE</strong>
          <span>Monitoring. Analyzing. Taking action.</span>
        </div>
      </div>
    </div>
  )
}

function LiveMonitor({ invoicesCount, evidenceCount, paymentCount, actionCount }) {
  return (
    <section className="ov-panel ov-live-panel">
      <div className="ov-rail-title">
        <div className="ov-live-title">
          <span className="ov-live-dot" />
          <strong>Live Monitor</strong>
          <span className="ov-live-pip" />
        </div>
        <StatusChip tone="green"><span className="ov-live-dot" />Live</StatusChip>
      </div>
      <div className="ov-monitor-grid">
        <div>
          <span>Invoices watched</span>
          <strong>{invoicesCount}</strong>
          <TinySpark />
        </div>
        <div>
          <span>Recent evidence</span>
          <strong>{evidenceCount}</strong>
          <TinySpark />
        </div>
        <div>
          <span>Recent payments</span>
          <strong>{paymentCount}</strong>
          <TinySpark tone="blue" variant="flat" />
        </div>
        <div>
          <span>Recent DW actions</span>
          <strong>{actionCount}</strong>
          <TinySpark />
        </div>
      </div>
    </section>
  )
}

function NoticeRow({ tone = 'orange', title, body, meta, signature }) {
  return (
    <article className="ov-notice">
      <span className={`ov-notice-icon ov-notice-icon--${tone}`}>
        <OverhaulIcon name={tone === 'green' ? 'evidence' : 'alert'} size={16} />
      </span>
      <div className="ov-notice-copy">
        <strong>{title}</strong>
        <p>{body}</p>
        {signature ? (
          <button className="ov-signature-trigger" type="button" aria-disabled="true">
            <span>◉</span> DW Signature <span>→</span>
          </button>
        ) : null}
        {meta ? <small>{meta}</small> : null}
      </div>
      <ChevronDown className="ov-notice-chevron" size={15} />
    </article>
  )
}

function RightRail({
  invoices,
  events,
  approvals,
  autopilotErrorCount,
  evidenceCount,
  paymentCount,
  actionCount,
}) {
  const overdue = invoices
    .filter((invoice) => isOutstanding(invoice) && daysOverdue(invoice.due_date) > 0)
    .sort((a, b) => daysOverdue(b.due_date) - daysOverdue(a.due_date))[0]

  const firstPayment = events.find(isPaymentEvent)

  return (
    <aside className="ov-right-rail">
      <LiveMonitor
        invoicesCount={invoices.length}
        evidenceCount={evidenceCount}
        paymentCount={paymentCount}
        actionCount={actionCount}
      />

      <section className="ov-panel ov-noticed-panel">
        <div className="ov-rail-section-head">
          <h3>What DW noticed <span>{Math.min(3, Number(Boolean(overdue)) + Number(Boolean(firstPayment)) + Number(approvals > 0 || autopilotErrorCount > 0)) || 0}</span></h3>
          <button type="button" aria-disabled="true">View all</button>
        </div>

        <div className="ov-notice-list">
          {approvals > 0 ? (
            <NoticeRow
              title={`${approvals} approval${approvals === 1 ? '' : 's'} need review`}
              body="DW is waiting for founder judgment before proceeding."
              meta="Approval boundary preserved"
              signature
            />
          ) : autopilotErrorCount > 0 ? (
            <NoticeRow
              title="Autopilot needs attention"
              body={`${autopilotErrorCount} recent execution error${autopilotErrorCount === 1 ? '' : 's'} recorded.`}
              meta="Review Activity for evidence"
            />
          ) : null}

          {overdue ? (
            <NoticeRow
              title={`${clientNameOf(overdue)} — overdue invoice`}
              body={`${overdue.invoice_number || 'Invoice'} is ${daysOverdue(overdue.due_date)} days overdue with ${formatMoney(balanceOf(overdue))} outstanding.`}
              meta="Based on current invoice data"
            />
          ) : null}

          {firstPayment ? (
            <NoticeRow
              tone="green"
              title="Payment activity recorded"
              body={`${eventClientName(firstPayment)} has a recent payment event in DueWatch.`}
              meta={timeAgo(firstPayment.created_at)}
            />
          ) : null}

          {!approvals && !autopilotErrorCount && !overdue && !firstPayment ? (
            <div className="ov-rail-empty">No urgent issues in the current data window.</div>
          ) : null}
        </div>
      </section>

      <section className="ov-panel ov-events-panel">
        <div className="ov-rail-section-head">
          <h3>Recent operational events</h3>
          <button type="button" aria-disabled="true">View all</button>
        </div>
        <div className="ov-event-list">
          {events.slice(0, 5).map((event) => (
            <div key={event.id}>
              <span className={`ov-event-dot ${isPaymentEvent(event) ? 'green' : isDwAction(event) ? 'orange' : 'blue'}`} />
              <p>
                <strong>{eventTitle(event)}</strong>
                <small>{eventClientName(event)} · {timeAgo(event.created_at)}</small>
              </p>
            </div>
          ))}
          {events.length === 0 ? <div className="ov-rail-empty">No recent operational events.</div> : null}
        </div>
      </section>
    </aside>
  )
}

function PriorityInvoices({ rows }) {
  return (
    <section className="ov-panel ov-table-panel">
      <div className="ov-compact-head">
        <h3>Top invoices to focus on <span>{rows.length}</span></h3>
        <button type="button" aria-disabled="true">View all</button>
      </div>
      <div className="ov-focus-table">
        <div className="ov-focus-row ov-focus-header">
          <span>Invoice</span><span>Client</span><span>Amount</span><span>Overdue</span><span>Why it needs attention</span><span>Next action</span>
        </div>
        {rows.map((invoice) => {
          const overdueBy = daysOverdue(invoice.due_date)
          return (
            <div className="ov-focus-row" key={invoice.id}>
              <span className="ov-focus-invoice">{invoice.invoice_number || '—'}</span>
              <span>{clientNameOf(invoice)}</span>
              <span>{formatMoney(balanceOf(invoice))}</span>
              <span className={overdueBy > 0 ? 'ov-danger-text' : ''}>{overdueBy > 0 ? overdueBy : '—'}</span>
              <span>{overdueBy >= 30 ? 'Severely overdue' : overdueBy > 0 ? 'Follow-up overdue' : 'Upcoming balance'}</span>
              <span><button className="ov-row-action" type="button" aria-disabled="true">{overdueBy >= 30 ? 'Review' : 'Follow up'}</button></span>
            </div>
          )
        })}
        {rows.length === 0 ? <div className="ov-table-empty">No outstanding invoices need attention.</div> : null}
      </div>
    </section>
  )
}

function AttentionQueue({ rows }) {
  return (
    <section className="ov-panel ov-table-panel">
      <div className="ov-compact-head">
        <h3>Due soon & next attention <span>{rows.length}</span></h3>
        <button type="button" aria-disabled="true">View all</button>
      </div>
      <div className="ov-attention-table">
        <div className="ov-attention-row ov-attention-header">
          <span>Client</span><span>Invoice</span><span>Due</span><span>Type</span>
        </div>
        {rows.map((invoice) => {
          const overdueBy = daysOverdue(invoice.due_date)
          return (
            <div className="ov-attention-row" key={invoice.id}>
              <span>{clientNameOf(invoice)}</span>
              <span>{invoice.invoice_number || '—'}</span>
              <span>{overdueBy > 0 ? `${overdueBy}d overdue` : invoice.due_date || 'No due date'}</span>
              <span><StatusChip tone={overdueBy > 0 ? 'orange' : 'blue'}>{overdueBy > 0 ? 'Needs attention' : 'Upcoming'}</StatusChip></span>
            </div>
          )
        })}
        {rows.length === 0 ? <div className="ov-table-empty">No due-soon invoices in the current data.</div> : null}
      </div>
    </section>
  )
}

export default function LockedPulse() {
  const { user } = useAuth()
  const askDwRuntime = useMemo(() => createPulseAskDwRuntime({ supabase }), [])
  const [askQuestion, setAskQuestion] = useState('')
  const [askResult, setAskResult] = useState(null)
  const [askError, setAskError] = useState('')
  const [askBusy, setAskBusy] = useState(false)
  const {
    invoices,
    clients,
    events,
    name,
    loading,
    error,
    autopilotEnabled,
    awaitingSignature,
    totalEventsCount,
    autopilotErrorCount,
  } = useData()

  const outstandingInvoices = useMemo(
    () => invoices.filter(isOutstanding),
    [invoices]
  )
  const outstanding = useMemo(
    () => outstandingInvoices.reduce((sum, invoice) => sum + balanceOf(invoice), 0),
    [outstandingInvoices]
  )
  const priorityRows = useMemo(
    () => outstandingInvoices
      .slice()
      .sort((a, b) => daysOverdue(b.due_date) - daysOverdue(a.due_date) || balanceOf(b) - balanceOf(a))
      .slice(0, 5),
    [outstandingInvoices]
  )
  const nextAttentionRows = useMemo(
    () => outstandingInvoices
      .slice()
      .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')))
      .slice(0, 5),
    [outstandingInvoices]
  )
  const paymentEvents = useMemo(() => events.filter(isPaymentEvent), [events])
  const dwActions = useMemo(() => events.filter(isDwAction), [events])
  const evidenceCount = useMemo(
    () => events.filter((event) => event.evidence && Object.keys(event.evidence).length > 0).length,
    [events]
  )
  const reminderCount = dwActions.length

  const fullName = (user?.user_metadata?.full_name || '').trim()
  const greetingName = fullName ? fullName.split(/\s+/)[0] : name || 'there'
  const company =
    user?.user_metadata?.company ||
    user?.user_metadata?.organization ||
    user?.user_metadata?.workspace ||
    'Workspace'

  async function runPulseAskDw(questionOverride = null) {
    const question = String(questionOverride ?? askQuestion).trim()
    if (!question || askBusy || !user?.id) return
    setAskQuestion(question)
    setAskBusy(true)
    setAskError('')
    setAskResult(null)
    try {
      const result = await askDwRuntime.run({
        tenantId: user.id,
        text: question,
        invoices,
        clients,
        events,
        approvals: awaitingSignature,
      })
      setAskResult(result)
    } catch (runError) {
      setAskError(runError?.message || 'Ask DW could not complete this request.')
    } finally {
      setAskBusy(false)
    }
  }

  const realClientPrompt = priorityRows[0]?.clients?.name
    ? `Why did ${priorityRows[0].clients.name} pay late?`
    : 'Why did this client pay late?'

  const askPrompts = [
    'What needs my attention?',
    realClientPrompt,
    'Show overdue by reason',
    'Draft a follow-up',
    'Cash forecast',
  ]

  if (loading) {
    return <div className="ov-pulse-page"><div className="ov-page-state">Loading DueWatch…</div></div>
  }

  if (error) {
    return <div className="ov-pulse-page"><div className="ov-page-state ov-page-state--error">Couldn&apos;t load Pulse: {error}</div></div>
  }

  return (
    <div className="ov-pulse-page">
      <header className="ov-topbar">
        <label className="ov-global-search">
          <OverhaulIcon name="search" size={16} />
          <input placeholder="Search invoices, clients, payments..." readOnly />
          <kbd>⌘ K</kbd>
        </label>

        <div className="ov-top-actions">
          <button className="ov-notification-button" type="button" aria-label="Notifications">
            <OverhaulIcon name="notifications" size={18} />
            {awaitingSignature.length > 0 ? <span>{Math.min(awaitingSignature.length, 9)}</span> : null}
          </button>
          <button className="ov-workspace-menu" type="button" aria-disabled="true">
            {company}<ChevronDown size={14} />
          </button>
        </div>
      </header>

      <div className="ov-page-inner">
        <section className="ov-welcome">
          <div>
            <h1>Good morning, <span>{greetingName}.</span></h1>
            <div className="ov-inline-status">
              <span className={`ov-autopilot-state ${autopilotEnabled ? 'is-on' : ''}`}>
                <span className="ov-live-dot" />
                Autopilot {autopilotEnabled ? 'active' : 'off'}
              </span>
              <span>{formatLongDate(new Date())}</span>
              <span>{invoices.length} invoices</span>
              <span>{dwActions.length} recent DW actions</span>
              <span>{awaitingSignature.length} need{awaitingSignature.length === 1 ? 's' : ''} approval</span>
            </div>
          </div>

          <div className="ov-live-mode-wrap">
            <button className="ov-live-mode-button" type="button" aria-disabled="true">
              <span className="ov-live-dot" /> Live mode
            </button>
            <span className="ov-sun-symbol">☼</span>
          </div>
        </section>

        <section className="ov-ask">
          <form
            className="ov-ask-row"
            onSubmit={(event) => {
              event.preventDefault()
              runPulseAskDw()
            }}
          >
            <span className="ov-ask-mark"><OverhaulIcon name="sparkle" size={18} /></span>
            <input
              value={askQuestion}
              onChange={(event) => setAskQuestion(event.target.value)}
              placeholder="Ask DW anything about your receivables..."
              disabled={askBusy}
              aria-label="Ask DW"
            />
            <button type="button" aria-label="Voice input unavailable" aria-disabled="true"><Mic size={19} /></button>
            <button className="ov-send" type="submit" disabled={askBusy || !askQuestion.trim()} aria-label="Ask DW">
              <OverhaulIcon name="send" size={17} />
            </button>
          </form>
          <div className="ov-prompt-row">
            {askPrompts.map((prompt) => (
              <button type="button" key={prompt} disabled={askBusy} onClick={() => runPulseAskDw(prompt)}>{prompt}</button>
            ))}
          </div>

          {(askBusy || askError || askResult) ? (
            <div className="ov-ask-response" aria-live="polite">
              {askBusy ? (
                <div className="ov-ask-response-loading"><span className="ov-live-dot" />Checking DueWatch truth…</div>
              ) : askError ? (
                <div className="ov-ask-response-error">{askError}</div>
              ) : askResult ? (
                <>
                  <div className="ov-ask-response-head">
                    <span className={`ov-chip ov-chip--${askResult.status === 'blocked' ? 'orange' : askResult.status === 'needs_resolution' ? 'blue' : 'green'}`}>
                      {askResult.status === 'answered' ? 'DW verified' : askResult.status === 'blocked' ? 'Guarded' : 'Needs a reference'}
                    </span>
                    <small>{askResult.scope === 'PORTFOLIO' ? 'Portfolio read' : 'Invoice truth'}</small>
                  </div>
                  <p className="ov-ask-response-conclusion">{askResult.conclusion}</p>
                  {askResult.nextStep ? <p className="ov-ask-response-next"><strong>Next:</strong> {askResult.nextStep}</p> : null}
                  {askResult.limitations?.length ? (
                    <div className="ov-ask-response-limit">
                      {askResult.limitations.map((item) => <span key={item}>{item}</span>)}
                    </div>
                  ) : null}
                  {askResult.evidence?.length ? (
                    <details className="ov-ask-response-evidence">
                      <summary>Evidence</summary>
                      <ul>{askResult.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
                    </details>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </section>

        <div className="ov-main-grid">
          <section className="ov-command">
            <PulseCore
              outstanding={outstanding}
              paymentCount={paymentEvents.length}
              totalEventsCount={totalEventsCount}
              reminderCount={reminderCount}
              clientsCount={clients.length}
              recentEventsCount={events.length}
            />

            <div className="ov-work-grid">
              <PriorityInvoices rows={priorityRows} />
              <AttentionQueue rows={nextAttentionRows} />
            </div>

            <div className="ov-bottom-grid">
              <section className="ov-panel ov-impact">
                <div className="ov-compact-head">
                  <h3>Autopilot impact this month</h3>
                  <button type="button" aria-disabled="true">View details</button>
                </div>
                <div className="ov-impact-metrics">
                  <div>
                    <span className="ov-metric-icon ov-metric-icon--green"><OverhaulIcon name="clients" size={19} /></span>
                    <p><strong>{dwActions.length}</strong><span>recent DW actions</span><small>visible activity window</small></p>
                  </div>
                  <div>
                    <span className="ov-metric-icon ov-metric-icon--blue"><OverhaulIcon name="clock" size={19} /></span>
                    <p><strong>{awaitingSignature.length}</strong><span>approvals waiting</span><small>founder judgment preserved</small></p>
                  </div>
                  <div>
                    <span className="ov-metric-icon ov-metric-icon--green"><OverhaulIcon name="cash" size={19} /></span>
                    <p><strong>{formatMoney(outstanding)}</strong><span>open receivables</span><small>current balance under watch</small></p>
                  </div>
                </div>
              </section>

              <section className="ov-panel ov-mode-panel">
                <div className="ov-compact-head">
                  <h3>DW Operating mode</h3>
                </div>
                <div className="ov-mode-content">
                  <span className="ov-mode-moon">☾</span>
                  <div>
                    <strong>{autopilotEnabled ? 'Normal' : 'Manual'}</strong>
                    <p>{autopilotEnabled ? 'Operating within current Autopilot settings.' : 'Autopilot is currently disabled.'}</p>
                    <button type="button" aria-disabled="true">Change mode</button>
                  </div>
                </div>
              </section>
            </div>
          </section>

          <RightRail
            invoices={invoices}
            events={events}
            approvals={awaitingSignature.length}
            autopilotErrorCount={autopilotErrorCount}
            evidenceCount={evidenceCount}
            paymentCount={paymentEvents.length}
            actionCount={dwActions.length}
          />
        </div>
      </div>
    </div>
  )
}
