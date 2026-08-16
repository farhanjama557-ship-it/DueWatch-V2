import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import { daysOverdue, daysUntil } from '../lib/format'
import { toPendingInvoiceIds, toHandledKeys } from '../lib/pulseAuthority'

// Matches supabase/functions/_shared/executionClaim.js's ACTION_TYPE_SEND_REMINDER.
// Inlined rather than importing that Deno-side module here (out of scope
// for this slice — no execution-claim changes) since it is the one finite,
// already-shipped action_type value every execution claim in this app uses.
const ACTION_TYPE_SEND_REMINDER = 'send_reminder'

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
  // The full, real autopilot_settings row (id, user_id, enabled,
  // approval_required) — Phase 2A.2: evaluateNextActionAuthority's
  // permission check requires autopilotSettings.user_id to prove these
  // settings are actually owned by the caller, which the two booleans
  // above alone can't carry. null means either no row yet or the query
  // failed; derivePermission already treats either as "no automatic
  // permission" (the safe default either way) — that internal fallback
  // is correct and untouched.
  const [autopilotSettings, setAutopilotSettings] = useState(null)
  // Second review-fix pass, HIGH: true ONLY when the settings query
  // itself failed — distinct from `autopilotSettings === null` meaning
  // "genuinely no row." Pulse/Dashboard uses this to avoid presenting
  // nextActionAuthority.js's safe requiresApproval-true default (or
  // autopilotEnabled's existing "off" default) as if it were an observed
  // founder policy — see classifyPulseAuthority's settingsUnavailable
  // parameter.
  const [autopilotSettingsUnavailable, setAutopilotSettingsUnavailable] = useState(false)
  const [awaitingSignature, setAwaitingSignature] = useState([])
  const [lastAutopilotRun, setLastAutopilotRun] = useState(null)
  const [autopilotRules, setAutopilotRules] = useState([])
  // Phase 2A.2 — evaluateNextActionAuthority's execution-history inputs.
  // A real (possibly empty) Set means "checked, here's what's true"; null
  // means the load-bearing query failed/is unavailable and must NEVER be
  // treated as "checked and found none" — passing null straight through
  // to evaluateNextActionAuthority makes it fail closed with
  // execution_history_unavailable, exactly like the Deno execution
  // boundary's isValidExecutionHistory() check.
  const [handledKeys, setHandledKeys] = useState(null)
  const [pendingInvoiceIds, setPendingInvoiceIds] = useState(null)
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
  // How many distinct payment events made up collectedLastMonth — the
  // Collected KPI's month-over-month trend needs this, not just the sum,
  // to tell a real comparison baseline from a single sparse data point
  // (see Dashboard.jsx's collectedTrend).
  const [collectedLastMonthCount, setCollectedLastMonthCount] = useState(0)
  // Real all-time count of every logged event — not the 20-row recent
  // window above — for the sidebar Evidence card's "N actions recorded".
  const [totalEventsCount, setTotalEventsCount] = useState(0)
  // Wall-clock time of the last successful `load()` completion (initial or
  // silent background poll) — the one genuine signal this app has for
  // "how fresh is what's on screen." Not a realtime/websocket connection;
  // the Evidence rail badge must present this as freshness copy ("Updated
  // 2m ago"), never a live/paused claim tied to Autopilot state.
  const [lastSyncedAt, setLastSyncedAt] = useState(null)

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
      .select('id, event_type, invoice_id, created_at, lifecycle_state, evidence, invoices(inv_num, clients(name))')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20)

    // Second review-fix pass, HIGH: fetchAutopilotSettings() (autopilot.js)
    // returns `null` for BOTH "query succeeded, no settings row yet" and
    // "the query itself failed" — collapsing those into one value is fine
    // for that helper's only other would-be callers (there are none today
    // — see below), but wrong for Pulse's authority contract: a failed
    // query must never be read as "genuinely no Autopilot settings exist"
    // (which is what drives the safe "off" default everywhere else in the
    // app). This is Pulse's OWN raw query, deliberately not routed through
    // fetchAutopilotSettings(), so nothing about that shared helper (or any
    // future caller of it) changes. `ok: false` means the query failed;
    // `ok: true` with `row: null` means it succeeded and genuinely found no
    // settings row — those two are never conflated again below.
    const autopilotSettingsPromise = supabase
      .from('autopilot_settings')
      .select('id, user_id, enabled, approval_required')
      .eq('user_id', user.id)
      .maybeSingle()
      .then((r) => {
        if (r.error) {
          console.warn('autopilot_settings query failed:', r.error.message)
          return { ok: false, row: null }
        }
        return { ok: true, row: r.data }
      })
      .catch((err) => {
        console.warn('autopilot_settings query threw:', err.message)
        return { ok: false, row: null }
      })

    // Reminders Autopilot has drafted, of every status — not just pending.
    // Phase 2A.2 (HIGH fix): the real Deno fetchHandledState() folds EVERY
    // row carrying ai_context.rule_id into handledKeys, regardless of
    // status — a founder-skipped or approved draft still durably blocks
    // that exact invoice+rule from being recommended again, even with zero
    // execution claims (approval-mode rules never create one). Pulse must
    // agree with that same truth, not just the execution-claim half of it.
    // One all-status query serves both the UI's pending-only display list
    // AND the full historical handled-state input — never two divergent
    // queries that could disagree. `data` is null only on failure/`.catch()`
    // — never on a real "zero rows" result, which is what
    // toPendingInvoiceIds/toHandledKeys below depend on.
    const awaitingHistoryPromise = supabase
      .from('awaiting_signature')
      .select('*, invoices(*, clients(name))')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .then((r) => {
        if (r.error) console.warn('awaiting_signature query failed:', r.error.message)
        return r.error ? null : r.data || []
      })
      .catch((err) => {
        console.warn('awaiting_signature query threw:', err.message)
        return null
      })

    // Phase 2A.2: the founder's durable execution-claim history — the
    // authority contract's handledKeys input. Same fail-closed contract as
    // above: a real (possibly empty) array on success, null only when the
    // query itself failed — never silently collapsed into "no history."
    const executionClaimsPromise = supabase
      .from('autopilot_execution_claims')
      .select('invoice_id, rule_id')
      .eq('user_id', user.id)
      .eq('action_type', ACTION_TYPE_SEND_REMINDER)
      .then((r) => {
        if (r.error) console.warn('autopilot_execution_claims query failed:', r.error.message)
        return r.error ? null : r.data || []
      })
      .catch((err) => {
        console.warn('autopilot_execution_claims query threw:', err.message)
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

    // Phase 2A.2 HIGH fix: this is Pulse's own rules fetch, deliberately
    // NOT routed through fetchAutopilotRules() (autopilot.js), which
    // collapses a query error into `[]` — appropriate for its other
    // callers (InvoiceDetailPanel, CognitiveCompose, the Autopilot
    // settings page), which are display-only and already treat "no rules"
    // and "couldn't load rules" the same way, but wrong for Pulse's
    // authority contract: a failed rule query must never be read as
    // "genuinely zero rules exist" (evaluatePulseAuthority would then
    // truthfully-but-wrongly conclude "no rule matches" instead of
    // "couldn't verify"). `data` is null only on failure/`.catch()` —
    // never on a real "zero rules" result. Changing fetchAutopilotRules()
    // itself was deliberately avoided so none of its other callers'
    // behavior changes.
    const rulesPromise = supabase
      .from('autopilot_rules')
      .select('*')
      .eq('user_id', user.id)
      .order('sort_order', { ascending: true })
      .then((r) => {
        if (r.error) console.warn('autopilot_rules query failed:', r.error.message)
        return r.error ? null : r.data || []
      })
      .catch((err) => {
        console.warn('autopilot_rules query threw:', err.message)
        return null
      })

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
      .then((r) => {
        const rows = r.data || []
        return {
          sum: rows.reduce((sum, row) => sum + (Number(row.evidence?.amount) || 0), 0),
          count: rows.length,
        }
      })
      .catch(() => ({ sum: 0, count: 0 }))

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
      autopilotSettingsResult,
      awaitingHistory,
      lastRun,
      rules,
      checkedSince,
      draftedSince,
      collected,
      collectedLast,
      totalEvents,
      executionClaims,
    ] = await Promise.all([
      profilePromise,
      invoicesPromise,
      clientsPromise,
      eventsPromise,
      autopilotSettingsPromise,
      awaitingHistoryPromise,
      lastRunPromise,
      rulesPromise,
      checkedSincePromise,
      draftedSincePromise,
      collectedPromise,
      collectedLastMonthPromise,
      totalEventsPromise,
      executionClaimsPromise,
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
    // Second review-fix pass, HIGH: on a genuine query failure, keep the
    // existing safe "off"/"approval required" defaults for autopilotEnabled/
    // autopilotApprovalRequired (every OTHER consumer of those two fields —
    // Sidebar, the Autopilot settings page, InvoiceDetailPanel — is
    // unaffected and keeps behaving exactly as it already did), but ALSO
    // record that this was a failure, not a genuine empty settings row, via
    // autopilotSettingsUnavailable — Pulse/Dashboard alone reads that flag.
    setAutopilotEnabled(autopilotSettingsResult.ok ? autopilotSettingsResult.row?.enabled === true : false)
    setAutopilotApprovalRequired(
      autopilotSettingsResult.ok ? autopilotSettingsResult.row?.approval_required !== false : true
    )
    setAutopilotSettings(autopilotSettingsResult.ok ? autopilotSettingsResult.row : null)
    setAutopilotSettingsUnavailable(!autopilotSettingsResult.ok)
    // Phase 2A.2: null (either history source's query failed) is preserved
    // as null, never silently downgraded to an empty/partial Set — see the
    // field doc comments above, and toPendingInvoiceIds/toHandledKeys's own
    // doc comments, for why that distinction is load-bearing. handledKeys
    // is the union of signature history (any status) and execution claims,
    // matching the real Deno fetchHandledState() exactly — see
    // toHandledKeys's doc comment for the parity statement.
    setPendingInvoiceIds(toPendingInvoiceIds(awaitingHistory))
    setHandledKeys(toHandledKeys(executionClaims, awaitingHistory))
    setAwaitingSignature(
      (awaitingHistory || [])
        .filter((row) => row.status === 'pending')
        .map((row) => ({
          ...row,
          invoice: row.invoices ? normalizeInvoice(row.invoices) : null,
        }))
    )
    setLastAutopilotRun(lastRun || null)
    // Phase 2A.2 HIGH fix: `rules` is null only when the query itself
    // failed — preserved as null, never downgraded to `[]`, so
    // evaluatePulseAuthority can tell "checked, zero rules" apart from
    // "couldn't check." (`autopilotRules` is used only by Pulse/Dashboard;
    // no other consumer of this context field exists today.)
    setAutopilotRules(rules)
    setCollectedThisMonth(collected || 0)
    setCollectedLastMonth(collectedLast?.sum || 0)
    setCollectedLastMonthCount(collectedLast?.count || 0)
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
    setLastSyncedAt(Date.now())
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
  //
  // Second review-fix pass, HIGH: removing the card from the visible list
  // alone left pendingInvoiceIds/handledKeys stale until the next 30s
  // background poll — Pulse would keep re-deriving a fresh authority
  // evaluation that still says PENDING_ACTION_EXISTS for this exact
  // invoice+rule (harmless — classifyPulseRowState now honors that
  // correctly either way, never falling through to "Choose action"), but
  // it would NOT yet reflect the real post-resolution truth
  // (ALREADY_HANDLED once the real awaiting_signature row's status is
  // approved/skipped). `resolvedInvoiceId`/`resolvedRuleId` (passed by
  // SignatureCard from the row it just resolved) let this reconcile BOTH
  // local Sets immediately: drop the invoice from pendingInvoiceIds (no
  // pending draft remains for it) and add its invoice:rule key to
  // handledKeys (a founder decision was just made) — exactly the same
  // union shape toHandledKeys/toPendingInvoiceIds already build from a
  // real query, just applied as a local delta instead of a full refetch.
  const resolveSignatureLocal = useCallback((id, { invoiceId: resolvedInvoiceId, ruleId: resolvedRuleId } = {}) => {
    setAwaitingSignature((cur) => cur.filter((i) => i.id !== id))
    if (resolvedInvoiceId) {
      setPendingInvoiceIds((cur) => {
        if (cur === null) return cur
        if (!cur.has(resolvedInvoiceId)) return cur
        const next = new Set(cur)
        next.delete(resolvedInvoiceId)
        return next
      })
    }
    if (resolvedInvoiceId && resolvedRuleId) {
      setHandledKeys((cur) => {
        if (cur === null) return cur
        const key = `${resolvedInvoiceId}:${resolvedRuleId}`
        if (cur.has(key)) return cur
        const next = new Set(cur)
        next.add(key)
        return next
      })
    }
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
    userId: user?.id ?? null,
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
    // Phase 2A.2: the real, full autopilot_settings row (or null) — the
    // authority-contract input every Pulse authority evaluation needs.
    autopilotSettings,
    // Second review-fix pass, HIGH: true only when the settings query
    // itself failed — distinct from autopilotSettings === null (genuinely
    // no row). See its own state doc comment.
    autopilotSettingsUnavailable,
    setAutopilotEnabledLocal: setAutopilotEnabled,
    awaitingSignature,
    // Phase 2A.2: real Set on success, null when the load-bearing query
    // failed — never silently downgraded to empty. See state doc comments.
    handledKeys,
    pendingInvoiceIds,
    resolveSignatureLocal,
    lastAutopilotRun,
    hasCompletedAutopilotRun: lastAutopilotRun?.status === 'completed',
    autopilotRules,
    sinceLastVisit,
    collectedThisMonth,
    collectedLastMonth,
    collectedLastMonthCount,
    totalEventsCount,
    lastSyncedAt,
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
