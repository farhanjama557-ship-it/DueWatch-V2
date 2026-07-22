import { useEffect, useMemo, useState } from 'react'
import { Bot } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { SearchIcon } from '../components/icons'
import { formatEventDate } from '../lib/format'
import {
  activityMeta,
  activityDescription,
  activityIcon,
  activityWhy,
  activityApprovedBy,
} from '../lib/activity'

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'payments', label: 'Payments' },
  { key: 'invoices', label: 'Invoices' },
]

export default function Activity() {
  const { user } = useAuth()
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoading(true)
    supabase
      .from('events')
      .select('id, event_type, invoice_id, created_at, invoices(inv_num, clients(name))')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) {
          setError(err.message)
        } else {
          setEvents(data || [])
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return events.filter((e) => {
      const meta = activityMeta(e.event_type)
      if (tab !== 'all' && meta.group !== tab) return false
      if (!q) return true
      const desc = activityDescription(e).toLowerCase()
      return desc.includes(q)
    })
  }, [events, tab, search])

  return (
    <div className="brief">
      <h1 className="brief-greeting">Activity Log</h1>
      <p className="brief-subline">Everything you and Duewatch have done.</p>

      <div className="list-controls">
        <div className="tabs">
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
          <p className="brief-empty list-pad">Loading activity…</p>
        ) : error ? (
          <p className="brief-error list-pad">Couldn&apos;t load activity: {error}</p>
        ) : rows.length === 0 ? (
          <p className="brief-empty list-pad">
            {events.length === 0
              ? 'Nothing here yet. Actions you and Duewatch take will appear here.'
              : 'Nothing matches this view.'}
          </p>
        ) : (
          <ul className="activity-timeline">
            {rows.map((e) => {
              const meta = activityMeta(e.event_type)
              const desc = activityDescription(e)
              const why = activityWhy(e)
              const approvedBy = activityApprovedBy(e)
              const { Icon, size, color } = activityIcon(e)
              return (
                <li key={e.id} className="activity-item">
                  <span className="activity-icon-wrap" aria-hidden="true">
                    <Icon size={size} color={color} />
                  </span>
                  <div className="activity-main">
                    <span className="activity-title">{meta.title}</span>
                    {desc && <span className="activity-desc">{desc}</span>}
                    {why && <span className="activity-why">{why}</span>}
                    {approvedBy && (
                      <span className="activity-approved">Approved by: {approvedBy}</span>
                    )}
                  </div>
                  <span className="activity-actor">
                    {meta.actor === 'Duewatch' && <Bot size={12} />} {meta.actor}
                  </span>
                  <span className="activity-time">{formatEventDate(e.created_at)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
