import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import OverhaulShell from './overhaul/OverhaulShell'
import LockedPulse from './overhaul/LockedPulse'
import {
  OverhaulActivity,
  OverhaulAutopilot,
  OverhaulCashFlow,
  OverhaulClients,
  OverhaulIntegrations,
  OverhaulInvoices,
  OverhaulPromises,
  OverhaulSettings,
} from './overhaul/OverhaulPages'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Dashboard from './pages/Dashboard'
import Reports from './pages/Reports'
import LandingPage from './landing'

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

      <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
      <Route path="/signup" element={<PublicOnly><Signup /></PublicOnly>} />

      <Route
        element={
          <ProtectedRoute>
            <OverhaulShell />
          </ProtectedRoute>
        }
      >
        <Route path="/invoices" element={<OverhaulInvoices />} />
        <Route path="/clients" element={<OverhaulClients />} />
        <Route path="/promise-to-pay" element={<OverhaulPromises />} />
        <Route path="/cash-flow" element={<OverhaulCashFlow />} />
        <Route path="/autopilot" element={<OverhaulAutopilot />} />
        <Route path="/activity" element={<OverhaulActivity />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/integrations" element={<OverhaulIntegrations />} />
        <Route path="/settings" element={<OverhaulSettings />} />
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
      </Route>

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/legacy-pulse" element={<Dashboard />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
