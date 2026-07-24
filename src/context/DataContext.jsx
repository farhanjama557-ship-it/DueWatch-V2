import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import { daysOverdue, daysUntil } from '../lib/format'
import { fetchAutopilotRules } from '../lib/autopilot'

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
  const [lastAutopilotRun, setLastAutopilotRun] = useState(null)
  const [autopilotRules, setAutopilotRules] = useState([])
  // Real activity since the founder's last visit (this app session) — null
  // until computed, and stays null forever on someone's very first-ever
  // visit (no prior last_seen_at to diff against). Computed once per mount,
  // not on every silent background refresh, so it doesn't reset itself
  // mid-session (see the visitStamped guard in `load` below).
  const [sinceLastVisit, setSinceLastVisit] = useState(null)
  const visitStamped = useRef(false)
  // Sum of evidence.amount across payment events this calendar month — real
  // dollars actually recorded, traced to the events that logged them. Only
  // counts payments recorded since evidence.amount started being captured;
  // older events have no amount and are silently excluded, not estimated.
  const [collectedThisMonth, setCollectedThisMonth] = useState(0)
  const [collectedLastMonth, setCollectedLastMonth] = useState(0)
  // Real all-time count of every logged event — not the 20-row recent
  // window above — for the sidebar Evidence card's "N actions recorded".
  const [totalEventsCount, setTotalEventsCount] = useState(0)

  // Presence System (Merged Spec v1.1) signals that aren't fetched from the
  // DB — they're set directly by the real action that's happening in this
  // session. Cognitive fires only while a real async send/sign is in
  // flight; Celebratory fires only right after a real payment write
  // succeeds. Neither is inferred from historical rows, so neither replays
  // on page load.
  const [cognitiveActivity, setCognitiveActivity] = useState(null) // { label } | null
  const [celebration, setCelebration] = useState(null) // { clientName, amount, daysEarly } | null

  // `silent` skips the global loading flag — used for the background poll so
  // the UI doesn't flicker to a loading state every refresh.
  const load = useCallback(async (opts = {}) => {
    if (!user) return
    if (!opts.silent) setLoading(true)
    setError(null)

    // "Since your last visit" is anchored to when this app session started,
    // not to every refresh — a mutation-triggered refresh() mid-session
    // must not quietly zero the counts back out. Computed once per mount:
    // read the last_seen_at written at the *previous* session's load before
    // anything in this session can overwrite it.
    const isFirstLoadThisSession = !visitStamped.current
    visitStamped.current = true
    let previousLastSeenAt = null
    if (isFirstLoadThisSession) {
      const { data: seenRow } = await supabase
        .from('profiles')
        .select('last_seen_at')
        .eq('id', user.id)
        .maybeSingle()
      previousLastSeenAt = seenRow?.last_seen_at ?? null
    }

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
    // existing yet (query errors → treated as empty). `evidence` carries
    // real per-event data (e.g. payment amounts) captured at write time.
    const eventsPromise = supabase
      .from('events')
      .select('id, event_type, invoice_id, created_at, evidence, invoices(inv_num, clients(name))')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20)

    // Tolerates the table/row not existing yet. Supabase resolves
    // successfully even on a query-level error (bad RLS, bad join, etc.) —
    // it doesn't throw — so `.catch()` alone would never see that error.
    // Check `r.error` explicitly and log it, or a real failure here goes
    // completely silent and just looks like "nothing pending."
    const autopilotPromise = supabase
      .from('autopilot_settings')
      .select('enabled, approval_required')
      .eq('user_id', user.id)
      .maybeSingle()
      .then((r) => {
        if (r.error) console.warn('autopilot_settings query failed:', r.error.message)
        return r.data
      })
      .catch((err) => {
        console.warn('autopilot_settings query threw:', err.message)
        return null
      })

    // Reminders Autopilot has drafted but not sent — queued for approval.
    const awaitingPromise = supabase
      .from('awaiting_signature')
      .select('*, invoices(*, clients(name))')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .then((r) => {
        if (r.error) console.warn('awaiting_signature query failed:', r.error.message)
        return r.data
      })
      .catch((err) => {
        console.warn('awaiting_signature query threw:', err.message)
        return null
      })

    // Most recent scheduler cycle, for the JourneyBar's "Checked" stage —
    // whether Autopilot has ever actually run for this user.
    const lastRunPromise = supabase
      .from('autopilot_runs')
      .select('id, status, started_at, completed_at')
      .eq('user_id', user.id)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then((r) => {
        if (r.error) console.warn('autopilot_runs query failed:', r.error.message)
        return r.data
      })
      .catch((err) => {
        console.warn('autopilot_runs query threw:', err.message)
        return null
      })

    // Real rules, for the Top Invoices "why" text and the "Duewatch will do
    // next" panel — the same engine the scheduler itself uses (ruleSchedule.js
    // mirrors _shared/rules.js), not a generic heuristic.
    const rulesPromise = fetchAutopilotRules(user.id).catch(() => [])

    // Real counts since the previous session, for "Since your last visit".
    // Only fired on the first load of this session, and only when there's a
    // prior last_seen_at to diff against (nothing to compare on a brand new
    // account's very first visit — that case renders no panel at all).
    const checkedSincePromise =
      isFirstLoadThisSession && previousLastSeenAt
        ? supabase
            .from('autopilot_runs')
            .select('invoices_checked')
            .eq('user_id', user.id)
            .gte('started_at', previousLastSeenAt)
            .then((r) => (r.data || []).reduce((sum, row) => sum + (row.invoices_checked || 0), 0))
            .catch(() => null)
        : Promise.resolve(null)

    // Real "Collected this month" — summed from evidence.amount on payment
    // events logged this calendar month. Queried directly (not derived from
    // the 20-row recent-events window above) so a busy month can't silently
    // undercount.
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()
    const collectedPromise = supabase
      .from('events')
      .select('evidence')
      .eq('user_id', user.id)
      .in('event_type', ['payment_recorded', 'invoice_marked_paid'])
      .gte('created_at', startOfMonth)
      .then((r) => (r.data || []).reduce((sum, row) => sum + (Number(row.evidence?.amount) || 0), 0))
      .catch(() => 0)

    // Real month-over-month comparison for the Collected KPI card — same
    // query, prior calendar month's window. (Outstanding/Need Attention
    // have no equivalent: they're derived from current invoice state, not
    // logged events, so there's no historical snapshot to diff against
    // without new schema — omitted rather than faked.)
    const collectedLastMonthPromise = supabase
      .from('events')
      .select('evidence')
      .eq('user_id', user.id)
      .in('event_type', ['payment_recorded', 'invoice_marked_paid'])
      .gte('created_at', startOfLastMonth)
      .lt('created_at', startOfMonth)
      .then((r) => (r.data || []).reduce((sum, row) => sum + (Number(row.evidence?.amount) || 0), 0))
      .catch(() => 0)

    // Real all-time event count for the sidebar Evidence card.
    const totalEventsPromise = supabase
      .from('events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .then((r) => r.count ?? 0)
      .catch(() => 0)

    const draftedSincePromise =
      isFirstLoadThisSession && previousLastSeenAt
        ? supabase
            .from('awaiting_signature')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .gte('created_at', previousLastSeenAt)
            .then((r) => r.count ?? null)
            .catch(() => null)
        : Promise.resolve(null)

    const [
      { data: profile },
      { data: inv, error: invErr },
      { data: cli },
      { data: ev },
      autopilot,
      awaiting,
      lastRun,
      rules,
      checkedSince,
      draftedSince,
      collected,
      collectedLast,
      totalEvents,
    ] = await Promise.all([
      profilePromise,
      invoicesPromise,
      clientsPromise,
      eventsPromise,
      autopilotPromise,
      awaitingPromise,
      lastRunPromise,
      rulesPromise,
      checkedSincePromise,
      draftedSincePromise,
      collectedPromise,
      collectedLastMonthPromise,
      totalEventsPromise,
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
    setLastAutopilotRun(lastRun || null)
    setAutopilotRules(rules || [])
    setCollectedThisMonth(collected || 0)
    setCollectedLastMonth(collectedLast || 0)
    setTotalEventsCount(totalEvents || 0)

    if (isFirstLoadThisSession) {
      setSinceLastVisit(
        previousLastSeenAt ? { checked: checkedSince ?? 0, drafted: draftedSince ?? 0 } : null
      )
      // Fire-and-forget: stamp this visit so next session's diff starts from
      // here. Never blocks rendering on it.
      supabase
        .from('profiles')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', user.id)
        .then(({ error }) => {
          if (error) console.warn('profiles.last_seen_at update failed:', error.message)
        })
    }
    setLoading(false)
  }, [user])

  useEffect(() => {
    visitStamped.current = false
    load()
  }, [load])

  // Keep JourneyBar / the global Autopilot indicator reasonably live without
  // a hard reload, without flickering the whole app into a loading state.
  useEffect(() => {
    if (!user) return
    const id = setInterval(() => load({ silent: true }), 30000)
    return () => clearInterval(id)
  }, [user, load])

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

  // Severely overdue (matches the existing "critical"/"final_notice"
  // thresholds in effectiveStatus) — the real signal behind the Presence
  // System's "Active" state. There is no signal in this codebase yet for
  // "Autopilot was unexpectedly paused" (no such distinction is tracked),
  // so that half of Active's trigger condition stays unimplemented rather
  // than faked.
  const criticalOverdueCount = invoices.filter(
    (i) => isOutstanding(i) && daysOverdue(i.due_date) >= 15
  ).length

  const autopilotErrorCount = events.filter((e) => e.lifecycle_state === 'error').length

  const startCognitive = useCallback((label) => setCognitiveActivity({ label }), [])
  const stopCognitive = useCallback(() => setCognitiveActivity(null), [])
  const celebrate = useCallback((payload) => setCelebration(payload), [])
  const dismissCelebration = useCallback(() => setCelebration(null), [])

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
    lastAutopilotRun,
    hasCompletedAutopilotRun: lastAutopilotRun?.status === 'completed',
    autopilotRules,
    sinceLastVisit,
    collectedThisMonth,
    collectedLastMonth,
    totalEventsCount,
    criticalOverdueCount,
    autopilotErrorCount,
    cognitiveActivity,
    startCognitive,
    stopCognitive,
    celebration,
    celebrate,
    dismissCelebration,
  }

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData() {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within a DataProvider')
  return ctx
}
