import { Outlet } from 'react-router-dom'
import { DataProvider } from '../context/DataContext'
import { PresenceProvider } from '../features/PresenceSystem'
import Sidebar from './Sidebar'

// `children` lets the root route (`/`, authenticated case) reuse this same
// shell directly instead of going through the nested-route Outlet — every
// other authenticated route still uses the Outlet exactly as before.
export default function Layout({ children }) {
  return (
    <DataProvider>
      <PresenceProvider>
        <div className="app-shell">
          <Sidebar />
          <main className="content">
            {children ?? <Outlet />}
          </main>
        </div>
      </PresenceProvider>
    </DataProvider>
  )
}
