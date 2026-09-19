import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileUp, Link2, PlugZap, RefreshCw, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { PageHeader, SegmentedTabs, SectionCard, StatusBadge, EmptyState } from '../components/V1Page'

const TABS = [
  { key: 'sources', label: 'Sources' },
  { key: 'identity', label: 'Identity review' },
  { key: 'imports', label: 'Import history' },
]

const PROVIDERS = [
  { key: 'quickbooks_online', label: 'QuickBooks', detail: 'Invoices, customers, accounting evidence', mark: 'qb' },
  { key: 'xero_accounting', label: 'Xero', detail: 'Invoices, contacts, accounting evidence', mark: 'xe' },
  { key: 'stripe', label: 'Stripe', detail: 'PaymentIntent, Charge, payment evidence', mark: 'st' },
  { key: 'gmail', label: 'Gmail', detail: 'Communication evidence and promises', mark: 'gm' },
  { key: 'highlevel', label: 'HighLevel', detail: 'CRM context and client records', mark: 'hl' },
  { key: 'google_drive', label: 'Google Drive', detail: 'Contracts and document evidence', mark: 'gd' },
  { key: 'dropbox', label: 'Dropbox', detail: 'Contracts and document evidence', mark: 'db' },
]

function formatWhen(value) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}

export default function Integrations() {
  const [tab, setTab] = useState('sources')
  const [identity, setIdentity] = useState([])
  const [imports, setImports] = useState([])
  const [identityError, setIdentityError] = useState('')
  const [importsError, setImportsError] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    setIdentityError('')
    setImportsError('')
    const [identityResult, importResult] = await Promise.all([
      supabase.rpc('m2h_cp7_review_queue'),
      supabase.from('import_runs').select('id, filename, status, created_at, updated_at').order('created_at', { ascending: false }).limit(15),
    ])
    if (identityResult.error) setIdentityError(identityResult.error.message)
    else setIdentity(Array.isArray(identityResult.data) ? identityResult.data : [])
    if (importResult.error) setImportsError(importResult.error.message)
    else setImports(importResult.data || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const providerReviewCounts = useMemo(() => {
    const out = new Map()
    for (const item of identity) out.set(item.provider, (out.get(item.provider) || 0) + 1)
    return out
  }, [identity])

  return (
    <div className="v1-page v1-integrations-page">
      <PageHeader
        title="Integrations"
        subtitle="The source room: what DueWatch can read, what needs identity review, and what has been imported."
        actions={<button type="button" className="v1-secondary-btn" onClick={load}><RefreshCw size={15} /> Refresh</button>}
      />
      <SegmentedTabs items={TABS.map((item) => item.key === 'identity' ? { ...item, count: identity.length || undefined } : item)} value={tab} onChange={setTab} />

      {tab === 'sources' && (
        <div className="v1-source-room">
          <div className="v1-source-room-intro">
            <PlugZap size={24} />
            <div><h2>Connected evidence starts here</h2><p>This browser intentionally does not invent provider health. CP6 owns connection lifecycle and service-side credentials; this room shows only safely readable product state.</p></div>
          </div>
          <div className="v1-provider-grid">
            {PROVIDERS.map((provider) => (
              <article key={provider.key} className="v1-provider-card">
                <span className={`v1-provider-mark provider-${provider.mark}`}>{provider.label.slice(0, 2)}</span>
                <div className="v1-provider-card-main"><strong>{provider.label}</strong><span>{provider.detail}</span></div>
                {providerReviewCounts.get(provider.key) ? <StatusBadge tone="amber">{providerReviewCounts.get(provider.key)} need review</StatusBadge> : <StatusBadge tone="neutral">Lifecycle governed by CP6</StatusBadge>}
              </article>
            ))}
          </div>
          <div className="v1-source-actions">
            <Link className="v1-primary-btn" to="/import"><FileUp size={16} /> Import files</Link>
            <div className="v1-safety-note"><ShieldCheck size={17} /><p><strong>No browser secrets.</strong> Provider OAuth, refresh, revocation, freshness, and webhook control remain behind the frozen CP6 control plane.</p></div>
          </div>
        </div>
      )}

      {tab === 'identity' && (
        <div className="v1-identity-room">
          <SectionCard title="Cross-provider identity review">
            <p className="v1-card-subtitle">CP7 never silently merges ambiguous records. These are the identities that still need judgment or are withheld by stale/conflicting evidence.</p>
            {loading ? <div className="v1-list-loading">Checking Company Brain…</div> : identityError ? (
              <div className="v1-warning-panel"><AlertTriangle size={18} /><div><strong>Identity review is unavailable</strong><p>{identityError}</p></div></div>
            ) : identity.length === 0 ? <EmptyState title="Nothing needs identity review" body="DueWatch is not asking you to resolve any cross-provider identity candidates right now." /> : (
              <div className="v1-identity-list">
                {identity.map((item) => (
                  <article key={item.candidate_id} className="v1-identity-row">
                    <div className="v1-identity-provider"><Link2 size={16} /><strong>{String(item.provider || 'provider').replaceAll('_', ' ')}</strong><span>{item.entity_type || 'record'}</span></div>
                    <div><span>Possible client</span><strong>{item.client_name || item.client_company || 'Client'}</strong></div>
                    <div><span>Classification</span><strong>{String(item.classification || 'review required').replaceAll('_', ' ')}</strong></div>
                    <div><span>Source observed</span><strong>{formatWhen(item.source_timestamp)}</strong></div>
                    <StatusBadge tone={item.status === 'BLOCKED_CONFLICT' ? 'red' : item.status === 'WITHHELD_STALE' ? 'amber' : 'purple'}>{String(item.status || 'REVIEW_REQUIRED').replaceAll('_', ' ')}</StatusBadge>
                  </article>
                ))}
              </div>
            )}
          </SectionCard>
          <div className="v1-safety-note"><ShieldCheck size={17} /><p>Review state is read-only here. Identity decisions remain revision-fenced and authenticated in the CP7 decision path; this screen will not bypass that path.</p></div>
        </div>
      )}

      {tab === 'imports' && (
        <div className="v1-import-history-room">
          <SectionCard title="Import history" action={<Link className="v1-inline-link" to="/imports">Open full history</Link>}>
            {loading ? <div className="v1-list-loading">Loading imports…</div> : importsError ? <div className="v1-warning-panel"><AlertTriangle size={18} /><div><strong>Import history unavailable</strong><p>{importsError}</p></div></div> : imports.length === 0 ? <EmptyState title="No imports yet" body="CSV, XLSX, and supported invoice imports will appear here after you review them." action={<Link className="v1-primary-btn" to="/import">Import invoices</Link>} /> : (
              <div className="v1-import-history-list">
                {imports.map((run) => <Link to={`/imports/${run.id}`} key={run.id} className="v1-import-history-row"><FileUp size={17}/><div><strong>{run.filename || 'Invoice import'}</strong><span>{formatWhen(run.created_at)}</span></div><StatusBadge tone={run.status === 'completed' ? 'green' : run.status === 'failed' ? 'red' : 'amber'}>{run.status || 'unknown'}</StatusBadge></Link>)}
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </div>
  )
}
