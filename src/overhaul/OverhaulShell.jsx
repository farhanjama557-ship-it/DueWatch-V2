import { NavLink } from 'react-router-dom'
import { DataProvider } from '../context/DataContext'
import { PresenceProvider } from '../features/PresenceSystem'
import './overhaul.css'

function DueWatchMark() {
  return (
    <svg className="ov-brand-mark" viewBox="0 0 44 44" aria-hidden="true">
      <rect x="7" y="7" width="9" height="30" rx="1.5" fill="currentColor" />
      <path d="M20 7h7.5A9.5 9.5 0 0 1 37 16.5V22H26a6 6 0 0 1-6-6V7Z" className="ov-brand-orange" />
      <path d="M26 23h11v4.5A9.5 9.5 0 0 1 27.5 37H20v-8a6 6 0 0 1 6-6Z" fill="currentColor" />
      <circle cx="28.5" cy="28.5" r="4.7" fill="white" />
    </svg>
  )
}

const primaryNav = [
  { label: 'Pulse', to: '/', glyph: 'pulse' },
  { label: 'Invoices', to: '/invoices', glyph: 'invoice' },
  { label: 'Clients', to: '/clients', glyph: 'clients' },
  { label: 'Promise-to-Pay', disabled: true, glyph: 'promise' },
  { label: 'Cash Flow', to: '/cash-flow', glyph: 'cash' },
  { label: 'Autopilot', to: '/autopilot', glyph: 'autopilot' },
  { label: 'Activity', to: '/activity', glyph: 'activity' },
  { label: 'Reports', disabled: true, glyph: 'reports' },
  { label: 'Integrations', disabled: true, glyph: 'integrations' },
  { label: 'Settings', to: '/settings', glyph: 'settings' },
]

function NavGlyph({ type }) {
  const map = {
    pulse: '◉',
    invoice: '▤',
    clients: '◫',
    promise: '⌁',
    cash: '⌁',
    autopilot: '✦',
    activity: '↻',
    reports: '▥',
    integrations: '⧉',
    settings: '◌',
  }
  return <span className={`ov-nav-glyph ov-nav-glyph--${type}`} aria-hidden="true">{map[type] || '•'}</span>
}

function Sidebar() {
  return (
    <aside className="ov-sidebar">
      <div className="ov-brand">
        <DueWatchMark />
        <div>
          <div className="ov-brand-name">DueWatch</div>
          <div className="ov-brand-company">Acme Holdings</div>
        </div>
      </div>

      <nav className="ov-nav" aria-label="DueWatch">
        {primaryNav.map((item) =>
          item.disabled ? (
            <button key={item.label} className="ov-nav-item is-disabled" type="button" aria-disabled="true">
              <NavGlyph type={item.glyph} />
              <span>{item.label}</span>
            </button>
          ) : (
            <NavLink
              key={item.label}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `ov-nav-item${isActive ? ' is-active' : ''}`}
            >
              <NavGlyph type={item.glyph} />
              <span>{item.label}</span>
            </NavLink>
          )
        )}
      </nav>

      <div className="ov-sidebar-spacer" />

      <div className="ov-autopilot-rail">
        <span className="ov-status-dot" />
        <div>
          <strong>Autopilot running</strong>
          <span>Watching receivables</span>
        </div>
      </div>

      <div className="ov-profile">
        <div className="ov-avatar">FJ</div>
        <div className="ov-profile-copy">
          <strong>Farhan Jama</strong>
          <span>Founder</span>
        </div>
        <span className="ov-profile-more">•••</span>
      </div>
      <div className="ov-sidebar-links">
        <button type="button">Help</button>
        <button type="button">Log out</button>
      </div>
    </aside>
  )
}

export default function OverhaulShell({ children }) {
  return (
    <DataProvider>
      <PresenceProvider>
        <div className="ov-app-shell">
          <Sidebar />
          <main className="ov-main">{children}</main>
        </div>
      </PresenceProvider>
    </DataProvider>
  )
}
