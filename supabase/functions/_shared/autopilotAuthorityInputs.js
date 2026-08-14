// Shared "fetch CURRENT, complete authority inputs" helper — used by both
// the scheduler (auto-send, autopilot-scheduler/index.ts) and the manual
// approval Edge Function (Approve & Send / Edit First,
// send-reminder-email/index.ts), so both re-check authority against the
// exact same fresh-state query shape (post-2A.1 execution safety
// checkpoint, BLOCKER 2). Takes `admin` as an explicit parameter rather
// than importing/constructing a client itself, so this stays a plain
// function over an injected Supabase client.
import { ACTION_TYPE_SEND_REMINDER } from './executionClaim.js'

// Second review-fix pass, HIGH: a query-level error (bad RLS, connection
// hiccup, etc.) must never silently become "no execution history" --
// Phase 2A.1's own doctrine is that "successfully checked and empty" is
// NOT the same as "unavailable." Any load-bearing query error here now
// throws, which propagates to the caller's own catch (the scheduler's
// per-invoice try/catch, or the Edge Function's try/catch) and is treated
// as a hard failure -- never silently downgraded to an empty Set that
// would let a send through on missing evidence.
export async function fetchHandledState(admin, userId, { excludeAwaitingSignatureId = null } = {}) {
  const [
    { data: existingSignatures, error: signaturesErr },
    { data: existingClaims, error: claimsErr },
  ] = await Promise.all([
    admin.from('awaiting_signature').select('id, invoice_id, status, ai_context').eq('user_id', userId),
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
  if (signaturesErr) throw signaturesErr
  if (claimsErr) throw claimsErr

  // Second review-fix pass, BLOCKER: the exact awaiting_signature row
  // currently being approved would otherwise appear in BOTH pendingInvoiceIds
  // (its own status === 'pending') and handledKeys (its own ai_context.rule_id)
  // -- meaning revalidateAuthority would reject the very row it's supposed
  // to be revalidating, via PENDING_ACTION_EXISTS / ALREADY_HANDLED, before
  // it could ever reach claim acquisition. Excluding ONLY that exact row's
  // own contribution (never any OTHER row) restores the correct semantics:
  // a different pending row for the same invoice, or a genuinely prior
  // historical claim, must still block, exactly as before.
  const relevantSignatures = (existingSignatures || []).filter((r) => r.id !== excludeAwaitingSignatureId)

  const handledKeys = new Set([
    ...relevantSignatures
      .filter((r) => r.ai_context?.rule_id)
      .map((r) => `${r.invoice_id}:${r.ai_context.rule_id}`),
    ...(existingClaims || []).map((c) => `${c.invoice_id}:${c.rule_id}`),
  ])
  const pendingInvoiceIds = new Set(
    relevantSignatures.filter((r) => r.status === 'pending').map((r) => r.invoice_id)
  )
  return { handledKeys, pendingInvoiceIds }
}

export async function fetchAuthorityInputs(admin, { userId, invoiceId, excludeAwaitingSignatureId = null } = {}) {
  const [
    { data: invoice, error: invoiceErr },
    { data: rules, error: rulesErr },
    { data: autopilotSettings, error: settingsErr },
    handledState,
  ] = await Promise.all([
    admin.from('invoices').select('*, clients(name, email)').eq('id', invoiceId).maybeSingle(),
    admin.from('autopilot_rules').select('*').eq('user_id', userId),
    admin.from('autopilot_settings').select('id, user_id, enabled, approval_required').eq('user_id', userId).maybeSingle(),
    fetchHandledState(admin, userId, { excludeAwaitingSignatureId }),
  ])
  // maybeSingle() resolves { data: null, error: null } for "no row found" --
  // that's a legitimate fact (no settings yet / invoice truly missing), not
  // a query failure. Only a real `.error` fails this closed.
  if (invoiceErr) throw invoiceErr
  if (rulesErr) throw rulesErr
  if (settingsErr) throw settingsErr

  return {
    invoice,
    rules: rules || [],
    autopilotSettings,
    handledKeys: handledState.handledKeys,
    pendingInvoiceIds: handledState.pendingInvoiceIds,
  }
}
