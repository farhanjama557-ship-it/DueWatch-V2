-- DW Intelligence Phase 2B proof persistence.
--
-- STATUS: repo-targeted candidate migration; NOT APPLIED by this package.
-- SCOPE: sandbox/stub proof only. This migration intentionally does not
-- authorize production communication or create a new reminder-send path.
--
-- Design goals:
--   * tenant-safe structural foreign keys, not RLS alone;
--   * durable evidence provenance and root lineage;
--   * client/invoice-scoped admitted memory;
--   * durable tombstones and blocked-evidence links;
--   * run + proof-event audit trail;
--   * authenticated users can read only their own proof state;
--   * writes remain server/service-role only for this proof checkpoint.

begin;

-- Existing ids are globally unique, but composite uniqueness is required for
-- tenant-safe composite foreign keys from the DW proof tables below.
create unique index if not exists clients_user_id_id_uidx
  on public.clients(user_id, id);
create unique index if not exists invoices_user_id_id_uidx
  on public.invoices(user_id, id);
create unique index if not exists invoices_user_id_id_client_id_uidx
  on public.invoices(user_id, id, client_id);

create table if not exists public.dw_intelligence_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null,
  invoice_id uuid not null,
  workflow text not null default 'overdue_invoice_triage_friendly_reminder'
    check (workflow = 'overdue_invoice_triage_friendly_reminder'),
  engine_version text not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  transport text not null default 'sandbox'
    check (transport in ('sandbox', 'stub', 'none')),
  -- Deliberately structurally false in this migration. A later production
  -- checkpoint would require a new reviewed migration to alter this contract.
  production_execution_authorized boolean not null default false
    check (production_execution_authorized = false),
  input_fingerprint text,
  summary jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint dw_intelligence_runs_fingerprint_check check (
    input_fingerprint is null or input_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint dw_intelligence_runs_invoice_scope_fk
    foreign key (user_id, invoice_id, client_id)
    references public.invoices(user_id, id, client_id)
    on update no action on delete cascade
);
create unique index if not exists dw_intelligence_runs_user_id_id_uidx
  on public.dw_intelligence_runs(user_id, id);
create index if not exists dw_intelligence_runs_user_started_idx
  on public.dw_intelligence_runs(user_id, started_at desc);
create index if not exists dw_intelligence_runs_scope_started_idx
  on public.dw_intelligence_runs(user_id, client_id, invoice_id, started_at desc);

create table if not exists public.dw_evidence_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null,
  client_id uuid not null,
  invoice_id uuid not null,
  evidence_key text not null,
  source_type text not null,
  source_ref text,
  trust text check (trust in ('HIGH', 'MEDIUM', 'LOW', 'UNTRUSTED')),
  admission_status text not null check (
    admission_status in (
      'ADMITTED',
      'CONTEXT_ONLY',
      'QUARANTINED_INSTRUCTION',
      'REJECTED_TENANT',
      'REJECTED_SCOPE'
    )
  ),
  admission_reason text,
  claim_type text,
  derived_from_key text,
  content_digest text,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint dw_evidence_content_digest_check check (
    content_digest is null or content_digest ~ '^[0-9a-f]{64}$'
  ),
  constraint dw_evidence_rejected_redaction_check check (
    (admission_status in ('REJECTED_TENANT', 'REJECTED_SCOPE') and trust is null and source_ref is null and claim_type is null)
    or
    (admission_status not in ('REJECTED_TENANT', 'REJECTED_SCOPE') and trust is not null)
  ),
  constraint dw_evidence_run_fk
    foreign key (user_id, run_id)
    references public.dw_intelligence_runs(user_id, id)
    on update no action on delete cascade,
  constraint dw_evidence_invoice_scope_fk
    foreign key (user_id, invoice_id, client_id)
    references public.invoices(user_id, id, client_id)
    on update no action on delete cascade
);
create unique index if not exists dw_evidence_items_user_id_id_uidx
  on public.dw_evidence_items(user_id, id);
create unique index if not exists dw_evidence_items_run_key_uidx
  on public.dw_evidence_items(user_id, run_id, evidence_key);
create index if not exists dw_evidence_items_scope_idx
  on public.dw_evidence_items(user_id, client_id, invoice_id, created_at desc);

alter table public.dw_evidence_items
  drop constraint if exists dw_evidence_derived_from_fk;
alter table public.dw_evidence_items
  add constraint dw_evidence_derived_from_fk
  foreign key (user_id, run_id, derived_from_key)
  references public.dw_evidence_items(user_id, run_id, evidence_key)
  on update no action on delete restrict;

create table if not exists public.dw_memory_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null,
  invoice_id uuid,
  scope text not null check (scope in ('client', 'invoice')),
  claim_key text not null,
  claim_value jsonb not null,
  admitted boolean not null default false,
  derived_from_memory_id uuid,
  admission_basis jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint dw_memory_scope_shape_check check (
    (scope = 'client' and invoice_id is null)
    or (scope = 'invoice' and invoice_id is not null)
  ),
  constraint dw_memory_client_fk
    foreign key (user_id, client_id)
    references public.clients(user_id, id)
    on update no action on delete cascade,
  constraint dw_memory_invoice_scope_fk
    foreign key (user_id, invoice_id, client_id)
    references public.invoices(user_id, id, client_id)
    on update no action on delete cascade
);
create unique index if not exists dw_memory_claims_user_id_id_uidx
  on public.dw_memory_claims(user_id, id);
create index if not exists dw_memory_claims_scope_idx
  on public.dw_memory_claims(user_id, client_id, invoice_id, created_at desc);

alter table public.dw_memory_claims
  drop constraint if exists dw_memory_derived_from_fk;
alter table public.dw_memory_claims
  add constraint dw_memory_derived_from_fk
  foreign key (user_id, derived_from_memory_id)
  references public.dw_memory_claims(user_id, id)
  on update no action on delete restrict;

create table if not exists public.dw_memory_evidence_links (
  user_id uuid not null references auth.users(id) on delete cascade,
  memory_id uuid not null,
  evidence_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, memory_id, evidence_id),
  constraint dw_memory_evidence_memory_fk
    foreign key (user_id, memory_id)
    references public.dw_memory_claims(user_id, id)
    on update no action on delete cascade,
  constraint dw_memory_evidence_evidence_fk
    foreign key (user_id, evidence_id)
    references public.dw_evidence_items(user_id, id)
    on update no action on delete restrict
);

create table if not exists public.dw_memory_tombstones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  memory_id uuid not null,
  reason text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id, memory_id),
  constraint dw_memory_tombstone_memory_fk
    foreign key (user_id, memory_id)
    references public.dw_memory_claims(user_id, id)
    on update no action on delete restrict
);
create unique index if not exists dw_memory_tombstones_user_id_id_uidx
  on public.dw_memory_tombstones(user_id, id);

create table if not exists public.dw_tombstone_evidence_links (
  user_id uuid not null references auth.users(id) on delete cascade,
  tombstone_id uuid not null,
  evidence_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, tombstone_id, evidence_id),
  constraint dw_tombstone_evidence_tombstone_fk
    foreign key (user_id, tombstone_id)
    references public.dw_memory_tombstones(user_id, id)
    on update no action on delete cascade,
  constraint dw_tombstone_evidence_evidence_fk
    foreign key (user_id, evidence_id)
    references public.dw_evidence_items(user_id, id)
    on update no action on delete restrict
);

create table if not exists public.dw_proof_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null,
  client_id uuid not null,
  invoice_id uuid not null,
  sequence_no integer not null check (sequence_no >= 0),
  event_type text not null,
  operational_state text check (
    operational_state is null or operational_state in (
      'HANDLED', 'READY', 'APPROVAL', 'WATCH', 'INVESTIGATING', 'UNCERTAIN', 'BLOCKED'
    )
  ),
  proof jsonb not null default '{}'::jsonb,
  -- Phase 2B proof is structurally incapable of recording a real side effect.
  real_side_effect boolean not null default false check (real_side_effect = false),
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id, run_id, sequence_no),
  constraint dw_proof_run_fk
    foreign key (user_id, run_id)
    references public.dw_intelligence_runs(user_id, id)
    on update no action on delete cascade,
  constraint dw_proof_invoice_scope_fk
    foreign key (user_id, invoice_id, client_id)
    references public.invoices(user_id, id, client_id)
    on update no action on delete cascade
);
create index if not exists dw_proof_events_scope_idx
  on public.dw_proof_events(user_id, client_id, invoice_id, created_at desc);

-- RLS is defense-in-depth on top of structural tenant FKs.
alter table public.dw_intelligence_runs enable row level security;
alter table public.dw_evidence_items enable row level security;
alter table public.dw_memory_claims enable row level security;
alter table public.dw_memory_evidence_links enable row level security;
alter table public.dw_memory_tombstones enable row level security;
alter table public.dw_tombstone_evidence_links enable row level security;
alter table public.dw_proof_events enable row level security;

drop policy if exists "dw_intelligence_runs_select_own" on public.dw_intelligence_runs;
create policy "dw_intelligence_runs_select_own" on public.dw_intelligence_runs
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "dw_evidence_items_select_own" on public.dw_evidence_items;
create policy "dw_evidence_items_select_own" on public.dw_evidence_items
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "dw_memory_claims_select_own" on public.dw_memory_claims;
create policy "dw_memory_claims_select_own" on public.dw_memory_claims
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "dw_memory_evidence_links_select_own" on public.dw_memory_evidence_links;
create policy "dw_memory_evidence_links_select_own" on public.dw_memory_evidence_links
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "dw_memory_tombstones_select_own" on public.dw_memory_tombstones;
create policy "dw_memory_tombstones_select_own" on public.dw_memory_tombstones
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "dw_tombstone_evidence_links_select_own" on public.dw_tombstone_evidence_links;
create policy "dw_tombstone_evidence_links_select_own" on public.dw_tombstone_evidence_links
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "dw_proof_events_select_own" on public.dw_proof_events;
create policy "dw_proof_events_select_own" on public.dw_proof_events
  for select to authenticated using ((select auth.uid()) = user_id);

-- Client/browser access is deliberately read-only for this proof. Writes must
-- cross a server-side boundary where scope, evidence admission, memory
-- admission, authority, and proof integrity can be revalidated.
revoke all on public.dw_intelligence_runs from public, anon, authenticated;
revoke all on public.dw_evidence_items from public, anon, authenticated;
revoke all on public.dw_memory_claims from public, anon, authenticated;
revoke all on public.dw_memory_evidence_links from public, anon, authenticated;
revoke all on public.dw_memory_tombstones from public, anon, authenticated;
revoke all on public.dw_tombstone_evidence_links from public, anon, authenticated;
revoke all on public.dw_proof_events from public, anon, authenticated;

grant select on public.dw_intelligence_runs to authenticated;
grant select on public.dw_evidence_items to authenticated;
grant select on public.dw_memory_claims to authenticated;
grant select on public.dw_memory_evidence_links to authenticated;
grant select on public.dw_memory_tombstones to authenticated;
grant select on public.dw_tombstone_evidence_links to authenticated;
grant select on public.dw_proof_events to authenticated;

grant select, insert, update, delete on public.dw_intelligence_runs to service_role;
grant select, insert, update, delete on public.dw_evidence_items to service_role;
grant select, insert, update, delete on public.dw_memory_claims to service_role;
grant select, insert, update, delete on public.dw_memory_evidence_links to service_role;
grant select, insert, update, delete on public.dw_memory_tombstones to service_role;
grant select, insert, update, delete on public.dw_tombstone_evidence_links to service_role;
grant select, insert, update, delete on public.dw_proof_events to service_role;

commit;
