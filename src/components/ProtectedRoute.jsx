import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function ProtectedRoute({ children }) {
  const { session, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return <div className="app-loading">Loading…</div>
  }

  if (!session) {
    // Send unauthenticated users to login, remembering where they came from.
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  return children
}
