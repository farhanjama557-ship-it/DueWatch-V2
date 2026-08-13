// Daily Autopilot scheduler (Quiet Mode only — Session 7 scope). For every
// user with Autopilot enabled: loads their rules and unpaid invoices,
// figures out what's newly eligible, and either queues it to
// awaiting_signature (review mode) or sends it immediately via Resend
// (auto mode). Writes exactly one autopilot_runs row per user per run,
// including zero-action runs — nothing about "Last checked" is ever faked.
//
// Post-2A.1 execution safety checkpoint (review-fix passes): every write
// re-establishes CURRENT authority via the Phase 2A.1 engine (never a
// second, simplified check), and auto-send routes the actual external
// request through autopilotExecutionCore's executeAutoSend() — the SAME
// durable execution boundary the manual approval Edge Function
// (Approve & Send AND Edit First) also calls. The draft/subject/reason are
// built from the SAME fresh invoice/rule state that authorized them
// (second pass, BLOCKER 3) — never a plan-time snapshot paired with a
// freshly-established authority receipt.
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
import { evaluateNextActionAuthority, buildRuleSnapshot } from '../_shared/nextActionAuthority.js'
import { executeAutoSend, SEND_OUTCOME, deriveFactualBasis } from '../_shared/autopilotExecutionCore.js'
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

// The single builder for a rule-backed message, called ONLY from fresh
// invoice/rule state (never a plan-time snapshot) — see buildMessage below
// and executeAutoSend's own fresh-state re-establishment.
function buildReminder(invoice, rule, factualBasis, today) {
  const draft = reminderDraft(rule.tone, {
    clientName: factualBasis.clientName,
    invoiceNumber: factualBasis.invNum,
    balance: factualBasis.balance,
    dueDate: factualBasis.dueDate,
  })
  const reason = explainRule(rule, {
    daysOverdueCount: daysOverdue(invoice.due_date, today),
    daysUntilCount: daysUntil(invoice.due_date, today),
  })
  return { draft, reason }
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
        // Only the ids of the plan-time candidate cross into actOnMatch --
        // every other field is re-established fresh inside it (BLOCKER 3).
        const result = await actOnMatch({
          userId,
          invoiceId: invoice.id,
          ruleId: rule.id,
          approvalRequired: settings.approval_required,
          today,
        })
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
// interface. Only `userId`/`invoiceId` are captured — every write's target
// row content (draft text, evidence, invoice fact strings) comes from the
// arguments runClaimedSend passes in, which are themselves derived from
// the FRESH state executeAutoSend establishes, never from a closed-over
// plan-time snapshot. Every write's error is checked and thrown, not
// silently ignored (HIGH 2, first pass).
function buildIo({ userId, invoiceId }) {
  return {
    async fetchAuthorityInputs({ invoiceId: id }) {
      return fetchAuthorityInputs(admin, { userId, invoiceId: id })
    },
    isProviderConfigured,
    async acquireClaim({ userId: uid, invoiceId: iid, ruleId, actionType, idempotencyKey }) {
      const { data, error } = await admin.rpc('acquire_autopilot_execution_claim', {
        p_user_id: uid,
        p_invoice_id: iid,
        p_rule_id: ruleId,
        p_action_type: actionType,
        p_idempotency_key: idempotencyKey,
      })
      if (error) throw error
      const row = data?.[0]
      if (row?.acquired) {
        return { claimId: row.claim_id, acquired: true }
      }
      // MEDIUM (existing claim outcome truthfulness): look up the REAL
      // prior status so a blocked caller can say what's actually known
      // (sent / send_failed / uncertain / in_flight) instead of a generic
      // "already handled."
      let existingStatus = null
      if (row?.claim_id) {
        const { data: existing } = await admin
          .from('autopilot_execution_claims')
          .select('status')
          .eq('id', row.claim_id)
          .maybeSingle()
        existingStatus = existing?.status ?? null
      }
      return { claimId: row?.claim_id, acquired: false, existingStatus }
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
    async queueForReview({ draft, draftReason, tone, authority, factualBasis }) {
      const { error } = await admin.from('awaiting_signature').insert({
        user_id: userId,
        invoice_id: invoiceId,
        action_type: 'send_reminder',
        recommended_tone: tone ?? null,
        draft_content: draft ?? '',
        ai_reason: `${draftReason || ''} No email on file — needs your review.`.trim(),
        ai_context: {
          rule_id: authority?.basis?.ruleId ?? null,
          rule_name: authority?.basis?.ruleName ?? null,
          authority,
          factualBasis,
        },
        status: 'pending',
      })
      if (error) throw error
    },
    async recordSentEvidence({ claimId, sendResult, authority, reason, text }) {
      const nowIso = new Date().toISOString()
      const { error: remErr } = await admin.from('reminders').insert({
        invoice_id: invoiceId,
        user_id: userId,
        title: 'Reminder sent',
        detail: text,
      })
      if (remErr) throw remErr

      const { error: invErr } = await admin.from('invoices').update({ last_reminder: nowIso }).eq('id', invoiceId)
      if (invErr) throw invErr

      const { error: evErr } = await admin.from('events').insert({
        user_id: userId,
        event_type: 'reminder_sent',
        invoice_id: invoiceId,
        lifecycle_stage: 'sent',
        lifecycle_state: 'completed',
        evidence: {
          reason,
          trigger: authority?.basis?.ruleName ?? null,
          approved_by: 'Autopilot (auto-send)',
          resend_id: sendResult.id || null,
          delivery_status: 'sent',
          execution_claim_id: claimId,
          // MEDIUM (persisted rule snapshot integrity): the receipt must
          // prove what policy actually authorized the action, not just
          // carry a bare rule id.
          rule_id: authority?.basis?.ruleId ?? null,
          rule_name: authority?.basis?.ruleName ?? null,
          rule_snapshot_hash: authority?.ruleSnapshotHash ?? null,
          authorized_at: authority?.evaluatedAt ?? null,
        },
      })
      if (evErr) throw evErr
    },
    async recordFailureEvidence({ claimId, error, authority, reason }) {
      // HIGH 2 (first pass): distinct event_type so this never renders as
      // "Sent a reminder" -- a truthful failure receipt, not a silent
      // automation.
      const { error: evErr } = await admin.from('events').insert({
        user_id: userId,
        event_type: 'reminder_send_failed',
        invoice_id: invoiceId,
        lifecycle_stage: 'sent',
        lifecycle_state: 'error',
        evidence: {
          reason,
          trigger: authority?.basis?.ruleName ?? null,
          approved_by: 'Autopilot (auto-send)',
          delivery_status: error,
          execution_claim_id: claimId,
          rule_id: authority?.basis?.ruleId ?? null,
          rule_name: authority?.basis?.ruleName ?? null,
          rule_snapshot_hash: authority?.ruleSnapshotHash ?? null,
          authorized_at: authority?.evaluatedAt ?? null,
        },
      })
      if (evErr) throw evErr
    },
    async recordUncertainEvidence({ claimId, error, authority, reason }) {
      // HIGH 2 (first pass): visible, durable evidence that Duewatch
      // stopped and will not auto-retry because completion could not be
      // proven.
      const { error: evErr } = await admin.from('events').insert({
        user_id: userId,
        event_type: 'reminder_send_uncertain',
        invoice_id: invoiceId,
        lifecycle_stage: 'sent',
        lifecycle_state: 'error',
        evidence: {
          reason,
          trigger: authority?.basis?.ruleName ?? null,
          approved_by: 'Autopilot (auto-send)',
          delivery_status: 'Duewatch stopped automatically; completion could not be proven, so no retry was attempted.',
          error,
          execution_claim_id: claimId,
          rule_id: authority?.basis?.ruleId ?? null,
          rule_name: authority?.basis?.ruleName ?? null,
          rule_snapshot_hash: authority?.ruleSnapshotHash ?? null,
          authorized_at: authority?.evaluatedAt ?? null,
        },
      })
      if (evErr) throw evErr
    },
  }
}

async function actOnMatch({ userId, invoiceId, ruleId, approvalRequired, today }) {
  if (approvalRequired) {
    // BLOCKER 2: re-establish CURRENT authority via the real Phase 2A.1
    // engine, never a second simplified check. BLOCKER 3: the draft text
    // and the persisted factual-basis/rule-snapshot must come from this
    // SAME fresh fetch -- never a plan-time snapshot paired with a fresh
    // authority receipt. Drafting makes no external request, so no
    // execution claim is needed here.
    const inputs = await fetchAuthorityInputs(admin, { userId, invoiceId })
    const evaluation = evaluateNextActionAuthority({
      userId,
      invoice: inputs.invoice,
      rules: inputs.rules,
      autopilotSettings: inputs.autopilotSettings,
      handledKeys: inputs.handledKeys,
      pendingInvoiceIds: inputs.pendingInvoiceIds,
      now: today,
    })
    if (!evaluation.authority.authorized || evaluation.authority.basis.ruleId !== ruleId) {
      return { counted: false, outcome: 'stale_authority', detail: evaluation.authority.blockedReason }
    }

    const rule = inputs.rules.find((r) => r.id === evaluation.authority.basis.ruleId)
    const invoice = inputs.invoice
    const factualBasis = deriveFactualBasis(invoice)
    const { draft, reason } = buildReminder(invoice, rule, factualBasis, today)

    const { error } = await admin.from('awaiting_signature').insert({
      user_id: userId,
      invoice_id: invoiceId,
      action_type: 'send_reminder',
      recommended_tone: rule.tone,
      draft_content: draft,
      ai_reason: reason,
      ai_context: {
        rule_id: rule.id,
        rule_name: rule.name,
        trigger_type: rule.trigger_type,
        trigger_days: rule.trigger_days,
        authority: evaluation.authority,
        factualBasis,
        ruleSnapshot: buildRuleSnapshot(rule),
      },
      status: 'pending',
    })
    if (error) throw error
    return { counted: true, outcome: 'drafted' }
  }

  // Auto mode: route through the SAME durable execution boundary the
  // manual approval Edge Function uses. executeAutoSend performs its OWN
  // fresh authority re-establishment internally (BLOCKER 2), and builds
  // the message from that SAME fresh state via buildMessage below
  // (BLOCKER 3) -- never a plan-time snapshot.
  const io = buildIo({ userId, invoiceId })
  const result = await executeAutoSend({
    userId,
    invoiceId,
    ruleId,
    buildMessage: (invoice, rule, factualBasis) => {
      const { draft, reason } = buildReminder(invoice, rule, factualBasis, today)
      return {
        subject: `Regarding invoice ${invoice.inv_num || ''}`.trim(),
        text: draft,
        reason,
      }
    },
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
