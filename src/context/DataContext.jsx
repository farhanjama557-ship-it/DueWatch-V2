import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import { daysOverdue } from '../lib/format'

const DataContext = createContext(null)

const CLOSED_STATUSES = new Set(['paid', 'cancelled', 'void'])

export function isOutstanding(inv) {
  return !CLOSED_STATUSES.has(String(inv.status || '').toLowerCase())
}

export function balanceOf(inv) {
  const amount = Number(inv.amount) || 0
  const paid = Number(inv.amount_paid) || 0
  return Math.max(amount - paid, 0)
}

export function DataProvider({ children }) {
  const { user } = useAuth()
  const [invoices, setInvoices] = useState([])
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)

    const profilePromise = supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', user.id)
      .maybeSingle()

    const invoicesPromise = supabase
      .from('invoices')
      .select(
        'id, invoice_number, status, issue_date, due_date, amount, amount_paid, last_reminder, client_id, clients(name)'
      )
      .eq('user_id', user.id)

    const [{ data: profile }, { data: inv, error: invErr }] = await Promise.all([
      profilePromise,
      invoicesPromise,
    ])

    if (invErr) {
      setError(invErr.message)
      setLoading(false)
      return
    }

    // First name only, per the greeting spec.
    const fullName =
      profile?.full_name || user.user_metadata?.full_name || ''
    const firstName =
      fullName.trim().split(/\s+/)[0] ||
      (profile?.email || user.email || '').split('@')[0] ||
      'there'

    setName(firstName)
    setInvoices(inv || [])
    setLoading(false)
  }, [user])

  useEffect(() => {
    load()
  }, [load])

  const overdueCount = invoices.filter(
    (i) => isOutstanding(i) && daysOverdue(i.due_date) > 0
  ).length

  const value = { invoices, name, loading, error, overdueCount, refresh: load }

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData() {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within a DataProvider')
  return ctx
}
