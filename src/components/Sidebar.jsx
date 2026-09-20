import { NavLink } from 'react-router-dom'
import { CircleHelp, LogOut, CalendarCheck2, Workflow, ChevronDown } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { initials } from '../lib/format'
import {
  PulseIcon,
  InvoicesIcon,
  ClientsIcon,
  CashFlowIcon,
  SparkleIcon,
  ActivityIcon,
  ReportsIcon,
  SettingsIcon,
  LogoMark,
} from './icons'

const mainNav = [
  { to: '/', label: 'Pulse', Icon: PulseIcon, end: true },
  { to: '/invoices', label: 'Invoices', Icon: InvoicesIcon, badge: true },
  { to: '/clients', label: 'Clients', Icon: ClientsIcon },
  { to: '/promise-to-pay', label: 'Promise-to-Pay', Icon: CalendarCheck2 },
  { to: '/cash-flow', label: 'Cash Flow', Icon: CashFlowIcon },
  { to: '/autopilot', label: 'Autopilot', Icon: SparkleIcon },
  { to: '/activity', label: 'Activity', Icon: ActivityIcon },
  { to: '/reports', label: 'Reports', Icon: ReportsIcon },
  { to: '/integrations', label: 'Integrations', Icon: Workflow },
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

export default function Sidebar() {
  const { user, signOut } = useAuth()
  const { name, overdueCount } = useData()

  const email = user?.email ?? ''
  const metadataName = (user?.user_metadata?.full_name || '').trim()
  const displayName = metadataName || name || email.split('@')[0] || 'Account'
  const organization =
    user?.user_metadata?.company ||
    user?.user_metadata?.organization ||
    user?.user_metadata?.workspace ||
    'Workspace'

  return (
    <aside className="sidebar canonical-sidebar">
      <div className="sidebar-brand">
        <LogoMark className="canonical-logo-mark" />
        <div className="sidebar-brand-text">
          <span className="sidebar-brand-name">DueWatch</span>
          <span className="sidebar-brand-subtitle">{organization}</span>
        </div>
      </div>

      <nav className="sidebar-nav">
        {mainNav.map((item) => (
          <NavItem key={item.to} {...item} overdueCount={overdueCount} />
        ))}
      </nav>

      <div className="canonical-sidebar-bottom">
        <div className="sidebar-profile">
          <span className="profile-avatar">{initials(displayName)}</span>
          <div className="profile-meta">
            <span className="profile-name">{displayName}</span>
            <span className="profile-tier">Early Access</span>
          </div>
          <ChevronDown size={14} className="profile-chevron" aria-hidden="true" />
        </div>

        <a
          className="canonical-sidebar-link"
          href="https://github.com/farhanjama557-ship-it/DueWatch-V2"
          target="_blank"
          rel="noreferrer"
        >
          <CircleHelp size={17} />
          <span>Help Center</span>
        </a>

        <button type="button" className="canonical-sidebar-link" onClick={signOut}>
          <LogOut size={17} />
          <span>Log out</span>
        </button>
      </div>
    </aside>
  )
}
