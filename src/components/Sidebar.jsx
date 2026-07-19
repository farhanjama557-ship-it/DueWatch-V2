import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { initials } from '../lib/format'
import {
  MorningBriefIcon,
  InvoicesIcon,
  ClientsIcon,
  CashFlowIcon,
  ActivityIcon,
  SettingsIcon,
  LogoMark,
} from './icons'

const mainNav = [
  { to: '/', label: 'Morning Brief', Icon: MorningBriefIcon, end: true },
  { to: '/invoices', label: 'Invoices', Icon: InvoicesIcon, badge: true },
  { to: '/clients', label: 'Clients', Icon: ClientsIcon },
  { to: '/cash-flow', label: 'Cash Flow', Icon: CashFlowIcon },
]

const workspaceNav = [
  { to: '/activity', label: 'Activity', Icon: ActivityIcon },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon },
]

function NavItem({ to, label, Icon, end, badge, overdueCount }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        isActive ? 'nav-item active' : 'nav-item'
      }
    >
      <Icon className="nav-icon" />
      <span className="nav-label">{label}</span>
      {badge && overdueCount > 0 && (
        <span className="nav-badge">{overdueCount}</span>
      )}
    </NavLink>
  )
}

export default function Sidebar() {
  const { user } = useAuth()
  const { name, overdueCount } = useData()

  const email = user?.email ?? ''
  const displayName = name || email.split('@')[0] || 'Account'

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <LogoMark />
        <span className="sidebar-brand-name">Duewatch</span>
      </div>

      <nav className="sidebar-nav">
        {mainNav.map((item) => (
          <NavItem key={item.to} {...item} overdueCount={overdueCount} />
        ))}

        <div className="sidebar-section-label">Workspace</div>

        {workspaceNav.map((item) => (
          <NavItem key={item.to} {...item} overdueCount={overdueCount} />
        ))}
      </nav>

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
