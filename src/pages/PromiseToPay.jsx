import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Filter, Search } from 'lucide-react'
import { useData, balanceOf } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { formatMoney, formatShortDate, timeAgo } from '../lib/format'
import Avatar from '../components/Avatar'
import { DetailTabs, EmptyState, PageHeader, SegmentedTabs, StatusBadge } from '../components/V1Page'

const VIEW_TABS = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'list', label: 'List' },
  { key: 'all', label: 'All Promises' },
]
const DETAIL_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'evidence', label: 'Evidence' },
  { key: 'payments', label: 'Payments' },
  { key: 'history', label: 'History' },
]

const statusTone = (status) => status === 'BROKEN' ? 'red' : status === 'FULFILLED' ? 'green' : status === 'DUE_TODAY' ? 'orange' : status === 'DISPUTED' ? 'purple' : 'amber'

function monthKey(value) {
  if (!value) return null
  const date = new Date(`${value}T12:00:00`)
  if (Number.isNaN(date.getTime())) return null
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}`
}

function promiseDateFrom(row) {
  const p = row?.proof?.arState?.promise || {}
  return p.promisedDate || p.promiseDate || p.date || row?.promiseDate || null
}

export default function PromiseToPay() {
  const { user } = useAuth()
  const { invoices, clients } = useData()
  const [proofs, setProofs] = useState([])
  const [evidence, setEvidence] = useState([])
  const [view, setView] = useState('calendar')
  const [detailTab, setDetailTab] = useState('overview')
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(null)
  const [query, setQuery] = useState('')
  const [monthCursor, setMonthCursor] = useState(() => new Date())

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    Promise.all([
      supabase.from('dw_proof_events')
        .select('id,run_id,client_id,invoice_id,operational_state,proof,created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(240),
      supabase.from('dw_evidence_items')
        .select('id,client_id,invoice_id,source_type,source_ref,trust,admission_status,claim_type,provenance,created_at')
        .eq('user_id', user.id)
        .eq('claim_type', 'promise_claim')
        .order('created_at', { ascending: false })
        .limit(160),
    ]).then(([proofResult, evidenceResult]) => {
      if (cancelled) return
      setProofs(proofResult.error ? [] : proofResult.data || [])
      setEvidence(evidenceResult.error ? [] : evidenceResult.data || [])
    })
    return () => { cancelled = true }
  }, [user?.id])

  const promises = useMemo(() => {
    const newest = new Map()
    for (const row of proofs) {
      if (newest.has(row.invoice_id)) continue
      const status = row.proof?.arState?.promise?.status
      if (!status || ['NONE','CLAIMED_UNVERIFIED'].includes(status)) continue
      newest.set(row.invoice_id, row)
    }
    return [...newest.values()].map((proof) => {
      const invoice = invoices.find((row) => row.id === proof.invoice_id)
      const client = clients.find((row) => row.id === proof.client_id)
      const relatedEvidence = evidence.filter((row) => row.invoice_id === proof.invoice_id && row.admission_status === 'ADMITTED')
      const evidenceDate = relatedEvidence.map((row) => row.provenance?.promisedDate || row.provenance?.promiseDate || row.provenance?.date || null).find(Boolean)
      return {
        proof,
        invoice,
        client,
        evidence: relatedEvidence,
        status: proof.proof?.arState?.promise?.status,
        date: promiseDateFrom(proof) || evidenceDate || null,
      }
    }).filter((row) => row.invoice)
  }, [proofs, evidence, invoices, clients])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return promises.filter((row) => !q || [row.client?.name, row.invoice?.invoice_number].some((value) => String(value || '').toLowerCase().includes(q)))
  }, [promises, query])

  useEffect(() => {
    if (!selectedInvoiceId && filtered[0]?.invoice?.id) setSelectedInvoiceId(filtered[0].invoice.id)
  }, [filtered, selectedInvoiceId])

  const selected = promises.find((row) => row.invoice?.id === selectedInvoiceId) || filtered[0] || null
  const currentMonth = `${monthCursor.getFullYear()}-${String(monthCursor.getMonth()+1).padStart(2,'0')}`
  const calendarRows = filtered.filter((row) => monthKey(row.date) === currentMonth)
  const start = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1)
  const days = new Date(monthCursor.getFullYear(), monthCursor.getMonth()+1, 0).getDate()
  const leading = start.getDay()
  const cells = Array.from({ length: 42 }, (_, index) => index - leading + 1)
  const monthLabel = new Intl.DateTimeFormat('en-US', { month:'long', year:'numeric' }).format(monthCursor)

  const active = promises.filter((row) => ['CONFIRMED','DUE_TODAY','PROPOSED'].includes(row.status))
  const broken = promises.filter((row) => row.status === 'BROKEN')
  const fulfilled = promises.filter((row) => row.status === 'FULFILLED')
  const dueToday = promises.filter((row) => row.status === 'DUE_TODAY')

  function moveMonth(delta) {
    setMonthCursor((value) => new Date(value.getFullYear(), value.getMonth()+delta, 1))
  }

  function renderMain() {
    if (filtered.length === 0) {
      return <EmptyState title="No admitted promises yet" body="DueWatch only shows promise-to-pay records when the Investigation Engine has admitted a promise into proof state." />
    }
    if (view === 'calendar') {
      return (
        <div className="v1-ptp-calendar-room">
          <div className="v1-calendar-toolbar">
            <div><button onClick={()=>moveMonth(-1)}><ChevronLeft size={16}/></button><button onClick={()=>moveMonth(1)}><ChevronRight size={16}/></button><button onClick={()=>setMonthCursor(new Date())}>Today</button></div>
            <strong>{monthLabel}</strong>
            <span>{calendarRows.length} dated promises</span>
          </div>
          <div className="v1-calendar-grid v1-calendar-days">
            {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d)=><div key={d}>{d}</div>)}
          </div>
          <div className="v1-calendar-grid v1-calendar-body">
            {cells.map((day, index) => {
              const inMonth = day >= 1 && day <= days
              const date = inMonth ? `${currentMonth}-${String(day).padStart(2,'0')}` : null
              const items = date ? calendarRows.filter((row)=>row.date===date) : []
              return (
                <div key={index} className={`v1-calendar-cell${inMonth ? '' : ' outside'}`}>
                  {inMonth && <span className="v1-calendar-number">{day}</span>}
                  {items.slice(0,3).map((row)=><button key={row.invoice.id} type="button" className={`v1-calendar-event tone-${statusTone(row.status)}`} onClick={()=>setSelectedInvoiceId(row.invoice.id)}><strong>{row.client?.name || 'Client'}</strong><span>{formatMoney(balanceOf(row.invoice))} · {row.status.replaceAll('_',' ')}</span></button>)}
                </div>
              )
            })}
          </div>
          {filtered.some((row)=>!row.date) && <div className="v1-undated-strip"><Clock3 size={15}/><span>{filtered.filter((row)=>!row.date).length} admitted promises have no verified promise date, so they stay in List instead of being placed on the calendar.</span></div>}
        </div>
      )
    }
    return (
      <div className="v1-ptp-list">
        <div className="v1-table-row v1-table-head"><span>Client</span><span>Invoice</span><span>Promised for</span><span>Amount</span><span>Status</span><span>Evidence</span></div>
        {filtered.map((row)=><button key={row.invoice.id} type="button" className={`v1-table-row${selected?.invoice?.id===row.invoice.id?' selected':''}`} onClick={()=>setSelectedInvoiceId(row.invoice.id)}><span className="v1-client-table-cell"><Avatar name={row.client?.name} size={32}/><strong>{row.client?.name || 'Client'}</strong></span><span>{row.invoice.invoice_number || 'Invoice'}</span><span>{row.date ? formatShortDate(row.date) : 'Date not verified'}</span><strong>{formatMoney(balanceOf(row.invoice))}</strong><StatusBadge tone={statusTone(row.status)}>{row.status.replaceAll('_',' ')}</StatusBadge><span>{row.evidence.length} source{row.evidence.length===1?'':'s'}</span></button>)}
      </div>
    )
  }

  function renderDetail() {
    if (!selected) return <EmptyState title="No promise selected" />
    if (detailTab === 'evidence') return selected.evidence.length ? <div className="v1-book-list">{selected.evidence.map((row)=><div className="v1-book-row" key={row.id}><div><strong>{row.source_type || 'Evidence'}</strong><span>{timeAgo(row.created_at)}</span></div><StatusBadge tone={row.trust==='HIGH'?'green':'amber'}>{row.trust || 'UNRATED'}</StatusBadge></div>)}</div> : <EmptyState title="No admitted evidence rows" body="The proof state can exist without exposing source content in this browser view." />
    if (detailTab === 'payments') return <EmptyState title="Payment verification lives on the invoice" body="Open the related invoice to review canonical payment allocations and evidence." />
    if (detailTab === 'history') return <div className="v1-book-timeline"><div><span className="v1-dot green"/><div><strong>Proof state: {selected.status.replaceAll('_',' ')}</strong><span>{timeAgo(selected.proof.created_at)}</span></div></div></div>
    return (
      <div className="v1-ptp-detail-overview">
        <section className={`v1-promise-callout tone-${statusTone(selected.status)}`}><CalendarDays size={22}/><div><strong>{selected.status==='DUE_TODAY'?'Promise due today':selected.status.replaceAll('_',' ')}</strong><span>{selected.date ? `Verified promise date: ${formatShortDate(selected.date)}` : 'The promise state is admitted, but no verified promise date is available.'}</span></div></section>
        <div className="v1-detail-facts"><div><span>Amount</span><strong>{formatMoney(balanceOf(selected.invoice))}</strong></div><div><span>Invoice</span><strong>{selected.invoice.invoice_number || 'Invoice'}</strong></div><div><span>Promise date</span><strong>{selected.date ? formatShortDate(selected.date) : 'Not verified'}</strong></div><div><span>Status</span><StatusBadge tone={statusTone(selected.status)}>{selected.status.replaceAll('_',' ')}</StatusBadge></div></div>
        <section className="v1-intelligence-banner"><CalendarDays size={18}/><div><strong>DW Intelligence</strong><p>This page is read-only proof state. A promise is never inferred from a due date or a customer sentence unless it is admitted by the Investigation Engine.</p></div></section>
      </div>
    )
  }

  return (
    <div className="v1-page v1-ptp-page">
      <PageHeader title="Promise-to-Pay" subtitle="Track admitted customer promises without turning unverified claims into payment truth." actions={<button type="button" className="v1-primary-btn" disabled title="No canonical manual promise write path is deployed yet">+ Record Promise</button>} />
      <div className="v1-ptp-toolbar"><SegmentedTabs items={VIEW_TABS} value={view} onChange={setView}/><div className="v1-field-search"><Search size={15}/><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Search promises..."/></div><button className="v1-secondary-btn"><Filter size={15}/> Filters</button></div>
      <div className="v1-ptp-summary"><div><span className="v1-dot green"/><strong>{active.length}</strong><span>Active</span></div><div><span className="v1-dot orange"/><strong>{dueToday.length}</strong><span>Due today</span></div><div><span className="v1-dot red"/><strong>{broken.length}</strong><span>Broken</span></div><div><span className="v1-dot green"/><strong>{fulfilled.length}</strong><span>Fulfilled</span></div></div>
      <div className="v1-ptp-room"><main className="v1-ptp-main">{renderMain()}</main><aside className="v1-detail-rail">{selected && <><div className="v1-detail-title"><div><span className="v1-eyebrow">{selected.invoice.invoice_number || 'Invoice'}</span><h2>{selected.client?.name || 'Client'}</h2><p>{formatMoney(balanceOf(selected.invoice))}</p></div><StatusBadge tone={statusTone(selected.status)}>{selected.status.replaceAll('_',' ')}</StatusBadge></div><DetailTabs items={DETAIL_TABS} value={detailTab} onChange={setDetailTab}/><div className="v1-detail-body">{renderDetail()}</div></>}</aside></div>
    </div>
  )
}
