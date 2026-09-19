import { useMemo, useState } from 'react'
import { Download, FileBarChart, ShieldCheck, Users, WalletCards } from 'lucide-react'
import { useData, balanceOf, isOutstanding } from '../context/DataContext'
import { formatMoney, daysOverdue } from '../lib/format'
import { PageHeader, SegmentedTabs, SectionCard, StatusBadge } from '../components/V1Page'

const TABS = [
  { key: 'collections', label: 'Collections' },
  { key: 'aging', label: 'Aging' },
  { key: 'clients', label: 'Clients' },
  { key: 'autopilot', label: 'Autopilot' },
]

function csvEscape(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function exportCsv(filename, rows) {
  const body = rows.map((row) => row.map(csvEscape).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function Reports() {
  const {
    invoices,
    clients,
    collectedThisMonth,
    collectedLastMonth,
    totalEventsCount,
    autopilotEnabled,
    awaitingSignature,
    dwIntelligence,
  } = useData()
  const [tab, setTab] = useState('collections')

  const report = useMemo(() => {
    const open = invoices.filter(isOutstanding)
    const outstanding = open.reduce((sum, row) => sum + balanceOf(row), 0)
    const buckets = {
      current: { label: 'Current', amount: 0, count: 0 },
      d1: { label: '1–30 days', amount: 0, count: 0 },
      d31: { label: '31–60 days', amount: 0, count: 0 },
      d61: { label: '61+ days', amount: 0, count: 0 },
    }
    for (const invoice of open) {
      const overdue = Math.max(0, daysOverdue(invoice.due_date))
      const target = overdue === 0 ? buckets.current : overdue <= 30 ? buckets.d1 : overdue <= 60 ? buckets.d31 : buckets.d61
      target.amount += balanceOf(invoice)
      target.count += 1
    }

    const clientRows = clients.map((client) => {
      const rows = invoices.filter((invoice) => invoice.client_id === client.id)
      const openRows = rows.filter(isOutstanding)
      const openBalance = openRows.reduce((sum, invoice) => sum + balanceOf(invoice), 0)
      const worst = openRows.reduce((max, invoice) => Math.max(max, Math.max(0, daysOverdue(invoice.due_date))), 0)
      const paidCount = rows.filter((row) => row.paid).length
      return { client, openBalance, openCount: openRows.length, worst, paidCount, totalCount: rows.length }
    }).sort((a, b) => b.openBalance - a.openBalance)

    return { open, outstanding, buckets: Object.values(buckets), clientRows }
  }, [invoices, clients])

  const maxBucket = Math.max(1, ...report.buckets.map((bucket) => bucket.amount))
  const collectionsDelta = collectedLastMonth > 0
    ? ((collectedThisMonth - collectedLastMonth) / collectedLastMonth) * 100
    : null

  function doExport() {
    if (tab === 'clients') {
      exportCsv('duewatch-client-report.csv', [
        ['Client', 'Outstanding', 'Open invoices', 'Worst days overdue', 'Paid invoices'],
        ...report.clientRows.map((row) => [row.client.name, row.openBalance, row.openCount, row.worst, row.paidCount]),
      ])
      return
    }
    exportCsv('duewatch-aging-report.csv', [
      ['Aging bucket', 'Outstanding', 'Invoices'],
      ...report.buckets.map((bucket) => [bucket.label, bucket.amount, bucket.count]),
    ])
  }

  return (
    <div className="v1-page v1-reports-page">
      <PageHeader
        title="Reports"
        subtitle="A quiet reporting room for cash, aging, client exposure, and verified DueWatch activity."
        actions={<button type="button" className="v1-secondary-btn" onClick={doExport}><Download size={16} /> Export CSV</button>}
      />
      <SegmentedTabs items={TABS} value={tab} onChange={setTab} />

      {tab === 'collections' && (
        <div className="v1-report-room">
          <section className="v1-report-hero">
            <div>
              <span className="v1-eyebrow">Collections this month</span>
              <strong>{formatMoney(collectedThisMonth)}</strong>
              <p>{collectionsDelta == null ? 'No prior-month comparison is available yet.' : `${collectionsDelta >= 0 ? 'Up' : 'Down'} ${Math.abs(collectionsDelta).toFixed(1)}% versus last month.`}</p>
            </div>
            <div className="v1-report-hero-mark"><WalletCards size={30} /></div>
          </section>
          <div className="v1-report-ledger-grid">
            <SectionCard title="Receivables still open">
              <div className="v1-report-number">{formatMoney(report.outstanding)}</div>
              <p className="v1-muted">{report.open.length} open {report.open.length === 1 ? 'invoice' : 'invoices'} remain in the canonical invoice ledger.</p>
            </SectionCard>
            <SectionCard title="DW proof journal">
              <div className="v1-report-number">{dwIntelligence?.whatsDone?.total || 0}</div>
              <p className="v1-muted">Proven investigation entries. This count does not imply a financial side effect.</p>
            </SectionCard>
            <SectionCard title="Operational events">
              <div className="v1-report-number">{totalEventsCount || 0}</div>
              <p className="v1-muted">Recorded app events in your activity history.</p>
            </SectionCard>
          </div>
          <SectionCard title="Collection posture by client" className="v1-report-table-card">
            <table className="v1-data-table">
              <thead><tr><th>Client</th><th>Outstanding</th><th>Open</th><th>Worst overdue</th><th>History</th></tr></thead>
              <tbody>{report.clientRows.slice(0, 10).map((row) => (
                <tr key={row.client.id}>
                  <td><strong>{row.client.name}</strong></td>
                  <td>{formatMoney(row.openBalance)}</td>
                  <td>{row.openCount}</td>
                  <td>{row.worst > 0 ? `${row.worst} days` : 'Current'}</td>
                  <td>{row.paidCount}/{row.totalCount} paid</td>
                </tr>
              ))}</tbody>
            </table>
          </SectionCard>
        </div>
      )}

      {tab === 'aging' && (
        <div className="v1-aging-room">
          <div className="v1-aging-total"><FileBarChart size={24} /><div><span>Total outstanding</span><strong>{formatMoney(report.outstanding)}</strong></div></div>
          <SectionCard title="Aging distribution" className="v1-aging-chart-card">
            <div className="v1-aging-bars">
              {report.buckets.map((bucket) => (
                <div key={bucket.label} className="v1-aging-bar-row">
                  <div><strong>{bucket.label}</strong><span>{bucket.count} invoices</span></div>
                  <div className="v1-aging-track"><span style={{ width: `${Math.max(4, (bucket.amount / maxBucket) * 100)}%` }} /></div>
                  <strong>{formatMoney(bucket.amount)}</strong>
                </div>
              ))}
            </div>
          </SectionCard>
          <div className="v1-report-note"><ShieldCheck size={17} /><span>Aging is calculated only from canonical invoice due dates and remaining balances.</span></div>
        </div>
      )}

      {tab === 'clients' && (
        <div className="v1-client-report-room">
          <div className="v1-book-shelf-heading"><Users size={21} /><div><h2>Client exposure book</h2><p>Who carries your receivables risk right now.</p></div></div>
          <div className="v1-client-report-list">
            {report.clientRows.map((row, index) => (
              <article key={row.client.id} className="v1-client-report-row">
                <span className="v1-report-rank">{String(index + 1).padStart(2, '0')}</span>
                <div className="v1-client-report-name"><strong>{row.client.name}</strong><span>{row.client.company || 'Client account'}</span></div>
                <div><span>Outstanding</span><strong>{formatMoney(row.openBalance)}</strong></div>
                <div><span>Open invoices</span><strong>{row.openCount}</strong></div>
                <div><span>Worst overdue</span><strong>{row.worst ? `${row.worst} days` : 'Current'}</strong></div>
                <StatusBadge tone={row.worst >= 30 ? 'red' : row.worst > 0 ? 'amber' : 'green'}>{row.worst >= 30 ? 'High attention' : row.worst > 0 ? 'Watch' : 'Current'}</StatusBadge>
              </article>
            ))}
          </div>
        </div>
      )}

      {tab === 'autopilot' && (
        <div className="v1-report-autopilot-room">
          <SectionCard title="Autopilot report">
            <div className="v1-report-autopilot-state">
              <span className={`v1-dot ${autopilotEnabled ? 'green' : 'gray'}`} />
              <div><strong>{autopilotEnabled ? 'Autopilot is enabled' : 'Autopilot is off'}</strong><p>Only persisted authority and server-side revalidation can produce automatic work.</p></div>
            </div>
            <div className="v1-report-facts">
              <div><span>Founder decisions waiting</span><strong>{awaitingSignature.length}</strong></div>
              <div><span>Proven DW entries</span><strong>{dwIntelligence?.whatsDone?.total || 0}</strong></div>
              <div><span>Needs You cases</span><strong>{dwIntelligence?.needsYou?.count || 0}</strong></div>
            </div>
          </SectionCard>
          <div className="v1-report-note"><ShieldCheck size={17} /><span>These reports describe observed state. They do not grant, expand, or imply execution authority.</span></div>
        </div>
      )}
    </div>
  )
}
