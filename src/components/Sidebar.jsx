import { NavLink } from 'react-router-dom'
import { ChevronDown, LogOut } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { initials } from '../lib/format'
import { DueWatchIcon, DueWatchLogoMark } from './DueWatchIconSystem'

const mainNav = [
  { to: '/', label: 'Pulse', icon: 'pulse', end: true },
  { to: '/invoices', label: 'Invoices', icon: 'invoices', badge: true },
  { to: '/clients', label: 'Clients', icon: 'clients' },
  { to: '/promise-to-pay', label: 'Promise-to-Pay', icon: 'promise' },
  { to: '/cash-flow', label: 'Cash Flow', icon: 'cashFlow' },
  { to: '/autopilot', label: 'Autopilot', icon: 'autopilot' },
  { to: '/activity', label: 'Activity', icon: 'activity' },
  { to: '/reports', label: 'Reports', icon: 'reports' },
  { to: '/integrations', label: 'Integrations', icon: 'integrations' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
]

function NavItem({ to, label, icon, end, badge, overdueCount }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
      <DueWatchIcon name={icon} size={17} className="nav-icon" tone="navy" />
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
        <DueWatchLogoMark size={30} className="canonical-logo-mark" />
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
          <DueWatchIcon name="help" size={17} tone="navy" />
          <span>Help Center</span>
        </a>

        <button type="button" className="canonical-sidebar-link" onClick={signOut}>
          <LogOut size={17} aria-hidden="true" />
          <span>Log out</span>
        </button>
      </div>
    </aside>
  )
}
