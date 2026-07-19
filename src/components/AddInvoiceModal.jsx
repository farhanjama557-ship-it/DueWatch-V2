import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { logEvent } from '../lib/events'
import { CloseIcon } from './icons'

// today / date + N days as YYYY-MM-DD (local).
function toISO(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10)
}
function addDays(isoDate, n) {
  const base = isoDate ? new Date(isoDate + 'T00:00:00') : new Date()
  base.setDate(base.getDate() + n)
  return toISO(base)
}

export default function AddInvoiceModal({ open, onClose }) {
  const { user } = useAuth()
  const { clients, refresh } = useData()

  const [clientName, setClientName] = useState('')
  const [invNum, setInvNum] = useState('')
  const [invDate, setInvDate] = useState(toISO(new Date()))
  const [dueDate, setDueDate] = useState(addDays(toISO(new Date()), 30))
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Reset when the modal opens.
  useEffect(() => {
    if (open) {
      setClientName('')
      setInvNum('')
      setInvDate(toISO(new Date()))
      setDueDate(addDays(toISO(new Date()), 30))
      setAmount('')
      setNotes('')
      setError('')
      setSaving(false)
    }
  }, [open])

  // Esc to close.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && !saving && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, saving, onClose])

  if (!open) return null

  function applyNet(days) {
    setDueDate(addDays(invDate, days))
  }

  async function handleSave(e) {
    e.preventDefault()
    setError('')

    const name = clientName.trim()
    if (!name) return setError('Client name is required.')
    if (!invNum.trim()) return setError('Invoice number is required.')
    const amt = Number(amount)
    if (!amount || Number.isNaN(amt) || amt < 0)
      return setError('Enter a valid amount.')

    setSaving(true)

    // Reuse an existing client by name (case-insensitive), else create one.
    let clientId = clients.find(
      (c) => (c.name || '').trim().toLowerCase() === name.toLowerCase()
    )?.id

    if (!clientId) {
      const { data: newClient, error: cErr } = await supabase
        .from('clients')
        .insert({ user_id: user.id, name })
        .select('id')
        .single()
      if (cErr) {
        setSaving(false)
        return setError(`Could not create client: ${cErr.message}`)
      }
      clientId = newClient.id
    }

    const { data: newInvoice, error: iErr } = await supabase
      .from('invoices')
      .insert({
        user_id: user.id,
        client_id: clientId,
        inv_num: invNum.trim(),
        inv_date: invDate || null,
        due_date: dueDate || null,
        amount: amt,
        amount_paid: 0,
        paid: false,
        notes: notes.trim() || null,
      })
      .select('id')
      .single()

    if (iErr) {
      setSaving(false)
      return setError(`Could not create invoice: ${iErr.message}`)
    }

    logEvent('invoice_created', { userId: user.id, invoiceId: newInvoice?.id ?? null })
    await refresh()
    setSaving(false)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={() => !saving && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="New invoice">
        <div className="modal-header">
          <h2 className="modal-title">New Invoice</h2>
          <button className="detail-close" onClick={onClose} aria-label="Close" disabled={saving}>
            <CloseIcon />
          </button>
        </div>

        <form className="modal-body" onSubmit={handleSave}>
          {error && <div className="auth-error">{error}</div>}

          <div className="field">
            <label htmlFor="clientName">Client name</label>
            <input
              id="clientName"
              list="client-options"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Start typing to autofill…"
              autoComplete="off"
              required
            />
            <datalist id="client-options">
              {clients.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </div>

          <div className="field">
            <label htmlFor="invNum">Invoice #</label>
            <input
              id="invNum"
              value={invNum}
              onChange={(e) => setInvNum(e.target.value)}
              placeholder="INV-1001"
              required
            />
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="invDate">Invoice date</label>
              <input
                id="invDate"
                type="date"
                value={invDate}
                onChange={(e) => setInvDate(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="dueDate">Due date</label>
              <input
                id="dueDate"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          <div className="net-picks">
            <span className="net-label">Quick set:</span>
            <button type="button" className="net-btn" onClick={() => applyNet(15)}>Net 15</button>
            <button type="button" className="net-btn" onClick={() => applyNet(30)}>Net 30</button>
            <button type="button" className="net-btn" onClick={() => applyNet(60)}>Net 60</button>
          </div>

          <div className="field">
            <label htmlFor="amount">Amount</label>
            <div className="money-field">
              <span className="money-prefix">$</span>
              <input
                id="amount"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onBlur={(e) => {
                  const n = Number(e.target.value)
                  if (e.target.value !== '' && !Number.isNaN(n)) {
                    setAmount(n.toFixed(2))
                  }
                }}
                placeholder="0.00"
                required
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="notes">Notes</label>
            <textarea
              id="notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-outline" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-terracotta" disabled={saving}>
              {saving ? 'Saving…' : 'Create Invoice'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
