import { useEffect, useState } from 'react'
import { Bot, PauseCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import StatusPill from './StatusPill'
import { CloseIcon, CheckIcon } from './icons'
import {
  formatMoney,
  formatShortDate,
  formatEventDate,
  daysOverdue,
} from '../lib/format'
import { balanceOf, effectiveStatus } from '../context/DataContext'
import { logEvent } from '../lib/events'
import { fetchAutopilotRules } from '../lib/autopilot'
import { nextScheduledAction } from '../lib/ruleSchedule'

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

const TONES = ['friendly', 'professional', 'firm']

function reminderDraft(tone, { clientName, invoiceNumber, balance, dueDate }) {
  const num = invoiceNumber || 'your invoice'
  if (tone === 'professional') {
    return (
      `Dear ${clientName},\n\n` +
      `I hope this finds you well. Our records show invoice ${num} for ${balance}, due ${dueDate}, ` +
      `remains outstanding.\n\n` +
      `Please let us know if you have any questions, or if payment has already been sent.\n\nBest regards.`
    )
  }
  if (tone === 'firm') {
    return (
      `Hi ${clientName},\n\n` +
      `Invoice ${num} for ${balance} was due ${dueDate} and remains unpaid. Please arrange payment ` +
      `as soon as possible.\n\n` +
      `If you believe this is an error, please reach out right away.`
    )
  }
  // friendly (default)
  return (
    `Hi ${clientName},\n\n` +
    `This is a friendly reminder that invoice ${num} for ${balance} was due ${dueDate}.\n\n` +
    `Please let us know if payment is already on its way.\n\nThank you.`
  )
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
}) {
  const { user } = useAuth()
  const { autopilotEnabled, awaitingSignature } = useData()
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
  const [tone, setTone] = useState('friendly')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [paymentConfirmation, setPaymentConfirmation] = useState('')

  // Mount / open / close transition management.
  useEffect(() => {
    if (invoice) {
      setData(invoice)
      setRender(true)
      setActionError('')
      setPaymentConfirmation('')
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

  async function markPaid() {
    setBusy(true)
    setActionError('')
    const { error } = await supabase
      .from('invoices')
      .update({ paid: true })
      .eq('id', data.id)
    setBusy(false)
    if (error) return setActionError(error.message)
    setData((d) => ({ ...d, paid: true }))
    logEvent('invoice_marked_paid', { userId: user.id, invoiceId: data.id })
    onMutated?.()
  }

  async function recordPayment() {
    const amt = Number(payAmount)
    if (!payAmount || Number.isNaN(amt) || amt <= 0) {
      return setActionError('Enter a valid payment amount.')
    }
    setBusy(true)
    setActionError('')
    const newPaid = paid + amt
    const willBePaid = newPaid >= (Number(data.amount) || 0)
    const updatePayload = { amount_paid: newPaid }
    if (willBePaid) updatePayload.paid = true

    // Optimistic: update local state immediately, sync Supabase in background.
    setData((d) => ({ ...d, amount_paid: newPaid, paid: willBePaid ? true : d.paid }))
    setPayAmount('')
    setMode('none')
    setPaymentConfirmation(`Payment of ${formatMoney(amt)} recorded`)
    setTimeout(() => setPaymentConfirmation(''), 2500)

    const { error } = await supabase.from('invoices').update(updatePayload).eq('id', data.id)
    setBusy(false)
    if (error) {
      setActionError(error.message)
      return
    }
    logEvent('payment_recorded', { userId: user.id, invoiceId: data.id })
    if (willBePaid) logEvent('invoice_marked_paid', { userId: user.id, invoiceId: data.id })
    onMutated?.()
  }

  function openReminderDraft() {
    setActionError('')
    if (signatureContext) {
      setTone(signatureContext.recommended_tone || 'friendly')
      setDraft(signatureContext.draft_content || '')
    } else {
      setTone('friendly')
      setDraft(
        reminderDraft('friendly', {
          clientName,
          invoiceNumber: data.invoice_number,
          balance: formatMoney(balance),
          dueDate: formatShortDate(data.due_date),
        })
      )
    }
    logEvent('reminder_opened', { userId: user.id, invoiceId: data.id })
    setMode('reminder')
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

    // The only place RESEND_API_KEY is used is server-side, in this Edge
    // Function — nothing here holds the key. Bail out without writing
    // anything if the send itself fails, so the founder can retry.
    const { data: sendResult, error: sendErr } = await supabase.functions.invoke(
      'send-reminder-email',
      { body: { invoiceId: data.id, body: draft.trim() } }
    )
    if (sendErr || sendResult?.error) {
      setBusy(false)
      return setActionError(sendResult?.error || sendErr.message)
    }

    const nowIso = new Date().toISOString()
    const { error: remErr } = await supabase.from('reminders').insert({
      invoice_id: data.id,
      user_id: user.id,
      title: 'Reminder sent',
      detail: draft.trim(),
    })
    if (remErr) {
      setBusy(false)
      return setActionError(remErr.message)
    }
    await supabase.from('invoices').update({ last_reminder: nowIso }).eq('id', data.id)

    if (signatureContext) {
      await supabase
        .from('awaiting_signature')
        .update({ status: 'approved', resolved_at: nowIso })
        .eq('id', signatureContext.id)
      logEvent('reminder_sent', {
        userId: user.id,
        invoiceId: data.id,
        lifecycleStage: 'sent',
        lifecycleState: 'completed',
        evidence: {
          reason: signatureContext.ai_reason,
          trigger: 'Autopilot recommendation (edited)',
          approved_by: 'You',
          resend_id: sendResult?.id || null,
          delivery_status: 'sent',
        },
      })
      onSignatureResolved?.(signatureContext.id)
    } else {
      logEvent('reminder_sent', {
        userId: user.id,
        invoiceId: data.id,
        lifecycleStage: 'sent',
        lifecycleState: 'completed',
        evidence: { resend_id: sendResult?.id || null, delivery_status: 'sent' },
      })
    }

    setBusy(false)
    setReminders((r) =>
      dedupeReminders([
        { id: `local-${Date.now()}`, title: 'Reminder sent', detail: draft.trim(), created_at: nowIso },
        ...r,
      ])
    )
    setData((d) => ({ ...d, last_reminder: nowIso }))
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
                <span className="money-prefix">$</span>
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
              <button className="btn-outline" onClick={() => { setActionError(''); setMode('payment') }} disabled={busy}>
                Record payment
              </button>
              <button className="btn-outline" onClick={markPaid} disabled={busy || data.paid === true}>
                {data.paid === true ? 'Paid' : busy ? 'Working…' : 'Mark paid'}
              </button>
            </>
          )}
        </div>
      </aside>
    </>
  )
}
