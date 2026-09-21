import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
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
  cancelPromise,
  confirmPromise,
  loadPromiseWorkspace,
  promiseStateLabel,
  promiseStateTone,
  recordPromise,
  replacePromise,
} from '../lib/promises'
import {
  DEFAULT_RULES,
  disableAutopilot,
  enableAutopilot,
  fetchAutopilotRules,
  ruleTiming,
  setAutopilotApprovalRequired,
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
import { SUPPORTED_CURRENCIES } from '../lib/import/money'
import { buildCashFlowReadModel } from '../lib/cashFlowReadModel'
import {
  formatMoneySummary,
  formatMoneyTruth,
  summarizeInvoiceBalances,
  summarizeMoney,
} from '../lib/moneyTruth'
import { OverhaulIcon } from './OverhaulIconSystem'
import { useWorkspacePreferences } from './WorkspacePreferencesContext'
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
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [showAdd, setShowAdd] = useState(false)

  useEffect(() => {
    const ref = searchParams.get('invoice')
    if (!ref || invoices.length === 0) return
    const match = invoices.find((invoice) => invoice.id === ref || invoice.invoice_number === ref)
    if (match) setSelected(match)
  }, [invoices, searchParams])

  function openInvoice(invoice) {
    setSelected(invoice)
    setSearchParams({ invoice: invoice.id }, { replace: true })
  }

  function closeInvoice() {
    setSelected(null)
    setSearchParams({}, { replace: true })
  }

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
              <button key={invoice.id} className="ov2-invoice-grid ov2-grid-row" onClick={() => openInvoice(invoice)}>
                <span className="ov2-strong">{invoice.invoice_number || '—'}</span>
                <span className="ov2-person"><InitialBadge name={invoice.clients?.name} /><b>{invoice.clients?.name || 'No client'}</b></span>
                <span>{formatShortDate(invoice.inv_date)}</span>
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

      <InvoiceDetailPanel invoice={selected} onClose={closeInvoice} onMutated={refresh} />
      <AddInvoiceModal open={showAdd} onClose={() => setShowAdd(false)} />
    </div>
  )
}

export function OverhaulClients() {
  const { clients, invoices, events, loading, error } = useData()
  const [searchParams, setSearchParams] = useSearchParams()
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

  useEffect(() => {
    const ref = searchParams.get('client')
    if (!ref || clients.length === 0) return
    const match = clients.find((client) => client.id === ref)
    if (match) setSelectedId(match.id)
  }, [clients, searchParams])

  function openClient(clientId) {
    setSelectedId(clientId)
    setSearchParams({ client: clientId }, { replace: true })
  }

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
                  onClick={() => openClient(row.client.id)}
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
                    <Link className="ov2-mini-link" to={`/invoices?invoice=${invoice.id}`}>Open</Link>
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
  const { invoices, refresh, lastSyncedAt } = useData()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState('')
  const [showRecord, setShowRecord] = useState(false)
  const [recordInvoiceId, setRecordInvoiceId] = useState('')
  const [recordAmount, setRecordAmount] = useState('')
  const [recordDate, setRecordDate] = useState('')
  const [recordCurrency, setRecordCurrency] = useState('')
  const [recordNote, setRecordNote] = useState('')
  const [recordBusy, setRecordBusy] = useState(false)
  const [replaceTarget, setReplaceTarget] = useState(null)
  const [replaceAmount, setReplaceAmount] = useState('')
  const [replaceDate, setReplaceDate] = useState('')
  const [replaceNote, setReplaceNote] = useState('')
  const [replaceBusy, setReplaceBusy] = useState(false)

  const promiseEligibleInvoices = useMemo(
    () => invoices
      .filter((invoice) => isOutstanding(invoice))
      .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'))),
    [invoices]
  )

  async function reloadPromises() {
    if (!user?.id) return
    setLoading(true)
    setError('')
    try {
      const result = await loadPromiseWorkspace({ database: supabase, userId: user.id })
      setRows(result)
    } catch (loadError) {
      setRows([])
      setError(loadError?.message || 'Could not load promises.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reloadPromises()
  }, [user?.id, lastSyncedAt])

  useEffect(() => {
    if (!showRecord || recordInvoiceId) return
    const first = promiseEligibleInvoices[0]
    if (!first) return
    setRecordInvoiceId(first.id)
    setRecordAmount(Number(balanceOf(first)).toFixed(2))
    setRecordCurrency(first.currency || '')
  }, [showRecord, recordInvoiceId, promiseEligibleInvoices])

  function chooseRecordInvoice(invoiceId) {
    setRecordInvoiceId(invoiceId)
    const invoice = promiseEligibleInvoices.find((candidate) => candidate.id === invoiceId)
    setRecordAmount(invoice ? Number(balanceOf(invoice)).toFixed(2) : '')
    setRecordCurrency(invoice?.currency || '')
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((row) => {
      const state = row.operational?.state || 'unknown'
      const matchesTab =
        tab === 'all' ||
        (tab === 'confirmed' && ['confirmed', 'due_soon', 'due_today'].includes(state)) ||
        state === tab

      if (!matchesTab) return false
      if (!q) return true
      return [row.id, row.invoices?.inv_num, row.invoices?.clients?.name, state]
        .filter(Boolean).join(' ').toLowerCase().includes(q)
    })
  }, [rows, tab, search])

  const dueToday = rows.filter((row) => row.operational?.state === 'due_today')
  const dueSoon = rows.filter((row) => row.operational?.state === 'due_soon')
  const pastDueUnresolved = rows.filter((row) => row.operational?.state === 'past_due_unresolved')
  const fulfilled = rows.filter((row) => row.operational?.state === 'fulfilled')
  const proposed = rows.filter((row) => row.operational?.state === 'proposed')
  const promiseMoney = (promiseRows) =>
    formatMoneySummary(
      summarizeMoney(promiseRows, {
        amountOf: (row) => row.promised_amount,
        currencyOf: (row) => row.currency,
      }),
      { compact: true }
    )

  async function handleRecord(event) {
    event.preventDefault()
    if (!user?.id || recordBusy) return
    setRecordBusy(true)
    setError('')
    try {
      await recordPromise({
        database: supabase,
        userId: user.id,
        invoiceId: recordInvoiceId,
        amount: recordAmount,
        promisedDate: recordDate,
        currency: recordCurrency,
        note: recordNote,
      })
      setShowRecord(false)
      setRecordInvoiceId('')
      setRecordAmount('')
      setRecordDate('')
      setRecordCurrency('')
      setRecordNote('')
      await Promise.all([reloadPromises(), refresh()])
    } catch (recordError) {
      setError(recordError?.message || 'Could not record the promise.')
    } finally {
      setRecordBusy(false)
    }
  }

  function openReplacePromise(row) {
    const remaining = Math.max(
      0,
      Number(row.promised_amount || 0) - Number(row.operational?.fulfilledAmount || 0)
    )
    setReplaceTarget(row)
    setReplaceAmount(remaining > 0 ? remaining.toFixed(2) : Number(row.promised_amount || 0).toFixed(2))
    setReplaceDate(row.promised_date || '')
    setReplaceNote(row.note || '')
  }

  async function handleReplace(event) {
    event.preventDefault()
    if (!replaceTarget?.id || replaceBusy) return
    setReplaceBusy(true)
    setError('')
    try {
      await replacePromise({
        database: supabase,
        promiseId: replaceTarget.id,
        promisedAmount: replaceAmount,
        promisedDate: replaceDate,
        source: replaceTarget.source || 'founder_manual',
        note: replaceNote || null,
      })
      setReplaceTarget(null)
      setReplaceAmount('')
      setReplaceDate('')
      setReplaceNote('')
      await Promise.all([reloadPromises(), refresh()])
    } catch (replaceError) {
      setError(replaceError?.message || 'Could not replace the promise.')
    } finally {
      setReplaceBusy(false)
    }
  }

  async function handlePromiseAction(row, action) {
    if (!user?.id || busyId) return
    setBusyId(row.id)
    setError('')
    try {
      if (action === 'confirm') {
        await confirmPromise({ database: supabase, userId: user.id, promiseId: row.id })
      } else if (action === 'cancel') {
        await cancelPromise({ database: supabase, userId: user.id, promiseId: row.id })
      }
      await reloadPromises()
    } catch (actionError) {
      setError(actionError?.message || 'Could not update the promise.')
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="ov2-page">
      <PageHeader
        title="Promise-to-Pay"
        subtitle="Track customer commitments separately from payment truth. Fulfillment is verified from the payment ledger."
        actions={
          <button
            className="ov2-button ov2-button--primary"
            type="button"
            onClick={() => setShowRecord(true)}
            disabled={promiseEligibleInvoices.length === 0}
          >
            <Plus size={15} /> Record promise
          </button>
        }
      />

      {error ? <div className="ov2-error"><CircleAlert size={15} />{error}</div> : null}

      <div className="ov2-summary-strip">
        <button type="button" onClick={() => setTab('proposed')}>
          <span>Needs confirmation</span><strong>{proposed.length}</strong><small>proposed promises</small>
        </button>
        <button type="button" onClick={() => setTab('due_today')}>
          <span>Due today</span><strong>{dueToday.length}</strong><small>{promiseMoney(dueToday)}</small>
        </button>
        <button type="button" onClick={() => setTab('due_soon')}>
          <span>Due soon</span><strong>{dueSoon.length}</strong><small>{promiseMoney(dueSoon)}</small>
        </button>
        <button type="button" onClick={() => setTab('past_due_unresolved')}>
          <span>Past due · unresolved</span><strong className="ov2-danger">{pastDueUnresolved.length}</strong><small>{promiseMoney(pastDueUnresolved)}</small>
        </button>
        <button type="button" onClick={() => setTab('fulfilled')}>
          <span>Fulfilled</span><strong className="ov2-positive">{fulfilled.length}</strong><small>{promiseMoney(fulfilled)}</small>
        </button>
      </div>

      <div className="ov2-toolbar">
        <div className="ov2-tabs">
          {[
            ['all','All promises'],
            ['proposed','Needs confirmation'],
            ['confirmed','Confirmed'],
            ['past_due_unresolved','Past due unresolved'],
            ['fulfilled','Fulfilled'],
            ['cancelled','Cancelled'],
          ].map(([key,label]) => (
            <button key={key} className={tab === key ? 'is-active' : ''} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
        <SearchField value={search} onChange={setSearch} placeholder="Search client, invoice, or promise..." />
      </div>

      <section className="ov2-card ov2-table-card">
        {loading ? <TableEmpty>Loading promises…</TableEmpty> : filtered.length === 0 ? (
          <TableEmpty>{rows.length === 0 ? 'No promises have been recorded yet.' : 'No promises match this view.'}</TableEmpty>
        ) : (
          <div className="ov2-scroll-table">
            <div className="ov2-promise-grid ov2-grid-head">
              <span>Client</span><span>Promise</span><span>State</span><span>Promised date</span><span>Amount</span><span>Action</span>
            </div>
            {filtered.map((row) => {
              const client = row.invoices?.clients?.name || 'Client'
              const state = row.operational?.state || 'unknown'
              const canConfirm = row.status === 'proposed'
              const canCancel = ['proposed', 'confirmed'].includes(row.status) && state !== 'fulfilled'
              return (
                <div className="ov2-promise-grid ov2-grid-row" key={row.id}>
                  <span className="ov2-person">
                    <InitialBadge name={client} />
                    <span><b>{client}</b><small>{row.invoices?.inv_num || 'Invoice'}</small></span>
                  </span>
                  <span>
                    <b>{row.id.slice(0, 8)}</b>
                    <small>{row.source || 'founder_manual'}{row.note ? ` · ${row.note}` : ''}</small>
                  </span>
                  <span>
                    <Pill tone={promiseStateTone(state)}>{promiseStateLabel(state)}</Pill>
                    {state === 'fulfilled' ? <small>{formatMoneyTruth(row.operational.fulfilledAmount, row.currency)} verified by payment allocations</small> : null}
                  </span>
                  <span>{formatShortDate(row.promised_date)}</span>
                  <span className="ov2-money">{formatMoneyTruth(row.promised_amount, row.currency)}</span>
                  <span className="ov2-row-actions">
                    {canConfirm ? (
                      <button type="button" disabled={busyId === row.id} onClick={() => handlePromiseAction(row, 'confirm')}>Confirm</button>
                    ) : null}
                    {canCancel ? (
                      <button type="button" disabled={busyId === row.id} onClick={() => handlePromiseAction(row, 'cancel')}>Cancel</button>
                    ) : null}
                    {canCancel ? (
                      <button type="button" disabled={busyId === row.id} onClick={() => openReplacePromise(row)}>Replace</button>
                    ) : null}
                    {!canConfirm && !canCancel ? <span className="ov2-muted">Read only</span> : null}
                    <Link className="ov2-mini-link" to={`/invoices?invoice=${row.invoice_id}`}>Invoice</Link>
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {showRecord ? (
        <div className="ov2-modal-backdrop" role="presentation" onMouseDown={() => !recordBusy && setShowRecord(false)}>
          <form className="ov2-modal" onSubmit={handleRecord} onMouseDown={(event) => event.stopPropagation()}>
            <div className="ov2-modal-head">
              <div><span>Promise-to-Pay</span><h2>Record a customer commitment</h2></div>
              <button type="button" onClick={() => setShowRecord(false)} disabled={recordBusy}>×</button>
            </div>
            <label className="ov2-field">
              <span>Invoice</span>
              <select value={recordInvoiceId} onChange={(event) => chooseRecordInvoice(event.target.value)} required>
                {promiseEligibleInvoices.map((invoice) => (
                  <option key={invoice.id} value={invoice.id}>
                    {invoice.invoice_number || 'Invoice'} · {invoice.clients?.name || 'Client'} · {formatMoneyTruth(balanceOf(invoice), invoice.currency)}
                  </option>
                ))}
              </select>
            </label>
            <div className="ov2-field-grid">
              <label className="ov2-field">
                <span>Promised amount</span>
                <input inputMode="decimal" value={recordAmount} onChange={(event) => setRecordAmount(event.target.value)} required />
              </label>
              <label className="ov2-field">
                <span>Promised date</span>
                <input type="date" value={recordDate} onChange={(event) => setRecordDate(event.target.value)} required />
              </label>
            </div>
            <label className="ov2-field">
              <span>Invoice currency {promiseEligibleInvoices.find((invoice) => invoice.id === recordInvoiceId)?.currency ? <small>already established</small> : <small>required for legacy invoice</small>}</span>
              <select
                value={recordCurrency}
                onChange={(event) => setRecordCurrency(event.target.value)}
                disabled={Boolean(promiseEligibleInvoices.find((invoice) => invoice.id === recordInvoiceId)?.currency)}
                required
              >
                <option value="">Choose currency</option>
                {SUPPORTED_CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
              </select>
              {!promiseEligibleInvoices.find((invoice) => invoice.id === recordInvoiceId)?.currency ? (
                <small className="ov2-field-help">DueWatch will save your explicit choice on this invoice. It will never assume USD.</small>
              ) : null}
            </label>
            <label className="ov2-field">
              <span>Note <small>optional</small></span>
              <textarea rows={3} value={recordNote} onChange={(event) => setRecordNote(event.target.value)} placeholder="What did the customer commit to?" />
            </label>
            <div className="ov2-modal-truth">
              <ShieldCheck size={16} />
              <span>This records a promise, not a payment. DueWatch only marks it fulfilled when matching payment evidence exists.</span>
            </div>
            <div className="ov2-modal-actions">
              <button className="ov2-button ov2-button--ghost" type="button" onClick={() => setShowRecord(false)} disabled={recordBusy}>Cancel</button>
              <button className="ov2-button ov2-button--primary" type="submit" disabled={recordBusy || !recordInvoiceId || !recordAmount || !recordDate || !recordCurrency}>
                {recordBusy ? 'Recording…' : 'Record promise'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {replaceTarget ? (
        <div className="ov2-modal-backdrop" role="presentation" onMouseDown={() => !replaceBusy && setReplaceTarget(null)}>
          <form className="ov2-modal" onSubmit={handleReplace} onMouseDown={(event) => event.stopPropagation()}>
            <div className="ov2-modal-head">
              <div><span>Promise-to-Pay</span><h2>Replace commitment</h2></div>
              <button type="button" onClick={() => setReplaceTarget(null)} disabled={replaceBusy}>×</button>
            </div>
            <div className="ov2-modal-truth">
              <ShieldCheck size={16} />
              <span>The existing promise will be resolved and preserved in history. DueWatch creates a new promise instead of mutating confirmed terms.</span>
            </div>
            <div className="ov2-field-grid">
              <label className="ov2-field">
                <span>New promised amount</span>
                <input inputMode="decimal" value={replaceAmount} onChange={(event) => setReplaceAmount(event.target.value)} required />
              </label>
              <label className="ov2-field">
                <span>New promised date</span>
                <input type="date" value={replaceDate} onChange={(event) => setReplaceDate(event.target.value)} required />
              </label>
            </div>
            <label className="ov2-field">
              <span>Currency</span>
              <input value={replaceTarget.currency || 'Unknown'} readOnly />
            </label>
            <label className="ov2-field">
              <span>Note <small>optional</small></span>
              <textarea rows={3} value={replaceNote} onChange={(event) => setReplaceNote(event.target.value)} />
            </label>
            <div className="ov2-modal-actions">
              <button className="ov2-button ov2-button--ghost" type="button" onClick={() => setReplaceTarget(null)} disabled={replaceBusy}>Keep existing</button>
              <button className="ov2-button ov2-button--primary" type="submit" disabled={replaceBusy || !replaceAmount || !replaceDate}>
                {replaceBusy ? 'Replacing…' : 'Replace promise'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
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
  const { user } = useAuth()
  const {
    invoices,
    collectedThisMonth,
    collectedLastMonth,
    collectedThisMonthSummary,
    collectedLastMonthSummary,
    collectionDataAvailable,
    lastSyncedAt,
  } = useData()
  const [promises, setPromises] = useState([])
  const [promiseError, setPromiseError] = useState('')

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    loadPromiseWorkspace({ database: supabase, userId: user.id })
      .then((result) => {
        if (!cancelled) {
          setPromises(result)
          setPromiseError('')
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setPromises([])
          setPromiseError(loadError?.message || 'Promise timing is unavailable.')
        }
      })
    return () => { cancelled = true }
  }, [user?.id])

  const model = useMemo(
    () => buildCashFlowReadModel({ invoices, promises, asOf: new Date() }),
    [invoices, promises]
  )

  const open = useMemo(() => invoices.filter(isOutstanding), [invoices])
  const buckets = ['Current','1–30 days','31–60 days','61–90 days','90+ days'].map((label) => {
    const bucketInvoices = open.filter((invoice) => agingBucket(invoice) === label)
    const summary = summarizeInvoiceBalances(bucketInvoices, balanceOf)
    const amount = summary.canRepresentAsSingleMoney ? (summary.byCurrency[0]?.amount ?? 0) : null
    return { label, amount, summary }
  })
  const maxWeek = Math.max(...model.weeks.map((week) => Number.isFinite(week.amount) ? week.amount : 0), 1)
  const maxAging = Math.max(...buckets.map((bucket) => Number.isFinite(bucket.amount) ? bucket.amount : 0), 1)

  const collectionTrend =
    collectionDataAvailable &&
    collectedThisMonthSummary?.canRepresentAsSingleMoney &&
    collectedLastMonthSummary?.canRepresentAsSingleMoney &&
    collectedThisMonthSummary.byCurrency[0]?.currency === collectedLastMonthSummary.byCurrency[0]?.currency &&
    Number.isFinite(collectedThisMonth) &&
    Number.isFinite(collectedLastMonth)
      ? `${collectedThisMonth >= collectedLastMonth ? '↑' : '↓'} vs last month`
      : collectionDataAvailable
        ? 'Currency-separated ledger totals'
        : 'Payment evidence unavailable'

  return (
    <div className="ov2-page">
      <PageHeader
        title="Cash Flow"
        subtitle="Receivables timing from invoice due dates, verified payments, and confirmed customer promises."
      />

      {promiseError ? (
        <div className="ov2-error"><CircleAlert size={15} />Promise timing unavailable: {promiseError}</div>
      ) : null}

      <div className="ov2-summary-strip">
        <div>
          <span>Collected this month</span>
          <strong>{collectionDataAvailable && collectedThisMonthSummary ? formatMoneySummary(collectedThisMonthSummary) : 'Unavailable'}</strong>
          <small>{collectionTrend}</small>
        </div>
        <div>
          <span>Scheduled next 7 days</span>
          <strong>{formatMoneySummary(model.scheduled7Summary)}</strong>
          <small>invoice + confirmed promise timing</small>
        </div>
        <div>
          <span>Scheduled next 30 days</span>
          <strong>{formatMoneySummary(model.scheduled30Summary)}</strong>
          <small>no probability weighting</small>
        </div>
        <div>
          <span>Confirmed promises ≤30d</span>
          <strong>{formatMoneySummary(model.committedPromise30Summary)}</strong>
          <small>customer commitments only</small>
        </div>
        <div>
          <span>Overdue exposure</span>
          <strong className="ov2-danger">{formatMoneySummary(model.overdueExposureSummary)}</strong>
          <small>{model.openInvoiceCount} open invoices total</small>
        </div>
      </div>

      <div className="ov2-cash-intel-layout">
        <section className="ov2-card ov2-cash-timing-card">
          <div className="ov2-card-head">
            <div><span>Next 35 days</span><h2>Receivables timing</h2></div>
            <Pill tone="blue">Factual schedule</Pill>
          </div>
          <div className="ov2-cash-legend">
            <span><i className="promise" />Confirmed promises</span>
            <span><i className="invoice" />Invoice due timing</span>
          </div>
          <div className="ov2-timing-chart">
            {model.weeks.map((week) => (
              <div className="ov2-timing-column" key={week.index}>
                <strong>{formatMoneySummary(week.amountSummary, { compact: true })}</strong>
                <div className="ov2-timing-track">
                  <span
                    className="ov2-timing-invoice"
                    style={{ height: `${Math.max(Number.isFinite(week.invoiceAmount) && week.invoiceAmount ? 3 : 0, ((Number.isFinite(week.invoiceAmount) ? week.invoiceAmount : 0) / maxWeek) * 100)}%` }}
                  />
                  <span
                    className="ov2-timing-promise"
                    style={{ height: `${Math.max(Number.isFinite(week.promiseAmount) && week.promiseAmount ? 3 : 0, ((Number.isFinite(week.promiseAmount) ? week.promiseAmount : 0) / maxWeek) * 100)}%` }}
                  />
                </div>
                <small>{formatShortDate(week.startDate)}–{formatShortDate(week.endDate)}</small>
              </div>
            ))}
          </div>
          <div className="ov2-cash-disclosure">
            <ShieldCheck size={15} />
            <span>This is scheduled receivables timing, not a predictive cash forecast. DueWatch is not assigning payment probabilities or inventing operating outflows.</span>
          </div>
        </section>

        <aside className="ov2-card ov2-cash-intelligence">
          <div className="ov2-card-head"><div><span>DW cash awareness</span><h2>What is changing timing</h2></div></div>
          <div className="ov2-cash-driver">
            <span className="ov2-driver-icon green"><OverhaulIcon name="promise" size={17} /></span>
            <div><b>Confirmed promise timing</b><small>{formatMoneySummary(model.committedPromise30Summary)} committed within 30 days</small></div>
          </div>
          <div className="ov2-cash-driver">
            <span className="ov2-driver-icon red"><CircleAlert size={17} /></span>
            <div><b>Overdue exposure</b><small>{formatMoneySummary(model.overdueExposureSummary)} is already past invoice due dates</small></div>
          </div>
          <div className="ov2-cash-driver">
            <span className="ov2-driver-icon amber"><Clock3 size={17} /></span>
            <div><b>Past-due promises</b><small>{formatMoneySummary(model.pastDuePromiseExposureSummary)} of confirmed commitments are past promised date without enough verified payment evidence</small></div>
          </div>
          <div className="ov2-cash-driver">
            <span className="ov2-driver-icon blue"><ShieldCheck size={17} /></span>
            <div>
              <b>Data quality</b>
              <small>{model.dataQuality.missingCurrencyCount} open invoice{model.dataQuality.missingCurrencyCount === 1 ? '' : 's'} missing currency · {model.dataQuality.missingDueDateCount} missing due date</small>
            </div>
          </div>
        </aside>
      </div>

      <div className="ov2-cash-bottom-layout">
        <section className="ov2-card">
          <div className="ov2-card-head"><div><span>Upcoming</span><h2>Cash events</h2></div><span className="ov2-head-count">{model.events.length}</span></div>
          <div className="ov2-cash-events">
            {model.events.slice(0, 8).map((event) => (
              <div key={`${event.type}:${event.invoiceId}:${event.date}`}>
                <span className={`ov2-cash-event-icon ${event.type === 'confirmed_promise' ? 'promise' : 'invoice'}`}>
                  <OverhaulIcon name={event.type === 'confirmed_promise' ? 'promise' : 'invoices'} size={15} />
                </span>
                <span><b>{event.clientName}</b><small>{event.invoiceNumber || 'Invoice'} · {event.type === 'confirmed_promise' ? 'confirmed promise' : 'invoice due'} · {formatShortDate(event.date)}</small></span>
                <strong>{formatMoneyTruth(event.amount, event.currency)}</strong>
                <Link className="ov2-mini-link" to={`/invoices?invoice=${event.invoiceId}`}>Open</Link>
              </div>
            ))}
            {model.events.length === 0 ? <TableEmpty>No future receivables events in the next 35 days.</TableEmpty> : null}
          </div>
        </section>

        <section className="ov2-card">
          <div className="ov2-card-head"><div><span>Portfolio risk</span><h2>Aging summary</h2></div></div>
          <div className="ov2-aging-bars">
            {buckets.map((bucket) => (
              <div key={bucket.label}>
                <span>{bucket.label}</span>
                <div><i style={{ width: `${Math.max(Number.isFinite(bucket.amount) && bucket.amount ? 2 : 0, ((Number.isFinite(bucket.amount) ? bucket.amount : 0) / maxAging) * 100)}%` }} /></div>
                <strong>{formatMoneySummary(bucket.summary, { compact: true })}</strong>
              </div>
            ))}
          </div>
        </section>
      </div>
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
                  <span>{event.invoice_id ? <Link className="ov2-entity-link" to={`/invoices?invoice=${event.invoice_id}`}>{event.invoices?.inv_num || 'Open invoice'}</Link> : '—'}</span>
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
  const {
    autopilotEnabled,
    autopilotApprovalRequired,
    lastSyncedAt,
    refresh,
  } = useData()
  const {
    preferences: persistedPrefs,
    loading: loadingPrefs,
    error: preferenceLoadError,
    save: saveShellPreferences,
  } = useWorkspacePreferences()

  const [prefs, setPrefs] = useState(persistedPrefs)
  const [savingPrefs, setSavingPrefs] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')

  useEffect(() => {
    if (!savingPrefs) setPrefs(persistedPrefs)
  }, [persistedPrefs, savingPrefs])

  useEffect(() => {
    if (preferenceLoadError) setSettingsError(preferenceLoadError)
  }, [preferenceLoadError])

  function patchPref(key, value) {
    setPrefs((current) => ({ ...current, [key]: value }))
    setSavedMessage('')
  }

  async function savePreferences() {
    if (!user?.id || savingPrefs) return
    setSavingPrefs(true)
    setSettingsError('')
    setSavedMessage('')
    try {
      const saved = await saveShellPreferences(prefs)
      setPrefs(saved)
      setSavedMessage('Settings saved')
    } catch (saveError) {
      setSettingsError(saveError?.message || 'Could not save settings.')
    } finally {
      setSavingPrefs(false)
    }
  }

  async function changeApprovalMode(next) {
    if (!user?.id || savingPrefs) return
    setSavingPrefs(true)
    setSettingsError('')
    const result = await setAutopilotApprovalRequired(user.id, next)
    if (result?.error) {
      setSettingsError(result.error.message || 'Could not update Autopilot approval mode.')
      setSavingPrefs(false)
      return
    }
    await refresh()
    setSavingPrefs(false)
    setSavedMessage('Autopilot approval mode updated')
  }

  return (
    <div className="ov2-page">
      <PageHeader
        title="Settings"
        subtitle="Persist workspace preferences while keeping automation authority in the Autopilot control plane."
        actions={
          <button className="ov2-button ov2-button--primary" type="button" onClick={savePreferences} disabled={savingPrefs || loadingPrefs}>
            {savingPrefs ? 'Saving…' : 'Save changes'}
          </button>
        }
      />

      {settingsError ? <div className="ov2-error"><CircleAlert size={15} />{settingsError}</div> : null}
      {savedMessage ? <div className="ov2-success"><Check size={15} />{savedMessage}</div> : null}

      <div className="ov2-settings-layout">
        <nav className="ov2-card ov2-settings-nav">
          <button className="is-active">Workspace</button>
          <button aria-disabled="true">Notifications</button>
          <button aria-disabled="true">Automation</button>
          <button aria-disabled="true">Account</button>
        </nav>

        <div className="ov2-settings-main">
          <section className="ov2-card ov2-settings-section">
            <div className="ov2-card-head"><div><span>Workspace</span><h2>Organization & display</h2></div><Pill tone={prefs.exists ? 'green' : 'neutral'}>{prefs.exists ? 'Saved' : 'Using local defaults'}</Pill></div>
            {loadingPrefs ? <TableEmpty>Loading settings…</TableEmpty> : (
              <div className="ov2-settings-form">
                <label className="ov2-field">
                  <span>Workspace name</span>
                  <input value={prefs.workspace_name || ''} onChange={(event) => patchPref('workspace_name', event.target.value)} maxLength={80} />
                </label>
                <div className="ov2-field-grid">
                  <label className="ov2-field">
                    <span>Timezone</span>
                    <input value={prefs.timezone || ''} onChange={(event) => patchPref('timezone', event.target.value)} placeholder="America/New_York" maxLength={80} />
                  </label>
                  <label className="ov2-field">
                    <span>Date format</span>
                    <select value={prefs.date_format} onChange={(event) => patchPref('date_format', event.target.value)}>
                      <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                      <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                      <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                    </select>
                  </label>
                </div>
                <div className="ov2-settings-note">
                  <ShieldCheck size={15} />
                  <span>The browser timezone is only used as an unsaved starting value. DueWatch does not claim it is your workspace timezone until you save it.</span>
                </div>
              </div>
            )}
          </section>

          <section className="ov2-card ov2-settings-section">
            <div className="ov2-card-head"><div><span>Notifications</span><h2>Founder preferences</h2></div></div>
            {[
              ['weekly_digest','Weekly performance digest','Receive a periodic receivables summary.'],
              ['overdue_summary','Overdue summary','Surface new overdue invoices in summaries.'],
              ['promise_notifications','Promise-to-Pay notifications','Surface promise due and past-due unresolved changes.'],
              ['escalation_alerts','Escalation alerts','Surface items that require founder judgment.'],
              ['product_updates','Product updates','Receive DueWatch product update notices.'],
            ].map(([key,label,help]) => (
              <div className="ov2-setting-toggle-row" key={key}>
                <span><b>{label}</b><small>{help}</small></span>
                <Toggle checked={prefs[key] !== false} onChange={(next) => patchPref(key, next)} disabled={loadingPrefs} />
              </div>
            ))}
          </section>

          <section className="ov2-card ov2-settings-section">
            <div className="ov2-card-head"><div><span>Automation authority</span><h2>Autopilot approval boundary</h2></div><Pill tone={autopilotEnabled ? 'green' : 'neutral'}>{autopilotEnabled ? 'Autopilot on' : 'Autopilot off'}</Pill></div>
            <div className="ov2-setting-toggle-row">
              <span>
                <b>Require approval before reminder send</b>
                <small>Stored in the hardened Autopilot authority settings—not workspace preferences.</small>
              </span>
              <Toggle checked={autopilotApprovalRequired} onChange={changeApprovalMode} disabled={savingPrefs} />
            </div>
            <div className="ov2-settings-row"><span>Current behavior</span><strong>{autopilotApprovalRequired ? 'Founder signature required' : 'Automatic within enabled rules'}</strong></div>
            <div className="ov2-settings-row"><span>Data last refreshed</span><strong>{lastSyncedAt ? timeAgo(lastSyncedAt) : 'Not available'}</strong></div>
            <Link className="ov2-inline-link" to="/autopilot">Open Autopilot authority & rules <ArrowRight size={13} /></Link>
          </section>

          <section className="ov2-card ov2-settings-section">
            <div className="ov2-card-head"><div><span>Account</span><h2>Session</h2></div></div>
            <div className="ov2-settings-row"><span>Name</span><strong>{user?.user_metadata?.full_name || 'Not set'}</strong></div>
            <div className="ov2-settings-row"><span>Email</span><strong>{user?.email || '—'}</strong></div>
            <div className="ov2-settings-session-action"><button className="ov2-button ov2-button--ghost" onClick={signOut}>Log out</button></div>
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

  async function setApprovalMode(next) {
    if (!user?.id || saving) return
    setSaving(true)
    setError('')
    const result = await setAutopilotApprovalRequired(user.id, next)
    if (result?.error) {
      setError(result.error.message || 'Could not update approval mode.')
      setSaving(false)
      return
    }
    await refresh()
    setSaving(false)
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
                  {event.invoice_id ? <Link className="ov2-mini-link" to={`/invoices?invoice=${event.invoice_id}`}>Open</Link> : null}
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
                  <Link className="ov2-mini-link" to={`/invoices?invoice=${invoice.id}`}>Open</Link>
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
              <div className="ov2-authority-toggle"><span>Approval</span><span><strong>{autopilotApprovalRequired ? 'Required' : 'Automatic within rules'}</strong><Toggle checked={autopilotApprovalRequired} onChange={setApprovalMode} disabled={saving} /></span></div>
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
                  {item.invoice_id ? <Link className="ov2-mini-link" to={`/invoices?invoice=${item.invoice_id}`}>Open approval</Link> : null}
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
