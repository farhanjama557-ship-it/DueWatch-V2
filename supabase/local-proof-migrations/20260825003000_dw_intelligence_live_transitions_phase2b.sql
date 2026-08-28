-- Phase 2B Increment 7 — truthful DW LIVE transition proof.
-- LOCAL PROOF ARTIFACT. Do not apply to a paid/cloud environment as part of Phase 2B.

create table if not exists public.dw_intelligence_live_transitions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.dw_intelligence_runs(id) on delete cascade,
  user_id uuid not null,
  invoice_id uuid not null,
  client_id uuid,
  event_type text not null check (event_type in ('ANALYZING','VERIFYING','PREPARING','WAITING','HANDLED','BLOCKED')),
  work_phase text not null check (work_phase in ('analyzing','verifying','preparing','waiting','handled','blocked')),
  occurred_at timestamptz not null default now(),
  detail text,
  page text not null default 'invoice',
  route_target jsonb,
  real_side_effect boolean not null default false check (real_side_effect = false),
  production_execution_authorized boolean not null default false check (production_execution_authorized = false),
  created_at timestamptz not null default now()
);

create index if not exists dw_intelligence_live_transitions_user_time_idx
  on public.dw_intelligence_live_transitions(user_id, occurred_at desc);

create index if not exists dw_intelligence_live_transitions_run_time_idx
  on public.dw_intelligence_live_transitions(run_id, occurred_at asc);

alter table public.dw_intelligence_live_transitions enable row level security;

-- No broad write policy is introduced by this proof migration.
-- Future server persistence must remain tenant-scoped and pass the existing
-- deterministic authority/sandbox boundary. Browser writes are not required.
