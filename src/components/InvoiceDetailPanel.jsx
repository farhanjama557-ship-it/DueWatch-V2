import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import StatusPill from './StatusPill'
import { CloseIcon } from './icons'
import {
  formatMoney,
  formatShortDate,
  formatEventDate,
  daysOverdue,
} from '../lib/format'
import { balanceOf, effectiveStatus } from '../context/DataContext'

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

/**
 * Slide-in invoice detail panel (320px, right side, overlay behind).
 * `invoice` non-null opens it; `onClose` closes it. Esc / overlay click close.
 */
export default function InvoiceDetailPanel({ invoice, onClose }) {
  const [render, setRender] = useState(Boolean(invoice))
  const [shown, setShown] = useState(false)
  const [data, setData] = useState(invoice)
  const [lineItems, setLineItems] = useState([])
  const [reminders, setReminders] = useState([])
  const [loading, setLoading] = useState(false)

  // Mount / open / close transition management.
  useEffect(() => {
    if (invoice) {
      setData(invoice)
      setRender(true)
      const raf = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(raf)
    }
    setShown(false)
    const t = setTimeout(() => setRender(false), 250)
    return () => clearTimeout(t)
  }, [invoice])

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
      supabase
        .from('line_items')
        .select('*')
        .eq('invoice_id', invoice.id),
      supabase
        .from('reminders')
        .select('id, title, detail, created_at')
        .eq('invoice_id', invoice.id)
        .order('created_at', { ascending: false }),
    ]).then(([li, rem]) => {
      if (cancelled) return
      setLineItems(li.data || [])
      setReminders(rem.data || [])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [invoice?.id])

  if (!render || !data) return null

  const clientName = data.clients?.name || 'No client'
  const overdueBy = daysOverdue(data.due_date)

  const subtotal = lineItems.reduce(
    (sum, li) => sum + liQty(li) * liPrice(li),
    0
  )
  // Fall back to the invoice amount if there are no line items yet.
  const displaySubtotal = lineItems.length > 0 ? subtotal : Number(data.amount) || 0
  const paid = Number(data.amount_paid) || 0
  const balance = balanceOf(data)

  return (
    <>
      <div
        className={shown ? 'panel-overlay shown' : 'panel-overlay'}
        onClick={onClose}
      />
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
              <button
                className="detail-close"
                onClick={onClose}
                aria-label="Close"
              >
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
            {overdueBy > 0 && (
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
          {/* Line items */}
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
                    <td className="ta-right">
                      {formatMoney(liQty(li) * liPrice(li))}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {/* Totals */}
          <div className="totals">
            <div className="totals-row">
              <span>Subtotal</span>
              <span>{formatMoney(displaySubtotal)}</span>
            </div>
            {paid > 0 && (
              <div className="totals-row">
                <span>Partial payment</span>
                <span className="totals-partial">-{formatMoney(paid)}</span>
              </div>
            )}
            <div className="totals-row totals-balance">
              <span>Balance due</span>
              <span>{formatMoney(balance)}</span>
            </div>
          </div>

          {/* Reminder history */}
          <div className="timeline-block">
            <h3 className="timeline-title">Reminder History</h3>
            {reminders.length === 0 ? (
              <p className="timeline-empty">
                {loading ? 'Loading…' : 'No reminders sent yet.'}
              </p>
            ) : (
              <ul className="timeline">
                {reminders.map((ev) => (
                  <li key={ev.id} className="timeline-item">
                    <span className="timeline-dot" />
                    <div className="timeline-content">
                      <div className="timeline-event-top">
                        <span className="timeline-event-title">{ev.title}</span>
                        <span className="timeline-event-date">
                          {formatEventDate(ev.created_at)}
                        </span>
                      </div>
                      {ev.detail && (
                        <p className="timeline-detail">{ev.detail}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Actions pinned to bottom */}
        <div className="detail-actions">
          <button className="btn-terracotta">Send reminder</button>
          <button className="btn-outline">Record payment</button>
          <button className="btn-outline">Mark paid</button>
        </div>
      </aside>
    </>
  )
}
