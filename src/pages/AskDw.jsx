import { useMemo, useState } from 'react'
import { ArrowRight, BookOpen, Search, Sparkles } from 'lucide-react'
import { useData, balanceOf, isOutstanding } from '../context/DataContext'
import { formatMoney, daysOverdue } from '../lib/format'
import AskDwInvoiceLiveProbe from '../features/dwIntelligence/AskDwInvoiceLiveProbe'
import { PageHeader, SegmentedTabs, SectionCard, EmptyState, StatusBadge } from '../components/V1Page'

const TABS = [
  { key: 'ask', label: 'Ask' },
  { key: 'investigations', label: 'Investigations' },
  { key: 'history', label: 'Proof journal' },
]

export default function AskDw() {
  const { invoices, dwIntelligence } = useData()
  const [tab, setTab] = useState('ask')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(() => invoices.find(isOutstanding)?.id || invoices[0]?.id || '')

  const candidateInvoices = useMemo(() => {
    const q = query.trim().toLowerCase()
    return invoices.filter((invoice) => {
      if (!q) return true
      return (invoice.clients?.name || '').toLowerCase().includes(q) || (invoice.invoice_number || '').toLowerCase().includes(q)
    }).sort((a, b) => daysOverdue(b.due_date) - daysOverdue(a.due_date))
  }, [invoices, query])

  const selected = invoices.find((invoice) => invoice.id === selectedId) || candidateInvoices[0] || null
  const needsYou = dwIntelligence?.needsYou?.items || []
  const journal = dwIntelligence?.whatsDone?.entries || []

  return (
    <div className="v1-page v1-ask-page">
      <PageHeader
        eyebrow="DW Intelligence"
        title="Ask DW"
        subtitle="Investigate an invoice with the same grounded engine that powers proactive DW Intelligence."
        actions={<StatusBadge tone="green">Verified read-only conversation</StatusBadge>}
      />
      <SegmentedTabs items={TABS.map((item) => item.key === 'investigations' ? { ...item, count: needsYou.length || undefined } : item)} value={tab} onChange={setTab} />

      {tab === 'ask' && (
        <div className="v1-ask-room">
          <aside className="v1-ask-casebook">
            <div className="v1-casebook-head"><BookOpen size={18}/><div><strong>Invoice casebook</strong><span>Choose what DW should investigate.</span></div></div>
            <label className="v1-ask-search"><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find client or invoice…" /></label>
            <div className="v1-casebook-list">
              {candidateInvoices.slice(0, 40).map((invoice) => (
                <button key={invoice.id} type="button" className={selected?.id === invoice.id ? 'active' : ''} onClick={() => setSelectedId(invoice.id)}>
                  <div><strong>{invoice.clients?.name || 'Client'}</strong><span>{invoice.invoice_number || 'Invoice'} · {formatMoney(balanceOf(invoice))}</span></div>
                  <span>{daysOverdue(invoice.due_date) > 0 ? `${daysOverdue(invoice.due_date)}d late` : invoice.paid ? 'Paid' : 'Current'}</span>
                </button>
              ))}
            </div>
          </aside>
          <section className="v1-ask-conversation-room">
            {selected ? (
              <>
                <div className="v1-ask-selected-case"><div><span className="v1-eyebrow">Current case</span><h2>{selected.clients?.name || 'Client'}</h2><p>{selected.invoice_number || 'Invoice'} · {formatMoney(balanceOf(selected))}</p></div><Sparkles size={24}/></div>
                <AskDwInvoiceLiveProbe invoiceId={selected.id} invoiceIds={invoices.map((invoice) => invoice.id)} />
              </>
            ) : <EmptyState title="No invoice case yet" body="Create or import an invoice before starting a verified Ask DW investigation." />}
          </section>
        </div>
      )}

      {tab === 'investigations' && (
        <div className="v1-investigation-room">
          <div className="v1-investigation-room-head"><Sparkles size={22}/><div><h2>Investigations that need judgment</h2><p>These come from the same frozen Investigation Engine. Opening one does not execute anything.</p></div></div>
          {needsYou.length === 0 ? <EmptyState title="Nothing needs your judgment" body="DW has no unresolved investigation in the Needs You queue right now." /> : (
            <div className="v1-investigation-stack">{needsYou.map((item) => {
              const invoice = invoices.find((row) => row.id === item.invoiceId)
              return <button type="button" key={item.runId || item.invoiceId} className="v1-investigation-card" onClick={() => { setSelectedId(item.invoiceId); setTab('ask') }}><div><strong>{invoice?.clients?.name || 'Client'}</strong><span>{invoice?.invoice_number || item.invoiceId}</span><p>{item.stateMessage}</p></div><div><strong>{formatMoney(item.balance)}</strong><span>{item.cta || 'Review case'}</span><ArrowRight size={15}/></div></button>
            })}</div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="v1-proof-room">
          <SectionCard title="DW proof journal">
            <p className="v1-card-subtitle">Completed, investigated, escalated, watched, and intentionally withheld work with persisted proof.</p>
            {journal.length === 0 ? <EmptyState title="No proof entries yet" body="Verified DW investigation history will appear here." /> : <div className="v1-proof-ledger">{journal.map((entry) => {
              const invoice = invoices.find((row) => row.id === entry.invoiceId)
              return <article key={`${entry.runId || entry.invoiceId}-${entry.at || ''}`}><StatusBadge tone={entry.kind === 'WITHHELD' ? 'amber' : entry.kind === 'ESCALATED' ? 'red' : 'green'}>{entry.kind}</StatusBadge><div><strong>{entry.title}</strong><span>{invoice?.clients?.name || 'Client'} · {invoice?.invoice_number || entry.invoiceId}</span><p>{entry.detail}</p></div><span>{entry.proofAvailable ? 'Proof available' : 'Proof unavailable'}</span></article>
            })}</div>}
          </SectionCard>
        </div>
      )}
    </div>
  )
}
