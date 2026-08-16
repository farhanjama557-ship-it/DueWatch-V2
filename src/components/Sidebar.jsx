import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import PresenceIndicator from '../features/PresenceIndicator'
import { usePresenceContext } from '../features/PresenceSystem'
import { activityMeta, activityDescription } from '../lib/activity'
import { initials, timeAgo } from '../lib/format'
import {
  PulseIcon,
  InvoicesIcon,
  ClientsIcon,
  CashFlowIcon,
  SparkleIcon,
  ActivityIcon,
  SettingsIcon,
  LogoMark,
} from './icons'

// Autopilot's nav icon is SparkleIcon — the exact same icon the Autopilot
// page itself uses in its own header (src/pages/Autopilot.jsx's pitch
// step), not a separate invented glyph.
const mainNav = [
  { to: '/', label: 'Pulse', Icon: PulseIcon, end: true },
  { to: '/invoices', label: 'Invoices', Icon: InvoicesIcon, badge: true },
  { to: '/clients', label: 'Clients', Icon: ClientsIcon },
  { to: '/cash-flow', label: 'Cash Flow', Icon: CashFlowIcon },
  { to: '/autopilot', label: 'Autopilot', Icon: SparkleIcon },
  { to: '/activity', label: 'Activity', Icon: ActivityIcon },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon },
]

function NavItem({ to, label, Icon, end, badge, overdueCount }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
      <Icon className="nav-icon" />
      <span className="nav-label">{label}</span>
      {badge && overdueCount > 0 && <span className="nav-badge">{overdueCount}</span>}
    </NavLink>
  )
}

// "Evidence" sidebar card — real all-time action count + real last event,
// same data source as the dark rail's Evidence panel, just the compact
// sidebar-footer treatment from the north-star mockup.
function EvidenceCard({ totalEventsCount, lastEvent }) {
  return (
    <div className="sidebar-card">
      <div className="sidebar-card-title">Evidence</div>
      <p className="sidebar-card-line">{totalEventsCount} actions recorded</p>
      {lastEvent && (
        <p className="sidebar-card-meta">
          Last: {activityMeta(lastEvent.event_type).title.toLowerCase()}
          {activityDescription(lastEvent) ? ` — ${activityDescription(lastEvent)}` : ''}
          {' · '}
          {timeAgo(lastEvent.created_at)}
        </p>
      )}
      <NavLink to="/activity" className="sidebar-card-link">
        View activity
      </NavLink>
    </div>
  )
}

export default function Sidebar() {
  const { user } = useAuth()
  const { name, overdueCount, events, totalEventsCount } = useData()
  const { state, srText } = usePresenceContext()

  const email = user?.email ?? ''
  const displayName = name || email.split('@')[0] || 'Account'

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <LogoMark />
        <div className="sidebar-brand-text">
          <span className="sidebar-brand-name">Duewatch</span>
          <span className="sidebar-brand-subtitle">Accounts Receivable Employee</span>
        </div>
        <span className={`sidebar-status-dot status-${state}`} aria-hidden="true" />
        <span className="sr-only">{srText}</span>
      </div>

      <nav className="sidebar-nav">
        {mainNav.map((item) => <NavItem key={item.to} {...item} overdueCount={overdueCount} />)}
      </nav>

      <PresenceIndicator />
      <EvidenceCard totalEventsCount={totalEventsCount} lastEvent={events[0]} />

      <div className="sidebar-profile">
        <span className="profile-avatar">{initials(displayName)}</span>
        <div className="profile-meta">
          <span className="profile-name">{displayName}</span>
          <span className="profile-tier">Early Access</span>
        </div>
      </div>
    </aside>
  )
}
