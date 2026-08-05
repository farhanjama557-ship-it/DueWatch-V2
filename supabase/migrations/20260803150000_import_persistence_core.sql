-- Phase 1.5B Checkpoint 1: safe, server-authoritative import persistence
-- core. Takes normalized, eligible importer rows and persists canonical
-- clients and invoices in bounded batches with durable, truthful outcomes.
--
-- Revised after independent review (see DUEWATCH_CONTEXT_LOG.md) to fix:
-- row-vs-batch exception classification and SQLERRM exposure, missing
-- server-side input bounds, incomplete server-authoritative eligibility
-- (date/amount/currency/status/paid-consistency, ready-with-issues
-- contradiction, warning acknowledgement), weak-client-identity auto-
-- persistence, a matched-vs-created bug on source-identity retries, a
-- missing durable invoice-source-identity/conflict contract, silently
-- dropped material fields (currency/payment_date/source_system/
-- source_invoice_id), a SELECT-then-INSERT race in run idempotency,
-- progress counts that didn't include runtime-blocked rows, and missing
-- tenant-safe composite FKs across the full import graph.
--
-- Architecture (preserving PR #22's Architecture B):
--   - public.resolve_or_create_client(...)'s signature and matching policy
--     are UNCHANGED. This migration adds a companion wrapper,
--     duewatch_ops.resolve_client_for_import(...), that determines
--     matched-vs-created truthfully under the SAME advisory lock the
--     resolver itself takes internally, without reimplementing or
--     duplicating any matching rule. See that function's own comment for
--     exactly how it avoids a race without touching the resolver.
--   - Every new function below follows the two conventions already
--     established in this repository, combined: internal orchestration
--     functions live in `duewatch_ops` (mirroring PR #22's
--     prepare/execute/rollback functions), but the entry points a
--     founder's own browser session calls are SECURITY DEFINER, granted
--     to `authenticated`, and independently re-check `auth.uid() =
--     p_user_id` inside the function body — the exact pattern
--     `public.resolve_or_create_client` itself already uses. This lets the
--     browser drive batch persistence directly (as it already does for
--     ordinary invoice creation) without granting `authenticated` direct
--     write access to any of these tables.
--   - Every new table is tenant-owned, RLS-enabled, `authenticated`-select-
--     only (writes happen only inside the SECURITY DEFINER functions,
--     never via direct grants) — mirroring PR #22's
--     client_dedup_runs/client_merge_candidates/client_merge_audit tables
--     exactly.
--
-- Scope (Checkpoint 1 only): eligibility revalidation, idempotent batched
-- persistence, minimum recovery mechanics (retry, cancellation, failed-
-- batch rollback, refresh reconstruction). No UI polish, no animations, no
-- AI, no saved mappings, no fuzzy matching — see DUEWATCH_CONTEXT_LOG.md's
-- 2026-08-03 entry for the full deferral list.

-- ============================================================
-- Server-side mirror of the eligibility allowlist
-- ============================================================
-- The browser's own preview outcome/issue codes are never authoritative —
-- this table is this migration's own independent copy of exactly which
-- issue codes block import, verified by reading every makeIssue() call
-- site in src/lib/import/normalize.js (see the identical comment and table
-- in src/lib/importPersistence/eligibility.js, which both derive from the
-- same audit so neither module trusts the other).
create schema if not exists duewatch_ops;

create table if not exists duewatch_ops.import_issue_codes (
  code text primary key,
  blocks_import boolean not null
);
revoke all on duewatch_ops.import_issue_codes from public, anon, authenticated;

insert into duewatch_ops.import_issue_codes(code, blocks_import) values
  ('EMPTY_FILE', true),
  ('HEADERS_ONLY', true),
  ('DUPLICATE_HEADER', true),
  ('MALFORMED_FILE', true),
  ('MISSING_REQUIRED_MAPPING', true),
  ('MISSING_REQUIRED_VALUE', true),
  ('INVALID_AMOUNT', true),
  ('AMBIGUOUS_AMOUNT_FORMAT', true),
  ('INVALID_DATE', true),
  ('AMBIGUOUS_DATE_FORMAT', true),
  ('MIXED_DATE_FORMATS', true),
  ('UNKNOWN_STATUS', true),
  ('PAID_WITHOUT_PAYMENT_DATE', false),
  ('AMOUNT_PAID_EXCEEDS_AMOUNT', true),
  ('PARTIAL_PAYMENT_REVIEW', true),
  ('DUPLICATE_IN_UPLOAD', true),
  ('DUPLICATE_DETECTION_INCOMPLETE', false),
  ('FORMULA_VALUE_UNAVAILABLE', false),
  ('FORMULA_CACHED_VALUE_USED', false),
  ('UNSUPPORTED_CURRENCY', true),
  ('CURRENCY_DECISION_REQUIRED', true),
  ('ROW_COLUMN_COUNT_MISMATCH', false),
  ('FILE_TOO_LARGE', true),
  ('ROW_LIMIT_EXCEEDED', true)
on conflict (code) do update set blocks_import = excluded.blocks_import;

create table if not exists duewatch_ops.import_approved_warning_codes (
  code text primary key references duewatch_ops.import_issue_codes(code)
);
revoke all on duewatch_ops.import_approved_warning_codes from public, anon, authenticated;

insert into duewatch_ops.import_approved_warning_codes(code) values
  ('DUPLICATE_DETECTION_INCOMPLETE'),
  ('FORMULA_CACHED_VALUE_USED'),
  ('FORMULA_VALUE_UNAVAILABLE'),
  ('PAID_WITHOUT_PAYMENT_DATE'),
  ('ROW_COLUMN_COUNT_MISMATCH')
on conflict (code) do nothing;

-- Mirrors src/lib/import/fields.js's STATUS_VALUES and
-- src/lib/import/money.js's SUPPORTED_CURRENCIES — local copies for the
-- same independent-auditability reason the issue-code table above is a
-- local copy, not a reference into the importer engine.
create table if not exists duewatch_ops.import_status_values (
  value text primary key
);
revoke all on duewatch_ops.import_status_values from public, anon, authenticated;
insert into duewatch_ops.import_status_values(value) values
  ('draft'), ('sent'), ('paid'), ('partial'), ('overdue'), ('void')
on conflict (value) do nothing;

create table if not exists duewatch_ops.import_supported_currencies (
  code text primary key
);
revoke all on duewatch_ops.import_supported_currencies from public, anon, authenticated;
insert into duewatch_ops.import_supported_currencies(code) values
  ('USD'), ('CAD'), ('GBP'), ('EUR'), ('AUD'), ('NZD')
on conflict (code) do nothing;

-- Server-side eligibility re-evaluation. `stable` (not `immutable`) because
-- it reads from the lookup tables above, whose contents this function
-- depends on. Mirrors src/lib/importPersistence/eligibility.js's
-- evaluateRowEligibility() field-for-field. p_warnings_acknowledged is a
-- REQUEST-level fact (see start_import_run) — a single row can never
-- assert its own acknowledgement.
drop function if exists duewatch_ops.evaluate_row_eligibility(text, text[], jsonb);
create or replace function duewatch_ops.evaluate_row_eligibility(
  p_outcome text,
  p_issue_codes text[],
  p_normalized jsonb,
  p_warnings_acknowledged boolean
) returns table(eligible boolean, reason_code text)
language plpgsql stable security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_code text;
  v_blocks boolean;
  v_approved boolean;
  v_amount numeric(12, 2);
  v_amount_paid numeric(12, 2);
  v_status text;
  v_has_source_identity boolean;
  v_has_email_identity boolean;
  v_ok boolean;
begin
  if p_outcome is null or p_outcome not in ('ready', 'ready_with_warnings') then
    if p_outcome = 'review_required' then
      return query select false, 'REVIEW_REQUIRED'; return;
    elsif p_outcome = 'rejected' then
      return query select false, 'REJECTED'; return;
    else
      return query select false, 'UNKNOWN_OUTCOME'; return;
    end if;
  end if;

  -- A genuine 'ready' outcome never carries any issue at all (see
  -- normalize.js's computeOutcome: issues.length > 0 always yields
  -- 'ready_with_warnings'). A row claiming 'ready' while carrying ANY
  -- issue code is internally contradictory.
  if p_outcome = 'ready' and coalesce(array_length(p_issue_codes, 1), 0) > 0 then
    return query select false, 'OUTCOME_ISSUE_MISMATCH'; return;
  end if;

  if p_issue_codes is not null then
    foreach v_code in array p_issue_codes loop
      select ic.blocks_import into v_blocks
      from duewatch_ops.import_issue_codes ic where ic.code = v_code;

      if v_blocks is null then
        return query select false, 'UNKNOWN_ISSUE_CODE'; return;
      end if;
      if v_blocks then
        return query select false, 'BLOCKING_ISSUE_ON_ELIGIBLE_OUTCOME'; return;
      end if;
      select exists(
        select 1 from duewatch_ops.import_approved_warning_codes w where w.code = v_code
      ) into v_approved;
      if not v_approved then
        return query select false, 'UNAPPROVED_WARNING_CODE'; return;
      end if;
    end loop;
  end if;

  if p_outcome = 'ready_with_warnings'
     and coalesce(array_length(p_issue_codes, 1), 0) > 0
     and not coalesce(p_warnings_acknowledged, false) then
    return query select false, 'WARNINGS_NOT_ACKNOWLEDGED'; return;
  end if;

  if coalesce(trim(p_normalized->>'invoice_number'), '') = '' then
    return query select false, 'MISSING_MATERIAL_FIELD'; return;
  end if;
  if coalesce(p_normalized->>'invoice_date', '') = '' then
    return query select false, 'MISSING_MATERIAL_FIELD'; return;
  end if;
  if coalesce(p_normalized->>'amount', '') = '' then
    return query select false, 'MISSING_MATERIAL_FIELD'; return;
  end if;

  if p_normalized->>'invoice_date' !~ '^\d{4}-\d{2}-\d{2}$' then
    return query select false, 'INVALID_DATE_VALUE'; return;
  end if;
  begin
    perform (p_normalized->>'invoice_date')::date;
  exception when others then
    return query select false, 'INVALID_DATE_VALUE'; return;
  end;
  if coalesce(p_normalized->>'due_date', '') <> '' then
    if p_normalized->>'due_date' !~ '^\d{4}-\d{2}-\d{2}$' then
      return query select false, 'INVALID_DATE_VALUE'; return;
    end if;
    begin
      perform (p_normalized->>'due_date')::date;
    exception when others then
      return query select false, 'INVALID_DATE_VALUE'; return;
    end;
  end if;
  if coalesce(p_normalized->>'payment_date', '') <> '' then
    if p_normalized->>'payment_date' !~ '^\d{4}-\d{2}-\d{2}$' then
      return query select false, 'INVALID_DATE_VALUE'; return;
    end if;
    begin
      perform (p_normalized->>'payment_date')::date;
    exception when others then
      return query select false, 'INVALID_DATE_VALUE'; return;
    end;
  end if;

  if p_normalized->>'amount' !~ '^-?\d{1,10}\.\d{2}$' then
    return query select false, 'INVALID_AMOUNT_VALUE'; return;
  end if;
  v_amount := (p_normalized->>'amount')::numeric(12, 2);
  if v_amount <= 0 then
    return query select false, 'NON_POSITIVE_AMOUNT'; return;
  end if;

  if coalesce(p_normalized->>'currency', '') <> '' then
    select exists(
      select 1 from duewatch_ops.import_supported_currencies c where c.code = p_normalized->>'currency'
    ) into v_ok;
    if not v_ok then
      return query select false, 'UNSUPPORTED_CURRENCY'; return;
    end if;
  end if;

  v_amount_paid := null;
  if coalesce(p_normalized->>'amount_paid', '') <> '' then
    if p_normalized->>'amount_paid' !~ '^-?\d{1,10}\.\d{2}$' then
      return query select false, 'INVALID_AMOUNT_PAID_VALUE'; return;
    end if;
    v_amount_paid := (p_normalized->>'amount_paid')::numeric(12, 2);
    if v_amount_paid < 0 or v_amount_paid > v_amount then
      return query select false, 'AMOUNT_PAID_OUT_OF_RANGE'; return;
    end if;
  end if;

  v_status := p_normalized->>'status';
  if coalesce(v_status, '') <> '' then
    if v_status = 'void' then
      return query select false, 'UNSUPPORTED_STATUS_VALUE'; return;
    end if;
    select exists(select 1 from duewatch_ops.import_status_values s where s.value = v_status) into v_ok;
    if not v_ok then
      return query select false, 'UNKNOWN_STATUS_VALUE'; return;
    end if;
    if v_status = 'paid' and v_amount_paid is not null and v_amount_paid <> v_amount then
      return query select false, 'PAID_STATUS_AMOUNT_MISMATCH'; return;
    end if;
  end if;

  -- Strong client identity only (see this migration's client-identity
  -- comment on resolve_client_for_import): company/name-only or name-only
  -- identity is not retry-safe automatic identity and must never
  -- auto-persist. Required: EITHER source_system + source_client_id, OR a
  -- present client_email.
  v_has_source_identity :=
    coalesce(trim(p_normalized->>'source_system'), '') <> ''
    and coalesce(trim(p_normalized->>'source_client_id'), '') <> '';
  v_has_email_identity := coalesce(trim(p_normalized->>'client_email'), '') <> '';
  if not v_has_source_identity and not v_has_email_identity then
    return query select false, 'WEAK_CLIENT_IDENTITY'; return;
  end if;

  return query select true, null::text;
end
$$;
revoke execute on function duewatch_ops.evaluate_row_eligibility(text, text[], jsonb, boolean)
  from public, anon, authenticated;
grant execute on function duewatch_ops.evaluate_row_eligibility(text, text[], jsonb, boolean)
  to service_role;

-- ============================================================
-- Tables
-- ============================================================

create table if not exists public.import_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  -- Hash of the exact logical request (rows + acknowledgement flag) that
  -- created this run (see start_import_run). A retry with the SAME
  -- idempotency_key must submit the SAME request; a mismatch fails closed
  -- rather than silently returning a run whose stored rows don't match
  -- what the caller just sent.
  request_payload_hash text not null,
  warnings_acknowledged boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'completed', 'partially_completed', 'failed', 'cancelled')),
  total_rows integer not null default 0,
  eligible_rows integer not null default 0,
  blocked_rows integer not null default 0,
  next_batch_index integer not null default 0,
  cancel_requested_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique(user_id, idempotency_key),
  -- Tenant-safe composite FK target for import_batches/import_rows below.
  unique(user_id, id)
);
create index if not exists import_runs_user_idx on public.import_runs(user_id, created_at desc);

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_index integer not null,
  status text not null check (status in ('in_progress', 'committed', 'failed')),
  row_count integer not null default 0,
  -- Customer-facing, sanitized: never raw SQLERRM (may contain schema,
  -- column, or data-derived text). See internal_diagnostic below for the
  -- operator-only counterpart.
  failure_reason text,
  -- Raw diagnostic detail for unexpected failures, never granted to
  -- `authenticated` (see the column-scoped GRANT below) — operator/
  -- service_role visibility only, alongside a `raise log` at the point of
  -- failure.
  internal_diagnostic text,
  created_at timestamptz not null default now(),
  unique(run_id, batch_index),
  unique(user_id, id),
  foreign key (user_id, run_id) references public.import_runs(user_id, id) on delete cascade
);
create index if not exists import_batches_run_idx on public.import_batches(run_id, batch_index);

create table if not exists public.import_rows (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  batch_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  row_number integer not null,
  row_idempotency_key text not null,
  material_payload jsonb not null,
  material_payload_hash text not null,
  server_status text not null default 'pending'
    check (server_status in ('pending', 'committed', 'blocked', 'failed')),
  block_reason_code text,
  block_reason_detail jsonb,
  client_id uuid references public.clients(id),
  client_result text check (client_result in ('matched', 'created')),
  invoice_id uuid references public.invoices(id),
  invoice_result text check (invoice_result in ('inserted', 'already_existed')),
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(run_id, row_number),
  unique(user_id, row_idempotency_key),
  unique(user_id, id),
  foreign key (user_id, run_id) references public.import_runs(user_id, id) on delete cascade,
  foreign key (user_id, batch_id) references public.import_batches(user_id, id) on delete set null
);
create index if not exists import_rows_run_status_idx
  on public.import_rows(run_id, server_status, row_number);
create index if not exists import_rows_batch_idx on public.import_rows(batch_id);

create table if not exists public.import_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid,
  row_id uuid,
  event_type text not null check (event_type in (
    'run_created', 'batch_started', 'client_matched', 'client_created',
    'invoice_inserted', 'invoice_already_existed', 'row_blocked',
    'batch_committed', 'batch_failed', 'cancellation_requested',
    'run_partially_completed', 'run_completed', 'run_failed'
  )),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (user_id, run_id) references public.import_runs(user_id, id) on delete cascade,
  foreign key (user_id, batch_id) references public.import_batches(user_id, id) on delete set null,
  foreign key (user_id, row_id) references public.import_rows(user_id, id) on delete set null
);
create index if not exists import_events_run_idx on public.import_events(run_id, created_at);

-- ---- material fields the original Checkpoint 1 draft silently dropped ----
-- currency/payment_date/source_system/source_invoice_id are enumerated
-- material fields (materialPayload.js) but the invoice insert never
-- persisted them. All four are nullable with NO default — a blank
-- currency stays null, never silently defaulted to 'USD'; existing
-- (non-imported) invoices simply read null for all four, meaning
-- "not tracked," which is accurate, not a guess.
alter table public.invoices add column if not exists currency text;
alter table public.invoices add column if not exists payment_date date;
alter table public.invoices add column if not exists source_system text;
alter table public.invoices add column if not exists source_invoice_id text;

-- ---- tenant-safe composite FKs, matching PR #22's established pattern ----
-- invoices needs the same (user_id, id) unique index clients already got
-- from PR #22's tenant-ownership migration, since import_rows.invoice_id
-- is a new FK target against it.
create unique index if not exists invoices_user_id_id_uidx
  on public.invoices(user_id, id);

-- Durable, tenant-scoped invoice-source-identity: source_system is
-- normalized case-insensitively (lower/trim, matching
-- client_source_identities' own convention), source_invoice_id is
-- outer-trimmed but case-sensitive. This is the STRONGEST invoice
-- identity when both are present — enforced at the database level so two
-- rows can never collide, not just checked in application code.
create unique index if not exists invoices_user_source_identity_uidx
  on public.invoices(user_id, source_system, source_invoice_id)
  where source_system is not null and source_invoice_id is not null;

do $tenant_fks$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.import_rows'::regclass
      and conname = 'import_rows_user_id_client_id_fkey' and contype = 'f'
  ) then
    alter table public.import_rows
      add constraint import_rows_user_id_client_id_fkey
      foreign key (user_id, client_id)
      references public.clients(user_id, id)
      on update no action
      on delete set null (client_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.import_rows'::regclass
      and conname = 'import_rows_user_id_invoice_id_fkey' and contype = 'f'
  ) then
    alter table public.import_rows
      add constraint import_rows_user_id_invoice_id_fkey
      foreign key (user_id, invoice_id)
      references public.invoices(user_id, id)
      on update no action
      on delete set null (invoice_id);
  end if;
end
$tenant_fks$;

-- ============================================================
-- RLS: authenticated may only ever SELECT their own rows. All writes
-- happen inside the SECURITY DEFINER functions below, never via a direct
-- grant — mirrors PR #22's client_dedup_runs/client_merge_candidates/
-- client_merge_audit tables exactly.
-- ============================================================
alter table public.import_runs enable row level security;
alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;
alter table public.import_events enable row level security;

drop policy if exists "import_runs_select_own" on public.import_runs;
create policy "import_runs_select_own" on public.import_runs
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "import_batches_select_own" on public.import_batches;
create policy "import_batches_select_own" on public.import_batches
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "import_rows_select_own" on public.import_rows;
create policy "import_rows_select_own" on public.import_rows
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "import_events_select_own" on public.import_events;
create policy "import_events_select_own" on public.import_events
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

grant select on public.import_runs, public.import_rows, public.import_events
  to authenticated;
-- import_batches.internal_diagnostic is deliberately withheld from
-- `authenticated` via a column-scoped grant instead of the blanket
-- whole-table grant every other import table gets (see Blocker 1 in the
-- independent review: never expose raw SQLERRM to authenticated users).
revoke select on public.import_batches from authenticated;
grant select (id, run_id, user_id, batch_index, status, row_count, failure_reason, created_at)
  on public.import_batches to authenticated;
grant select, insert, update, delete
  on public.import_runs, public.import_batches, public.import_rows, public.import_events
  to service_role;

-- ============================================================
-- Client resolution wrapper — matched-vs-created truth without a second
-- matching algorithm.
-- ============================================================
-- public.resolve_or_create_client(...) is SECURITY INVOKER and internally
-- requires auth.uid() = p_user_id (see its own definition in
-- 20260726000000_canonical_clients.sql) — the exact same context PR #22's
-- own integration test simulates via set_config('request.jwt.claim.sub',
-- ...). This wrapper establishes that same context so a server-driven
-- batch can call the unmodified resolver at all, and separately determines
-- matched-vs-created WITHOUT re-deriving or duplicating any matching rule.
--
-- Two determination paths, mirroring the resolver's own two internal
-- paths in the same order:
--
--  1. SOURCE IDENTITY FAST PATH. resolve_or_create_client's first move,
--     before any email/phone/name matching, is a direct lookup in
--     client_source_identities by (user_id, lower(trim(source)),
--     trim(external_id)) — if found, it returns that client_id
--     immediately, full stop. This wrapper performs the IDENTICAL lookup
--     (same normalization, same table, same columns — reusing the
--     resolver's own deterministic first branch, not a second matching
--     algorithm) BEFORE calling the resolver. If it finds a mapping, the
--     resolver is guaranteed to return that same existing client via its
--     own fast path — was_created is unconditionally false, regardless of
--     whether the import row's name/email happen to differ from what's
--     currently stored on that client. (An earlier version of this
--     wrapper only checked an email/phone/name lock-key partition, which
--     is the WRONG identity space for a source-identity retry whose
--     name/email drifted from the client's stored values — exactly the
--     bug an independent review caught: a source-identity retry with a
--     different name was misreported as "created" a second time.)
--
--  2. EMAIL/PHONE/NAME FALLTHROUGH. If no source-identity mapping exists
--     yet, the resolver falls through to its own count-based matching
--     query. This wrapper takes the identical advisory lock the resolver
--     computes internally (same coalesce(normalized_email,
--     normalized_phone, normalized_name) formula — copying a lock *key
--     expression* is not matching logic; the decision of which existing
--     client counts as the same identity stays 100% inside the resolver),
--     holds it for this transaction, and snapshots which client ids
--     already exist in this identity's lock-key partition BEFORE calling
--     the resolver, then checks set membership after. This is race-free
--     (the lock is held across both the snapshot and the call) and
--     correctly treats "matched a client created earlier in this same
--     transaction" as a match, not a create — an even earlier version of
--     this wrapper compared created_at to transaction_timestamp(), which
--     local Postgres smoke testing proved wrong (transaction_timestamp()
--     is frozen for the whole transaction, so every row inserted anywhere
--     in the same transaction shares one timestamp).
create or replace function duewatch_ops.resolve_client_for_import(
  p_user_id uuid,
  p_name text,
  p_email text default null,
  p_phone text default null,
  p_company text default null,
  p_source text default null,
  p_external_id text default null,
  p_provenance jsonb default '{}'::jsonb
) returns table(client_id uuid, was_created boolean)
language plpgsql security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_client_id uuid;
  v_lock_key bigint;
  v_existing_ids uuid[];
  v_source_identity_existed boolean := false;
begin
  if p_source is not null and p_external_id is not null then
    select exists(
      select 1 from public.client_source_identities
      where user_id = p_user_id
        and source = lower(trim(p_source))
        and external_id = trim(p_external_id)
    ) into v_source_identity_existed;
  end if;

  v_lock_key := hashtextextended(
    p_user_id::text || ':' || coalesce(
      public.normalize_client_email(p_email),
      public.normalize_client_phone(p_phone),
      public.normalize_client_text(p_name)
    ), 0
  );
  perform pg_advisory_xact_lock(v_lock_key);

  -- Every client sharing this identity's lock-key partition, before the
  -- resolver runs. Reuses only the lock-key EXPRESSION (identical to the
  -- resolver's own internal lock) to scope this existence check — never a
  -- match *decision* — so this stays a wrapper around PR #22's resolver,
  -- not a second matching algorithm. Only needed for the fallthrough path
  -- (source identity not already existing); harmless to compute either way.
  select coalesce(array_agg(c.id), array[]::uuid[]) into v_existing_ids
  from public.clients c
  where c.user_id = p_user_id
    and hashtextextended(
      p_user_id::text || ':' || coalesce(
        public.normalize_client_email(c.email),
        public.normalize_client_phone(c.phone),
        public.normalize_client_text(c.name)
      ), 0
    ) = v_lock_key;

  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_client_id := public.resolve_or_create_client(
    p_user_id, p_name, p_email, p_phone, p_company, p_source, p_external_id, p_provenance
  );

  return query select
    v_client_id,
    case
      when v_source_identity_existed then false
      else not (v_client_id = any(v_existing_ids))
    end;
end
$$;
revoke execute on function duewatch_ops.resolve_client_for_import(
  uuid, text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function duewatch_ops.resolve_client_for_import(
  uuid, text, text, text, text, text, text, jsonb
) to service_role;

-- ============================================================
-- start_import_run — atomically idempotent run creation + server-side row
-- revalidation. Called once per "click Start Import."
-- ============================================================
-- p_rows: jsonb array of { row_number, outcome, issue_codes: text[],
-- normalized: {...material fields...} } — exactly the shape the browser's
-- eligibility.js already evaluates client-side; this function re-evaluates
-- every row from scratch rather than trusting any eligibility claim in the
-- payload. p_warnings_acknowledged is a single request-level flag (not
-- per-row): the browser shows one confirmation before submitting a run
-- that contains any ready_with_warnings rows, and that one flag governs
-- every such row in the request.
drop function if exists public.start_import_run(uuid, text, jsonb);
create or replace function public.start_import_run(
  p_user_id uuid,
  p_idempotency_key text,
  p_rows jsonb,
  p_warnings_acknowledged boolean default false
) returns uuid
language plpgsql security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_run_id uuid;
  v_existing_run_id uuid;
  v_row jsonb;
  v_blocked_row record;
  v_eligible boolean;
  v_reason text;
  v_payload jsonb;
  v_hash text;
  v_row_key text;
  v_total integer := 0;
  v_eligible_count integer := 0;
  v_blocked_count integer := 0;
  v_request_hash text;
  v_existing_hash text;
  v_row_number_count integer;
  v_distinct_row_number_count integer;
  v_invalid_row_numbers integer;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_user_id then
    raise exception 'Cannot start an import run for another user';
  end if;
  if p_idempotency_key is null or trim(p_idempotency_key) = '' then
    raise exception 'idempotency key is required';
  end if;

  -- ---- server-enforced bounds (Blocker 2) — never trust the caller ----
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total > 10000 then
    raise exception 'Import request exceeds the maximum of 10000 rows (got %)', v_total;
  end if;

  select count(*) into v_invalid_row_numbers
  from jsonb_array_elements(p_rows) r
  where jsonb_typeof(r->'row_number') <> 'number'
    or (r->>'row_number')::numeric <> floor((r->>'row_number')::numeric)
    or (r->>'row_number')::numeric < 1;
  if v_invalid_row_numbers > 0 then
    raise exception 'Every row must have a positive integer row_number';
  end if;

  select count(*), count(distinct (r->>'row_number'))
  into v_row_number_count, v_distinct_row_number_count
  from jsonb_array_elements(p_rows) r;
  if v_row_number_count <> v_distinct_row_number_count then
    raise exception 'row_number values must be unique within one import request';
  end if;

  -- jsonb::text is a deterministic, canonical rendering of the same jsonb
  -- value (Postgres normalizes whitespace/structure on the way into jsonb
  -- storage) — this hash only ever needs to compare against itself on a
  -- later call with the exact same key, not match any hash computed
  -- elsewhere, so this canonicalization is sufficient. Includes the
  -- acknowledgement flag: a same-key retry that flips acknowledgement is
  -- also a different logical request.
  v_request_hash := encode(sha256(convert_to(
    jsonb_build_object('rows', p_rows, 'warnings_acknowledged', coalesce(p_warnings_acknowledged, false))::text,
    'UTF8'
  )), 'hex');

  -- ---- atomic idempotent run creation (Blocker 8) ----
  -- INSERT ... ON CONFLICT DO NOTHING is the whole fix: two concurrent
  -- calls with the same (user_id, idempotency_key) can no longer race a
  -- plain SELECT-then-INSERT into a unique-constraint error. Exactly one
  -- concurrent caller's INSERT wins; Postgres blocks the other caller's
  -- INSERT on the same unique index entry until the winner's transaction
  -- resolves, then that caller sees either the committed winning row (via
  -- the SELECT fallback below) or, if the winner rolled back, an open
  -- conflict to retry into.
  insert into public.import_runs(
    id, user_id, idempotency_key, request_payload_hash, warnings_acknowledged, status, total_rows, started_at
  ) values (
    gen_random_uuid(), p_user_id, p_idempotency_key, v_request_hash, coalesce(p_warnings_acknowledged, false),
    'in_progress', v_total, now()
  )
  on conflict (user_id, idempotency_key) do nothing
  returning id into v_run_id;

  if v_run_id is not null then
    -- We won the race (or there was no race) — populate rows below.
    null;
  else
    select id, request_payload_hash into v_existing_run_id, v_existing_hash
    from public.import_runs
    where user_id = p_user_id and idempotency_key = p_idempotency_key;

    if v_existing_run_id is null then
      -- Extremely unlikely: the conflicting row vanished between the
      -- INSERT and this SELECT (e.g. a concurrent user deletion cascade).
      -- Fail loudly rather than loop indefinitely on a pathological case.
      raise exception 'Could not resolve import run for idempotency key %', p_idempotency_key;
    end if;
    if v_existing_hash <> v_request_hash then
      raise exception
        'Idempotency key % was already used to start a different import; refusing to overwrite it',
        p_idempotency_key;
    end if;
    return v_existing_run_id;
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    select e.eligible, e.reason_code into v_eligible, v_reason
    from duewatch_ops.evaluate_row_eligibility(
      v_row->>'outcome',
      case when v_row->'issue_codes' is null then null
        else array(select jsonb_array_elements_text(v_row->'issue_codes')) end,
      coalesce(v_row->'normalized', '{}'::jsonb),
      coalesce(p_warnings_acknowledged, false)
    ) e;

    v_payload := jsonb_build_object(
      'user_id', p_user_id::text,
      'client_name', v_row->'normalized'->>'client_name',
      'client_company', v_row->'normalized'->>'client_company',
      'client_email', v_row->'normalized'->>'client_email',
      'client_phone', v_row->'normalized'->>'client_phone',
      'source_system', v_row->'normalized'->>'source_system',
      'source_client_id', v_row->'normalized'->>'source_client_id',
      'invoice_number', v_row->'normalized'->>'invoice_number',
      'source_invoice_id', v_row->'normalized'->>'source_invoice_id',
      'invoice_date', v_row->'normalized'->>'invoice_date',
      'due_date', v_row->'normalized'->>'due_date',
      'amount', v_row->'normalized'->>'amount',
      'currency', v_row->'normalized'->>'currency',
      'status', v_row->'normalized'->>'status',
      'amount_paid', v_row->'normalized'->>'amount_paid',
      'payment_date', v_row->'normalized'->>'payment_date'
    );
    v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
    v_row_key := v_run_id::text || ':' || (v_row->>'row_number');

    if v_eligible then
      v_eligible_count := v_eligible_count + 1;
      insert into public.import_rows(
        run_id, user_id, row_number, row_idempotency_key,
        material_payload, material_payload_hash, server_status
      ) values (
        v_run_id, p_user_id, (v_row->>'row_number')::integer, v_row_key,
        v_payload, v_hash, 'pending'
      );
    else
      v_blocked_count := v_blocked_count + 1;
      insert into public.import_rows(
        run_id, user_id, row_number, row_idempotency_key,
        material_payload, material_payload_hash, server_status,
        block_reason_code, block_reason_detail
      ) values (
        v_run_id, p_user_id, (v_row->>'row_number')::integer, v_row_key,
        v_payload, v_hash, 'blocked',
        v_reason, jsonb_build_object('outcome', v_row->>'outcome')
      );
    end if;
  end loop;

  update public.import_runs
  set eligible_rows = v_eligible_count, blocked_rows = v_blocked_count
  where id = v_run_id;

  insert into public.import_events(run_id, user_id, event_type, detail)
  values (v_run_id, p_user_id, 'run_created', jsonb_build_object(
    'total_rows', v_total, 'eligible_rows', v_eligible_count, 'blocked_rows', v_blocked_count
  ));
  for v_blocked_row in
    select id, block_reason_code from public.import_rows
    where run_id = v_run_id and server_status = 'blocked'
  loop
    insert into public.import_events(run_id, user_id, row_id, event_type, detail)
    values (v_run_id, p_user_id, v_blocked_row.id, 'row_blocked',
      jsonb_build_object('reason_code', v_blocked_row.block_reason_code));
  end loop;

  return v_run_id;
end
$$;
revoke execute on function public.start_import_run(uuid, text, jsonb, boolean)
  from public, anon;
grant execute on function public.start_import_run(uuid, text, jsonb, boolean) to authenticated, service_role;

-- ============================================================
-- process_import_batch — claims and transactionally persists the next
-- pending batch (bounded to 200 rows). Call repeatedly from the browser
-- until the returned status is 'completed', 'partially_completed', or
-- 'cancelled'.
-- ============================================================
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
  delete from _claimed_rows;
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
        select i.* into v_existing from public.invoices i
        where i.user_id = v_run.user_id
          and i.client_id = v_client_id
          and i.inv_num = (v_row.material_payload->>'invoice_number')
          and i.source_system is null and i.source_invoice_id is null;
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

-- ============================================================
-- request_import_cancellation — idempotent; cancellation is observed
-- between batches by process_import_batch, never mid-batch.
-- ============================================================
create or replace function public.request_import_cancellation(p_run_id uuid)
returns void
language plpgsql security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_user_id uuid;
begin
  select user_id into v_user_id from public.import_runs where id = p_run_id for update;
  if not found then
    raise exception 'Import run not found';
  end if;
  if (select auth.uid()) is null or (select auth.uid()) <> v_user_id then
    raise exception 'Cannot cancel another user''s import run';
  end if;

  update public.import_runs
  set cancel_requested_at = coalesce(cancel_requested_at, now())
  where id = p_run_id;

  insert into public.import_events(run_id, user_id, event_type)
  values (p_run_id, v_user_id, 'cancellation_requested');
end
$$;
revoke execute on function public.request_import_cancellation(uuid) from public, anon;
grant execute on function public.request_import_cancellation(uuid) to authenticated, service_role;

-- ============================================================
-- Postconditions
-- ============================================================
do $postconditions$
begin
  if not exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename in ('import_runs', 'import_batches', 'import_rows', 'import_events')
    having count(*) = 4
  ) then
    raise exception 'Not all four import persistence tables were created';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'invoices'
      and column_name in ('currency', 'payment_date', 'source_system', 'source_invoice_id')
    having count(*) = 4
  ) then
    raise exception 'invoices is missing one or more material-field columns';
  end if;

  if (select execution_enabled from duewatch_ops.client_dedup_config where singleton) then
    raise exception 'Canonical dedup execution must remain disabled';
  end if;
end
$postconditions$;
