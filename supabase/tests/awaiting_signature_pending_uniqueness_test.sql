-- Second execution-safety review-fix pass, HIGH: awaiting_signature's
-- original unique(user_id, invoice_id, status) constraint permitted only
-- one row per (user, invoice, status) FOREVER -- including 'approved',
-- which meant only one rule's draft could ever be approved for a given
-- invoice. Apply schema.sql, then
-- 20260814090000_awaiting_signature_pending_only_uniqueness.sql, before
-- running this file. Everything here runs inside one transaction that
-- always rolls back.
begin;

\echo 'TEST GROUP START: multiple_rules_approved_historically_coexist'
do $coexist$
declare
  u uuid := gen_random_uuid();
  inv uuid;
  rule_a uuid := gen_random_uuid();
  rule_b uuid := gen_random_uuid();
  sig_a uuid;
  sig_b uuid;
  approved_count integer;
begin
  insert into auth.users(id, email) values (u, 'awaiting-sig-coexist@example.test');
  insert into public.invoices(id, user_id, amount, due_date, paid)
  values (gen_random_uuid(), u, 100, '2026-08-01', false)
  returning id into inv;

  -- Rule A's draft is queued, then approved.
  insert into public.awaiting_signature(id, user_id, invoice_id, recommended_tone, draft_content, ai_reason, ai_context, status)
  values (gen_random_uuid(), u, inv, 'friendly', 'draft A', 'reason A', jsonb_build_object('rule_id', rule_a), 'pending')
  returning id into sig_a;
  update public.awaiting_signature set status = 'approved', resolved_at = now() where id = sig_a;

  -- Later, Rule B's draft is queued and approved for the SAME invoice --
  -- this is exactly the write the original broad constraint would have
  -- rejected once Rule A's row was already 'approved'.
  insert into public.awaiting_signature(id, user_id, invoice_id, recommended_tone, draft_content, ai_reason, ai_context, status)
  values (gen_random_uuid(), u, inv, 'firm', 'draft B', 'reason B', jsonb_build_object('rule_id', rule_b), 'pending')
  returning id into sig_b;
  update public.awaiting_signature set status = 'approved', resolved_at = now() where id = sig_b;

  select count(*) into approved_count
  from public.awaiting_signature
  where user_id = u and invoice_id = inv and status = 'approved';
  if approved_count <> 2 then
    raise exception 'expected both rule A and rule B approvals to coexist, got % approved rows', approved_count;
  end if;
end
$coexist$;
\echo 'TEST GROUP PASS: multiple_rules_approved_historically_coexist'

\echo 'TEST GROUP START: only_one_pending_ask_per_invoice_at_a_time'
do $one_pending$
declare
  u uuid := gen_random_uuid();
  inv uuid;
  rule_a uuid := gen_random_uuid();
  rule_b uuid := gen_random_uuid();
  raised boolean := false;
begin
  insert into auth.users(id, email) values (u, 'awaiting-sig-one-pending@example.test');
  insert into public.invoices(id, user_id, amount, due_date, paid)
  values (gen_random_uuid(), u, 100, '2026-08-01', false)
  returning id into inv;

  insert into public.awaiting_signature(id, user_id, invoice_id, recommended_tone, draft_content, ai_reason, ai_context, status)
  values (gen_random_uuid(), u, inv, 'friendly', 'draft A', 'reason A', jsonb_build_object('rule_id', rule_a), 'pending');

  begin
    insert into public.awaiting_signature(id, user_id, invoice_id, recommended_tone, draft_content, ai_reason, ai_context, status)
    values (gen_random_uuid(), u, inv, 'firm', 'draft B', 'reason B', jsonb_build_object('rule_id', rule_b), 'pending');
  exception when unique_violation then
    raised := true;
  end;
  if not raised then
    raise exception 'expected a second simultaneous pending row for the same user/invoice to be rejected';
  end if;
end
$one_pending$;
\echo 'TEST GROUP PASS: only_one_pending_ask_per_invoice_at_a_time'

\echo 'TEST GROUP START: rule_b_approval_write_never_fails_because_rule_a_already_approved'
do $write_order$
declare
  u uuid := gen_random_uuid();
  inv uuid;
  rule_a uuid := gen_random_uuid();
  rule_b uuid := gen_random_uuid();
  sig_b uuid;
begin
  insert into auth.users(id, email) values (u, 'awaiting-sig-write-order@example.test');
  insert into public.invoices(id, user_id, amount, due_date, paid)
  values (gen_random_uuid(), u, 100, '2026-08-01', false)
  returning id into inv;

  -- Rule A already durably approved (simulating an earlier send).
  insert into public.awaiting_signature(id, user_id, invoice_id, recommended_tone, draft_content, ai_reason, ai_context, status, resolved_at)
  values (gen_random_uuid(), u, inv, 'friendly', 'draft A', 'reason A', jsonb_build_object('rule_id', rule_a), 'approved', now());

  -- Rule B's draft is queued...
  insert into public.awaiting_signature(id, user_id, invoice_id, recommended_tone, draft_content, ai_reason, ai_context, status)
  values (gen_random_uuid(), u, inv, 'firm', 'draft B', 'reason B', jsonb_build_object('rule_id', rule_b), 'pending')
  returning id into sig_b;

  -- ...and now approved AFTER the (simulated) external send already
  -- succeeded. This exact write is what the original broad constraint
  -- would have thrown on -- an external-succeeded/local-write-failed
  -- inconsistency. It must succeed cleanly now.
  update public.awaiting_signature set status = 'approved', resolved_at = now() where id = sig_b;

  if (select status from public.awaiting_signature where id = sig_b) <> 'approved' then
    raise exception 'expected rule B''s row to reach approved status without being blocked by rule A''s prior approval';
  end if;
end
$write_order$;
\echo 'TEST GROUP PASS: rule_b_approval_write_never_fails_because_rule_a_already_approved'

rollback;
