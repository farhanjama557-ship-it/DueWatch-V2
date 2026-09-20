import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { loadReportsSourceData } from '../lib/reports/reportDataSource'
import { buildReportsReadModel } from '../lib/reports/reportReadModel'
import { buildReportCsv, reportExportFilename } from '../lib/reports/reportExport'
import {
  deleteReportView,
  findCollectionTarget,
  loadReportPreferences,
  saveCollectionTarget,
  saveReportView,
} from '../lib/reports/reportPreferences'
import {
  deleteReportSchedule,
  loadReportSchedules,
  saveReportSchedule,
  setReportScheduleEnabled,
} from '../lib/reports/reportSchedule'
import './reports.css'

const TABS = [
  { id: 'collections', label: 'Collections' },
  { id: 'aging', label: 'Aging' },
  { id: 'client-risk', label: 'Client Risk' },
  { id: 'promises', label: 'Promise Performance' },
  { id: 'team-activity', label: 'Team Activity' },
]

const SOURCE_LABELS = {
  invoices: 'Invoices',
  payments: 'Payments',
  allocations: 'Payment allocations',
  promises: 'Promise-to-Pay',
  executionClaims: 'Autopilot execution',
  approvals: 'Approvals',
  events: 'Activity evidence',
}

function localDateString(date) {
  const d = new Date(date)
  const offset = d.getTimezoneOffset()
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10)
}

function addOneDay(day) {
  const d = new Date(day + 'T12:00:00')
  d.setDate(d.getDate() + 1)
  return localDateString(d)
}

function defaultPeriod(kind, now = new Date()) {
  const year = now.getFullYear()
  const month = now.getMonth()
  if (kind === 'Quarterly') {
    const quarterMonth = Math.floor(month / 3) * 3
    return {
      startDate: localDateString(new Date(year, quarterMonth, 1)),
      endDate: localDateString(new Date(year, quarterMonth + 3, 1)),
    }
  }
  if (kind === 'Yearly') {
    return {
      startDate: localDateString(new Date(year, 0, 1)),
      endDate: localDateString(new Date(year + 1, 0, 1)),
    }
  }
  return {
    startDate: localDateString(new Date(year, month, 1)),
    endDate: localDateString(new Date(year, month + 1, 1)),
  }
}

function displayStartDate(start) {
  if (!start) return ''
  return new Date(start + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

function displayEndDate(end) {
  if (!end) return ''
  const d = new Date(end + 'T12:00:00')
  d.setDate(d.getDate() - 1)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function moneyFormatter(currency) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0,
    })
  } catch {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
  }
}

function formatMoney(value, currency) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  return moneyFormatter(currency).format(Number(value))
}

function pct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  return String(Math.round(Number(value) * 100)) + '%'
}

function Skeleton({ className = '' }) {
  return <span className={'reports-skeleton ' + className} aria-hidden="true" />
}

function MetricCard({ label, value, support, trend, tone = 'neutral', loading = false, action = null }) {
  return (
    <article className="reports-metric-card">
      <span className="reports-metric-label">{label}</span>
      {loading ? (
        <>
          <Skeleton className="reports-skeleton-value" />
          <Skeleton className="reports-skeleton-copy" />
        </>
      ) : (
        <>
          <strong className="reports-metric-value">{value}</strong>
          <span className={'reports-metric-support reports-tone-' + tone}>{trend || support}</span>
          {action}
        </>
      )}
    </article>
  )
}

function SourceNotice({ sources }) {
  if (!sources.length) return null
  return (
    <div className="reports-source-notice" role="status">
      <span className="reports-source-notice-icon">!</span>
      <div>
        <strong>Some report sources are unavailable.</strong>
        <span>{sources.join(', ')} are withheld from calculations instead of being treated as zero.</span>
      </div>
    </div>
  )
}

function CurrencySelector({ currencies, value, onChange }) {
  if (currencies.length <= 1) {
    return currencies.length === 1 ? <span className="reports-currency-badge">{currencies[0]}</span> : null
  }
  return (
    <label className="reports-compact-select">
      <span className="sr-only">Report currency</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
      </select>
    </label>
  )
}

function CollectionsChart({ series, currency, available }) {
  const values = available ? series.map((point) => point.byCurrency?.[currency]?.amount || 0) : []
  const max = Math.max(...values, 1)

  return (
    <div className="reports-chart-shell" aria-label="Monthly collections chart">
      <div className="reports-chart-y">
        <span>{formatMoney(max, currency)}</span>
        <span>{formatMoney(max / 2, currency)}</span>
        <span>{formatMoney(0, currency)}</span>
      </div>
      <div className="reports-chart-plot">
        {available ? series.map((point, index) => {
          const value = values[index]
          const height = Math.max(3, Math.round((value / max) * 100))
          return (
            <div className="reports-chart-column" key={point.startDate}>
              <div className="reports-chart-bar-wrap">
                <div
                  className="reports-chart-bar"
                  style={{ height: String(height) + '%' }}
                  title={point.label + ': ' + formatMoney(value, currency)}
                />
              </div>
              <span>{point.label}</span>
            </div>
          )
        }) : (
          <div className="reports-chart-unavailable">
            <strong>Collection history unavailable</strong>
            <span>The payment ledger could not be read, so no trend is shown.</span>
          </div>
        )}
      </div>
    </div>
  )
}

const AGING_LABELS = {
  current: 'Current',
  '1_14': '1–14 days',
  '15_30': '15–30 days',
  '31_60': '31–60 days',
  '61_plus': '61+ days',
}

function AgingPanel({ aging, currency, available }) {
  const keys = ['current', '1_14', '15_30', '31_60', '61_plus']
  const values = keys.map((key) => aging?.buckets?.[key]?.byCurrency?.[currency]?.amount || 0)
  const total = values.reduce((sum, value) => sum + value, 0)
  const percentages = values.map((value) => total > 0 ? value / total : 0)
  const swatches = ['#5f8f6a', '#8eaa91', '#d6a042', '#d98253', '#c9534d']
  const stops = []
  let cursor = 0
  percentages.forEach((share, index) => {
    const end = cursor + share * 100
    stops.push(swatches[index] + ' ' + cursor + '% ' + end + '%')
    cursor = end
  })

  return (
    <section className="reports-panel" id="reports-aging">
      <div className="reports-panel-head">
        <div><span className="reports-kicker">Portfolio</span><h2>AR aging breakdown</h2></div>
        <span className="reports-panel-meta">{currency}</span>
      </div>
      {!available ? (
        <div className="reports-unavailable"><strong>Aging unavailable</strong><span>Invoice truth could not be loaded.</span></div>
      ) : (
        <div className="reports-aging-body">
          <div
            className="reports-donut"
            style={{ background: total > 0 ? 'conic-gradient(' + stops.join(',') + ')' : '#efeee9' }}
            aria-label={'Outstanding ' + formatMoney(total, currency)}
          >
            <div className="reports-donut-hole"><span>Outstanding</span><strong>{formatMoney(total, currency)}</strong></div>
          </div>
          <div className="reports-legend-list">
            {keys.map((key, index) => (
              <div className="reports-legend-row" key={key}>
                <span className="reports-legend-dot" style={{ background: swatches[index] }} />
                <span>{AGING_LABELS[key]}</span>
                <strong>{formatMoney(values[index], currency)}</strong>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function PromisePanel({ summary, currency, available }) {
  const rows = [
    ['Needs confirmation', 'needs_confirmation'],
    ['Future', 'future'],
    ['Due soon', 'due_soon'],
    ['Due today', 'due_today'],
    ['Past due unresolved', 'past_due_unresolved'],
  ]
  return (
    <section className="reports-panel" id="reports-promises">
      <div className="reports-panel-head">
        <div><span className="reports-kicker">Promise-to-Pay</span><h2>Promise timing</h2></div>
        <span className="reports-panel-meta">Evidence-bound</span>
      </div>
      {!available ? (
        <div className="reports-unavailable">
          <strong>Promise reporting is not connected yet</strong>
          <span>DueWatch will not fabricate fulfilled or broken promises from missing lifecycle data.</span>
        </div>
      ) : (
        <div className="reports-promise-list">
          {rows.map(([label, key]) => {
            const state = summary.states[key]
            return (
              <div className="reports-promise-row" key={key}>
                <span>{label}</span>
                <strong>{state.promiseCount}</strong>
                <span>{formatMoney(state.byCurrency?.[currency]?.amount || 0, currency)}</span>
              </div>
            )
          })}
          {!summary.capabilities.fulfilledState && (
            <p className="reports-proof-note">Fulfillment and broken-promise rates remain hidden until terminal Promise-to-Pay evidence exists.</p>
          )}
        </div>
      )}
    </section>
  )
}

function ClientImprovementTable({ rows, currency, available }) {
  const ranked = available ? rows
    .map((row) => ({ ...row, metric: row.comparisonByCurrency?.[currency] }))
    .filter((row) => row.metric && row.metric.previousAmount > 0 && row.metric.relativeChange !== null)
    .sort((a, b) => b.metric.relativeChange - a.metric.relativeChange)
    .slice(0, 5) : []

  return (
    <section className="reports-panel reports-table-panel">
      <div className="reports-panel-head">
        <div><span className="reports-kicker">Collections</span><h2>Top improving clients</h2></div>
        <span className="reports-panel-meta">vs prior period</span>
      </div>
      {!available ? <div className="reports-unavailable compact">Payment allocations unavailable.</div> :
        ranked.length === 0 ? <div className="reports-empty compact">No comparable client collection history yet.</div> : (
          <div className="reports-table">
            <div className="reports-table-row reports-table-head"><span>Client</span><span>Collected</span><span>Prior</span><span>Change</span></div>
            {ranked.map((row) => (
              <div className="reports-table-row" key={row.clientId || row.clientName}>
                <strong>{row.clientName}</strong>
                <span>{formatMoney(row.metric.currentAmount, currency)}</span>
                <span>{formatMoney(row.metric.previousAmount, currency)}</span>
                <span className={row.metric.relativeChange >= 0 ? 'reports-positive' : 'reports-negative'}>
                  {(row.metric.relativeChange >= 0 ? '+' : '') + pct(row.metric.relativeChange)}
                </span>
              </div>
            ))}
          </div>
        )}
    </section>
  )
}

function RiskTable({ rows, currency, available }) {
  const ranked = available ? rows
    .map((row) => ({ ...row, displayAmount: row.overdueByCurrency?.[currency]?.amount || 0 }))
    .filter((row) => row.displayAmount > 0)
    .sort((a, b) => b.displayAmount - a.displayAmount || b.maxDaysOverdue - a.maxDaysOverdue)
    .slice(0, 5) : []

  return (
    <section className="reports-panel reports-table-panel" id="reports-client-risk">
      <div className="reports-panel-head">
        <div><span className="reports-kicker">Risk</span><h2>Highest overdue exposure</h2></div>
        <span className="reports-panel-meta">by overdue balance</span>
      </div>
      {!available ? <div className="reports-unavailable compact">Invoice exposure unavailable.</div> :
        ranked.length === 0 ? <div className="reports-empty compact">No overdue exposure in {currency}.</div> : (
          <div className="reports-table reports-risk-table">
            <div className="reports-table-row reports-table-head"><span>Client</span><span>Overdue</span><span>Invoices</span><span>Oldest</span></div>
            {ranked.map((row) => (
              <div className="reports-table-row" key={row.clientId || row.clientName}>
                <strong>{row.clientName}</strong>
                <span>{formatMoney(row.displayAmount, currency)}</span>
                <span>{row.overdueInvoiceCount}</span>
                <span className={row.maxDaysOverdue >= 31 ? 'reports-negative' : ''}>{row.maxDaysOverdue}d</span>
              </div>
            ))}
          </div>
        )}
    </section>
  )
}

function OperationsPanel({ operations, executionAvailable, approvalsAvailable, eventsAvailable }) {
  const statuses = [
    ['Provider accepted', operations.execution.byStatus.sent],
    ['Failed', operations.execution.byStatus.send_failed],
    ['Uncertain', operations.execution.byStatus.uncertain],
    ['In flight', operations.execution.byStatus.in_flight],
  ]
  return (
    <section className="reports-panel reports-operations" id="reports-team-activity">
      <div className="reports-panel-head">
        <div><span className="reports-kicker">DW operations</span><h2>Execution & founder review</h2></div>
        <span className="reports-panel-meta">current period</span>
      </div>
      <div className="reports-operation-grid">
        <div><span>Execution receipts</span><strong>{executionAvailable ? operations.execution.claimCount : '—'}</strong><small>{executionAvailable ? 'Canonical Autopilot claims' : 'Source unavailable'}</small></div>
        <div><span>Approvals requested</span><strong>{approvalsAvailable ? operations.approvals.requestCount : '—'}</strong><small>{approvalsAvailable ? String(operations.approvals.byStatus.pending) + ' pending' : 'Source unavailable'}</small></div>
        <div><span>Activity evidence</span><strong>{eventsAvailable ? operations.activity.eventCount : '—'}</strong><small>{eventsAvailable ? 'Persisted events' : 'Source unavailable'}</small></div>
      </div>
      {executionAvailable && (
        <div className="reports-status-strip">
          {statuses.map(([label, value]) => <span key={label}><b>{value}</b>{label}</span>)}
        </div>
      )}
      <p className="reports-proof-note">“Provider accepted” is not treated as delivery, reading, payment, or proof that an Autopilot action caused collection.</p>
    </section>
  )
}

function InsightsRail({ model, currency, sourceUnavailable, configuredTarget }) {
  const collection = model.collections?.comparisonByCurrency?.[currency]
  return (
    <aside className="reports-insights">
      <div className="reports-insights-head">
        <span className="reports-insights-mark">DW</span>
        <div><strong>DW Report Insights</strong><span>Grounded report analysis</span></div>
      </div>
      {collection && collection.previousAmount > 0 && (
        <div className={'reports-insight-hero ' + (collection.relativeChange >= 0 ? 'positive' : 'attention')}>
          <span>{collection.relativeChange >= 0 ? '↗' : '↘'}</span>
          <div>
            <strong>Collections are {collection.relativeChange >= 0 ? 'up' : 'down'} {Math.abs(Math.round(collection.relativeChange * 100))}%</strong>
            <p>{formatMoney(collection.currentAmount, currency)} this period versus {formatMoney(collection.previousAmount, currency)} previously.</p>
          </div>
        </div>
      )}
      <section className="reports-insight-section">
        <h3>Key takeaways</h3>
        {model.insights.length ? model.insights.map((insight) => (
          <article className="reports-insight-row" key={insight.id}>
            <span className={'reports-insight-dot ' + insight.kind} />
            <div>
              <strong>{insight.title}</strong>
              <p>{insight.detail}</p>
              <small>{insight.evidence.type.replaceAll('_', ' ')}</small>
            </div>
          </article>
        )) : <p className="reports-insights-empty">No evidence-backed changes to call out for this period.</p>}
      </section>
      <section className="reports-insight-section">
        <h3>Proof boundaries</h3>
        <div className="reports-boundary-list">
          <span><b>Collection target</b> {configuredTarget ? formatMoney(configuredTarget, currency) : 'Not configured'}</span>
          <span><b>Collection rate</b> Historical denominator not proven</span>
          <span><b>PTP fulfillment</b> Terminal lifecycle not proven</span>
          <span><b>Autopilot ROI</b> Causal attribution not proven</span>
        </div>
      </section>
      {sourceUnavailable.length > 0 && (
        <section className="reports-insight-section">
          <h3>Unavailable sources</h3>
          <p className="reports-insights-empty">{sourceUnavailable.join(', ')}. DueWatch withheld dependent metrics rather than substituting zero.</p>
        </section>
      )}
    </aside>
  )
}

function ReportsLoading() {
  return (
    <div className="reports-page reports-loading" aria-busy="true" aria-label="Loading reports">
      <div className="reports-header"><div><Skeleton className="reports-skeleton-title" /><Skeleton className="reports-skeleton-subtitle" /></div></div>
      <div className="reports-metric-grid">{[1, 2, 3, 4].map((key) => <MetricCard key={key} loading />)}</div>
      <div className="reports-loading-grid"><Skeleton className="reports-skeleton-panel large" /><Skeleton className="reports-skeleton-panel rail" /></div>
    </div>
  )
}

export default function Reports() {
  const { user } = useAuth()
  const [source, setSource] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [cadence, setCadence] = useState('Monthly')
  const initialPeriod = useMemo(() => defaultPeriod('Monthly'), [])
  const [startDate, setStartDate] = useState(initialPeriod.startDate)
  const [endDate, setEndDate] = useState(initialPeriod.endDate)
  const [activeTab, setActiveTab] = useState('collections')
  const [selectedCurrency, setSelectedCurrency] = useState('')
  const [scheduleMessage, setScheduleMessage] = useState(false)
  const [schedules, setSchedules] = useState(null)
  const [scheduleError, setScheduleError] = useState(null)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [scheduleName, setScheduleName] = useState('')
  const [scheduleEmail, setScheduleEmail] = useState('')
  const [scheduleCadence, setScheduleCadence] = useState('weekly')
  const [scheduleWeekday, setScheduleWeekday] = useState(1)
  const [scheduleDayOfMonth, setScheduleDayOfMonth] = useState(1)
  const [scheduleHour, setScheduleHour] = useState(8)
  const [scheduleTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  )
  const [preferences, setPreferences] = useState(null)
  const [preferenceError, setPreferenceError] = useState(null)
  const [showSaveView, setShowSaveView] = useState(false)
  const [viewName, setViewName] = useState('')
  const [showTargetEditor, setShowTargetEditor] = useState(false)
  const [targetAmount, setTargetAmount] = useState('')
  const [savingPreference, setSavingPreference] = useState(false)

  useEffect(() => {
    let active = true
    if (!user?.id) return undefined
    setLoading(true)
    setLoadError(null)
    loadReportsSourceData({ database: supabase, userId: user.id })
      .then((result) => {
        if (!active) return
        setSource(result)
        setLoading(false)
      })
      .catch((error) => {
        if (!active) return
        setLoadError(error instanceof Error ? error.message : String(error))
        setLoading(false)
      })
    return () => { active = false }
  }, [user?.id])

  useEffect(() => {
    let active = true
    if (!user?.id) return undefined
    setPreferenceError(null)
    loadReportPreferences({ database: supabase, userId: user.id })
      .then((result) => {
        if (!active) return
        setPreferences(result)
      })
      .catch((error) => {
        if (!active) return
        setPreferenceError(error instanceof Error ? error.message : String(error))
      })
    return () => { active = false }
  }, [user?.id])

  useEffect(() => {
    if (user?.email && !scheduleEmail) setScheduleEmail(user.email)
  }, [user?.email, scheduleEmail])

  useEffect(() => {
    let active = true
    if (!user?.id) return undefined
    setScheduleError(null)
    loadReportSchedules({ database: supabase, userId: user.id })
      .then((result) => {
        if (!active) return
        setSchedules(result)
      })
      .catch((error) => {
        if (!active) return
        setScheduleError(error instanceof Error ? error.message : String(error))
      })
    return () => { active = false }
  }, [user?.id])

  const model = useMemo(() => {
    if (!source) return null
    return buildReportsReadModel({
      invoices: source.invoices.rows,
      invoicesAvailable: source.invoices.available,
      payments: source.payments.rows,
      paymentsAvailable: source.payments.available,
      allocations: source.allocations.rows,
      allocationsAvailable: source.allocations.available,
      promises: source.promises.rows,
      promisesAvailable: source.promises.available,
      executionClaims: source.executionClaims.rows,
      executionClaimsAvailable: source.executionClaims.available,
      approvals: source.approvals.rows,
      approvalsAvailable: source.approvals.available,
      events: source.events.rows,
      eventsAvailable: source.events.available,
      asOf: new Date(),
      startDate,
      endDate,
    })
  }, [source, startDate, endDate])

  const currencies = useMemo(() => {
    if (!model) return []
    return Array.from(new Set([
      ...Object.keys(model.collections?.current?.byCurrency || {}),
      ...Object.keys(model.aging?.outstanding?.byCurrency || {}),
    ])).sort()
  }, [model])

  useEffect(() => {
    if (!currencies.length) {
      setSelectedCurrency('')
      return
    }
    if (!currencies.includes(selectedCurrency)) setSelectedCurrency(currencies[0])
  }, [currencies, selectedCurrency])

  const unavailable = useMemo(() => {
    if (!source) return []
    return Object.entries(source)
      .filter(([, value]) => value?.available === false)
      .map(([key]) => SOURCE_LABELS[key] || key)
  }, [source])

  function changeCadence(next) {
    setCadence(next)
    const nextPeriod = defaultPeriod(next)
    setStartDate(nextPeriod.startDate)
    setEndDate(nextPeriod.endDate)
  }

  function selectTab(tabId) {
    setActiveTab(tabId)
    const targets = {
      collections: 'reports-collections',
      aging: 'reports-aging',
      'client-risk': 'reports-client-risk',
      promises: 'reports-promises',
      'team-activity': 'reports-team-activity',
    }
    requestAnimationFrame(() => {
      const target = document.getElementById(targets[tabId])
      if (!target) return
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    })
  }

  function exportCsv() {
    if (!model) return
    const csv = buildReportCsv(model, { currency })
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = reportExportFilename(model)
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  async function reloadPreferences() {
    if (!user?.id) return
    const result = await loadReportPreferences({ database: supabase, userId: user.id })
    setPreferences(result)
  }

  async function handleSaveView() {
    if (!user?.id || !viewName.trim()) return
    setSavingPreference(true)
    setPreferenceError(null)
    try {
      await saveReportView({
        database: supabase,
        input: {
          userId: user.id,
          name: viewName,
          cadence,
          startDate,
          endDate,
          currency: selectedCurrency || null,
          activeTab,
          filters: {},
        },
      })
      await reloadPreferences()
      setViewName('')
      setShowSaveView(false)
    } catch (error) {
      setPreferenceError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingPreference(false)
    }
  }

  async function handleDeleteView(id) {
    if (!user?.id || !id) return
    setSavingPreference(true)
    setPreferenceError(null)
    try {
      await deleteReportView({ database: supabase, userId: user.id, id })
      await reloadPreferences()
    } catch (error) {
      setPreferenceError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingPreference(false)
    }
  }

  function applySavedView(view) {
    setCadence(view.cadence)
    setStartDate(view.start_date)
    setEndDate(view.end_date)
    if (view.currency) setSelectedCurrency(view.currency)
    setActiveTab(view.active_tab || 'collections')
  }

  async function handleSaveTarget(currency) {
    if (!user?.id || !currency || !targetAmount) return
    setSavingPreference(true)
    setPreferenceError(null)
    try {
      await saveCollectionTarget({
        database: supabase,
        input: {
          userId: user.id,
          startDate,
          endDate,
          currency,
          targetAmount,
        },
      })
      await reloadPreferences()
      setTargetAmount('')
      setShowTargetEditor(false)
    } catch (error) {
      setPreferenceError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingPreference(false)
    }
  }

  async function reloadSchedules() {
    if (!user?.id) return
    const result = await loadReportSchedules({ database: supabase, userId: user.id })
    setSchedules(result)
  }

  async function handleSaveSchedule() {
    if (!user?.id) return
    setSavingSchedule(true)
    setScheduleError(null)
    try {
      await saveReportSchedule({
        database: supabase,
        input: {
          userId: user.id,
          name: scheduleName,
          recipientEmail: scheduleEmail,
          cadence: scheduleCadence,
          weekday: scheduleCadence === 'weekly' ? Number(scheduleWeekday) : null,
          dayOfMonth: scheduleCadence === 'monthly' ? Number(scheduleDayOfMonth) : null,
          localHour: Number(scheduleHour),
          timezone: scheduleTimezone,
          currency: selectedCurrency || null,
          activeTab,
          filters: {},
        },
      })
      await reloadSchedules()
      setScheduleName('')
      setScheduleMessage(false)
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingSchedule(false)
    }
  }

  async function handleDeleteSchedule(id) {
    if (!user?.id || !id) return
    setSavingSchedule(true)
    setScheduleError(null)
    try {
      await deleteReportSchedule({ database: supabase, userId: user.id, id })
      await reloadSchedules()
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingSchedule(false)
    }
  }

  async function handleToggleSchedule(schedule) {
    if (!user?.id || !schedule?.id) return
    setSavingSchedule(true)
    setScheduleError(null)
    try {
      await setReportScheduleEnabled({
        database: supabase,
        userId: user.id,
        id: schedule.id,
        enabled: !schedule.enabled,
      })
      await reloadSchedules()
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingSchedule(false)
    }
  }

  function printReport() {
    window.print()
  }

  if (loading) return <ReportsLoading />
  if (loadError || !model) {
    return (
      <div className="reports-page">
        <div className="reports-fatal-error">
          <strong>Reports could not be loaded.</strong>
          <span>{loadError || 'No report model was produced.'}</span>
          <button type="button" onClick={() => window.location.reload()}>Retry</button>
        </div>
      </div>
    )
  }

  const currency = selectedCurrency || currencies[0] || 'USD'
  const collection = model.collections.comparisonByCurrency?.[currency]
  const collectionCurrent = model.collections.current.byCurrency?.[currency]
  const collectionTrend = collection?.relativeChange === null || collection?.relativeChange === undefined
    ? null
    : (collection.relativeChange >= 0 ? '↑ ' : '↓ ') + Math.abs(Math.round(collection.relativeChange * 100)) + '% vs prior period'
  const target = preferences?.targets?.available
    ? findCollectionTarget(preferences.targets.rows, { startDate, endDate, currency })
    : null
  const configuredTarget = target ? Number(target.target_amount) : null
  const targetAttainment =
    configuredTarget && collectionCurrent
      ? Number(collectionCurrent.amount || 0) / configuredTarget
      : null
  const savedViewsAvailable = preferences?.savedViews?.available === true
  const targetsAvailable = preferences?.targets?.available === true

  return (
    <div className="reports-page">
      <header className="reports-header">
        <div>
          <h1>Reports</h1>
          <p>Analyze collections performance, cash trends, operational output, and portfolio risk.</p>
        </div>
        <div className="reports-header-actions">
          <label className="reports-date-control"><span>From</span><input type="date" value={startDate} max={endDate} onChange={(e) => {
            const nextStart = e.target.value
            setCadence('Custom')
            setStartDate(nextStart)
            if (nextStart >= endDate) setEndDate(addOneDay(nextStart))
          }} /></label>
          <label className="reports-date-control"><span>To</span><input type="date" value={endDate} min={addOneDay(startDate)} onChange={(e) => {
            const nextEnd = e.target.value
            setCadence('Custom')
            setEndDate(nextEnd <= startDate ? addOneDay(startDate) : nextEnd)
          }} /></label>
          <label className="reports-cadence">
            <span className="sr-only">Report cadence</span>
            <select value={cadence} onChange={(e) => changeCadence(e.target.value)}>
              <option>Monthly</option><option>Quarterly</option><option>Yearly</option><option disabled value="Custom">Custom</option>
            </select>
          </label>
          <button
            className="reports-btn reports-btn-secondary"
            type="button"
            onClick={() => setShowSaveView((value) => !value)}
            disabled={!savedViewsAvailable || savingPreference}
            title={savedViewsAvailable ? 'Save this report view' : 'Saved views storage is unavailable'}
          >
            Save view
          </button>
          <button className="reports-btn reports-btn-secondary" type="button" onClick={printReport}>Print / PDF</button>
          <button className="reports-btn reports-btn-secondary" type="button" onClick={exportCsv}>Export CSV</button>
          <button className="reports-btn reports-btn-primary" type="button" onClick={() => setScheduleMessage((value) => !value)} aria-expanded={scheduleMessage}>Schedule report</button>
        </div>
      </header>

      {scheduleMessage && (
        <section className="reports-schedule-editor" aria-label="Schedule report">
          <div className="reports-schedule-editor-copy">
            <strong>Schedule recurring report</strong>
            <span>
              Sends the previous complete {scheduleCadence === 'weekly' ? 'week' : 'month'} as a CSV attachment.
              Times use {scheduleTimezone}.
            </span>
          </div>
          <label>
            <span>Name</span>
            <input value={scheduleName} onChange={(e) => setScheduleName(e.target.value)} placeholder="Weekly CFO report" maxLength={80} />
          </label>
          <label>
            <span>Recipient</span>
            <input type="email" value={scheduleEmail} onChange={(e) => setScheduleEmail(e.target.value)} placeholder="finance@example.com" />
          </label>
          <label>
            <span>Cadence</span>
            <select value={scheduleCadence} onChange={(e) => setScheduleCadence(e.target.value)}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          {scheduleCadence === 'weekly' ? (
            <label>
              <span>Day</span>
              <select value={scheduleWeekday} onChange={(e) => setScheduleWeekday(Number(e.target.value))}>
                <option value={1}>Monday</option>
                <option value={2}>Tuesday</option>
                <option value={3}>Wednesday</option>
                <option value={4}>Thursday</option>
                <option value={5}>Friday</option>
                <option value={6}>Saturday</option>
                <option value={0}>Sunday</option>
              </select>
            </label>
          ) : (
            <label>
              <span>Day of month</span>
              <select value={scheduleDayOfMonth} onChange={(e) => setScheduleDayOfMonth(Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                  <option key={day} value={day}>{day}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>Hour</span>
            <select value={scheduleHour} onChange={(e) => setScheduleHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, hour) => hour).map((hour) => (
                <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>
              ))}
            </select>
          </label>
          <div className="reports-schedule-actions">
            <button type="button" onClick={handleSaveSchedule} disabled={savingSchedule || !scheduleName.trim() || !scheduleEmail.trim()}>
              {savingSchedule ? 'Saving…' : 'Save schedule'}
            </button>
            <button type="button" className="quiet" onClick={() => setScheduleMessage(false)}>Cancel</button>
          </div>
        </section>
      )}

      {showSaveView && savedViewsAvailable && (
        <div className="reports-config-panel">
          <div>
            <strong>Save current view</strong>
            <span>Stores the period, cadence, currency, and active section.</span>
          </div>
          <input
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            placeholder="e.g. Monthly close"
            maxLength={80}
            autoFocus
          />
          <button type="button" onClick={handleSaveView} disabled={!viewName.trim() || savingPreference}>
            {savingPreference ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="quiet" onClick={() => setShowSaveView(false)}>Cancel</button>
        </div>
      )}

      {showTargetEditor && targetsAvailable && (
        <div className="reports-config-panel">
          <div>
            <strong>Set collection target · {currency}</strong>
            <span>{displayStartDate(startDate)} – {displayEndDate(endDate)}</span>
          </div>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={targetAmount}
            onChange={(e) => setTargetAmount(e.target.value)}
            placeholder="Target amount"
            autoFocus
          />
          <button type="button" onClick={() => handleSaveTarget(currency)} disabled={!targetAmount || savingPreference}>
            {savingPreference ? 'Saving…' : 'Save target'}
          </button>
          <button type="button" className="quiet" onClick={() => setShowTargetEditor(false)}>Cancel</button>
        </div>
      )}

      {preferenceError && (
        <div className="reports-preference-error" role="alert">{preferenceError}</div>
      )}
      {scheduleError && (
        <div className="reports-preference-error" role="alert">{scheduleError}</div>
      )}

      {schedules?.schedules?.available && schedules.schedules.rows.length > 0 && (
        <section className="reports-schedule-list" aria-label="Scheduled reports">
          <div className="reports-schedule-list-title">
            <strong>Scheduled reports</strong>
            <span>{schedules.schedules.rows.length} configured</span>
          </div>
          {schedules.schedules.rows.map((schedule) => {
            const lastRun = schedules?.runs?.rows?.find((run) => run.schedule_id === schedule.id)
            return (
              <div className="reports-schedule-row" key={schedule.id}>
                <div>
                  <strong>{schedule.name}</strong>
                  <span>
                    {schedule.recipient_email} · {schedule.cadence} · {schedule.timezone}
                  </span>
                </div>
                <span className={'reports-schedule-status ' + (schedule.enabled ? 'enabled' : 'disabled')}>
                  {schedule.enabled ? 'Active' : 'Paused'}
                </span>
                <span>
                  Next {new Date(schedule.next_run_at).toLocaleString()}
                  {lastRun ? ' · last ' + lastRun.status : ''}
                </span>
                <button type="button" onClick={() => handleToggleSchedule(schedule)} disabled={savingSchedule}>
                  {schedule.enabled ? 'Pause' : 'Resume'}
                </button>
                <button type="button" className="delete" onClick={() => handleDeleteSchedule(schedule.id)} disabled={savingSchedule}>
                  Delete
                </button>
              </div>
            )
          })}
        </section>
      )}

      <SourceNotice sources={unavailable} />

      {savedViewsAvailable && preferences.savedViews.rows.length > 0 && (
        <div className="reports-saved-views" aria-label="Saved report views">
          <span>Saved views</span>
          {preferences.savedViews.rows.map((view) => (
            <div className="reports-saved-view" key={view.id}>
              <button type="button" onClick={() => applySavedView(view)}>{view.name}</button>
              <button type="button" className="delete" aria-label={'Delete ' + view.name} onClick={() => handleDeleteView(view.id)}>×</button>
            </div>
          ))}
        </div>
      )}
      <div className="reports-period-line">
        <span>{displayStartDate(startDate)} – {displayEndDate(endDate)}</span>
        <CurrencySelector currencies={currencies} value={currency} onChange={setSelectedCurrency} />
      </div>

      <nav className="reports-tabs" aria-label="Report sections">
        {TABS.map((tab) => <button key={tab.id} type="button" className={activeTab === tab.id ? 'active' : ''} onClick={() => selectTab(tab.id)}>{tab.label}</button>)}
      </nav>

      <section className="reports-metric-grid" id="reports-collections">
        <MetricCard
          label="Total collections"
          value={model.availability.collections ? formatMoney(collectionCurrent?.amount || 0, currency) : '—'}
          trend={model.availability.collections ? collectionTrend : null}
          support={model.availability.collections ? String(collectionCurrent?.paymentCount || 0) + ' payments' : 'Payment ledger unavailable'}
          tone={collection?.relativeChange >= 0 ? 'positive' : collection?.relativeChange < 0 ? 'attention' : 'neutral'}
        />
        <MetricCard
          label="Collection target"
          value={configuredTarget ? formatMoney(configuredTarget, currency) : targetsAvailable ? 'Not configured' : '—'}
          support={
            configuredTarget
              ? (targetAttainment === null ? 'Explicit founder target' : pct(targetAttainment) + ' attained')
              : targetsAvailable ? 'No target set for this period' : 'Target storage unavailable'
          }
          tone={targetAttainment !== null && targetAttainment >= 1 ? 'positive' : 'neutral'}
          action={
            targetsAvailable ? (
              <button className="reports-card-action" type="button" onClick={() => setShowTargetEditor((value) => !value)}>
                {configuredTarget ? 'Edit target' : 'Set target'}
              </button>
            ) : null
          }
        />
        <MetricCard
          label="Collected invoices"
          value={model.availability.collectedInvoices ? model.collectedInvoices.collectedInvoiceCount : '—'}
          support={model.availability.collectedInvoices ? 'From payment allocations' : 'Allocation data unavailable'}
          tone="positive"
        />
        <MetricCard label="Collection rate" value="—" support="Historical denominator not proven" />
      </section>

      <div className="reports-layout">
        <main className="reports-main">
          <section className="reports-panel reports-chart-panel">
            <div className="reports-panel-head">
              <div><span className="reports-kicker">Trend</span><h2>Monthly collections</h2></div>
              <div className="reports-chart-legend">
                <span><i className="collections" />Collections</span>
                <span className={configuredTarget ? '' : 'muted'}><i />{configuredTarget ? 'Target ' + formatMoney(configuredTarget, currency) : 'Target not configured'}</span>
              </div>
            </div>
            <CollectionsChart series={model.monthlyCollections} currency={currency} available={model.availability.collections} />
          </section>

          <div className="reports-two-col">
            <AgingPanel aging={model.aging} currency={currency} available={model.availability.aging} />
            <PromisePanel summary={model.promises} currency={currency} available={model.availability.promiseCurrentState} />
          </div>

          <OperationsPanel
            operations={model.operations}
            executionAvailable={model.availability.operationalExecution}
            approvalsAvailable={model.availability.operationalApprovals}
            eventsAvailable={model.availability.activityEvidence}
          />

          <div className="reports-two-col">
            <ClientImprovementTable rows={model.clientCollections} currency={currency} available={model.availability.clientCollections} />
            <RiskTable rows={model.clientExposure} currency={currency} available={model.availability.clientExposure} />
          </div>
        </main>
        <InsightsRail
          model={model}
          currency={currency}
          sourceUnavailable={unavailable}
          configuredTarget={configuredTarget}
        />
      </div>
    </div>
  )
}
