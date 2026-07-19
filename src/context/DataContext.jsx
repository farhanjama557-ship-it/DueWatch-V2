import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import { daysOverdue } from '../lib/format'

const DataContext = createContext(null)

// An invoice is outstanding until it is marked paid.
export function isOutstanding(inv) {
  return inv.paid !== true
}

export function balanceOf(inv) {
  const amount = Number(inv.amount) || 0
  const paid = Number(inv.amount_paid) || 0
  return Math.max(amount - paid, 0)
}

// Map the invoices table's real columns to the canonical fields the UI uses.
// Actual columns: id, user_id, client_id, inv_num, amount, amount_paid,
// inv_date, due_date, notes, paid, last_reminder, created_at (no status).
export function normalizeInvoice(row) {
  return {
    ...row,
    invoice_number: row.inv_num ?? null,
    issue_date: row.inv_date ?? null,
    due_date: row.due_date ?? null,
    amount: Number(row.amount) || 0,
    amount_paid: Number(row.amount_paid) || 0,
    last_reminder: row.last_reminder ?? null,
    paid: row.paid === true,
  }
}

// There is no status column — derive it from `paid` + how overdue the invoice
// is, per the product spec.
export function effectiveStatus(inv) {
  if (inv.paid === true) return 'paid'
  const overdueBy = daysOverdue(inv.due_date) // >0 means past due
  if (overdueBy > 30) return 'final_notice'
  if (overdueBy >= 15) return 'firm' // 15–30 days
  if (overdueBy >= 1) return 'overdue' // 1–14 days
  return 'sent' // not yet due
}

// Display-side safety net: collapse rows duplicated by invoice number, keeping
// the oldest (earliest created_at). The DB cleanup (dedupe.sql) is the real fix.
export function dedupeInvoices(rows) {
  const kept = new Map()
  for (const r of rows) {
    const key = r.invoice_number ?? r.id
    const existing = kept.get(key)
    if (!existing) {
      kept.set(key, r)
      continue
    }
    const t = r.created_at ? new Date(r.created_at).getTime() : Infinity
    const te = existing.created_at ? new Date(existing.created_at).getTime() : Infinity
    if (t < te) kept.set(key, r)
  }
  return Array.from(kept.values())
}

// Greeting name: prefer profiles.full_name (first name), else the email local
// part; capitalize the first letter either way.
function greetingName(profile, user) {
  const fullName = (profile?.full_name || user?.user_metadata?.full_name || '').trim()
  const base = fullName
    ? fullName.split(/\s+/)[0]
    : (user?.email || '').split('@')[0]
  if (!base) return 'there'
  return base.charAt(0).toUpperCase() + base.slice(1)
}

export function DataProvider({ children }) {
  const { user } = useAuth()
  const [invoices, setInvoices] = useState([])
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [clients, setClients] = useState([])

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)

    const profilePromise = supabase
      .from('profiles')
      .select('full_name')
      .eq('id', user.id)
      .maybeSingle()

    const invoicesPromise = supabase
      .from('invoices')
      .select('*, clients(name)')
      .eq('user_id', user.id)

    const clientsPromise = supabase
      .from('clients')
      .select('*')
      .eq('user_id', user.id)

    const [{ data: profile }, { data: inv, error: invErr }, { data: cli }] =
      await Promise.all([profilePromise, invoicesPromise, clientsPromise])

    if (invErr) {
      setError(invErr.message)
      setLoading(false)
      return
    }

    setName(greetingName(profile, user))
    setInvoices(dedupeInvoices((inv || []).map(normalizeInvoice)))
    setClients(cli || [])
    setLoading(false)
  }, [user])

  useEffect(() => {
    load()
  }, [load])

  const overdueCount = invoices.filter(
    (i) => isOutstanding(i) && daysOverdue(i.due_date) > 0
  ).length

  const value = { invoices, clients, name, loading, error, overdueCount, refresh: load }

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData() {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within a DataProvider')
  return ctx
}
