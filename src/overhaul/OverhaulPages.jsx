import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Download,
  Filter,
  Mail,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import {
  balanceOf,
  effectiveStatus,
  isOutstanding,
  useData,
} from '../context/DataContext'
import InvoiceDetailPanel from '../components/InvoiceDetailPanel'
import AddInvoiceModal from '../components/AddInvoiceModal'
import { supabase } from '../lib/supabase'
import {
  DEFAULT_RULES,
  disableAutopilot,
  enableAutopilot,
  fetchAutopilotRules,
  ruleTiming,
  toggleRule,
} from '../lib/autopilot'
import {
  daysOverdue,
  daysUntil,
  formatEventDate,
  formatMoney,
  formatShortDate,
  initials,
  timeAgo,
} from '../lib/format'
import { OverhaulIcon } from './OverhaulIconSystem'
import './overhaul-pages.css'

function PageHeader({ title, subtitle, actions }) {
  return (
    <header className="ov2-page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="ov2-page-actions">{actions}</div> : null}
    </header>
  )
}

function Pill({ tone = 'neutral', children }) {
  return <span className={`ov2-pill ov2-pill--${tone}`}>{children}</span>
}

function TableEmpty({ children }) {
  return <div className="ov2-empty">{children}</div>
}

function InitialBadge({ name }) {
  return <span className="ov2-initial">{initials(name)}</span>
}

function SearchField({ value, onChange, placeholder }) {
  return (
    <label className="ov2-search">
      <Search size={15} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </label>
  )
}

function moneyCompact(value) {
  const n = Number(value) || 0
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: Math.abs(n) >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(n) >= 10000 ? 1 : 0,
  }).format(n)
}

const invoiceTabs = [
  ['all', 'All invoices'],
  ['overdue', 'Overdue'],
  ['due_soon', 'Due soon'],
  ['sent', 'Sent'],
  ['paid', 'Paid'],
]

function invoiceTabMatch(invoice, tab) {
  if (tab === 'all') return true
  const state = effectiveStatus(invoice)
  if (tab === 'overdue') return ['overdue', 'critical', 'final_notice'].includes(state)
  return state === tab
}

function invoiceTone(invoice) {
  const state = effectiveStatus(invoice)
  if (state === 'paid') return 'green'
  if (state === 'due_soon') return 'amber'
  if (['overdue', 'critical', 'final_notice'].includes(state)) return 'red'
  return 'blue'
}

function invoiceStatusLabel(invoice) {
  const state = effectiveStatus(invoice)
  const labels = {
    paid: 'Paid',
    due_soon: 'Due soon',
    overdue: 'Overdue',
    critical: 'Critical',
    final_notice: 'Final notice',
    sent: 'Sent',
  }
  return labels[state] || state
}

export function OverhaulInvoices() {
  const { invoices, loading, error, refresh } = useData()
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [showAdd, setShowAdd] = useState(false)

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return invoices
      .filter((invoice) => invoiceTabMatch(invoice, tab))
      .filter((invoice) => {
        if (!q) return true
        return [invoice.invoice_number, invoice.clients?.name]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q)
      })
      .sort((a, b) => daysOverdue(b.due_date) - daysOverdue(a.due_date))
  }, [invoices, tab, search])

  return (
    <div className="ov2-page">
      <PageHeader
        title="Invoices"
        subtitle="Create, track, and manage every receivable."
        actions={
          <>
            <Link className="ov2-button ov2-button--ghost" to="/import"><Upload size={15} />Import</Link>
            <button className="ov2-button ov2-button--primary" onClick={() => setShowAdd(true)}><Plus size={15} />New invoice</button>
          </>
        }
      />

      <div className="ov2-toolbar">
        <div className="ov2-tabs">
          {invoiceTabs.map(([key, label]) => (
            <button key={key} className={tab === key ? 'is-active' : ''} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
        <div className="ov2-toolbar-right">
          <SearchField value={search} onChange={setSearch} placeholder="Search invoices..." />
          <button className="ov2-icon-button" type="button" aria-disabled="true"><Filter size={15} /></button>
        </div>
      </div>

      <section className="ov2-card ov2-table-card">
        {loading ? <TableEmpty>Loading invoices…</TableEmpty> : error ? <TableEmpty>Couldn&apos;t load invoices: {error}</TableEmpty> : rows.length === 0 ? (
          <TableEmpty>No invoices match this view.</TableEmpty>
        ) : (
          <div className="ov2-scroll-table">
            <div className="ov2-invoice-grid ov2-grid-head">
              <span>Invoice</span><span>Client</span><span>Issue date</span><span>Due date</span><span>Amount</span><span>Balance</span><span>Status</span><span />
            </div>
            {rows.map((invoice) => (
              <button key={invoice.id} className="ov2-invoice-grid ov2-grid-row" onClick={() => setSelected(invoice)}>
                <span className="ov2-strong">{invoice.invoice_number || '—'}</span>
                <span className="ov2-person"><InitialBadge name={invoice.clients?.name} /><b>{invoice.clients?.name || 'No client'}</b></span>
                <span>{formatShortDate(invoice.issue_date)}</span>
                <span>{formatShortDate(invoice.due_date)}</span>
                <span className="ov2-money">{formatMoney(invoice.amount)}</span>
                <span className="ov2-money">{formatMoney(balanceOf(invoice))}</span>
                <span><Pill tone={invoiceTone(invoice)}>{invoiceStatusLabel(invoice)}</Pill></span>
                <span className="ov2-more"><MoreHorizontal size={15} /></span>
              </button>
            ))}
          </div>
        )}
      </section>

      <InvoiceDetailPanel invoice={selected} onClose={() => setSelected(null)} onMutated={refresh} />
      <AddInvoiceModal open={showAdd} onClose={() => setShowAdd(false)} />
    </div>
  )
}

export function OverhaulClients() {
  const { clients, invoices, events, loading, error } = useData()
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState(null)

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return clients
      .map((client) => {
        const clientInvoices = invoices.filter((invoice) => invoice.client_id === client.id)
        const open = clientInvoices.filter(isOutstanding)
        const overdue = open.filter((invoice) => daysOverdue(invoice.due_date) > 0)
        const outstanding = open.reduce((sum, invoice) => sum + balanceOf(invoice), 0)
        return {
          client,
          clientInvoices,
          open,
          overdue,
          outstanding,
          maxDays: overdue.reduce((max, invoice) => Math.max(max, daysOverdue(invoice.due_date)), 0),
        }
      })
      .filter((row) => !q || [row.client.name, row.client.email, row.client.company]
        .filter(Boolean).join(' ').toLowerCase().includes(q))
      .sort((a, b) => b.outstanding - a.outstanding)
  }, [clients, invoices, search])

  const selected = rows.find((row) => row.client.id === selectedId) || rows[0] || null
  const selectedEvents = selected
    ? events.filter((event) => event.invoices?.clients?.name === selected.client.name).slice(0, 4)
    : []

  return (
    <div className="ov2-page">
      <PageHeader title="Clients" subtitle="See relationships, receivables, and payment behavior in one place." />
      <div className="ov2-toolbar">
        <div className="ov2-tabs">
          <button className="is-active">All clients</button>
          <button type="button" aria-disabled="true">At risk</button>
          <button type="button" aria-disabled="true">Clear</button>
        </div>
        <SearchField value={search} onChange={setSearch} placeholder="Search clients..." />
      </div>

      <div className="ov2-split-layout">
        <section className="ov2-card ov2-table-card">
          {loading ? <TableEmpty>Loading clients…</TableEmpty> : error ? <TableEmpty>Couldn&apos;t load clients: {error}</TableEmpty> : rows.length === 0 ? (
            <TableEmpty>No clients match this view.</TableEmpty>
          ) : (
            <div className="ov2-scroll-table">
              <div className="ov2-client-grid ov2-grid-head">
                <span>Client</span><span>Outstanding</span><span>Open invoices</span><span>Overdue</span><span>Health</span>
              </div>
              {rows.map((row) => (
                <button
                  key={row.client.id}
                  className={`ov2-client-grid ov2-grid-row ${selected?.client.id === row.client.id ? 'is-selected' : ''}`}
                  onClick={() => setSelectedId(row.client.id)}
                >
                  <span className="ov2-person"><InitialBadge name={row.client.name} /><b>{row.client.name || 'Unnamed client'}</b></span>
                  <span className="ov2-money">{formatMoney(row.outstanding)}</span>
                  <span>{row.open.length}</span>
                  <span className={row.maxDays > 0 ? 'ov2-danger' : ''}>{row.maxDays > 0 ? `${row.maxDays}d` : '—'}</span>
                  <span><Pill tone={row.overdue.length ? 'red' : row.open.length ? 'green' : 'neutral'}>{row.overdue.length ? 'At risk' : row.open.length ? 'Active' : 'Clear'}</Pill></span>
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="ov2-card ov2-detail-rail">
          {selected ? (
            <>
              <div className="ov2-detail-person">
                <InitialBadge name={selected.client.name} />
                <div><h2>{selected.client.name || 'Unnamed client'}</h2><p>{selected.client.company || selected.client.email || 'Client record'}</p></div>
              </div>
              <div className="ov2-detail-metrics">
                <div><span>Outstanding</span><strong>{formatMoney(selected.outstanding)}</strong></div>
                <div><span>Open</span><strong>{selected.open.length}</strong></div>
                <div><span>Overdue</span><strong>{selected.maxDays ? `${selected.maxDays}d` : 'None'}</strong></div>
              </div>
              <section className="ov2-detail-section">
                <h3>Contact</h3>
                <p>{selected.client.email || 'No email saved'}</p>
                <p>{selected.client.phone || 'No phone saved'}</p>
              </section>
              <section className="ov2-detail-section">
                <div className="ov2-section-title"><h3>Recent invoices</h3><span>{selected.clientInvoices.length}</span></div>
                {selected.clientInvoices.slice(0, 5).map((invoice) => (
                  <div className="ov2-mini-row" key={invoice.id}>
                    <span><b>{invoice.invoice_number || 'Invoice'}</b><small>Due {formatShortDate(invoice.due_date)}</small></span>
                    <strong>{formatMoney(balanceOf(invoice))}</strong>
                  </div>
                ))}
                {selected.clientInvoices.length === 0 ? <p className="ov2-muted">No invoices recorded.</p> : null}
              </section>
              <section className="ov2-detail-section">
                <h3>Recent activity</h3>
                {selectedEvents.map((event) => (
                  <div className="ov2-activity-mini" key={event.id}>
                    <span className="ov2-dot" />
                    <div><b>{String(event.event_type || 'activity').replaceAll('_', ' ')}</b><small>{timeAgo(event.created_at)}</small></div>
                  </div>
                ))}
                {selectedEvents.length === 0 ? <p className="ov2-muted">No recent activity in the current window.</p> : null}
              </section>
            </>
          ) : <TableEmpty>Select a client.</TableEmpty>}
        </aside>
      </div>
    </div>
  )
}

export function OverhaulPromises() {
  const { user } = useAuth()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    setLoading(true)
    supabase
      .from('promises')
      .select('id,user_id,invoice_id,status,promised_amount,promised_date,currency,source,confirmed_at,created_at,invoices(inv_num,due_date,amount,amount_paid,clients(name))')
      .eq('user_id', user.id)
      .order('promised_date', { ascending: true })
      .then(({ data, error: queryError }) => {
        if (cancelled) return
        setRows(data || [])
        setError(queryError?.message || '')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [user])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((row) => {
      const status = String(row.status || '').toLowerCase()
      if (tab !== 'all' && status !== tab) return false
      if (!q) return true
      return [row.id, row.invoices?.inv_num, row.invoices?.clients?.name]
        .filter(Boolean).join(' ').toLowerCase().includes(q)
    })
  }, [rows, tab, search])

  const dueToday = rows.filter((row) => daysUntil(row.promised_date) === 0)
  const dueSoon = rows.filter((row) => {
    const days = daysUntil(row.promised_date)
    return days !== null && days >= 0 && days <= 2
  })
  const broken = rows.filter((row) => String(row.status || '').toLowerCase() === 'broken')
  const fulfilled = rows.filter((row) => String(row.status || '').toLowerCase() === 'fulfilled')

  return (
    <div className="ov2-page">
      <PageHeader
        title="Promise-to-Pay"
        subtitle="Track payment promises from evidence already recorded in DueWatch."
      />

      <div className="ov2-summary-strip">
        <div><span>All promises</span><strong>{rows.length}</strong><small>recorded</small></div>
        <div><span>Due today</span><strong>{dueToday.length}</strong><small>{moneyCompact(dueToday.reduce((s, r) => s + Number(r.promised_amount || 0), 0))}</small></div>
        <div><span>Due soon ≤48h</span><strong>{dueSoon.length}</strong><small>{moneyCompact(dueSoon.reduce((s, r) => s + Number(r.promised_amount || 0), 0))}</small></div>
        <div><span>Broken</span><strong className="ov2-danger">{broken.length}</strong><small>{moneyCompact(broken.reduce((s, r) => s + Number(r.promised_amount || 0), 0))}</small></div>
        <div><span>Fulfilled</span><strong className="ov2-positive">{fulfilled.length}</strong><small>{moneyCompact(fulfilled.reduce((s, r) => s + Number(r.promised_amount || 0), 0))}</small></div>
      </div>

      <div className="ov2-toolbar">
        <div className="ov2-tabs">
          {[['all','All promises'],['confirmed','Confirmed'],['broken','Broken'],['fulfilled','Fulfilled'],['cancelled','Cancelled']].map(([key,label]) => (
            <button key={key} className={tab === key ? 'is-active' : ''} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
        <SearchField value={search} onChange={setSearch} placeholder="Search client, invoice, or promise..." />
      </div>

      <section className="ov2-card ov2-table-card">
        {loading ? <TableEmpty>Loading promises…</TableEmpty> : error ? <TableEmpty>Promise data unavailable: {error}</TableEmpty> : filtered.length === 0 ? (
          <TableEmpty>No promises match this view.</TableEmpty>
        ) : (
          <div className="ov2-scroll-table">
            <div className="ov2-promise-grid ov2-grid-head">
              <span>Client</span><span>Promise</span><span>State</span><span>Promised date</span><span>Amount</span><span>Source</span>
            </div>
            {filtered.map((row) => {
              const client = row.invoices?.clients?.name || 'Client'
              const state = String(row.status || 'recorded')
              const tone = state.toLowerCase() === 'fulfilled' ? 'green' : state.toLowerCase() === 'broken' ? 'red' : 'amber'
              return (
                <div className="ov2-promise-grid ov2-grid-row" key={row.id}>
                  <span className="ov2-person"><InitialBadge name={client} /><span><b>{client}</b><small>{row.invoices?.inv_num || 'Invoice'}</small></span></span>
                  <span><b>{row.id.slice(0, 8)}</b><small>{row.confirmed_at ? 'Confirmed' : 'Recorded'}</small></span>
                  <span><Pill tone={tone}>{state.replaceAll('_', ' ')}</Pill></span>
                  <span>{formatShortDate(row.promised_date)}</span>
                  <span className="ov2-money">{formatMoney(row.promised_amount)}</span>
                  <span>{row.source || 'Recorded evidence'}</span>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function agingBucket(invoice) {
  const overdue = daysOverdue(invoice.due_date)
  if (overdue <= 0) return 'Current'
  if (overdue <= 30) return '1–30 days'
  if (overdue <= 60) return '31–60 days'
  if (overdue <= 90) return '61–90 days'
  return '90+ days'
}

export function OverhaulCashFlow() {
  const { invoices, collectedThisMonth, collectedLastMonth } = useData()
  const open = useMemo(() => invoices.filter(isOutstanding), [invoices])
  const outstanding = open.reduce((sum, invoice) => sum + balanceOf(invoice), 0)
  const overdueTotal = open.filter((invoice) => daysOverdue(invoice.due_date) > 0).reduce((sum, invoice) => sum + balanceOf(invoice), 0)
  const next30 = open.filter((invoice) => {
    const days = daysUntil(invoice.due_date)
    return days !== null && days >= 0 && days <= 30
  }).reduce((sum, invoice) => sum + balanceOf(invoice), 0)

  const buckets = ['Current','1–30 days','31–60 days','61–90 days','90+ days'].map((label) => {
    const amount = open.filter((invoice) => agingBucket(invoice) === label).reduce((sum, invoice) => sum + balanceOf(invoice), 0)
    return { label, amount }
  })
  const maxBucket = Math.max(...buckets.map((b) => b.amount), 1)
  const topOverdue = open.filter((invoice) => daysOverdue(invoice.due_date) > 0)
    .sort((a,b) => daysOverdue(b.due_date) - daysOverdue(a.due_date))
    .slice(0,5)

  return (
    <div className="ov2-page">
      <PageHeader title="Cash Flow" subtitle="Track collected cash and the timing of open receivables." />

      <div className="ov2-summary-strip ov2-summary-strip--four">
        <div><span>Collected this month</span><strong>{formatMoney(collectedThisMonth)}</strong><small>{collectedLastMonth ? `${collectedThisMonth >= collectedLastMonth ? '↑' : '↓'} vs last month` : 'No prior-month baseline'}</small></div>
        <div><span>Due next 30 days</span><strong>{formatMoney(next30)}</strong><small>invoice due dates only</small></div>
        <div><span>Outstanding</span><strong>{formatMoney(outstanding)}</strong><small>{open.length} open invoices</small></div>
        <div><span>Overdue</span><strong className="ov2-danger">{formatMoney(overdueTotal)}</strong><small>past due now</small></div>
      </div>

      <div className="ov2-cash-layout">
        <section className="ov2-card ov2-chart-card">
          <div className="ov2-card-head"><div><span>Portfolio timing</span><h2>Outstanding by aging</h2></div><Pill tone="neutral">Invoice truth</Pill></div>
          <div className="ov2-bar-chart">
            {buckets.map((bucket) => (
              <div className="ov2-bar-column" key={bucket.label}>
                <div className="ov2-bar-value">{moneyCompact(bucket.amount)}</div>
                <div className="ov2-bar-track"><span style={{ height: `${Math.max(4, (bucket.amount / maxBucket) * 100)}%` }} /></div>
                <small>{bucket.label}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="ov2-card ov2-top-overdue">
          <div className="ov2-card-head"><div><span>Priority</span><h2>Top overdue</h2></div></div>
          {topOverdue.map((invoice) => (
            <div className="ov2-overdue-row" key={invoice.id}>
              <InitialBadge name={invoice.clients?.name} />
              <span><b>{invoice.clients?.name || 'Client'}</b><small>{invoice.invoice_number || 'Invoice'} · {daysOverdue(invoice.due_date)} days</small></span>
              <strong>{formatMoney(balanceOf(invoice))}</strong>
            </div>
          ))}
          {topOverdue.length === 0 ? <TableEmpty>No overdue invoices.</TableEmpty> : null}
        </section>
      </div>

      <section className="ov2-card ov2-aging-table">
        <div className="ov2-card-head"><div><span>Receivables</span><h2>Aging summary</h2></div></div>
        <div className="ov2-aging-grid">
          {buckets.map((bucket) => (
            <div key={bucket.label}><span>{bucket.label}</span><strong>{formatMoney(bucket.amount)}</strong></div>
          ))}
        </div>
      </section>
    </div>
  )
}

export function OverhaulActivity() {
  const { user } = useAuth()
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('all')

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    supabase
      .from('events')
      .select('id,event_type,invoice_id,created_at,lifecycle_state,evidence,invoices(inv_num,clients(name))')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data, error: queryError }) => {
        if (cancelled) return
        setEvents(data || [])
        setError(queryError?.message || '')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [user])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return events.filter((event) => {
      const type = String(event.event_type || '').toLowerCase()
      if (tab === 'payments' && !type.includes('payment')) return false
      if (tab === 'reminders' && !/(reminder|email|follow)/.test(type)) return false
      if (tab === 'system' && /(payment|reminder|email|follow|promise)/.test(type)) return false
      if (!q) return true
      return [type, event.invoices?.inv_num, event.invoices?.clients?.name]
        .filter(Boolean).join(' ').toLowerCase().includes(q)
    })
  }, [events, search, tab])

  return (
    <div className="ov2-page">
      <PageHeader title="Activity" subtitle="Complete evidence trail of actions and events." />
      <div className="ov2-toolbar">
        <div className="ov2-tabs">
          {[['all','All activity'],['reminders','Reminders'],['payments','Payments'],['system','System']].map(([key,label]) => (
            <button key={key} className={tab === key ? 'is-active' : ''} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
        <SearchField value={search} onChange={setSearch} placeholder="Search activity..." />
      </div>

      <section className="ov2-card ov2-table-card">
        {loading ? <TableEmpty>Loading activity…</TableEmpty> : error ? <TableEmpty>Activity unavailable: {error}</TableEmpty> : rows.length === 0 ? (
          <TableEmpty>No activity matches this view.</TableEmpty>
        ) : (
          <div className="ov2-scroll-table">
            <div className="ov2-activity-grid ov2-grid-head">
              <span>Time</span><span>Type</span><span>Description</span><span>Client</span><span>Invoice</span><span>Evidence</span>
            </div>
            {rows.map((event) => {
              const evidenceCount = event.evidence && typeof event.evidence === 'object' ? Object.keys(event.evidence).length : 0
              return (
                <div className="ov2-activity-grid ov2-grid-row" key={event.id}>
                  <span>{formatEventDate(event.created_at)}<small>{timeAgo(event.created_at)}</small></span>
                  <span><Pill tone={event.lifecycle_state === 'error' ? 'red' : 'blue'}>{String(event.event_type || 'event').replaceAll('_',' ')}</Pill></span>
                  <span>{event.lifecycle_state ? `Lifecycle: ${event.lifecycle_state}` : 'Recorded operational event'}</span>
                  <span>{event.invoices?.clients?.name || '—'}</span>
                  <span>{event.invoices?.inv_num || '—'}</span>
                  <span>{evidenceCount ? `${evidenceCount} field${evidenceCount === 1 ? '' : 's'}` : '—'}</span>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

const integrationCards = [
  { name: 'CSV / Excel imports', icon: 'invoices', state: 'available', detail: 'Native importer is available now.', action: 'Open importer', href: '/import' },
  { name: 'Outbound reminders', icon: 'reminders', state: 'server', detail: 'Uses the hardened server-side reminder pipeline.' },
  { name: 'Stripe', icon: 'payments', state: 'not_configured', detail: 'No user-facing OAuth connection is configured in this build.' },
  { name: 'Gmail', icon: 'activityStream', state: 'not_configured', detail: 'No user-facing Gmail connection is configured in this build.' },
  { name: 'Google Drive', icon: 'evidence', state: 'not_configured', detail: 'No user-facing Drive connection is configured in this build.' },
  { name: 'CRM', icon: 'clients', state: 'not_configured', detail: 'No user-facing CRM connection is configured in this build.' },
]

export function OverhaulIntegrations() {
  return (
    <div className="ov2-page">
      <PageHeader title="Integrations" subtitle="Connect the systems that can supply or receive receivables evidence." />
      <div className="ov2-integration-grid">
        {integrationCards.map((item) => (
          <article className="ov2-card ov2-integration-card" key={item.name}>
            <span className="ov2-integration-icon"><OverhaulIcon name={item.icon} size={21} /></span>
            <div>
              <div className="ov2-section-title">
                <h2>{item.name}</h2>
                <Pill tone={item.state === 'available' || item.state === 'server' ? 'green' : 'neutral'}>
                  {item.state === 'available' ? 'Available' : item.state === 'server' ? 'Server-side' : 'Not configured'}
                </Pill>
              </div>
              <p>{item.detail}</p>
              {item.href ? <Link to={item.href}>{item.action}<ArrowRight size={13} /></Link> : <span className="ov2-disabled-action">No connect action available</span>}
            </div>
          </article>
        ))}
      </div>
      <div className="ov2-truth-note"><ShieldCheck size={17} /><span>DueWatch does not display a provider as connected unless the application has a real configured connection path.</span></div>
    </div>
  )
}

export function OverhaulSettings() {
  const { user, signOut } = useAuth()
  const { autopilotEnabled, autopilotApprovalRequired, lastSyncedAt } = useData()
  const workspace =
    user?.user_metadata?.company ||
    user?.user_metadata?.organization ||
    user?.user_metadata?.workspace ||
    'Workspace'

  return (
    <div className="ov2-page">
      <PageHeader title="Settings" subtitle="Account, workspace, and control-plane visibility." />
      <div className="ov2-settings-layout">
        <nav className="ov2-card ov2-settings-nav">
          <button className="is-active">General</button>
          <button aria-disabled="true">Notifications</button>
          <button aria-disabled="true">Security</button>
          <button aria-disabled="true">Billing</button>
        </nav>
        <div className="ov2-settings-main">
          <section className="ov2-card ov2-settings-section">
            <div className="ov2-card-head"><div><span>Account</span><h2>Profile</h2></div></div>
            <div className="ov2-settings-row"><span>Name</span><strong>{user?.user_metadata?.full_name || 'Not set'}</strong></div>
            <div className="ov2-settings-row"><span>Email</span><strong>{user?.email || '—'}</strong></div>
            <div className="ov2-settings-row"><span>Workspace</span><strong>{workspace}</strong></div>
          </section>
          <section className="ov2-card ov2-settings-section">
            <div className="ov2-card-head"><div><span>Automation</span><h2>Current controls</h2></div></div>
            <div className="ov2-settings-row"><span>Autopilot</span><Pill tone={autopilotEnabled ? 'green' : 'neutral'}>{autopilotEnabled ? 'Enabled' : 'Off'}</Pill></div>
            <div className="ov2-settings-row"><span>Reminder approval</span><strong>{autopilotApprovalRequired ? 'Required' : 'Automatic within rules'}</strong></div>
            <div className="ov2-settings-row"><span>Data last refreshed</span><strong>{lastSyncedAt ? timeAgo(lastSyncedAt) : 'Not available'}</strong></div>
            <Link className="ov2-inline-link" to="/autopilot">Open Autopilot controls <ArrowRight size={13} /></Link>
          </section>
          <section className="ov2-card ov2-settings-section">
            <div className="ov2-card-head"><div><span>Session</span><h2>Account access</h2></div></div>
            <button className="ov2-button ov2-button--ghost" onClick={signOut}>Log out</button>
          </section>
        </div>
      </div>
    </div>
  )
}

function Toggle({ checked, onChange, disabled = false }) {
  return (
    <button
      className={`ov2-toggle ${checked ? 'is-on' : ''}`}
      type="button"
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

export function OverhaulAutopilot() {
  const { user } = useAuth()
  const {
    invoices,
    events,
    autopilotEnabled,
    autopilotApprovalRequired,
    setAutopilotEnabledLocal,
    awaitingSignature,
    lastAutopilotRun,
    refresh,
  } = useData()
  const [rules, setRules] = useState([])
  const [loadingRules, setLoadingRules] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    setLoadingRules(true)
    fetchAutopilotRules(user.id).then((result) => {
      if (!cancelled) {
        setRules(result)
        setLoadingRules(false)
      }
    })
    return () => { cancelled = true }
  }, [user, autopilotEnabled])

  const open = invoices.filter(isOutstanding)
  const focus = open.slice().sort((a,b) => daysOverdue(b.due_date) - daysOverdue(a.due_date)).slice(0,5)
  const autopilotEvents = events.filter((event) => /(reminder|autopilot|email|follow|signature)/i.test(String(event.event_type || ''))).slice(0,6)

  async function setEnabled(next) {
    if (!user?.id || saving) return
    setSaving(true)
    setError('')
    const result = next
      ? await enableAutopilot(user.id, { approvalRequired: autopilotApprovalRequired, rules: rules.length ? rules : DEFAULT_RULES })
      : await disableAutopilot(user.id)
    setSaving(false)
    if (result?.error) {
      setError(result.error.message || 'Could not update Autopilot.')
      return
    }
    setAutopilotEnabledLocal(next)
    await refresh()
  }

  async function setRuleEnabled(rule, next) {
    const before = rules
    setRules((current) => current.map((item) => item.id === rule.id ? { ...item, enabled: next } : item))
    const result = await toggleRule(rule.id, next)
    if (result?.error) {
      setRules(before)
      setError(result.error.message || 'Could not update rule.')
    }
  }

  return (
    <div className="ov2-page ov2-autopilot-page">
      <PageHeader
        title="Autopilot"
        subtitle="See what DW is doing, what it plans to do next, and exactly what authority it has."
        actions={
          <div className="ov2-autopilot-master">
            <span><b>{autopilotEnabled ? 'Active' : 'Off'}</b><small>{autopilotEnabled ? 'Normal mode · governed by saved rules' : 'Manual control'}</small></span>
            <Toggle checked={autopilotEnabled} onChange={setEnabled} disabled={saving} />
          </div>
        }
      />

      {error ? <div className="ov2-error"><CircleAlert size={15} />{error}</div> : null}

      <div className="ov2-autopilot-layout">
        <main className="ov2-autopilot-main">
          <section className="ov2-card ov2-autopilot-live">
            <div className="ov2-card-head">
              <div><span>DW is working</span><h2>Operational timeline</h2></div>
              <Pill tone={autopilotEnabled ? 'green' : 'neutral'}>{autopilotEnabled ? 'Live' : 'Paused'}</Pill>
            </div>
            <div className="ov2-autopilot-timeline">
              {autopilotEvents.map((event) => (
                <div key={event.id}>
                  <span className="ov2-timeline-dot" />
                  <div><b>{String(event.event_type || 'Action').replaceAll('_',' ')}</b><p>{event.invoices?.clients?.name || 'Receivables'} · {event.invoices?.inv_num || 'operational event'}</p></div>
                  <small>{timeAgo(event.created_at)}</small>
                </div>
              ))}
              {autopilotEvents.length === 0 ? <TableEmpty>No recent Autopilot events in the current activity window.</TableEmpty> : null}
            </div>
          </section>

          <section className="ov2-card">
            <div className="ov2-card-head"><div><span>Current focus</span><h2>Receivables DW is watching</h2></div><span className="ov2-head-count">{open.length} open</span></div>
            <div className="ov2-focus-list">
              {focus.map((invoice) => (
                <div key={invoice.id}>
                  <InitialBadge name={invoice.clients?.name} />
                  <span><b>{invoice.clients?.name || 'Client'}</b><small>{invoice.invoice_number || 'Invoice'} · {Math.max(daysOverdue(invoice.due_date),0)} days overdue</small></span>
                  <strong>{formatMoney(balanceOf(invoice))}</strong>
                  <Pill tone={daysOverdue(invoice.due_date) >= 15 ? 'red' : 'amber'}>{daysOverdue(invoice.due_date) > 0 ? 'Watching' : 'Upcoming'}</Pill>
                </div>
              ))}
              {focus.length === 0 ? <TableEmpty>No open invoices to watch.</TableEmpty> : null}
            </div>
          </section>

          <section className="ov2-card">
            <div className="ov2-card-head"><div><span>30-day operating view</span><h2>What the current rules can affect</h2></div></div>
            <div className="ov2-autopilot-impact">
              <div><OverhaulIcon name="invoices" size={20} /><span><strong>{open.length}</strong><small>open invoices</small></span></div>
              <div><OverhaulIcon name="reminders" size={20} /><span><strong>{rules.filter((rule) => rule.enabled).length}</strong><small>enabled reminder rules</small></span></div>
              <div><OverhaulIcon name="evidence" size={20} /><span><strong>{awaitingSignature.length}</strong><small>approvals waiting</small></span></div>
            </div>
          </section>
        </main>

        <aside className="ov2-autopilot-rail">
          <section className="ov2-card">
            <div className="ov2-card-head"><div><span>Current authority</span><h2>What DW may do</h2></div></div>
            <div className="ov2-authority-list">
              <div><span>Operating mode</span><strong>Normal</strong></div>
              <div><span>Action class</span><strong>Reminder follow-ups</strong></div>
              <div><span>Approval</span><strong>{autopilotApprovalRequired ? 'Required' : 'Automatic within rules'}</strong></div>
              <div><span>Last run</span><strong>{lastAutopilotRun?.created_at ? timeAgo(lastAutopilotRun.created_at) : 'No completed run shown'}</strong></div>
            </div>
            <div className="ov2-truth-note ov2-truth-note--compact"><ShieldCheck size={15} /><span>Night Shift, Cash Recovery, Protect, Away, and Quarter-End are not exposed here because the current production authority model is Normal-mode only.</span></div>
          </section>

          <section className="ov2-card">
            <div className="ov2-card-head"><div><span>Authority & rules</span><h2>Reminder policy</h2></div></div>
            {loadingRules ? <TableEmpty>Loading rules…</TableEmpty> : (
              <div className="ov2-rule-list">
                {rules.map((rule) => (
                  <div key={rule.id}>
                    <span><b>{rule.name}</b><small>{ruleTiming(rule)}</small></span>
                    <Toggle checked={rule.enabled} onChange={(next) => setRuleEnabled(rule, next)} />
                  </div>
                ))}
                {rules.length === 0 ? <TableEmpty>No saved rules yet. Enable Autopilot to seed the default rule set.</TableEmpty> : null}
              </div>
            )}
          </section>

          <section className="ov2-card">
            <div className="ov2-card-head"><div><span>Needs you</span><h2>Approvals</h2></div><span className="ov2-head-count">{awaitingSignature.length}</span></div>
            <div className="ov2-approval-list">
              {awaitingSignature.slice(0,4).map((item) => (
                <div key={item.id}>
                  <span><b>{item.invoice?.clients?.name || 'Client'}</b><small>{item.invoice?.invoice_number || 'Invoice'} · founder approval required</small></span>
                  <Pill tone="amber">Review</Pill>
                </div>
              ))}
              {awaitingSignature.length === 0 ? <TableEmpty>No approvals waiting.</TableEmpty> : null}
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
