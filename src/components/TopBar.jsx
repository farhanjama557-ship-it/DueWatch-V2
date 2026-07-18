import { useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const titles = {
  '/': 'Dashboard',
  '/invoices': 'Invoices',
  '/clients': 'Clients',
  '/settings': 'Settings',
}

export default function TopBar() {
  const { pathname } = useLocation()
  const { user } = useAuth()

  const title = titles[pathname] ?? 'DueWatch'
  const email = user?.email ?? ''
  const initial = email ? email[0] : '?'

  return (
    <header className="topbar">
      <div className="topbar-title">{title}</div>
      <div className="topbar-right">
        <div className="avatar" title={email} aria-label={email}>
          {initial}
        </div>
      </div>
    </header>
  )
}
