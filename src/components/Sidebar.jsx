import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  DashboardIcon,
  InvoicesIcon,
  ClientsIcon,
  SettingsIcon,
  SignOutIcon,
  LogoMark,
} from './icons'

const navItems = [
  { to: '/', label: 'Dashboard', Icon: DashboardIcon, end: true },
  { to: '/invoices', label: 'Invoices', Icon: InvoicesIcon },
  { to: '/clients', label: 'Clients', Icon: ClientsIcon },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon },
]

export default function Sidebar() {
  const { signOut } = useAuth()

  return (
    <aside className="sidebar">
      <div className="sidebar-logo" title="DueWatch">
        <LogoMark />
      </div>

      <nav className="sidebar-nav">
        {navItems.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              isActive ? 'sidebar-link active' : 'sidebar-link'
            }
            title={label}
            aria-label={label}
          >
            <Icon />
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-spacer" />

      <button
        className="sidebar-signout"
        onClick={signOut}
        title="Sign out"
        aria-label="Sign out"
      >
        <SignOutIcon />
      </button>
    </aside>
  )
}
