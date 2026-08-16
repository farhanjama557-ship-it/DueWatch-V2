import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Upload } from 'lucide-react'
import { useData, isOutstanding, balanceOf, effectiveStatus } from '../context/DataContext'
import StatusPill from '../components/StatusPill'
import Avatar from '../components/Avatar'
import InvoiceDetailPanel from '../components/InvoiceDetailPanel'
import AddInvoiceModal from '../components/AddInvoiceModal'
import { formatMoney, formatShortDate, daysOverdue } from '../lib/format'
import { SearchIcon, PlusIcon } from '../components/icons'

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'due_soon', label: 'Due Soon' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'sent', label: 'Sent' },
  { key: 'paid', label: 'Paid' },
]

function matchesTab(inv, tab) {
  if (tab === 'all') return true
  const s = effectiveStatus(inv)
  if (tab === 'paid') return s === 'paid'
  if (tab === 'sent') return s === 'sent'
  if (tab === 'due_soon') return s === 'due_soon'
  // "Overdue" tab groups every past-due tier.
  if (tab === 'overdue') return s === 'overdue' || s === 'critical' || s === 'final_notice'
  return true
}

export default function Invoices() {
  const { invoices, loading, error, refresh } = useData()
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [showAdd, setShowAdd] = useState(false)

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return invoices
      .filter((inv) => matchesTab(inv, tab))
      .filter((inv) => {
        if (!q) return true
        const client = (inv.clients?.name || '').toLowerCase()
        const num = (inv.invoice_number || '').toLowerCase()
        return client.includes(q) || num.includes(q)
      })
      .sort((a, b) => daysOverdue(b.due_date) - daysOverdue(a.due_date))
  }, [invoices, tab, search])

  return (
    <div className="brief">
      <div className="list-head">
        <h1 className="brief-greeting">Invoices</h1>
        <div className="invoices-header-actions">
          <Link to="/import" className="btn-outline btn-inline invoices-import-link">
            <Upload width={16} height={16} /> Import CSV / Excel
          </Link>
          <button className="btn-terracotta btn-inline" onClick={() => setShowAdd(true)}>
            <PlusIcon width={16} height={16} /> New Invoice
          </button>
        </div>
      </div>

      <div className="list-controls">
        <div className="tabs invoice-filter-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={tab === t.key ? 'tab active' : 'tab'}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="search-box">
          <SearchIcon width={16} height={16} className="search-icon" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search client or invoice #"
          />
        </div>
      </div>

      <div className="brief-card list-card">
        {loading ? (
          <p className="brief-empty list-pad">Loading invoices…</p>
        ) : error ? (
          <p className="brief-error list-pad">Couldn&apos;t load invoices: {error}</p>
        ) : rows.length === 0 ? (
          <p className="brief-empty list-pad">
            {invoices.length === 0 ? 'No invoices yet.' : 'No invoices match this view.'}
          </p>
        ) : (
          <table className="invoice-table">
            <colgroup>
              <col className="col-client" />
              <col className="col-invnum" />
              <col className="col-amount" />
              <col className="col-due" />
              <col className="col-overdue" />
              <col className="col-status" />
            </colgroup>
            <thead>
              <tr>
                <th className="invoice-client-heading">Client</th>
                <th>Invoice #</th>
                <th className="ta-right">Amount</th>
                <th>Due Date</th>
                <th className="ta-right">Days Overdue</th>
                <th className="ta-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const od = daysOverdue(inv.due_date)
                return (
                  <tr key={inv.id} onClick={() => setSelected(inv)}>
                    <td>
                      <div className="cell-client">
                        <Avatar name={inv.clients?.name} size={28} />
                        <span>{inv.clients?.name || 'No client'}</span>
                      </div>
                    </td>
                    <td className="cell-muted">{inv.invoice_number || '—'}</td>
                    <td className="ta-right cell-amount">{formatMoney(inv.amount)}</td>
                    <td className="cell-muted">{formatShortDate(inv.due_date)}</td>
                    <td className="ta-right">
                      {!inv.paid && od > 0 ? (
                        <span className="cell-overdue">{od}</span>
                      ) : (
                        <span className="cell-muted">—</span>
                      )}
                    </td>
                    <td className="ta-right">
                      <StatusPill status={effectiveStatus(inv)} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <InvoiceDetailPanel
        invoice={selected}
        onClose={() => setSelected(null)}
        onMutated={refresh}
      />
      <AddInvoiceModal open={showAdd} onClose={() => setShowAdd(false)} />
    </div>
  )
}
