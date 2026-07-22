import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import { daysOverdue, daysUntil } from '../lib/format'

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

// There is no status column — derive it from `paid` + how overdue (or how
// soon due) the invoice is, per the product spec ladder:
//   Paid → Final Notice (>30d) → Critical (15–30d) → Overdue (1–14d)
//   → Due Soon (due within 14d, not overdue) → Sent (more than 14d away)
export function effectiveStatus(inv) {
  if (inv.paid === true) return 'paid'
  const overdueBy = daysOverdue(inv.due_date) // >0 means past due
  if (overdueBy > 30) return 'final_notice'
  if (overdueBy >= 15) return 'critical' // 15–30 days
  if (overdueBy >= 1) return 'overdue' // 1–14 days
  const until = daysUntil(inv.due_date) // >=0 means not yet due
  if (until !== null && until <= 14) return 'due_soon' // due within 14 days
  return 'sent' // more than 14 days away (or no due date)
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
  const [events, setEvents] = useState([])
  const [autopilotEnabled, setAutopilotEnabled] = useState(false)
  const [autopilotApprovalRequired, setAutopilotApprovalRequired] = useState(true)
  const [awaitingSignature, setAwaitingSignature] = useState([])

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

    // Recent activity for "Handled for you". Tolerates the events table not
    // existing yet (query errors → treated as empty).
    const eventsPromise = supabase
      .from('events')
      .select('id, event_type, invoice_id, created_at, invoices(inv_num, clients(name))')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20)

    // Tolerates the table/row not existing yet — resolves to null.
    const autopilotPromise = supabase
      .from('autopilot_settings')
      .select('enabled, approval_required')
      .eq('user_id', user.id)
      .maybeSingle()
      .then((r) => r.data)
      .catch(() => null)

    // Reminders Autopilot has drafted but not sent — queued for approval.
    const awaitingPromise = supabase
      .from('awaiting_signature')
      .select('*, invoices(*, clients(name))')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .then((r) => r.data)
      .catch(() => null)

    const [
      { data: profile },
      { data: inv, error: invErr },
      { data: cli },
      { data: ev },
      autopilot,
      awaiting,
    ] = await Promise.all([
      profilePromise,
      invoicesPromise,
      clientsPromise,
      eventsPromise,
      autopilotPromise,
      awaitingPromise,
    ])

    if (invErr) {
      setError(invErr.message)
      setLoading(false)
      return
    }

    setName(greetingName(profile, user))
    setInvoices(dedupeInvoices((inv || []).map(normalizeInvoice)))
    setClients(cli || [])
    setEvents(ev || [])
    setAutopilotEnabled(autopilot?.enabled === true)
    setAutopilotApprovalRequired(autopilot?.approval_required !== false)
    setAwaitingSignature(
      (awaiting || []).map((row) => ({
        ...row,
        invoice: row.invoices ? normalizeInvoice(row.invoices) : null,
      }))
    )
    setLoading(false)
  }, [user])

  useEffect(() => {
    load()
  }, [load])

  // Optimistically add a just-created invoice, normalized so its derived
  // status (Overdue/Critical/etc.) is correct immediately, before the refetch.
  const addInvoiceLocal = useCallback((row) => {
    setInvoices((cur) => dedupeInvoices([normalizeInvoice(row), ...cur]))
  }, [])

  // Remove a resolved (approved/skipped) signature request immediately,
  // without waiting for a full refetch.
  const resolveSignatureLocal = useCallback((id) => {
    setAwaitingSignature((cur) => cur.filter((i) => i.id !== id))
  }, [])

  const overdueCount = invoices.filter(
    (i) => isOutstanding(i) && daysOverdue(i.due_date) > 0
  ).length

  const value = {
    invoices,
    clients,
    events,
    name,
    loading,
    error,
    overdueCount,
    refresh: load,
    addInvoiceLocal,
    autopilotEnabled,
    autopilotApprovalRequired,
    setAutopilotEnabledLocal: setAutopilotEnabled,
    awaitingSignature,
    resolveSignatureLocal,
  }

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData() {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within a DataProvider')
  return ctx
}
