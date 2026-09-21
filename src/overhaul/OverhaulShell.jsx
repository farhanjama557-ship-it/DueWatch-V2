import { NavLink, Outlet } from 'react-router-dom'
import { ChevronDown, LogOut } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { DataProvider, useData } from '../context/DataContext'
import { PresenceProvider } from '../features/PresenceSystem'
import { initials } from '../lib/format'
import { DueWatchMark, OverhaulIcon } from './OverhaulIconSystem'
import { WorkspacePreferencesProvider, useWorkspacePreferences } from './WorkspacePreferencesContext'
import './overhaul.css'

const primaryNav = [
  { label: 'Pulse', to: '/', icon: 'pulse' },
  { label: 'Invoices', to: '/invoices', icon: 'invoices', badge: true },
  { label: 'Clients', to: '/clients', icon: 'clients' },
  { label: 'Promise-to-Pay', to: '/promise-to-pay', icon: 'promise' },
  { label: 'Cash Flow', to: '/cash-flow', icon: 'cash' },
  { label: 'Autopilot', to: '/autopilot', icon: 'autopilot' },
  { label: 'Activity', to: '/activity', icon: 'activity' },
  { label: 'Reports', to: '/reports', icon: 'reports' },
  { label: 'Integrations', to: '/integrations', icon: 'integrations' },
  { label: 'Settings', to: '/settings', icon: 'settings' },
]

function Sidebar() {
  const { user, signOut } = useAuth()
  const { name, overdueCount, autopilotEnabled, autopilotErrorCount } = useData()
  const { preferences } = useWorkspacePreferences()

  const fullName = (user?.user_metadata?.full_name || '').trim()
  const email = user?.email || ''
  const displayName = fullName || name || email.split('@')[0] || 'Account'
  const company =
    preferences?.workspace_name ||
    user?.user_metadata?.company ||
    user?.user_metadata?.organization ||
    user?.user_metadata?.workspace ||
    'Workspace'
  const role = user?.user_metadata?.role || 'Early Access'

  return (
    <aside className="ov-sidebar">
      <div className="ov-brand">
        <DueWatchMark className="ov-brand-mark" />
        <div className="ov-brand-copy">
          <div className="ov-brand-name">DueWatch</div>
          <div className="ov-brand-company">{company}</div>
        </div>
      </div>

      <nav className="ov-nav" aria-label="DueWatch">
        {primaryNav.map((item) =>
          item.disabled ? (
            <button key={item.label} className="ov-nav-item is-disabled" type="button" aria-disabled="true">
              <OverhaulIcon name={item.icon} size={17} className="ov-nav-glyph" />
              <span>{item.label}</span>
            </button>
          ) : (
            <NavLink
              key={item.label}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `ov-nav-item${isActive ? ' is-active' : ''}`}
            >
              <OverhaulIcon name={item.icon} size={17} className="ov-nav-glyph" />
              <span>{item.label}</span>
              {item.badge && overdueCount > 0 ? <b className="ov-nav-badge">{overdueCount}</b> : null}
            </NavLink>
          )
        )}
      </nav>

      <div className="ov-sidebar-spacer" />

      <section className="ov-autopilot-rail">
        <span className={`ov-status-dot ${autopilotErrorCount > 0 ? 'is-warning' : ''}`} />
        <div>
          <strong>Autopilot {autopilotEnabled ? 'active' : 'off'}</strong>
          <span>
            {autopilotErrorCount > 0
              ? `${autopilotErrorCount} recent error${autopilotErrorCount === 1 ? '' : 's'}`
              : autopilotEnabled
                ? 'DW is handling receivables'
                : 'Manual control'}
          </span>
        </div>
      </section>

      <div className="ov-profile">
        <div className="ov-avatar">{initials(displayName)}</div>
        <div className="ov-profile-copy">
          <strong>{displayName}</strong>
          <span>{role}</span>
        </div>
        <ChevronDown size={14} className="ov-profile-more" aria-hidden="true" />
      </div>

      <div className="ov-sidebar-links">
        <a href="https://github.com/farhanjama557-ship-it/DueWatch-V2" target="_blank" rel="noreferrer">
          <OverhaulIcon name="help" size={16} />
          <span>Help Center</span>
        </a>
        <button type="button" onClick={signOut}>
          <LogOut size={16} />
          <span>Log out</span>
        </button>
      </div>
    </aside>
  )
}

function ShellInner({ children }) {
  return (
    <div className="ov-app-shell">
      <Sidebar />
      <main className="ov-main">{children}</main>
    </div>
  )
}

export default function OverhaulShell({ children }) {
  return (
    <DataProvider>
      <WorkspacePreferencesProvider>
        <PresenceProvider>
          <ShellInner>{children ?? <Outlet />}</ShellInner>
        </PresenceProvider>
      </WorkspacePreferencesProvider>
    </DataProvider>
  )
}
