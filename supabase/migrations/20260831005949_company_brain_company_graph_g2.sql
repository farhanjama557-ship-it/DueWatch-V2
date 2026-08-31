-- M2G-G2: tenant-safe Company Graph persistence.
-- Repository-scope migration only. It must be applied and exercised in an
-- isolated Supabase/Postgres environment before any deployment claim.

create table public.company_graph_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  brain_snapshot_id uuid not null,
  graph_version bigint not null check (graph_version > 0),
  schema_version text not null check (schema_version = 'COMPANY_GRAPH_V0'),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  source_version_ids jsonb not null check (jsonb_typeof(source_version_ids) = 'array'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  unique (user_id, id),
  unique (user_id, graph_version),
  unique (user_id, fingerprint),
  constraint company_graph_versions_brain_snapshot_fk foreign key (user_id, brain_snapshot_id)
    references public.company_brain_snapshots(user_id, id) on delete restrict,
  check ((active and invalidated_at is null) or (not active and invalidated_at is not null))
);

create unique index company_graph_one_active_version_idx
  on public.company_graph_versions (user_id) where active;

create table public.company_graph_nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  graph_version_id uuid not null,
  stable_key text not null,
  node_type text not null check (node_type in (
    'COMPANY','CLIENT','PERSON','ROLE','CONTRACT','POLICY_CANDIDATE','WORKFLOW',
    'CLIENT_EXCEPTION','PRECEDENT','SOURCE','ARTIFACT','CLAIM','CONFLICT'
  )),
  label text not null,
  semantic_scope jsonb not null,
  resolution_state text not null check (resolution_state in ('RESOLVED','AMBIGUOUS','UNRESOLVED','CONFLICTED')),
  confidence numeric,
  uncertainty text,
  explicit boolean not null,
  derived boolean not null,
  independent boolean not null default false,
  active boolean not null default true,
  revoked boolean not null default false,
  effective_from timestamptz,
  effective_to timestamptz,
  node_data jsonb not null default '{}'::jsonb,
  primary_claim_id uuid not null,
  primary_source_version_id uuid not null,
  provenance_claim_ids jsonb not null check (jsonb_typeof(provenance_claim_ids) = 'array' and jsonb_array_length(provenance_claim_ids) > 0),
  root_source_version_ids jsonb not null check (jsonb_typeof(root_source_version_ids) = 'array' and jsonb_array_length(root_source_version_ids) > 0),
  canonical_financial_truth boolean not null default false check (canonical_financial_truth = false),
  dw_authority boolean not null default false check (dw_authority = false),
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  unique (user_id, id),
  unique (user_id, graph_version_id, id),
  unique (user_id, graph_version_id, stable_key),
  constraint company_graph_nodes_version_fk foreign key (user_id, graph_version_id)
    references public.company_graph_versions(user_id, id) on delete restrict,
  constraint company_graph_nodes_primary_claim_fk foreign key (user_id, primary_claim_id)
    references public.company_brain_claims(user_id, id) on delete restrict,
  constraint company_graph_nodes_primary_source_fk foreign key (user_id, primary_source_version_id)
    references public.company_brain_source_versions(user_id, id) on delete restrict,
  constraint company_graph_nodes_primary_root_fk foreign key (user_id, primary_claim_id, primary_source_version_id)
    references public.company_brain_claim_roots(user_id, claim_id, source_version_id) on delete restrict,
  check (not (derived and independent))
);

create table public.company_graph_edges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  graph_version_id uuid not null,
  stable_key text not null,
  edge_type text not null check (edge_type in (
    'BELONGS_TO_COMPANY','CLIENT_OF','HAS_CONTRACT','APPLIES_TO_CLIENT',
    'APPLIES_TO_COMPANY','HAS_ROLE','ROLE_IN_COMPANY','OBSERVED_DELEGATION',
    'REFERENCES_POLICY','EXCEPTION_FOR','SUPPORTED_BY','DERIVED_FROM',
    'CONFLICTS_WITH','PRECEDENT_FOR','HISTORICAL_TO','ALIAS_OF','SUPERSEDES'
  )),
  from_node_id uuid not null,
  to_node_id uuid not null,
  semantic_scope jsonb not null,
  resolution_state text not null check (resolution_state in ('RESOLVED','AMBIGUOUS','UNRESOLVED','CONFLICTED')),
  confidence numeric,
  uncertainty text,
  explicit boolean not null,
  derived boolean not null,
  independent boolean not null default false,
  active boolean not null default true,
  revoked boolean not null default false,
  effective_from timestamptz,
  effective_to timestamptz,
  edge_data jsonb not null default '{}'::jsonb,
  primary_claim_id uuid not null,
  primary_source_version_id uuid not null,
  provenance_claim_ids jsonb not null check (jsonb_typeof(provenance_claim_ids) = 'array' and jsonb_array_length(provenance_claim_ids) > 0),
  root_source_version_ids jsonb not null check (jsonb_typeof(root_source_version_ids) = 'array' and jsonb_array_length(root_source_version_ids) > 0),
  canonical_financial_truth boolean not null default false check (canonical_financial_truth = false),
  dw_authority boolean not null default false check (dw_authority = false),
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  unique (user_id, id),
  unique (user_id, graph_version_id, id),
  unique (user_id, graph_version_id, stable_key),
  constraint company_graph_edges_version_fk foreign key (user_id, graph_version_id)
    references public.company_graph_versions(user_id, id) on delete restrict,
  constraint company_graph_edges_from_fk foreign key (user_id, graph_version_id, from_node_id)
    references public.company_graph_nodes(user_id, graph_version_id, id) on delete restrict,
  constraint company_graph_edges_to_fk foreign key (user_id, graph_version_id, to_node_id)
    references public.company_graph_nodes(user_id, graph_version_id, id) on delete restrict,
  constraint company_graph_edges_primary_claim_fk foreign key (user_id, primary_claim_id)
    references public.company_brain_claims(user_id, id) on delete restrict,
  constraint company_graph_edges_primary_source_fk foreign key (user_id, primary_source_version_id)
    references public.company_brain_source_versions(user_id, id) on delete restrict,
  constraint company_graph_edges_primary_root_fk foreign key (user_id, primary_claim_id, primary_source_version_id)
    references public.company_brain_claim_roots(user_id, claim_id, source_version_id) on delete restrict,
  check (from_node_id <> to_node_id),
  check (not (derived and independent)),
  check (edge_type <> 'SUPERSEDES' or explicit)
);

create table public.company_graph_entity_resolutions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  graph_version_id uuid not null,
  claim_id uuid not null,
  entity_type text not null,
  stable_identifier text,
  raw_reference text,
  normalized_reference text,
  resolution_state text not null check (resolution_state in ('RESOLVED','AMBIGUOUS','UNRESOLVED','CONFLICTED')),
  selected_node_id uuid,
  candidate_node_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(candidate_node_ids) = 'array'),
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, graph_version_id, id),
  unique (user_id, graph_version_id, claim_id, entity_type, normalized_reference),
  constraint company_graph_entity_resolutions_version_fk foreign key (user_id, graph_version_id)
    references public.company_graph_versions(user_id, id) on delete restrict,
  constraint company_graph_entity_resolutions_claim_fk foreign key (user_id, claim_id)
    references public.company_brain_claims(user_id, id) on delete restrict,
  constraint company_graph_entity_resolutions_selected_fk foreign key (user_id, graph_version_id, selected_node_id)
    references public.company_graph_nodes(user_id, graph_version_id, id) on delete restrict,
  check ((resolution_state = 'RESOLVED' and selected_node_id is not null)
    or (resolution_state <> 'RESOLVED' and selected_node_id is null))
);

create table public.company_graph_resolution_candidates (
  user_id uuid not null references auth.users(id) on delete cascade,
  graph_version_id uuid not null,
  resolution_id uuid not null,
  candidate_node_id uuid not null,
  candidate_order integer not null check (candidate_order >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, resolution_id, candidate_node_id),
  unique (user_id, resolution_id, candidate_order),
  constraint company_graph_resolution_candidates_resolution_fk
    foreign key (user_id, graph_version_id, resolution_id)
    references public.company_graph_entity_resolutions(user_id, graph_version_id, id)
    on delete restrict deferrable initially deferred,
  constraint company_graph_resolution_candidates_node_fk
    foreign key (user_id, graph_version_id, candidate_node_id)
    references public.company_graph_nodes(user_id, graph_version_id, id)
    on delete restrict deferrable initially deferred
);

create table public.company_graph_node_provenance (
  user_id uuid not null references auth.users(id) on delete cascade,
  node_id uuid not null,
  claim_id uuid not null,
  source_version_id uuid not null,
  independent boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, node_id, claim_id, source_version_id),
  constraint company_graph_node_provenance_node_fk foreign key (user_id, node_id)
    references public.company_graph_nodes(user_id, id) on delete restrict,
  constraint company_graph_node_provenance_claim_fk foreign key (user_id, claim_id)
    references public.company_brain_claims(user_id, id) on delete restrict,
  constraint company_graph_node_provenance_source_fk foreign key (user_id, source_version_id)
    references public.company_brain_source_versions(user_id, id) on delete restrict,
  constraint company_graph_node_provenance_claim_root_fk foreign key (user_id, claim_id, source_version_id)
    references public.company_brain_claim_roots(user_id, claim_id, source_version_id) on delete restrict
);

create table public.company_graph_edge_provenance (
  user_id uuid not null references auth.users(id) on delete cascade,
  edge_id uuid not null,
  claim_id uuid not null,
  source_version_id uuid not null,
  independent boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, edge_id, claim_id, source_version_id),
  constraint company_graph_edge_provenance_edge_fk foreign key (user_id, edge_id)
    references public.company_graph_edges(user_id, id) on delete restrict,
  constraint company_graph_edge_provenance_claim_fk foreign key (user_id, claim_id)
    references public.company_brain_claims(user_id, id) on delete restrict,
  constraint company_graph_edge_provenance_source_fk foreign key (user_id, source_version_id)
    references public.company_brain_source_versions(user_id, id) on delete restrict,
  constraint company_graph_edge_provenance_claim_root_fk foreign key (user_id, claim_id, source_version_id)
    references public.company_brain_claim_roots(user_id, claim_id, source_version_id) on delete restrict
);

create index company_graph_nodes_lookup_idx on public.company_graph_nodes
  (user_id, graph_version_id, node_type, active);
create index company_graph_nodes_scope_gin on public.company_graph_nodes using gin (semantic_scope);
create index company_graph_edges_lookup_idx on public.company_graph_edges
  (user_id, graph_version_id, edge_type, active);
create index company_graph_edges_scope_gin on public.company_graph_edges using gin (semantic_scope);
create index company_graph_resolutions_lookup_idx on public.company_graph_entity_resolutions
  (user_id, graph_version_id, resolution_state, normalized_reference);
create index company_graph_resolution_candidates_lookup_idx on public.company_graph_resolution_candidates
  (user_id, graph_version_id, candidate_node_id);

alter table public.company_graph_versions enable row level security;
alter table public.company_graph_nodes enable row level security;
alter table public.company_graph_edges enable row level security;
alter table public.company_graph_entity_resolutions enable row level security;
alter table public.company_graph_resolution_candidates enable row level security;
alter table public.company_graph_node_provenance enable row level security;
alter table public.company_graph_edge_provenance enable row level security;

create policy company_graph_versions_owner_read on public.company_graph_versions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy company_graph_nodes_owner_read on public.company_graph_nodes
  for select to authenticated using ((select auth.uid()) = user_id);
create policy company_graph_edges_owner_read on public.company_graph_edges
  for select to authenticated using ((select auth.uid()) = user_id);
create policy company_graph_entity_resolutions_owner_read on public.company_graph_entity_resolutions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy company_graph_resolution_candidates_owner_read on public.company_graph_resolution_candidates
  for select to authenticated using ((select auth.uid()) = user_id);
create policy company_graph_node_provenance_owner_read on public.company_graph_node_provenance
  for select to authenticated using ((select auth.uid()) = user_id);
create policy company_graph_edge_provenance_owner_read on public.company_graph_edge_provenance
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.company_graph_versions, public.company_graph_nodes,
  public.company_graph_edges, public.company_graph_entity_resolutions,
  public.company_graph_resolution_candidates,
  public.company_graph_node_provenance, public.company_graph_edge_provenance
  from anon, authenticated;

grant select on public.company_graph_versions, public.company_graph_nodes,
  public.company_graph_edges, public.company_graph_entity_resolutions,
  public.company_graph_resolution_candidates,
  public.company_graph_node_provenance, public.company_graph_edge_provenance
  to authenticated;

-- Root revocation propagates immediately to graph persistence. A subsequent
-- deterministic rebuild creates the next active graph version.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Resolution candidates are normalized so every candidate is constrained to
-- the resolution's tenant and exact graph version. The JSON array remains a
-- read projection and must exactly match the normalized relation.
create or replace function private.assert_company_graph_resolution_candidates(
  p_user_id uuid,
  p_graph_version_id uuid,
  p_resolution_id uuid,
  p_candidate_node_ids jsonb,
  p_selected_node_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) <> count(distinct candidate_id)
      from jsonb_array_elements_text(p_candidate_node_ids) declared(candidate_id))
  then raise exception 'COMPANY_GRAPH_RESOLUTION_CANDIDATE_DUPLICATE'; end if;
  if exists (
    select 1 from jsonb_array_elements_text(p_candidate_node_ids) declared(candidate_id)
    where not exists (
      select 1 from public.company_graph_resolution_candidates c
      where c.user_id = p_user_id and c.graph_version_id = p_graph_version_id
        and c.resolution_id = p_resolution_id
        and c.candidate_node_id = declared.candidate_id::uuid
    )
  ) or exists (
    select 1 from public.company_graph_resolution_candidates c
    where c.user_id = p_user_id and c.graph_version_id = p_graph_version_id
      and c.resolution_id = p_resolution_id
      and not p_candidate_node_ids @> jsonb_build_array(c.candidate_node_id::text)
  ) then raise exception 'COMPANY_GRAPH_RESOLUTION_CANDIDATE_PROJECTION_MISMATCH'; end if;
  if p_selected_node_id is not null
    and not p_candidate_node_ids @> jsonb_build_array(p_selected_node_id::text)
  then raise exception 'COMPANY_GRAPH_SELECTED_NODE_NOT_A_CANDIDATE'; end if;
end;
$$;

create or replace function private.validate_company_graph_resolution_candidates()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_company_graph_resolution_candidates(
    new.user_id, new.graph_version_id, new.id,
    new.candidate_node_ids, new.selected_node_id
  );
  return new;
end;
$$;

create or replace function private.validate_company_graph_resolution_candidate_link_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  v_graph_version_id uuid := case when tg_op = 'DELETE' then old.graph_version_id else new.graph_version_id end;
  v_resolution_id uuid := case when tg_op = 'DELETE' then old.resolution_id else new.resolution_id end;
  v_candidate_node_ids jsonb;
  v_selected_node_id uuid;
begin
  select candidate_node_ids, selected_node_id
    into v_candidate_node_ids, v_selected_node_id
    from public.company_graph_entity_resolutions
    where user_id = v_user_id and graph_version_id = v_graph_version_id and id = v_resolution_id;
  if found then
    perform private.assert_company_graph_resolution_candidates(
      v_user_id, v_graph_version_id, v_resolution_id,
      v_candidate_node_ids, v_selected_node_id
    );
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke execute on function private.assert_company_graph_resolution_candidates(uuid,uuid,uuid,jsonb,uuid) from public, anon, authenticated;
revoke execute on function private.validate_company_graph_resolution_candidates() from public, anon, authenticated;
revoke execute on function private.validate_company_graph_resolution_candidate_link_change() from public, anon, authenticated;

create constraint trigger company_graph_resolution_candidates_complete
after insert or update of candidate_node_ids, selected_node_id, graph_version_id
on public.company_graph_entity_resolutions
deferrable initially deferred
for each row execute function private.validate_company_graph_resolution_candidates();

create constraint trigger company_graph_resolution_candidate_link_consistent
after insert or update or delete on public.company_graph_resolution_candidates
deferrable initially deferred
for each row execute function private.validate_company_graph_resolution_candidate_link_change();

-- JSON is a retrieval projection, never the integrity boundary. Deferred
-- checks require every declared claim/root to exist in the normalized,
-- tenant-composite provenance tables and reject unlisted normalized rows.
create or replace function private.validate_company_graph_node_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.active and not exists (
    select 1 from public.company_graph_node_provenance p
    where p.user_id = new.user_id and p.node_id = new.id
      and p.claim_id = new.primary_claim_id and p.source_version_id = new.primary_source_version_id
  ) then raise exception 'COMPANY_GRAPH_PRIMARY_NODE_PROVENANCE_MISSING'; end if;
  if exists (
    select 1 from jsonb_array_elements_text(new.provenance_claim_ids) declared(claim_id)
    where not exists (
      select 1 from public.company_graph_node_provenance p
      where p.user_id = new.user_id and p.node_id = new.id and p.claim_id = declared.claim_id::uuid
    )
  ) or exists (
    select 1 from jsonb_array_elements_text(new.root_source_version_ids) declared(source_version_id)
    where not exists (
      select 1 from public.company_graph_node_provenance p
      where p.user_id = new.user_id and p.node_id = new.id and p.source_version_id = declared.source_version_id::uuid
    )
  ) or exists (
    select 1 from public.company_graph_node_provenance p
    where p.user_id = new.user_id and p.node_id = new.id
      and (not new.provenance_claim_ids @> jsonb_build_array(p.claim_id::text)
        or not new.root_source_version_ids @> jsonb_build_array(p.source_version_id::text))
  ) then raise exception 'COMPANY_GRAPH_NODE_PROVENANCE_PROJECTION_MISMATCH'; end if;
  return new;
end;
$$;

create or replace function private.validate_company_graph_edge_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.active and not exists (
    select 1 from public.company_graph_edge_provenance p
    where p.user_id = new.user_id and p.edge_id = new.id
      and p.claim_id = new.primary_claim_id and p.source_version_id = new.primary_source_version_id
  ) then raise exception 'COMPANY_GRAPH_PRIMARY_EDGE_PROVENANCE_MISSING'; end if;
  if exists (
    select 1 from jsonb_array_elements_text(new.provenance_claim_ids) declared(claim_id)
    where not exists (
      select 1 from public.company_graph_edge_provenance p
      where p.user_id = new.user_id and p.edge_id = new.id and p.claim_id = declared.claim_id::uuid
    )
  ) or exists (
    select 1 from jsonb_array_elements_text(new.root_source_version_ids) declared(source_version_id)
    where not exists (
      select 1 from public.company_graph_edge_provenance p
      where p.user_id = new.user_id and p.edge_id = new.id and p.source_version_id = declared.source_version_id::uuid
    )
  ) or exists (
    select 1 from public.company_graph_edge_provenance p
    where p.user_id = new.user_id and p.edge_id = new.id
      and (not new.provenance_claim_ids @> jsonb_build_array(p.claim_id::text)
        or not new.root_source_version_ids @> jsonb_build_array(p.source_version_id::text))
  ) then raise exception 'COMPANY_GRAPH_EDGE_PROVENANCE_PROJECTION_MISMATCH'; end if;
  return new;
end;
$$;

revoke execute on function private.validate_company_graph_node_provenance() from public, anon, authenticated;
revoke execute on function private.validate_company_graph_edge_provenance() from public, anon, authenticated;

create constraint trigger company_graph_node_provenance_complete
after insert or update of active, provenance_claim_ids, root_source_version_ids,
  primary_claim_id, primary_source_version_id on public.company_graph_nodes
deferrable initially deferred
for each row execute function private.validate_company_graph_node_provenance();

create constraint trigger company_graph_edge_provenance_complete
after insert or update of active, provenance_claim_ids, root_source_version_ids,
  primary_claim_id, primary_source_version_id on public.company_graph_edges
deferrable initially deferred
for each row execute function private.validate_company_graph_edge_provenance();

create or replace function private.validate_company_graph_node_provenance_link_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  v_node_id uuid := case when tg_op = 'DELETE' then old.node_id else new.node_id end;
  v_active boolean;
  v_primary_claim_id uuid;
  v_primary_source_version_id uuid;
  v_claim_ids jsonb;
  v_root_ids jsonb;
begin
  select active, primary_claim_id, primary_source_version_id, provenance_claim_ids, root_source_version_ids
    into v_active, v_primary_claim_id, v_primary_source_version_id, v_claim_ids, v_root_ids
    from public.company_graph_nodes where user_id = v_user_id and id = v_node_id;
  if not found then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if v_active and not exists (
    select 1 from public.company_graph_node_provenance p
    where p.user_id = v_user_id and p.node_id = v_node_id
      and p.claim_id = v_primary_claim_id and p.source_version_id = v_primary_source_version_id
  ) then raise exception 'COMPANY_GRAPH_PRIMARY_NODE_PROVENANCE_MISSING'; end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_claim_ids) declared(claim_id)
    where not exists (select 1 from public.company_graph_node_provenance p where p.user_id = v_user_id and p.node_id = v_node_id and p.claim_id = declared.claim_id::uuid)
  ) or exists (
    select 1 from jsonb_array_elements_text(v_root_ids) declared(source_version_id)
    where not exists (select 1 from public.company_graph_node_provenance p where p.user_id = v_user_id and p.node_id = v_node_id and p.source_version_id = declared.source_version_id::uuid)
  ) or exists (
    select 1 from public.company_graph_node_provenance p where p.user_id = v_user_id and p.node_id = v_node_id
      and (not v_claim_ids @> jsonb_build_array(p.claim_id::text) or not v_root_ids @> jsonb_build_array(p.source_version_id::text))
  ) then raise exception 'COMPANY_GRAPH_NODE_PROVENANCE_PROJECTION_MISMATCH'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function private.validate_company_graph_edge_provenance_link_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  v_edge_id uuid := case when tg_op = 'DELETE' then old.edge_id else new.edge_id end;
  v_active boolean;
  v_primary_claim_id uuid;
  v_primary_source_version_id uuid;
  v_claim_ids jsonb;
  v_root_ids jsonb;
begin
  select active, primary_claim_id, primary_source_version_id, provenance_claim_ids, root_source_version_ids
    into v_active, v_primary_claim_id, v_primary_source_version_id, v_claim_ids, v_root_ids
    from public.company_graph_edges where user_id = v_user_id and id = v_edge_id;
  if not found then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if v_active and not exists (
    select 1 from public.company_graph_edge_provenance p
    where p.user_id = v_user_id and p.edge_id = v_edge_id
      and p.claim_id = v_primary_claim_id and p.source_version_id = v_primary_source_version_id
  ) then raise exception 'COMPANY_GRAPH_PRIMARY_EDGE_PROVENANCE_MISSING'; end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_claim_ids) declared(claim_id)
    where not exists (select 1 from public.company_graph_edge_provenance p where p.user_id = v_user_id and p.edge_id = v_edge_id and p.claim_id = declared.claim_id::uuid)
  ) or exists (
    select 1 from jsonb_array_elements_text(v_root_ids) declared(source_version_id)
    where not exists (select 1 from public.company_graph_edge_provenance p where p.user_id = v_user_id and p.edge_id = v_edge_id and p.source_version_id = declared.source_version_id::uuid)
  ) or exists (
    select 1 from public.company_graph_edge_provenance p where p.user_id = v_user_id and p.edge_id = v_edge_id
      and (not v_claim_ids @> jsonb_build_array(p.claim_id::text) or not v_root_ids @> jsonb_build_array(p.source_version_id::text))
  ) then raise exception 'COMPANY_GRAPH_EDGE_PROVENANCE_PROJECTION_MISMATCH'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke execute on function private.validate_company_graph_node_provenance_link_change() from public, anon, authenticated;
revoke execute on function private.validate_company_graph_edge_provenance_link_change() from public, anon, authenticated;

create constraint trigger company_graph_node_provenance_link_consistent
after insert or update or delete on public.company_graph_node_provenance
deferrable initially deferred
for each row execute function private.validate_company_graph_node_provenance_link_change();

create constraint trigger company_graph_edge_provenance_link_consistent
after insert or update or delete on public.company_graph_edge_provenance
deferrable initially deferred
for each row execute function private.validate_company_graph_edge_provenance_link_change();

create or replace function private.invalidate_company_graph_for_source_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'REVOKED' and old.status is distinct from new.status then
    update public.company_graph_nodes n
      set active = false, revoked = true, invalidated_at = coalesce(n.invalidated_at, now())
      where n.user_id = new.user_id and n.active and exists (
        select 1 from public.company_graph_node_provenance p
        where p.user_id = new.user_id and p.node_id = n.id and p.source_version_id = new.id
      ) or (n.user_id = new.user_id and n.active and n.root_source_version_ids @> jsonb_build_array(new.id::text));
    update public.company_graph_edges e
      set active = false, revoked = true, invalidated_at = coalesce(e.invalidated_at, now())
      where e.user_id = new.user_id and e.active and exists (
        select 1 from public.company_graph_edge_provenance p
        where p.user_id = new.user_id and p.edge_id = e.id and p.source_version_id = new.id
      ) or (e.user_id = new.user_id and e.active and e.root_source_version_ids @> jsonb_build_array(new.id::text));
    update public.company_graph_versions v
      set active = false, invalidated_at = coalesce(v.invalidated_at, now())
      where v.user_id = new.user_id and v.active and (
        exists (select 1 from public.company_graph_nodes n where n.user_id = v.user_id and n.graph_version_id = v.id and n.revoked)
        or exists (select 1 from public.company_graph_edges e where e.user_id = v.user_id and e.graph_version_id = v.id and e.revoked)
      );
  end if;
  return new;
end;
$$;

revoke execute on function private.invalidate_company_graph_for_source_version() from public, anon, authenticated;

create trigger company_graph_source_version_revocation
after update of status on public.company_brain_source_versions
for each row
when (new.status = 'REVOKED' and old.status is distinct from new.status)
execute function private.invalidate_company_graph_for_source_version();

-- Company Brain owns knowledge freshness. Any mutation that invalidates a
-- referenced Brain snapshot also invalidates every persisted graph version
-- built from that snapshot, including non-revocation mutations such as a new
-- claim, founder decision, conflict revision, or authority change.
create or replace function private.invalidate_company_graph_for_brain_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.company_graph_versions v
    set active = false, invalidated_at = coalesce(v.invalidated_at, new.invalidated_at, now())
    where v.user_id = new.user_id and v.brain_snapshot_id = new.id and v.active;
  return new;
end;
$$;

revoke execute on function private.invalidate_company_graph_for_brain_snapshot() from public, anon, authenticated;

create trigger company_graph_stale_on_brain_snapshot_invalidation
after update of active on public.company_brain_snapshots
for each row
when (old.active = true and new.active = false)
execute function private.invalidate_company_graph_for_brain_snapshot();
