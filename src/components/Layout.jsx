import { Outlet } from 'react-router-dom'
import { DataProvider } from '../context/DataContext'
import { PresenceProvider } from '../features/PresenceSystem'
import Sidebar from './Sidebar'

export default function Layout() {
  return (
    <DataProvider>
      <PresenceProvider>
        <div className="app-shell">
          <Sidebar />
          <main className="content">
            <Outlet />
          </main>
        </div>
      </PresenceProvider>
    </DataProvider>
  )
}
