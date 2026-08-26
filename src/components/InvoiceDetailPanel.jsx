import { useEffect, useState } from 'react'
import { Bot, PauseCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import StatusPill from './StatusPill'
import JourneyBar from './JourneyBar'
import CognitiveCompose from '../features/reminders/CognitiveCompose'
import DwInvoiceIntelligencePanel from '../features/dwIntelligence/DwInvoiceIntelligencePanel'
import AskDwInvoiceLiveProbe from '../features/dwIntelligence/AskDwInvoiceLiveProbe'
import { CloseIcon, CheckIcon } from './icons'
import {
  formatMoney,
  formatShortDate,
  formatEventDate,
  daysOverdue,
  daysUntil,
} from '../lib/format'
import { balanceOf, effectiveStatus } from '../context/DataContext'
import { logEvent } from '../lib/events'
import { fetchAutopilotRules } from '../lib/autopilot'
import { nextScheduledAction } from '../lib/ruleSchedule'
import { TONES, reminderDraft, sendReminderNow } from '../lib/reminders'
import { formatPaymentAmount, recordInvoicePayment } from '../lib/payments'
import { SUPPORTED_CURRENCIES } from '../lib/import/money'

// line_items is a pre-existing table — tolerate common column-name variants.
const pick = (obj, ...keys) => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return undefined
}
const liDesc = (li) => pick(li, 'description', 'desc', 'name', 'item') ?? ''
const liQty = (li) => Number(pick(li, 'quantity', 'qty', 'units')) || 0
const liPrice = (li) => Number(pick(li, 'unit_price', 'price', 'rate', 'amount')) || 0

// Collapse duplicate reminder events (from seed data) by content, keeping the
// first occurrence. The dedupe.sql cleanup is the real fix for the DB.
function dedupeReminders(rows) {
  const seen = new Set()
  const out = []
  for (const r of rows) {
    const key = `${r.title} ${r.detail || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

/**
 * Slide-in invoice detail panel (320px, right side, overlay behind).
 * `invoice` non-null opens it; `onClose` closes it. `onMutated` refreshes the
 * parent list after a write. Esc / overlay click close.
 *
 * `signatureContext` (optional): the awaiting_signature row when opened via
 * "Edit First" — pre-fills the recommended tone/draft and, on send, resolves
 * that signature request too (calls `onSignatureResolved`).
 */
export default function InvoiceDetailPanel({
  invoice,
  onClose,
  onMutated,
  signatureContext = null,
  onSignatureResolved,
  // Read-only Phase 2B projection. Never execution authority.
  dwCase = null,
}) {
  const { user } = useAuth()
  const {
    autopilotEnabled,
    awaitingSignature,
    hasCompletedAutopilotRun,
    startCognitive,
    stopCognitive,
    celebrate,
  } = useData()
  const [render, setRender] = useState(Boolean(invoice))
  const [shown, setShown] = useState(false)
  const [data, setData] = useState(invoice)
  const [lineItems, setLineItems] = useState([])
  const [reminders, setReminders] = useState([])
  const [autopilotRules, setAutopilotRules] = useState([])
  const [pauseBusy, setPauseBusy] = useState(false)
  const [loading, setLoading] = useState(false)

  // Action UI state.
  const [mode, setMode] = useState('none') // 'none' | 'payment' | 'reminder' | 'sent'
  const [payAmount, setPayAmount] = useState('')
  const [paymentDate, setPaymentDate] = useState('')
  const [paymentCurrency, setPaymentCurrency] = useState('')
  const [tone, setTone] = useState('friendly')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [paymentConfirmation, setPaymentConfirmation] = useState('')
  // A founder-initiated draft (no signatureContext) opens CognitiveCompose;
  // editing an Autopilot recommendation (signatureContext, "Edit First")
  // keeps using this panel's existing inline reminder mode below.
  const [showCompose, setShowCompose] = useState(false)

  // Mount / open / close transition management.
  useEffect(() => {
    if (invoice) {
      setData(invoice)
      setRender(true)
      setActionError('')
      setPaymentConfirmation('')
      setPayAmount('')
      setPaymentDate('')
      setPaymentCurrency(invoice?.currency || '')
      if (signatureContext) {
        setTone(signatureContext.recommended_tone || 'friendly')
        setDraft(signatureContext.draft_content || '')
        setMode('reminder')
      } else {
        setMode('none')
      }
      const raf = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(raf)
    }
    setShown(false)
    const t = setTimeout(() => setRender(false), 250)
    return () => clearTimeout(t)
  }, [invoice, signatureContext])

  // Esc to close.
  useEffect(() => {
    if (!invoice) return
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [invoice, onClose])

  // Load line items + reminder events for the open invoice.
  useEffect(() => {
    if (!invoice?.id) return
    let cancelled = false
    setLoading(true)
    Promise.all([
      supabase.from('line_items').select('*').eq('invoice_id', invoice.id),
      supabase
        .from('reminders')
        .select('id, title, detail, created_at')
        .eq('invoice_id', invoice.id)
        .order('created_at', { ascending: false }),
    ]).then(([li, rem]) => {
      if (cancelled) return
      setLineItems(li.data || [])
      setReminders(dedupeReminders(rem.data || []))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [invoice?.id])

  // Autopilot rules, for "next scheduled action" — only needed when
  // Autopilot is on and the panel is open for some invoice.
  useEffect(() => {
    if (!invoice?.id || !autopilotEnabled || !user) return
    let cancelled = false
    fetchAutopilotRules(user.id).then((rules) => {
      if (!cancelled) setAutopilotRules(rules)
    })
    return () => {
      cancelled = true
    }
  }, [invoice?.id, autopilotEnabled, user])

  if (!render || !data) return null

  const clientName = data.clients?.name || 'No client'
  const overdueBy = daysOverdue(data.due_date)

  const subtotal = lineItems.reduce((sum, li) => sum + liQty(li) * liPrice(li), 0)
  const displaySubtotal = lineItems.length > 0 ? subtotal : Number(data.amount) || 0
  const paid = Number(data.amount_paid) || 0
  const balance = balanceOf(data)

  const invoicePaused = data.autopilot_paused === true
  const hasPendingSignature = awaitingSignature.some((s) => s.invoice_id === data.id)
  const upcoming = !invoicePaused ? nextScheduledAction(autopilotRules, data) : null

  // ---- Actions ----
  async function toggleInvoiceAutopilot() {
    const next = !invoicePaused
    setPauseBusy(true)
    // Optimistic — pausing/resuming one invoice never touches any other.
    setData((d) => ({ ...d, autopilot_paused: next }))
    const { error } = await supabase
      .from('invoices')
      .update({ autopilot_paused: next })
      .eq('id', data.id)
    setPauseBusy(false)
    if (error) {
      setData((d) => ({ ...d, autopilot_paused: !next }))
      setActionError(error.message)
      return
    }
    onMutated?.()
  }

  function markPaid() {
    setActionError('')
    setPayAmount(Number(balance).toFixed(2))
    setPaymentDate('')
    setPaymentCurrency(data.currency || '')
    setMode('payment')
  }

  async function recordPayment() {
    setBusy(true)
    setActionError('')
    try {
      const result = await recordInvoicePayment({
        database: supabase,
        invoiceId: data.id,
        amount: payAmount,
        currency: paymentCurrency,
        paymentDate,
      })
      const allocation = result?.allocations?.[0]
      if (!allocation) throw new Error('The payment was recorded but its invoice result was unavailable. Refresh before retrying.')
      const wasPaid = data.paid === true
      setData((d) => ({
        ...d,
        amount_paid: Number(allocation.invoice_amount_paid),
        paid: allocation.invoice_paid === true,
        currency: allocation.invoice_currency,
      }))
      setPayAmount('')
      setPaymentDate('')
      setPaymentCurrency(allocation.invoice_currency || '')
      setMode('none')
      const paymentLabel = formatPaymentAmount(allocation.amount, allocation.invoice_currency)
      setPaymentConfirmation(`Payment of ${paymentLabel} recorded`)
      setTimeout(() => setPaymentConfirmation(''), 2500)
      if (!wasPaid && allocation.invoice_paid === true) {
        // Celebratory only on the payment that actually closes the invoice.
        celebrate({
          clientName,
          amount: paymentLabel,
          daysEarly: Math.max(daysUntil(data.due_date) ?? 0, 0),
        })
      }
      onMutated?.()
    } catch (error) {
      setActionError(error.message)
    } finally {
      setBusy(false)
    }
  }

  function openReminderDraft() {
    setActionError('')
    if (signatureContext) {
      setTone(signatureContext.recommended_tone || 'friendly')
      setDraft(signatureContext.draft_content || '')
      logEvent('reminder_opened', { userId: user.id, invoiceId: data.id })
      setMode('reminder')
      return
    }
    // A fresh, founder-initiated draft — CognitiveCompose owns this
    // experience end to end (work-status, reveal, review, send).
    setShowCompose(true)
  }

  function pickTone(t) {
    setTone(t)
    setDraft(
      reminderDraft(t, {
        clientName,
        invoiceNumber: data.invoice_number,
        balance: formatMoney(balance),
        dueDate: formatShortDate(data.due_date),
      })
    )
  }

  async function sendReminder() {
    if (!draft.trim()) return setActionError('The reminder message is empty.')
    setBusy(true)
    setActionError('')
    // Real Cognitive signal — an actual in-flight network call, not a
    // fabricated "thinking" state.
    startCognitive(`Drafting reminder for ${clientName}`)

    const result = await sendReminderNow({
      userId: user.id,
      invoice: data,
      draft,
      signatureContext,
    })
    // The real async work (the network send) is done — Cognitive shouldn't
    // keep animating through the follow-up DB writes above.
    stopCognitive()
    if (result.error) {
      setBusy(false)
      return setActionError(result.error)
    }

    // Second review-fix pass, HIGH: "Edit First" is the same approval
    // resolution as SignatureCard's Approve/Skip — pass the same
    // invoiceId/ruleId so Pulse's pendingInvoiceIds/handledKeys reconcile
    // immediately here too, not just on the unedited approval path.
    if (signatureContext) {
      onSignatureResolved?.(signatureContext.id, {
        invoiceId: signatureContext.invoice_id,
        ruleId: signatureContext.ai_context?.rule_id,
      })
    }

    setBusy(false)
    setReminders((r) =>
      dedupeReminders([
        { id: `local-${Date.now()}`, title: 'Reminder sent', detail: result.draft, created_at: result.nowIso },
        ...r,
      ])
    )
    setData((d) => ({ ...d, last_reminder: result.nowIso }))
    onMutated?.()
    setMode('sent')
    setTimeout(() => onClose(), 1400)
  }

  return (
    <>
      <div className={shown ? 'panel-overlay shown' : 'panel-overlay'} onClick={onClose} />
      <aside
        className={shown ? 'detail-panel shown' : 'detail-panel'}
        role="dialog"
        aria-label={`Invoice ${data.invoice_number || ''} for ${clientName}`}
      >
        {/* Header */}
        <div className="detail-header">
          <div className="detail-header-top">
            <h2 className="detail-client">{clientName}</h2>
            <div className="detail-header-right">
              <StatusPill status={effectiveStatus(data)} />
              <button className="detail-close" onClick={onClose} aria-label="Close">
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="detail-meta">
            <span>{data.invoice_number || 'No number'}</span>
            <span className="detail-meta-dot">·</span>
            <span>Issued {formatShortDate(data.issue_date)}</span>
            <span className="detail-meta-dot">·</span>
            <span>Due {formatShortDate(data.due_date)}</span>
            {!data.paid && overdueBy > 0 && (
              <>
                <span className="detail-meta-dot">·</span>
                <span className="detail-meta-overdue">
                  {overdueBy} {overdueBy === 1 ? 'day' : 'days'} overdue
                </span>
              </>
            )}
          </div>
        </div>

        {/* Scrollable body */}
        <div className="detail-body">
          <JourneyBar
            invoice={data}
            isPendingSignature={hasPendingSignature}
            hasAutopilotRun={hasCompletedAutopilotRun}
          />

          <DwInvoiceIntelligencePanel model={dwCase} />
          <AskDwInvoiceLiveProbe invoiceId={data.id} />

          {autopilotEnabled && (
            <div className={invoicePaused ? 'invoice-autopilot-block paused' : 'invoice-autopilot-block'}>
              {invoicePaused ? (
                <>
                  <div className="invoice-autopilot-status">
                    <PauseCircle size={14} color="var(--text-muted)" /> Autopilot paused for this invoice.
                  </div>
                  <button
                    type="button"
                    className="invoice-autopilot-toggle"
                    onClick={toggleInvoiceAutopilot}
                    disabled={pauseBusy}
                  >
                    {pauseBusy ? 'Turning on…' : 'Turn on'}
                  </button>
                </>
              ) : (
                <>
                  <div className="invoice-autopilot-status">
                    <Bot size={14} color="var(--primary)" /> Autopilot is handling future reminders.
                  </div>
                  {hasPendingSignature ? (
                    <p className="invoice-autopilot-next">A reminder is waiting for your signature.</p>
                  ) : upcoming ? (
                    <p className="invoice-autopilot-next">
                      {upcoming.eligible
                        ? `Next check will send a ${upcoming.rule.name.toLowerCase()}.`
                        : `Next: ${upcoming.rule.name} in ${upcoming.daysAway} ${upcoming.daysAway === 1 ? 'day' : 'days'}.`}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="invoice-autopilot-toggle"
                    onClick={toggleInvoiceAutopilot}
                    disabled={pauseBusy}
                  >
                    {pauseBusy ? 'Pausing…' : 'Pause for this invoice'}
                  </button>
                </>
              )}
            </div>
          )}

          <table className="line-items">
            <thead>
              <tr>
                <th>Description</th>
                <th className="ta-center">Qty</th>
                <th className="ta-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.length === 0 ? (
                <tr>
                  <td colSpan={3} className="line-items-empty">
                    {loading ? 'Loading…' : 'No line items.'}
                  </td>
                </tr>
              ) : (
                lineItems.map((li) => (
                  <tr key={li.id}>
                    <td>{liDesc(li)}</td>
                    <td className="ta-center">{liQty(li)}</td>
                    <td className="ta-right">{formatMoney(liQty(li) * liPrice(li))}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <div className="totals">
            <div className="totals-row">
              <span>Amount</span>
              <span>{formatMoney(displaySubtotal)}</span>
            </div>
            {paid > 0 && (
              <div className="totals-row">
                <span>Amount paid</span>
                <span className="totals-partial">-{formatMoney(paid)}</span>
              </div>
            )}
            <div className="totals-row totals-balance">
              <span>Balance due</span>
              <span>{formatMoney(balance)}</span>
            </div>
          </div>

          <div className="timeline-block">
            <h3 className="timeline-title">Reminder History</h3>
            {reminders.length === 0 ? (
              <p className="timeline-empty">{loading ? 'Loading…' : 'No reminders sent yet.'}</p>
            ) : (
              <ul className="timeline">
                {reminders.map((ev) => (
                  <li key={ev.id} className="timeline-item">
                    <span className="timeline-dot" />
                    <div className="timeline-content">
                      <div className="timeline-event-top">
                        <span className="timeline-event-title">{ev.title}</span>
                        <span className="timeline-event-date">{formatEventDate(ev.created_at)}</span>
                      </div>
                      {ev.detail && <p className="timeline-detail">{ev.detail}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Actions pinned to bottom */}
        <div className="detail-actions">
          {paymentConfirmation && (
            <div className="payment-confirmation">
              <CheckIcon width={14} height={14} /> {paymentConfirmation}
            </div>
          )}
          {actionError && <div className="auth-error action-error">{actionError}</div>}

          {mode === 'payment' && (
            <div className="action-form">
              <label htmlFor="payAmount">Payment amount</label>
              <div className="money-field">
                <span className="money-prefix">{paymentCurrency || '—'}</span>
                <input
                  id="payAmount"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  onBlur={(e) => {
                    const n = Number(e.target.value)
                    if (e.target.value !== '' && !Number.isNaN(n)) {
                      setPayAmount(n.toFixed(2))
                    }
                  }}
                  placeholder="0.00"
                  autoFocus
                />
              </div>
              {!data.currency && (
                <>
                  <label htmlFor="paymentCurrency">Currency</label>
                  <select
                    id="paymentCurrency"
                    value={paymentCurrency}
                    onChange={(e) => setPaymentCurrency(e.target.value)}
                    required
                  >
                    <option value="">Choose currency</option>
                    {SUPPORTED_CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
                  </select>
                </>
              )}
              <label htmlFor="paymentDate">Payment date</label>
              <input
                id="paymentDate"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                required
              />
              <div className="action-form-row">
                <button className="btn-outline" onClick={() => setMode('none')} disabled={busy}>
                  Cancel
                </button>
                <button className="btn-terracotta" onClick={recordPayment} disabled={busy}>
                  {busy ? 'Saving…' : 'Record'}
                </button>
              </div>
            </div>
          )}

          {mode === 'reminder' && (
            <div className="action-form">
              {signatureContext && (
                <div className="autopilot-draft-label">
                  <Bot size={14} color="var(--primary)" /> Autopilot&apos;s draft — edit anything.
                </div>
              )}
              <div className="tone-buttons">
                {TONES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={tone === t ? 'tone-btn active' : 'tone-btn'}
                    onClick={() => pickTone(t)}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
              <textarea
                id="draft"
                rows={7}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="action-form-row">
                <button className="btn-outline" onClick={() => setMode('none')} disabled={busy}>
                  Cancel
                </button>
                <button className="btn-terracotta" onClick={sendReminder} disabled={busy}>
                  {busy ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          )}

          {mode === 'sent' && (
            <div className="reminder-sent-state">
              <span className="success-check">
                <CheckIcon width={16} height={16} />
              </span>
              I sent a reminder to {clientName}.
            </div>
          )}

          {mode === 'none' && (
            <>
              <button className="btn-terracotta" onClick={openReminderDraft} disabled={busy}>
                Send reminder
              </button>
              <button className="btn-outline" onClick={() => { setActionError(''); setPayAmount(''); setPaymentDate(''); setPaymentCurrency(data.currency || ''); setMode('payment') }} disabled={busy}>
                Record payment
              </button>
              <button className="btn-outline" onClick={markPaid} disabled={busy || data.paid === true}>
                {data.paid === true ? 'Paid' : busy ? 'Working…' : 'Mark paid'}
              </button>
            </>
          )}
        </div>
      </aside>

      {showCompose && (
        <CognitiveCompose
          invoice={data}
          onClose={() => setShowCompose(false)}
          onSent={() => onMutated?.()}
        />
      )}
    </>
  )
}
