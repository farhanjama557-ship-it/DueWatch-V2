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

const firstDefined = (...vals) => vals.find((v) => v !== undefined && v !== null)

// Map the pre-existing table's real columns to the canonical fields the UI
// uses. Tolerates common naming variants so the app doesn't break on a rename.
export function normalizeInvoice(row) {
  return {
    ...row,
    invoice_number: firstDefined(row.invoice_number, row.inv_num, row.number) ?? null,
    issue_date: firstDefined(row.issue_date, row.issued_date, row.issued_on) ?? null,
    due_date: firstDefined(row.due_date, row.due, row.due_on) ?? null,
    amount: Number(firstDefined(row.amount, row.total, row.total_amount)) || 0,
    amount_paid: Number(firstDefined(row.amount_paid, row.paid_amount, row.paid)) || 0,
    last_reminder: firstDefined(row.last_reminder, row.last_reminder_at) ?? null,
    status: firstDefined(row.status, row.state) ?? '',
  }
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

    // Select * so a differently-named column in the pre-existing table can't
    // throw "column does not exist"; fields are normalized below.
    const invoicesPromise = supabase
      .from('invoices')
      .select('*, clients(name)')
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
    setInvoices((inv || []).map(normalizeInvoice))
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
