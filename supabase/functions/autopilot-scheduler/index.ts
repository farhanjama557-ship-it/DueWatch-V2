// Daily Autopilot scheduler (Quiet Mode only — Session 7 scope). For every
// user with Autopilot enabled: loads their rules and unpaid invoices,
// figures out what's newly eligible, and either queues it to
// awaiting_signature (review mode) or sends it immediately via Resend
// (auto mode). Writes exactly one autopilot_runs row per user per run,
// including zero-action runs — nothing about "Last checked" is ever faked.
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
import { sendEmail } from '../_shared/resend.js'
import { planRun, daysOverdue, daysUntil } from '../_shared/rules.js'
import { reminderDraft, explainRule } from '../_shared/draftTemplate.js'

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
    const [{ data: rules }, { data: invoices }, { data: existingSignatures }] = await Promise.all([
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
      admin.from('awaiting_signature').select('invoice_id, status, ai_context').eq('user_id', userId),
    ])

    invoicesChecked = (invoices || []).length

    const handledKeys = new Set(
      (existingSignatures || [])
        .filter((r) => r.ai_context?.rule_id)
        .map((r) => `${r.invoice_id}:${r.ai_context.rule_id}`)
    )
    const pendingInvoiceIds = new Set(
      (existingSignatures || []).filter((r) => r.status === 'pending').map((r) => r.invoice_id)
    )

    const { toProcess, deferred } = planRun({
      invoices: invoices || [],
      rules: rules || [],
      handledKeys,
      pendingInvoiceIds,
      today,
      cap: MAX_PER_RUN,
    })
    remindersSkipped = deferred

    for (const { invoice, rule } of toProcess) {
      try {
        await actOnMatch({ userId, invoice, rule, approvalRequired: settings.approval_required, today })
        remindersDrafted += 1
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
    // Review mode: queue for the founder's signature. No email sent yet.
    const { error } = await admin.from('awaiting_signature').insert({
      user_id: userId,
      invoice_id: invoice.id,
      action_type: 'send_reminder',
      recommended_tone: rule.tone,
      draft_content: draft,
      ai_reason: reason,
      ai_context: ruleContext,
      status: 'pending',
    })
    if (error) throw error
    return
  }

  // Auto mode: send immediately. If the client has no email on file, fall
  // back to queuing for review rather than silently dropping the reminder.
  const to = invoice.clients?.email
  const nowIso = new Date().toISOString()

  if (!to) {
    await admin.from('awaiting_signature').insert({
      user_id: userId,
      invoice_id: invoice.id,
      action_type: 'send_reminder',
      recommended_tone: rule.tone,
      draft_content: draft,
      ai_reason: `${reason} No email on file — needs your review.`,
      ai_context: ruleContext,
      status: 'pending',
    })
    return
  }

  const sendResult = await sendEmail({
    to,
    subject: `Regarding invoice ${invoice.inv_num || ''}`.trim(),
    text: draft,
  })

  await admin.from('reminders').insert({
    invoice_id: invoice.id,
    user_id: userId,
    title: 'Reminder sent',
    detail: draft,
  })
  await admin.from('invoices').update({ last_reminder: nowIso }).eq('id', invoice.id)
  await admin.from('events').insert({
    user_id: userId,
    event_type: 'reminder_sent',
    invoice_id: invoice.id,
    lifecycle_stage: 'sent',
    lifecycle_state: sendResult.error ? 'error' : 'completed',
    evidence: {
      reason,
      trigger: rule.name,
      approved_by: 'Autopilot (auto-send)',
      resend_id: sendResult.id || null,
      delivery_status: sendResult.error || 'sent',
      ...ruleContext,
    },
  })

  if (sendResult.error) throw new Error(sendResult.error)
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
