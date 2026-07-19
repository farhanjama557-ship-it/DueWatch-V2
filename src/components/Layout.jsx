import { Outlet } from 'react-router-dom'
import { DataProvider } from '../context/DataContext'
import Sidebar from './Sidebar'

export default function Layout() {
  return (
    <DataProvider>
      <div className="app-shell">
        <Sidebar />
        <main className="content">
          <Outlet />
        </main>
      </div>
    </DataProvider>
  )
}
