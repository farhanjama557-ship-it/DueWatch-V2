import { NavLink, useNavigate } from 'react-router-dom'
import { PenSquare } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useData, isOutstanding } from '../context/DataContext'
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

function AutopilotIndicator({ invoiceCount, watchingCount, enabled }) {
  const navigate = useNavigate()

  let dotClass = 'autopilot-dot off'
  let title = 'Autopilot off'
  let sub = 'Click to set up'

  if (invoiceCount === 0) {
    dotClass = 'autopilot-dot off'
    title = 'Autopilot ready'
    sub = 'Add invoices to start'
  } else if (enabled) {
    dotClass = 'autopilot-dot on'
    title = 'Autopilot on'
    sub = `Watching ${watchingCount} ${watchingCount === 1 ? 'invoice' : 'invoices'}`
  }

  return (
    <button
      type="button"
      className="sidebar-autopilot"
      onClick={() => navigate('/autopilot')}
    >
      <span className={dotClass} aria-hidden="true" />
      <div className="sidebar-autopilot-text">
        <span className="sidebar-autopilot-title">{title}</span>
        <span className="sidebar-autopilot-sub">{sub}</span>
      </div>
    </button>
  )
}

function SignatureIndicator({ count }) {
  const navigate = useNavigate()

  return (
    <button
      type="button"
      className="sidebar-autopilot sidebar-signature"
      onClick={() => navigate('/', { state: { scrollToSignature: true } })}
    >
      <span
        className={count > 0 ? 'signature-dot amber' : 'signature-dot green'}
        aria-hidden="true"
      />
      <div className="sidebar-autopilot-text">
        <span className="sidebar-autopilot-title">
          <PenSquare size={13} className="signature-icon" />{' '}
          {count > 0 ? `Awaiting your signature (${count})` : 'No signatures needed'}
        </span>
      </div>
    </button>
  )
}

export default function Sidebar() {
  const { user } = useAuth()
  const { name, overdueCount, invoices, autopilotEnabled, awaitingSignature } = useData()

  const email = user?.email ?? ''
  const displayName = name || email.split('@')[0] || 'Account'
  const watchingCount = invoices.filter(isOutstanding).length

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

      <SignatureIndicator count={awaitingSignature.length} />

      <AutopilotIndicator
        invoiceCount={invoices.length}
        watchingCount={watchingCount}
        enabled={autopilotEnabled}
      />

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
