-- Second execution-safety review-fix pass, HIGH: awaiting_signature's
-- original unique(user_id, invoice_id, status) constraint (schema.sql)
-- permits only ONE row per (user, invoice, status) combination FOREVER --
-- including 'approved'. That means once any rule's draft for an invoice
-- is approved, no OTHER rule can ever have its own draft approved for that
-- same invoice again, since a second row transitioning to status =
-- 'approved' would collide with the first.
--
-- Worse, this collision was reachable AFTER a real external send: the
-- execution-claim send path (autopilotExecutionCore.js's
-- recordSentEvidence) sends via Resend, resolves the durable claim, THEN
-- updates awaiting_signature.status = 'approved' -- so a second rule's
-- approval could have the email genuinely delivered and then fail on this
-- exact constraint while writing local bookkeeping, an external-succeeded/
-- local-failed inconsistency.
--
-- The real requirement is narrower than the original constraint: only one
-- PENDING ask per invoice at a time (so the founder never sees two open
-- signature requests for the same invoice simultaneously) -- historical
-- approved/rejected/skipped/expired rows must be free to coexist across
-- however many different rules eventually act on the same invoice.
alter table public.awaiting_signature
  drop constraint if exists awaiting_signature_user_id_invoice_id_status_key;

create unique index if not exists awaiting_signature_one_pending_per_invoice
  on public.awaiting_signature (user_id, invoice_id)
  where (status = 'pending');
