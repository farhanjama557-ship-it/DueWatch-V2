-- Phase 1.5B hosted SQL-safety compatibility correction.
--
-- Generated with Supabase CLI 2.111.0. Hosted staging already has the original
-- Phase 1.5B migration and the privilege-baseline correction, so this append-
-- only migration replaces only process_import_batch. Its definition is kept
-- byte-for-byte aligned with the corrected fresh-install migration except that
-- clearing the transaction-scoped temporary claim table now uses an explicit
-- predicate accepted by hosted require-WHERE guards.

create or replace function public.process_import_batch(
  p_run_id uuid,
  p_batch_size integer default 200
) returns jsonb
language plpgsql security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_run public.import_runs%rowtype;
  v_batch_index integer;
  v_batch_id uuid;
  v_row public.import_rows%rowtype;
  v_client_id uuid;
  v_was_created boolean;
  v_invoice_id uuid;
  v_invoice_result text;
  v_paid boolean;
  v_amount_paid numeric(12, 2);
  v_amount numeric(12, 2);
  v_currency text;
  v_payment_date date;
  v_source_system text;
  v_source_invoice_id text;
  v_lock_key bigint;
  v_row_count integer := 0;
  v_remaining integer;
  v_committed_in_call integer;
  v_existing public.invoices%rowtype;
  v_fallback_invoice_ids uuid[];
  v_fallback_match_count integer;
  v_conflict boolean;
  v_sanitized_reason text := 'An unexpected error occurred while processing this batch. No rows from this batch were saved.';
begin
  select * into v_run from public.import_runs where id = p_run_id for update;
  if not found then
    raise exception 'Import run not found';
  end if;
  if (select auth.uid()) is null or (select auth.uid()) <> v_run.user_id then
    raise exception 'Cannot process a batch for another user''s import run';
  end if;

  -- ---- server-enforced bounds (Blocker 2) ----
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 200 then
    raise exception 'p_batch_size must be an integer between 1 and 200 inclusive';
  end if;

  if v_run.status in ('completed', 'partially_completed', 'failed', 'cancelled') then
    return jsonb_build_object('status', v_run.status, 'run_id', p_run_id);
  end if;

  -- Cancellation is observed BETWEEN batches, never mid-batch: checked
  -- here, before any new batch is claimed, never inside the loop below.
  if v_run.cancel_requested_at is not null then
    update public.import_runs set status = 'cancelled', completed_at = now()
    where id = p_run_id;
    insert into public.import_events(run_id, user_id, event_type)
    values (p_run_id, v_run.user_id, 'run_completed');
    return jsonb_build_object('status', 'cancelled', 'run_id', p_run_id);
  end if;

  -- Claim up to p_batch_size PENDING rows. FOR UPDATE SKIP LOCKED means a
  -- second concurrent call for the same run claims a *different* set of
  -- rows (or none) rather than racing on the same ones. (Defense-in-depth:
  -- the run-row FOR UPDATE lock taken above already fully serializes
  -- concurrent calls for the SAME run — stated plainly, not overclaiming
  -- finer-grained concurrency than what's actually load-bearing here.)
  create temporary table if not exists _claimed_rows (id uuid primary key) on commit drop;
  delete from _claimed_rows
  where id is not null;
  insert into _claimed_rows
  select id from public.import_rows
  where run_id = p_run_id and batch_id is null and server_status = 'pending'
  order by row_number
  limit p_batch_size
  for update skip locked;

  select count(*) into v_row_count from _claimed_rows;

  if v_row_count = 0 then
    select count(*) into v_remaining from public.import_rows
    where run_id = p_run_id and server_status = 'pending';
    if v_remaining > 0 then
      -- Another concurrent worker holds the remaining pending rows right
      -- now; this run is not finished, just not claimable by us this call.
      return jsonb_build_object('status', 'in_progress', 'run_id', p_run_id, 'claimed', 0);
    end if;

    select count(*) into v_remaining from public.import_rows
    where run_id = p_run_id and server_status in ('blocked', 'failed');
    update public.import_runs
    set status = case when v_remaining > 0 then 'partially_completed' else 'completed' end,
        completed_at = now()
    where id = p_run_id;
    insert into public.import_events(run_id, user_id, event_type)
    values (p_run_id, v_run.user_id,
      case when v_remaining > 0 then 'run_partially_completed' else 'run_completed' end);
    return jsonb_build_object(
      'status', case when v_remaining > 0 then 'partially_completed' else 'completed' end,
      'run_id', p_run_id
    );
  end if;

  update public.import_runs set next_batch_index = next_batch_index + 1
  where id = p_run_id
  returning next_batch_index - 1 into v_batch_index;

  -- The batch row is inserted FIRST (status='in_progress') so that
  -- per-row UPDATEs referencing batch_id never violate
  -- import_rows_batch_id_fkey by pointing at a batch that doesn't exist
  -- yet. Its status is corrected to 'committed' or 'failed' below, once
  -- known.
  v_batch_id := gen_random_uuid();
  insert into public.import_batches(id, run_id, user_id, batch_index, status, row_count)
  values (v_batch_id, p_run_id, v_run.user_id, v_batch_index, 'in_progress', v_row_count);

  insert into public.import_events(run_id, user_id, event_type, detail)
  values (p_run_id, v_run.user_id, 'batch_started', jsonb_build_object('batch_index', v_batch_index, 'row_count', v_row_count));

  -- Nested block = implicit savepoint. Any unexpected exception here rolls
  -- back every row-level write in this batch (invoice inserts, client
  -- creates via the resolver, import_rows updates) while letting the
  -- OUTER block still record a truthful 'batch_failed' fact afterward —
  -- the failure record itself is not part of what gets rolled back.
  begin
    for v_row in
      select r.* from public.import_rows r
      join _claimed_rows c on c.id = r.id
      order by r.row_number
    loop
      begin
        select * from duewatch_ops.resolve_client_for_import(
          v_run.user_id,
          v_row.material_payload->>'client_name',
          v_row.material_payload->>'client_email',
          v_row.material_payload->>'client_phone',
          v_row.material_payload->>'client_company',
          v_row.material_payload->>'source_system',
          v_row.material_payload->>'source_client_id',
          jsonb_build_object('import_run_id', p_run_id, 'row_id', v_row.id)
        ) into v_client_id, v_was_created;
      exception when others then
        -- Row-vs-batch exception classification (Blocker 1): only
        -- explicitly defined, expected business outcomes of the resolver
        -- may block a single row. 'Ambiguous client identity...' (v_count
        -- > 1 in resolve_or_create_client) and 'Client name is required'
        -- (no usable normalized name) are the resolver's own two named,
        -- deterministic, data-dependent failure modes — genuinely
        -- reachable even after this migration's own strong-identity gate,
        -- since an email match can still be ambiguous across two existing
        -- clients, and client_name is not itself a required material
        -- field. Anything else (permission errors, schema drift, type
        -- errors, serialization failures, unexpected nulls) is NOT a
        -- known business outcome and must re-raise, aborting and rolling
        -- back the whole batch via the outer savepoint — never silently
        -- blocking just this row for a reason nobody defined.
        if sqlerrm = 'Ambiguous client identity; select a client explicitly' then
          update public.import_rows
          set server_status = 'blocked',
              block_reason_code = 'AMBIGUOUS_CLIENT_IDENTITY',
              block_reason_detail = jsonb_build_object('message', 'Multiple existing clients match this row''s identity.'),
              batch_id = v_batch_id
          where id = v_row.id;
          insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
          values (p_run_id, v_run.user_id, v_batch_id, v_row.id, 'row_blocked',
            jsonb_build_object('reason_code', 'AMBIGUOUS_CLIENT_IDENTITY'));
          continue;
        elsif sqlerrm = 'Client name is required' then
          update public.import_rows
          set server_status = 'blocked',
              block_reason_code = 'MISSING_CLIENT_NAME',
              block_reason_detail = jsonb_build_object('message', 'No usable client name was provided.'),
              batch_id = v_batch_id
          where id = v_row.id;
          insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
          values (p_run_id, v_run.user_id, v_batch_id, v_row.id, 'row_blocked',
            jsonb_build_object('reason_code', 'MISSING_CLIENT_NAME'));
          continue;
        else
          raise;
        end if;
      end;

      -- ---- durable, tenant-scoped invoice-source-identity (Blocker 6) ----
      -- source_system normalized case-insensitively (lower/trim, matching
      -- client_source_identities' own convention); source_invoice_id
      -- outer-trimmed but case-sensitive. Strongest identity when both
      -- present; fallback is (client_id, invoice_number) — invoice number
      -- alone is never sufficient, a client_id is always part of the
      -- fallback key.
      v_source_system := nullif(lower(trim(v_row.material_payload->>'source_system')), '');
      v_source_invoice_id := nullif(trim(v_row.material_payload->>'source_invoice_id'), '');

      v_lock_key := hashtextextended(
        v_run.user_id::text || ':inv:' || coalesce(
          case when v_source_system is not null and v_source_invoice_id is not null
            then v_source_system || ':' || v_source_invoice_id
          end,
          v_client_id::text || ':' || (v_row.material_payload->>'invoice_number')
        ), 0
      );
      perform pg_advisory_xact_lock(v_lock_key);

      if v_source_system is not null and v_source_invoice_id is not null then
        select i.* into v_existing from public.invoices i
        where i.user_id = v_run.user_id
          and i.source_system = v_source_system
          and i.source_invoice_id = v_source_invoice_id;
      else
        -- A source-less fallback is not structurally unique in the legacy
        -- invoice schema. Probe at most two IDs under the existing fallback
        -- advisory lock: zero means insert, one is safe to compare, and two
        -- is enough to prove ambiguity without choosing or exposing either
        -- candidate. Ordering is deterministic only for testability; an
        -- ambiguous candidate is never selected regardless of that order.
        select coalesce(array_agg(matches.id order by matches.id), '{}'::uuid[])
        into v_fallback_invoice_ids
        from (
          select i.id
          from public.invoices i
          where i.user_id = v_run.user_id
            and i.client_id = v_client_id
            and i.inv_num = (v_row.material_payload->>'invoice_number')
            and i.source_system is null and i.source_invoice_id is null
          order by i.id
          limit 2
        ) matches;

        v_fallback_match_count := cardinality(v_fallback_invoice_ids);
        if v_fallback_match_count > 1 then
          update public.import_rows
          set server_status = 'blocked',
              block_reason_code = 'AMBIGUOUS_INVOICE_IDENTITY',
              block_reason_detail = jsonb_build_object(
                'message', 'Multiple existing invoices match this client and invoice number. Review is required.'
              ),
              batch_id = v_batch_id,
              invoice_id = null,
              invoice_result = null
          where id = v_row.id;
          insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
          values (p_run_id, v_run.user_id, v_batch_id, v_row.id, 'row_blocked',
            jsonb_build_object(
              'reason_code', 'AMBIGUOUS_INVOICE_IDENTITY',
              'message', 'Multiple existing invoices match this client and invoice number. Review is required.'
            ));
          continue;
        elsif v_fallback_match_count = 1 then
          select i.* into strict v_existing
          from public.invoices i
          where i.id = v_fallback_invoice_ids[1]
            and i.user_id = v_run.user_id;
        else
          v_existing := null;
        end if;
      end if;

      -- status -> paid boolean translation (the real schema has no status
      -- column; this is Phase 1.5B's one authoritative, locked
      -- translation, never re-derived elsewhere):
      --   'paid'                          -> paid = true
      --   'partial' / 'draft' / 'sent' /
      --   'overdue' / null (blank)        -> paid = false
      --   'void'                          -> blocked before reaching here
      --                                      (see evaluate_row_eligibility)
      -- coalesce is required: `null = 'paid'` evaluates to NULL, not
      -- false, and invoices.paid is not-null — a blank/omitted status
      -- must resolve to paid = false, not an unassigned NULL.
      v_amount := (v_row.material_payload->>'amount')::numeric(12, 2);
      v_paid := coalesce(v_row.material_payload->>'status', '') = 'paid';
      v_amount_paid := case
        when v_row.material_payload->>'amount_paid' is not null
          then (v_row.material_payload->>'amount_paid')::numeric(12,2)
        when v_paid then v_amount
        else 0
      end;
      v_currency := nullif(v_row.material_payload->>'currency', '');
      v_payment_date := nullif(v_row.material_payload->>'payment_date', '')::date;

      if v_existing.id is not null then
        -- Idempotent-retry vs conflicting-retry: an EXACT match on every
        -- material fact is a safe, idempotent already_existed outcome. Any
        -- difference is a conflict — never committed, saved, inserted, or
        -- silently skipped, and the existing invoice is never overwritten.
        v_conflict :=
          v_existing.amount is distinct from v_amount
          or v_existing.inv_date is distinct from (v_row.material_payload->>'invoice_date')::date
          or v_existing.due_date is distinct from nullif(v_row.material_payload->>'due_date', '')::date
          or v_existing.paid is distinct from v_paid
          or v_existing.amount_paid is distinct from v_amount_paid
          or v_existing.currency is distinct from v_currency
          or v_existing.payment_date is distinct from v_payment_date;

        if v_conflict then
          update public.import_rows
          set server_status = 'blocked',
              block_reason_code = 'INVOICE_MATERIAL_CONFLICT',
              block_reason_detail = jsonb_build_object(
                'existing_invoice_id', v_existing.id,
                'message', 'An invoice with this identity already exists with different details.'
              ),
              batch_id = v_batch_id
          where id = v_row.id;
          insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
          values (p_run_id, v_run.user_id, v_batch_id, v_row.id, 'row_blocked',
            jsonb_build_object('reason_code', 'INVOICE_MATERIAL_CONFLICT', 'existing_invoice_id', v_existing.id));
          continue;
        end if;

        v_invoice_id := v_existing.id;
        v_invoice_result := 'already_existed';
      else
        insert into public.invoices(
          user_id, client_id, inv_num, amount, amount_paid,
          inv_date, due_date, paid, currency, payment_date,
          source_system, source_invoice_id
        ) values (
          v_run.user_id, v_client_id,
          v_row.material_payload->>'invoice_number',
          v_amount,
          v_amount_paid,
          (v_row.material_payload->>'invoice_date')::date,
          nullif(v_row.material_payload->>'due_date', '')::date,
          v_paid,
          v_currency,
          v_payment_date,
          v_source_system,
          v_source_invoice_id
        )
        returning id into v_invoice_id;
        v_invoice_result := 'inserted';
      end if;

      update public.import_rows
      set server_status = 'committed',
          batch_id = v_batch_id,
          client_id = v_client_id,
          client_result = case when v_was_created then 'created' else 'matched' end,
          invoice_id = v_invoice_id,
          invoice_result = v_invoice_result,
          committed_at = now()
      where id = v_row.id;

      insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
      values (p_run_id, v_run.user_id, v_batch_id, v_row.id,
        case when v_was_created then 'client_created' else 'client_matched' end,
        jsonb_build_object('client_id', v_client_id));
      insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
      values (p_run_id, v_run.user_id, v_batch_id, v_row.id,
        case when v_invoice_result = 'inserted' then 'invoice_inserted' else 'invoice_already_existed' end,
        jsonb_build_object('invoice_id', v_invoice_id));
    end loop;

    -- Batch row committed only now, once every claimed row in it has a
    -- durable outcome (committed or blocked) — this UPDATE and every
    -- import_rows/import_events write above are part of the SAME
    -- transaction as the function call itself, so they commit together
    -- or not at all.
    update public.import_batches
    set status = 'committed', row_count = v_row_count
    where id = v_batch_id;
    insert into public.import_events(run_id, user_id, batch_id, event_type, detail)
    values (p_run_id, v_run.user_id, v_batch_id, 'batch_committed', jsonb_build_object('row_count', v_row_count));
  exception when others then
    -- Savepoint rollback undid every row-level write above; the claimed
    -- rows are back to server_status='pending', batch_id=null — exactly
    -- as if this call never happened, safe to retry. The import_batches
    -- row itself (status='in_progress') was inserted before the savepoint
    -- began and is NOT rolled back, so it must be corrected via UPDATE,
    -- not re-inserted. Raw SQLERRM is logged server-side and stored in the
    -- operator-only internal_diagnostic column — never returned to the
    -- caller or written into an authenticated-visible event.
    raise log 'process_import_batch: batch % (run %) failed: %', v_batch_id, p_run_id, sqlerrm;
    update public.import_batches
    set status = 'failed', failure_reason = v_sanitized_reason, internal_diagnostic = sqlerrm
    where id = v_batch_id;
    insert into public.import_events(run_id, user_id, batch_id, event_type, detail)
    values (p_run_id, v_run.user_id, v_batch_id, 'batch_failed', jsonb_build_object('message', v_sanitized_reason));
    return jsonb_build_object('status', 'batch_failed', 'run_id', p_run_id, 'reason', v_sanitized_reason);
  end;

  -- Truthful progress (Blocker 9): count what was ACTUALLY committed in
  -- this call, straight from import_rows, rather than reusing the claimed
  -- count (some claimed rows may have been blocked, not committed).
  select count(*) into v_committed_in_call
  from public.import_rows where batch_id = v_batch_id and server_status = 'committed';

  return jsonb_build_object(
    'status', 'in_progress', 'run_id', p_run_id,
    'committed', v_committed_in_call, 'claimed', v_row_count
  );
end
$$;
revoke execute on function public.process_import_batch(uuid, integer) from public, anon;
grant execute on function public.process_import_batch(uuid, integer) to authenticated, service_role;

-- Fail closed if the corrected reset or callable contract drifts.
do $postconditions$
declare
  v_definition text;
  v_config text[];
  v_security_definer boolean;
begin
  select pg_get_functiondef(p.oid), p.proconfig, p.prosecdef
  into v_definition, v_config, v_security_definer
  from pg_proc p
  where p.oid = 'public.process_import_batch(uuid, integer)'::regprocedure;

  if not v_security_definer then
    raise exception 'process_import_batch must remain SECURITY DEFINER';
  end if;
  if v_config is distinct from array['search_path=public, duewatch_ops, pg_temp']::text[] then
    raise exception 'process_import_batch search_path drifted: %', v_config;
  end if;
  if position('delete from _claimed_rows;' in lower(v_definition)) > 0 then
    raise exception 'Unsafe WHERE-less _claimed_rows reset remains';
  end if;
  if position('delete from _claimed_rows' || chr(10) || '  where id is not null;' in lower(v_definition)) = 0 then
    raise exception 'Expected WHERE-qualified _claimed_rows reset is missing';
  end if;
  if not has_function_privilege('authenticated', 'public.process_import_batch(uuid, integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.process_import_batch(uuid, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.process_import_batch(uuid, integer)', 'EXECUTE') then
    raise exception 'process_import_batch EXECUTE contract drifted';
  end if;
end
$postconditions$;
