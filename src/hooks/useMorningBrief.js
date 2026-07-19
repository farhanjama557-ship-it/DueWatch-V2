import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { daysOverdue, daysUntil } from '../lib/format'

// Statuses that mean an invoice is settled / not owed.
const CLOSED_STATUSES = new Set(['paid', 'cancelled', 'void'])

function isOutstanding(inv) {
  return !CLOSED_STATUSES.has(String(inv.status || '').toLowerCase())
}

/**
 * Loads everything the Morning Brief needs from Supabase and derives the
 * KPIs and lists. Elements with no backing table yet (reminders / handled
 * activity) resolve to zero / empty so the UI renders clean empty states.
 */
export function useMorningBrief() {
  const { user } = useAuth()
  const [state, setState] = useState({
    loading: true,
    error: null,
    name: '',
    kpis: {
      outstanding: 0,
      expectedThisWeek: 0,
      needAttention: 0,
      remindersSent: 0,
    },
    handled: [], // no activity table yet -> always empty for now
    needsAttention: [],
    dueIn7Days: [],
  })

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!user) return
      setState((s) => ({ ...s, loading: true, error: null }))

      // Name: prefer the profile row, fall back to auth metadata / email.
      const profilePromise = supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', user.id)
        .maybeSingle()

      // Invoices with their client name.
      const invoicesPromise = supabase
        .from('invoices')
        .select('id, invoice_number, status, due_date, amount, client_id, clients(name)')
        .eq('user_id', user.id)

      const [{ data: profile }, { data: invoices, error: invErr }] =
        await Promise.all([profilePromise, invoicesPromise])

      if (cancelled) return

      if (invErr) {
        setState((s) => ({ ...s, loading: false, error: invErr.message }))
        return
      }

      const rows = invoices || []
      const outstanding = rows.filter(isOutstanding)

      let outstandingTotal = 0
      let expectedThisWeek = 0
      const needsAttention = []
      const dueIn7Days = []

      for (const inv of outstanding) {
        const amount = Number(inv.amount) || 0
        outstandingTotal += amount

        const overdueBy = daysOverdue(inv.due_date)
        const until = daysUntil(inv.due_date)

        const item = {
          id: inv.id,
          clientName: inv.clients?.name || 'No client',
          amount,
          invoiceNumber: inv.invoice_number,
          overdueBy,
          until,
        }

        if (overdueBy > 0) {
          needsAttention.push(item)
        }
        if (until !== null && until >= 0 && until <= 7) {
          expectedThisWeek += amount
          dueIn7Days.push(item)
        }
      }

      // Most overdue first; soonest-due first.
      needsAttention.sort((a, b) => b.overdueBy - a.overdueBy)
      dueIn7Days.sort((a, b) => a.until - b.until)

      const nameSource =
        profile?.full_name ||
        user.user_metadata?.full_name ||
        (profile?.email || user.email || '').split('@')[0] ||
        'there'

      setState({
        loading: false,
        error: null,
        name: nameSource,
        kpis: {
          outstanding: outstandingTotal,
          expectedThisWeek,
          needAttention: needsAttention.length,
          remindersSent: 0, // no reminders table yet
        },
        handled: [], // no activity table yet
        needsAttention,
        dueIn7Days,
      })
    }

    load()
    return () => {
      cancelled = true
    }
  }, [user])

  return state
}
