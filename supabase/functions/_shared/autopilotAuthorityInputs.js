// Shared "fetch CURRENT, complete authority inputs" helper — used by both
// the scheduler (auto-send, autopilot-scheduler/index.ts) and the manual
// approval Edge Function (Approve & Send, send-reminder-email/index.ts),
// so both re-check authority against the exact same fresh-state query
// shape (post-2A.1 execution safety checkpoint, BLOCKER 2). Takes `admin`
// as an explicit parameter rather than importing/constructing a client
// itself, so this stays a plain function over an injected Supabase client.
import { ACTION_TYPE_SEND_REMINDER } from './executionClaim.js'

export async function fetchHandledState(admin, userId) {
  const [{ data: existingSignatures }, { data: existingClaims }] = await Promise.all([
    admin.from('awaiting_signature').select('invoice_id, status, ai_context').eq('user_id', userId),
    // autopilot_execution_claims is the durable record of every auto-send
    // attempt (any status) -- feeding it into handledKeys is what resolves
    // the "first rule forever" defect discovered and deferred across
    // Phase 2A.1's second and third review-fix passes.
    admin
      .from('autopilot_execution_claims')
      .select('invoice_id, rule_id')
      .eq('user_id', userId)
      .eq('action_type', ACTION_TYPE_SEND_REMINDER),
  ])
  const handledKeys = new Set([
    ...(existingSignatures || [])
      .filter((r) => r.ai_context?.rule_id)
      .map((r) => `${r.invoice_id}:${r.ai_context.rule_id}`),
    ...(existingClaims || []).map((c) => `${c.invoice_id}:${c.rule_id}`),
  ])
  const pendingInvoiceIds = new Set(
    (existingSignatures || []).filter((r) => r.status === 'pending').map((r) => r.invoice_id)
  )
  return { handledKeys, pendingInvoiceIds }
}

export async function fetchAuthorityInputs(admin, { userId, invoiceId }) {
  const [{ data: invoice }, { data: rules }, { data: autopilotSettings }, handledState] = await Promise.all([
    admin.from('invoices').select('*, clients(name, email)').eq('id', invoiceId).maybeSingle(),
    admin.from('autopilot_rules').select('*').eq('user_id', userId),
    admin.from('autopilot_settings').select('id, user_id, enabled, approval_required').eq('user_id', userId).maybeSingle(),
    fetchHandledState(admin, userId),
  ])
  return {
    invoice,
    rules: rules || [],
    autopilotSettings,
    handledKeys: handledState.handledKeys,
    pendingInvoiceIds: handledState.pendingInvoiceIds,
  }
}
