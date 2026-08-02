import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
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

// Lazy-loaded so Dashboard/Invoices (and every other route) never pull in
// the importer's own dependency tree (ExcelJS, parsing/normalization
// modules) — that code only downloads when a visitor actually opens
// /import. Suspense's fallback is a calm, static message: it appears only
// while the route chunk itself is fetching, before any file has even been
// selected, so it must never look like parsing progress.
const Import = lazy(() => import('./pages/Import'))

function ImportRouteFallback() {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      Loading import tools…
    </div>
  )
}

// Redirect authenticated users away from auth screens.
function PublicOnly({ children }) {
  const { session, loading } = useAuth()
  if (loading) return <div className="app-loading">Loading…</div>
  if (session) return <Navigate to="/" replace />
  return children
}

// `/` is auth-aware rather than gated: logged-out visitors see the public
// marketing page, logged-in users see exactly what they saw before this
// change (Dashboard, inside the same app shell). No other route's behavior
// changes — everything else still goes through ProtectedRoute as before.
function RootRoute() {
  const { session, loading } = useAuth()
  if (loading) return <div className="app-loading">Loading…</div>
  if (!session) return <LandingPage />
  return (
    <Layout>
      <Dashboard />
    </Layout>
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
        <Route path="/invoices" element={<Invoices />} />
        <Route
          path="/import"
          element={
            <Suspense fallback={<ImportRouteFallback />}>
              <Import />
            </Suspense>
          }
        />
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
