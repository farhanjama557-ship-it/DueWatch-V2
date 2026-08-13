// Daily Autopilot scheduler (Quiet Mode only — Session 7 scope). For every
// user with Autopilot enabled: loads their rules and unpaid invoices,
// figures out what's newly eligible, and either queues it to
// awaiting_signature (review mode) or sends it immediately via Resend
// (auto mode). Writes exactly one autopilot_runs row per user per run,
// including zero-action runs — nothing about "Last checked" is ever faked.
//
// Post-2A.1 execution safety checkpoint (review-fix pass): before any
// write, actOnMatch re-establishes CURRENT authority via the Phase 2A.1
// engine (never a second, simplified check) and, for auto-send, routes the
// actual external request through autopilotExecutionCore's
// executeAutoSend() — the SAME durable execution boundary the manual
// approval Edge Function (send-reminder-email) also calls, so scheduler
// auto-send and founder Approve & Send share one at-most-once guarantee.
//
// Deploy: supabase functions deploy autopilot-scheduler
// Schedule: Supabase Dashboard -> Edge Functions -> autopilot-scheduler ->
//   Schedule a cron trigger, e.g. "0 13 * * *" (once daily). Or via SQL:
//   select cron.schedule('autopilot-daily', '0 13 * * *',
//     $$ select net.http_post(
//          url := '<project-url>/functions/v1/autopilot-scheduler',
//          headers := jsonb_build_object(
//            'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
//            'Content-Type', 'application/json'
//          )
//        ) $$
//   );  -- requires the pg_cron and pg_net extensions enabled on the project
import { createClient } from 'npm:@supabase/supabase-js@2'
import { sendEmail, isProviderConfigured } from '../_shared/resend.js'
import { planRun, daysOverdue, daysUntil } from '../_shared/rules.js'
import { reminderDraft, explainRule } from '../_shared/draftTemplate.js'
import { evaluateNextActionAuthority } from '../_shared/nextActionAuthority.js'
import { executeAutoSend, SEND_OUTCOME } from '../_shared/autopilotExecutionCore.js'
import { fetchHandledState, fetchAuthorityInputs } from '../_shared/autopilotAuthorityInputs.js'

const MAX_PER_RUN = 10 // safety rail: Resend rate limits + no surprise batches

const admin = createClient(
  Deno.env.get('SUPABASE_URL'),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
)

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function formatMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    Number(n) || 0
  )
}

function formatShortDate(value) {
  if (!value) return '—'
  const [y, m, d] = String(value).split('-').map(Number)
  if (!y || !m || !d) return '—'
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

Deno.serve(async (_req) => {
  const today = startOfToday()

  const { data: enabledSettings, error: settingsErr } = await admin
    .from('autopilot_settings')
    .select('user_id, approval_required')
    .eq('enabled', true)

  if (settingsErr) {
    return json({ error: settingsErr.message }, 500)
  }

  const summaries = []

  for (const settings of enabledSettings || []) {
    summaries.push(await runForUser(settings, today))
  }

  return json({ usersProcessed: summaries.length, summaries })
})

async function runForUser(settings, today) {
  const userId = settings.user_id

  const { data: run, error: runInsertErr } = await admin
    .from('autopilot_runs')
    .insert({ user_id: userId, status: 'running' })
    .select('id')
    .single()

  if (runInsertErr) {
    return { userId, error: runInsertErr.message }
  }

  let invoicesChecked = 0
  let remindersDrafted = 0
  let remindersSkipped = 0
  let errors = 0

  try {
    const [{ data: rules }, { data: invoices }, handledState] = await Promise.all([
      admin
        .from('autopilot_rules')
        .select('*')
        .eq('user_id', userId)
        .eq('enabled', true)
        .order('sort_order', { ascending: true }),
      // autopilot_paused invoices are excluded entirely — the per-invoice
      // toggle (Session 7.5 #7) must actually stop Autopilot from acting,
      // not just look paused in the UI.
      admin
        .from('invoices')
        .select('*, clients(name, email)')
        .eq('user_id', userId)
        .eq('paid', false)
        .eq('autopilot_paused', false),
      fetchHandledState(admin, userId),
    ])

    invoicesChecked = (invoices || []).length

    const { toProcess, deferred } = planRun({
      invoices: invoices || [],
      rules: rules || [],
      handledKeys: handledState.handledKeys,
      pendingInvoiceIds: handledState.pendingInvoiceIds,
      today,
      cap: MAX_PER_RUN,
    })
    remindersSkipped = deferred

    for (const { invoice, rule } of toProcess) {
      try {
        const result = await actOnMatch({ userId, invoice, rule, approvalRequired: settings.approval_required, today })
        // MEDIUM 1: a lost claim race or a stale-authority skip performed
        // no actual work and must not be counted as drafted/sent.
        if (result?.counted) remindersDrafted += 1
      } catch (err) {
        errors += 1
        console.error(`autopilot-scheduler: user ${userId} invoice ${invoice.id}:`, err)
      }
    }

    await admin
      .from('autopilot_runs')
      .update({
        status: 'completed',
        invoices_checked: invoicesChecked,
        reminders_drafted: remindersDrafted,
        reminders_skipped: remindersSkipped,
        errors,
        completed_at: new Date().toISOString(),
      })
      .eq('id', run.id)

    return { userId, invoicesChecked, remindersDrafted, remindersSkipped, errors }
  } catch (err) {
    await admin
      .from('autopilot_runs')
      .update({
        status: 'error',
        invoices_checked: invoicesChecked,
        errors: errors + 1,
        completed_at: new Date().toISOString(),
      })
      .eq('id', run.id)
    return { userId, error: err?.message || 'Unexpected error' }
  }
}

// Real, Supabase-backed implementation of autopilotExecutionCore's `io`
// interface for one invoice/rule candidate. Every write's error is
// checked and thrown, not silently ignored (HIGH 2).
function buildIo({ userId, invoice, rule, reason, draft }) {
  return {
    async fetchAuthorityInputs({ invoiceId }) {
      return fetchAuthorityInputs(admin, { userId, invoiceId })
    },
    isProviderConfigured,
    async acquireClaim({ userId: uid, invoiceId, ruleId, actionType, idempotencyKey }) {
      const { data, error } = await admin.rpc('acquire_autopilot_execution_claim', {
        p_user_id: uid,
        p_invoice_id: invoiceId,
        p_rule_id: ruleId,
        p_action_type: actionType,
        p_idempotency_key: idempotencyKey,
      })
      if (error) throw error
      const row = data?.[0]
      return { claimId: row?.claim_id, acquired: row?.acquired === true }
    },
    async resolveClaim({ claimId, status, providerMessageId, evidence }) {
      const { error } = await admin
        .from('autopilot_execution_claims')
        .update({
          status,
          resolved_at: new Date().toISOString(),
          provider_message_id: providerMessageId ?? null,
          evidence: evidence ?? {},
        })
        .eq('id', claimId)
      if (error) throw error
    },
    sendEmail,
    async queueForReview() {
      const { error } = await admin.from('awaiting_signature').insert({
        user_id: userId,
        invoice_id: invoice.id,
        action_type: 'send_reminder',
        recommended_tone: rule.tone,
        draft_content: draft,
        ai_reason: `${reason} No email on file — needs your review.`,
        ai_context: {
          rule_id: rule.id,
          rule_name: rule.name,
          trigger_type: rule.trigger_type,
          trigger_days: rule.trigger_days,
        },
        status: 'pending',
      })
      if (error) throw error
    },
    async recordSentEvidence({ claimId, sendResult }) {
      const nowIso = new Date().toISOString()
      const { error: remErr } = await admin.from('reminders').insert({
        invoice_id: invoice.id,
        user_id: userId,
        title: 'Reminder sent',
        detail: draft,
      })
      if (remErr) throw remErr

      const { error: invErr } = await admin.from('invoices').update({ last_reminder: nowIso }).eq('id', invoice.id)
      if (invErr) throw invErr

      const { error: evErr } = await admin.from('events').insert({
        user_id: userId,
        event_type: 'reminder_sent',
        invoice_id: invoice.id,
        lifecycle_stage: 'sent',
        lifecycle_state: 'completed',
        evidence: {
          reason,
          trigger: rule.name,
          approved_by: 'Autopilot (auto-send)',
          resend_id: sendResult.id || null,
          delivery_status: 'sent',
          execution_claim_id: claimId,
          rule_id: rule.id,
          rule_name: rule.name,
          trigger_type: rule.trigger_type,
          trigger_days: rule.trigger_days,
        },
      })
      if (evErr) throw evErr
    },
    async recordFailureEvidence({ claimId, error }) {
      // HIGH 2: distinct event_type so this never renders as "Sent a
      // reminder" -- a truthful failure receipt, not a silent automation.
      const { error: evErr } = await admin.from('events').insert({
        user_id: userId,
        event_type: 'reminder_send_failed',
        invoice_id: invoice.id,
        lifecycle_stage: 'sent',
        lifecycle_state: 'error',
        evidence: {
          reason,
          trigger: rule.name,
          approved_by: 'Autopilot (auto-send)',
          delivery_status: error,
          execution_claim_id: claimId,
          rule_id: rule.id,
          rule_name: rule.name,
        },
      })
      if (evErr) throw evErr
    },
    async recordUncertainEvidence({ claimId, error }) {
      // HIGH 2: visible, durable evidence that Duewatch stopped and will
      // not auto-retry because completion could not be proven.
      const { error: evErr } = await admin.from('events').insert({
        user_id: userId,
        event_type: 'reminder_send_uncertain',
        invoice_id: invoice.id,
        lifecycle_stage: 'sent',
        lifecycle_state: 'error',
        evidence: {
          reason,
          trigger: rule.name,
          approved_by: 'Autopilot (auto-send)',
          delivery_status: 'Duewatch stopped automatically; completion could not be proven, so no retry was attempted.',
          error,
          execution_claim_id: claimId,
          rule_id: rule.id,
          rule_name: rule.name,
        },
      })
      if (evErr) throw evErr
    },
  }
}

async function actOnMatch({ userId, invoice, rule, approvalRequired, today }) {
  const clientName = invoice.clients?.name || 'No client'
  const balance = formatMoney((Number(invoice.amount) || 0) - (Number(invoice.amount_paid) || 0))
  const dueDate = formatShortDate(invoice.due_date)
  const draft = reminderDraft(rule.tone, {
    clientName,
    invoiceNumber: invoice.inv_num,
    balance,
    dueDate,
  })
  const reason = explainRule(rule, {
    daysOverdueCount: daysOverdue(invoice.due_date, today),
    daysUntilCount: daysUntil(invoice.due_date, today),
  })
  const ruleContext = {
    rule_id: rule.id,
    rule_name: rule.name,
    trigger_type: rule.trigger_type,
    trigger_days: rule.trigger_days,
  }

  if (approvalRequired) {
    // BLOCKER 2: stamp the draft with a freshly-established authority
    // receipt (via the real Phase 2A.1 engine, never a second simplified
    // check) so a later Approve & Send has real provenance to revalidate
    // against, rather than inventing one at approval time. Drafting makes
    // no external request, so no execution claim is needed here.
    const inputs = await fetchAuthorityInputs(admin, { userId, invoiceId: invoice.id })
    const evaluation = evaluateNextActionAuthority({
      userId,
      invoice: inputs.invoice,
      rules: inputs.rules,
      autopilotSettings: inputs.autopilotSettings,
      handledKeys: inputs.handledKeys,
      pendingInvoiceIds: inputs.pendingInvoiceIds,
      now: today,
    })
    if (!evaluation.authority.authorized || evaluation.authority.basis.ruleId !== rule.id) {
      return { counted: false, outcome: 'stale_authority', detail: evaluation.authority.blockedReason }
    }

    const { error } = await admin.from('awaiting_signature').insert({
      user_id: userId,
      invoice_id: invoice.id,
      action_type: 'send_reminder',
      recommended_tone: rule.tone,
      draft_content: draft,
      ai_reason: reason,
      ai_context: { ...ruleContext, authority: evaluation.authority },
      status: 'pending',
    })
    if (error) throw error
    return { counted: true, outcome: 'drafted' }
  }

  // Auto mode: route through the SAME durable execution boundary the
  // manual approval Edge Function uses. executeAutoSend performs its OWN
  // fresh authority re-establishment internally (BLOCKER 2) immediately
  // before acquiring any claim -- this call IS the execution boundary, not
  // a second check layered on top of one already done here.
  const io = buildIo({ userId, invoice, rule, reason, draft })
  const result = await executeAutoSend({
    userId,
    invoiceId: invoice.id,
    ruleId: rule.id,
    subject: `Regarding invoice ${invoice.inv_num || ''}`.trim(),
    text: draft,
    now: today,
    io,
  })

  if (result.outcome === SEND_OUTCOME.SENT || result.outcome === SEND_OUTCOME.NO_EMAIL_FALLBACK) {
    return { counted: true, outcome: result.outcome }
  }
  // CLAIM_LOST, STALE_AUTHORITY, PROVIDER_NOT_CONFIGURED: no work was
  // actually performed -- never counted as drafted/sent (MEDIUM 1).
  return { counted: false, outcome: result.outcome, detail: result.detail }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
