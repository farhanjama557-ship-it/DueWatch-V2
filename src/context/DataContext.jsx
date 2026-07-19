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
    status:
      firstDefined(
        row.status,
        row.state,
        row.invoice_status,
        row.stage,
        row.reminder_stage,
        row.status_label
      ) ?? '',
  }
}

const KNOWN_STATUSES = new Set(['sent', 'overdue', 'firm', 'final_notice', 'paid'])

// Common variants seen in seed/test data mapped to the five known pill states.
const STATUS_SYNONYMS = {
  past_due: 'overdue',
  pastdue: 'overdue',
  late: 'overdue',
  final: 'final_notice',
  final_notice_sent: 'final_notice',
  last_notice: 'final_notice',
  firm_reminder: 'firm',
  second_reminder: 'firm',
  complete: 'paid',
  completed: 'paid',
  settled: 'paid',
  closed: 'paid',
  unpaid: 'sent',
  open: 'sent',
  pending: 'sent',
  emailed: 'sent',
  delivered: 'sent',
  awaiting: 'sent',
}

function statusKey(status) {
  return String(status || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
}

// Resolve an invoice to one of the five known pill statuses. Falls back to a
// value derived from reliable fields (balance / due date) so a mismatched or
// empty status column never renders as "Unknown".
export function effectiveStatus(inv) {
  const key = statusKey(inv.status)
  if (KNOWN_STATUSES.has(key)) return key
  if (STATUS_SYNONYMS[key]) return STATUS_SYNONYMS[key]
  if ((Number(inv.amount) || 0) > 0 && balanceOf(inv) <= 0) return 'paid'
  if (daysOverdue(inv.due_date) > 0) return 'overdue'
  return 'sent'
}

// Display-side safety net: collapse rows duplicated by invoice number, keeping
// the oldest (earliest created_at when present). The DB cleanup is the real fix.
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

// Greeting name: prefer profile full_name (first name), else the email local
// part; capitalize the first letter either way.
function greetingName(profile, user) {
  const fullName = (profile?.full_name || user?.user_metadata?.full_name || '').trim()
  const base = fullName
    ? fullName.split(/\s+/)[0]
    : (profile?.email || user?.email || '').split('@')[0]
  if (!base) return 'there'
  return base.charAt(0).toUpperCase() + base.slice(1)
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

    setName(greetingName(profile, user))
    setInvoices(dedupeInvoices((inv || []).map(normalizeInvoice)))
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
