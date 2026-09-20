import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import OverhaulShell from './overhaul/OverhaulShell'
import LockedPulse from './overhaul/LockedPulse'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Dashboard from './pages/Dashboard'
import Invoices from './pages/Invoices'
import Clients from './pages/Clients'
import CashFlow from './pages/CashFlow'
import Activity from './pages/Activity'
import Autopilot from './pages/Autopilot'
import Settings from './pages/Settings'
import LandingPage from './landing'

// Importer remains lazy so the existing parsing/persistence dependency tree
// is not pulled into Pulse. During the overhaul, each route is migrated
// independently while the current production-safe implementation remains
// available underneath.
const Import = lazy(() => import('./pages/Import'))
const ImportHistory = lazy(() => import('./pages/ImportHistory'))
const ImportRunDetail = lazy(() => import('./pages/ImportRunDetail'))

function ImportRouteFallback() {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      Loading import tools…
    </div>
  )
}

function PublicOnly({ children }) {
  const { session, loading } = useAuth()
  if (loading) return <div className="app-loading">Loading…</div>
  if (session) return <Navigate to="/" replace />
  return children
}

// UI overhaul rule: the authenticated root is now the locked Pulse visual
// foundation. It deliberately carries NO theatrical/live behavior yet.
// DataProvider + PresenceProvider still wrap the shell so the existing
// backend seams remain available for the next functional integration pass.
function RootRoute() {
  const { session, loading } = useAuth()
  if (loading) return <div className="app-loading">Loading…</div>
  if (!session) return <LandingPage />
  return (
    <OverhaulShell>
      <LockedPulse />
    </OverhaulShell>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRoute />} />

      <Route
        path="/login"
        element={
          <PublicOnly>
            <Login />
          </PublicOnly>
        }
      />
      <Route
        path="/signup"
        element={
          <PublicOnly>
            <Signup />
          </PublicOnly>
        }
      />

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/legacy-pulse" element={<Dashboard />} />
        <Route path="/invoices" element={<Invoices />} />
        <Route
          path="/import"
          element={
            <Suspense fallback={<ImportRouteFallback />}>
              <Import />
            </Suspense>
          }
        />
        <Route path="/imports" element={<Suspense fallback={<ImportRouteFallback />}><ImportHistory /></Suspense>} />
        <Route path="/imports/:runId" element={<Suspense fallback={<ImportRouteFallback />}><ImportRunDetail /></Suspense>} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/cash-flow" element={<CashFlow />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/autopilot" element={<Autopilot />} />
        <Route path="/settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
