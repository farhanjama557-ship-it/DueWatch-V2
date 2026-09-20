import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, Upload, X, Mail, Phone, FileText } from 'lucide-react'
import { useData, balanceOf, isOutstanding } from '../context/DataContext'
import Avatar from '../components/Avatar'
import { formatMoney, formatShortDate, formatEventDate, daysOverdue } from '../lib/format'
import './clients.css'

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'at_risk', label: 'At risk' },
  { key: 'clear', label: 'Clear' },
]

function clientEmail(client) {
  return client?.email || client?.primary_email || client?.contact_email || ''
}

function clientPhone(client) {
  return client?.phone || client?.primary_phone || client?.contact_phone || ''
}

function clientCompany(client) {
  return client?.company || client?.company_name || ''
}

export default function Clients() {
  const { clients, invoices, events, loading, error } = useData()
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState(null)

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()

    return clients
      .map((client) => {
        const clientInvoices = invoices.filter((invoice) => invoice.client_id === client.id)
        const outstandingInvoices = clientInvoices.filter(isOutstanding)
        const outstanding = outstandingInvoices.reduce((sum, invoice) => sum + balanceOf(invoice), 0)
        const overdueInvoices = outstandingInvoices.filter((invoice) => daysOverdue(invoice.due_date) > 0)
        const maxDaysOverdue = overdueInvoices.reduce(
          (max, invoice) => Math.max(max, daysOverdue(invoice.due_date)),
          0
        )
        const lastEvent = events.find((event) => event.invoices?.clients?.name === client.name)

        return {
          client,
          clientInvoices,
          outstanding,
          openCount: outstandingInvoices.length,
          overdueCount: overdueInvoices.length,
          maxDaysOverdue,
          lastEvent,
        }
      })
      .filter((row) => {
        if (filter === 'active') return row.openCount > 0
        if (filter === 'at_risk') return row.overdueCount > 0
        if (filter === 'clear') return row.overdueCount === 0
        return true
      })
      .filter((row) => {
        if (!q) return true
        const haystack = [
          row.client.name,
          clientCompany(row.client),
          clientEmail(row.client),
          clientPhone(row.client),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return haystack.includes(q)
      })
      .sort((a, b) => b.outstanding - a.outstanding || a.client.name.localeCompare(b.client.name))
  }, [clients, invoices, events, filter, search])

  const selected = rows.find((row) => row.client.id === selectedId) || rows[0] || null

  return (
    <div className="clients-screen">
      <section className="clients-workspace">
        <header className="clients-page-head">
          <div>
            <h1>Clients</h1>
            <p>Manage your customers, understand payment behavior, and act on real receivable state.</p>
          </div>
          <Link to="/import" className="clients-import-btn">
            <Upload size={15} />
            Import from CSV
          </Link>
        </header>

        <div className="clients-toolbar">
          <div className="clients-filter-tabs" role="tablist" aria-label="Client filters">
            {FILTERS.map((item) => (
              <button
                type="button"
                key={item.key}
                className={filter === item.key ? 'is-active' : ''}
                onClick={() => setFilter(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="clients-search">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search clients..."
              aria-label="Search clients"
            />
          </label>
        </div>

        <div className="clients-table-shell">
          {loading ? (
            <div className="clients-state">Loading clients…</div>
          ) : error ? (
            <div className="clients-state clients-state-error">Couldn&apos;t load clients: {error}</div>
          ) : rows.length === 0 ? (
            <div className="clients-state">{clients.length ? 'No clients match this view.' : 'No clients yet.'}</div>
          ) : (
            <table className="clients-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Outstanding</th>
                  <th>Open inv.</th>
                  <th>Overdue</th>
                  <th>Last activity</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const active = selected?.client.id === row.client.id
                  return (
                    <tr
                      key={row.client.id}
                      className={active ? 'is-selected' : ''}
                      onClick={() => setSelectedId(row.client.id)}
                    >
                      <td>
                        <div className="client-identity">
                          <Avatar name={row.client.name} size={31} fontSize={10.5} />
                          <div>
                            <strong>{row.client.name || 'Unnamed client'}</strong>
                            <span>{clientCompany(row.client) || clientEmail(row.client) || 'Client record'}</span>
                          </div>
                        </div>
                      </td>
                      <td className="clients-money">{formatMoney(row.outstanding)}</td>
                      <td>{row.openCount}</td>
                      <td>
                        {row.maxDaysOverdue > 0 ? (
                          <span className="clients-overdue">{row.maxDaysOverdue}d</span>
                        ) : (
                          <span className="clients-muted">—</span>
                        )}
                      </td>
                      <td>
                        {row.lastEvent ? (
                          <span>{formatEventDate(row.lastEvent.created_at)}</span>
                        ) : (
                          <span className="clients-muted">No recent activity</span>
                        )}
                      </td>
                      <td>
                        {row.overdueCount > 0 ? (
                          <span className="client-status client-status-risk">At risk</span>
                        ) : row.openCount > 0 ? (
                          <span className="client-status client-status-active">Active</span>
                        ) : (
                          <span className="client-status client-status-clear">Clear</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <aside className="client-detail-dock" aria-live="polite">
        {selected ? (
          <>
            <div className="client-detail-head">
              <div className="client-detail-title">
                <Avatar name={selected.client.name} size={44} fontSize={14} />
                <div>
                  <h2>{selected.client.name || 'Unnamed client'}</h2>
                  <p>{clientCompany(selected.client) || 'Client overview'}</p>
                </div>
              </div>
              <button
                type="button"
                className="client-detail-clear"
                onClick={() => setSelectedId(null)}
                aria-label="Clear selected client"
              >
                <X size={18} />
              </button>
            </div>

            <div className="client-detail-tabs">
              <button type="button" className="is-active">Overview</button>
              <button type="button" disabled>Payments</button>
              <button type="button" disabled>Promises</button>
              <button type="button" disabled>Notes</button>
            </div>

            <div className="client-detail-metrics">
              <div>
                <span>Total outstanding</span>
                <strong>{formatMoney(selected.outstanding)}</strong>
              </div>
              <div>
                <span>Open invoices</span>
                <strong>{selected.openCount}</strong>
              </div>
              <div>
                <span>Overdue</span>
                <strong className={selected.maxDaysOverdue > 0 ? 'is-risk' : ''}>
                  {selected.maxDaysOverdue > 0 ? selected.maxDaysOverdue + ' days' : 'None'}
                </strong>
              </div>
            </div>

            <section className="client-detail-section">
              <div className="client-detail-section-head">
                <h3>Contact information</h3>
              </div>
              <div className="client-contact-list">
                {clientEmail(selected.client) ? (
                  <a href={'mailto:' + clientEmail(selected.client)}>
                    <Mail size={15} />
                    <span>{clientEmail(selected.client)}</span>
                  </a>
                ) : null}
                {clientPhone(selected.client) ? (
                  <a href={'tel:' + clientPhone(selected.client)}>
                    <Phone size={15} />
                    <span>{clientPhone(selected.client)}</span>
                  </a>
                ) : null}
                {!clientEmail(selected.client) && !clientPhone(selected.client) ? (
                  <p className="clients-muted">No contact details saved.</p>
                ) : null}
              </div>
            </section>

            <section className="client-detail-section">
              <div className="client-detail-section-head">
                <h3>Recent invoices</h3>
                <span>{selected.clientInvoices.length}</span>
              </div>
              <div className="client-invoice-list">
                {selected.clientInvoices.length === 0 ? (
                  <p className="clients-muted">No invoices for this client.</p>
                ) : (
                  selected.clientInvoices
                    .slice()
                    .sort((a, b) => new Date(b.issue_date || 0) - new Date(a.issue_date || 0))
                    .slice(0, 5)
                    .map((invoice) => (
                      <Link key={invoice.id} to="/invoices" className="client-invoice-row">
                        <span className="client-invoice-icon"><FileText size={14} /></span>
                        <span className="client-invoice-copy">
                          <strong>{invoice.invoice_number || 'Invoice'}</strong>
                          <small>Due {formatShortDate(invoice.due_date)}</small>
                        </span>
                        <span className="client-invoice-amount">{formatMoney(balanceOf(invoice))}</span>
                      </Link>
                    ))
                )}
              </div>
            </section>

            <section className="client-detail-section">
              <div className="client-detail-section-head">
                <h3>Recent activity</h3>
              </div>
              {selected.lastEvent ? (
                <div className="client-activity-row">
                  <span className="client-activity-dot" />
                  <div>
                    <strong>{selected.lastEvent.event_type?.replaceAll('_', ' ') || 'Activity recorded'}</strong>
                    <span>{formatEventDate(selected.lastEvent.created_at)}</span>
                  </div>
                </div>
              ) : (
                <p className="clients-muted">No recent activity in the current activity window.</p>
              )}
            </section>
          </>
        ) : (
          <div className="clients-state">Select a client to see details.</div>
        )}
      </aside>
    </div>
  )
}
