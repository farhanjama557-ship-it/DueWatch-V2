-- Forward migration for the verified staging tenant-integrity gap:
-- client_source_identities.client_id was only a single-column FK to
-- clients(id), proving the referenced client exists but not that it
-- belongs to the same tenant as user_id. An authenticated caller could
-- satisfy RLS's `auth.uid() = user_id` check while inserting a row whose
-- client_id pointed at another tenant's client, and PostgreSQL accepted
-- it (reproduced through a genuine authenticated staging REST session:
-- the cross-tenant insert returned HTTP 201). Reads stayed isolated, but
-- the write did not.
--
-- 20260726000000_canonical_clients.sql now creates the table with the
-- composite tenant-safe FK from the start, but Supabase does not re-run
-- an already-applied migration file just because its contents changed —
-- an environment that already ran that migration before this fix existed
-- (current hosted staging) would never receive the corrected FK from
-- editing that file alone. This migration replaces the single-column FK
-- with the same composite tenant-ownership pattern already proven by
-- invoices_user_id_client_id_fkey, and does so idempotently so it is also
-- safe to run against a fresh database where the corrected historical
-- migration already created the desired constraint under the same name.
--
-- Does not weaken RLS: client_source_identities_insert_own/_update_own
-- remain exactly as they are. The composite FK is a second, independent,
-- structural guarantee that holds for every role (including service_role
-- and any other role that bypasses RLS), not a replacement for RLS.
--
-- Catalog preflight: before touching any constraint, this migration reads
-- the actual pg_constraint state and classifies it into exactly one of
-- two legitimate transitions:
--   State A — current hosted-staging shape: the exact old constraint
--     (client_source_identities_client_id_fkey, single-column client_id
--     -> clients(id), ON DELETE CASCADE, validated, not deferrable)
--     exists, and the desired composite constraint does not.
--   State B — corrected fresh-install shape (also what a prior run of
--     this same migration leaves behind): the desired composite
--     constraint (client_source_identities_user_id_client_id_fkey, exact
--     definition below) already exists, and the old single-column
--     constraint does not. This is an idempotent no-op.
-- Anything else — an unexpected duplicate, an expected name with the
-- wrong definition, an unexpected name on an otherwise-matching shape, a
-- desired-named constraint that does not actually have the required
-- definition, or both an old-shaped and new-shaped constraint present at
-- once — is schema drift this migration does not understand well enough
-- to safely resolve. It raises a clear exception and stops before
-- dropping or adding anything, rather than guessing.
--
-- Narrow drop: once State A is proven, this migration drops only the
-- single, by-name constraint client_source_identities_client_id_fkey. It
-- never loops over "every constraint with this column shape" — that
-- would risk silently removing an unrelated or intentionally different
-- constraint that merely happens to reference clients(id) via client_id.
--
-- Bounded locking: lock_timeout is set for the remainder of this
-- migration's session so that on a busy hosted table, this migration
-- fails fast and closed instead of waiting indefinitely for a lock. No
-- retry loop and no destructive fallback — a lock timeout is a stop
-- signal to re-run later, not a signal to try something else instead.
set lock_timeout = '5s';

do $preflight$
begin
  if exists (
    select 1
    from public.client_source_identities si
    join public.clients c on c.id = si.client_id
    where si.user_id <> c.user_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot enforce client_source_identities tenant ownership: cross-tenant relationships exist';
  end if;
end
$preflight$;

-- Idempotent and, on a fresh install, already created by the corrected
-- 20260726000000_canonical_clients.sql — see that file for why it is
-- created there too, ahead of 20260803021842_enforce_invoice_client_
-- tenant_ownership.sql where it was originally introduced for invoices.
-- Creating an index cannot drop or replace a constraint, so this step is
-- safe to run ahead of the catalog preflight below.
create unique index if not exists clients_user_id_id_uidx
  on public.clients(user_id, id);

do $catalog_transition$
declare
  v_child constant regclass := 'public.client_source_identities'::regclass;
  v_parent constant regclass := 'public.clients'::regclass;
  v_desired_old_name constant text := 'client_source_identities_client_id_fkey';
  v_desired_new_name constant text := 'client_source_identities_user_id_client_id_fkey';
  v_expected_old_def constant text :=
    'FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE';
  v_expected_new_def constant text :=
    'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id) ON DELETE CASCADE';

  v_client_id_attnum smallint;
  v_user_id_child_attnum smallint;
  v_id_parent_attnum smallint;
  v_user_id_parent_attnum smallint;

  v_old_shape_count int;
  v_old_named record;
  v_old_state text;

  v_new_shape_count int;
  v_new_named record;
  v_new_state text;
begin
  select attnum into strict v_client_id_attnum
    from pg_attribute where attrelid = v_child and attname = 'client_id';
  select attnum into strict v_user_id_child_attnum
    from pg_attribute where attrelid = v_child and attname = 'user_id';
  select attnum into strict v_id_parent_attnum
    from pg_attribute where attrelid = v_parent and attname = 'id';
  select attnum into strict v_user_id_parent_attnum
    from pg_attribute where attrelid = v_parent and attname = 'user_id';

  -- Classify the old (single-column client_id -> clients.id) shape,
  -- regardless of its current name, before deciding anything.
  select count(*) into v_old_shape_count
  from pg_constraint
  where conrelid = v_child and confrelid = v_parent and contype = 'f'
    and conkey = array[v_client_id_attnum]::smallint[]
    and confkey = array[v_id_parent_attnum]::smallint[];

  if v_old_shape_count > 1 then
    raise exception
      'client_source_identities tenant FK preflight: found % foreign keys matching the old single-column client_id -> clients(id) shape; expected at most one. Refusing to guess which to drop.',
      v_old_shape_count;
  end if;

  if v_old_shape_count = 1 then
    select conname, pg_get_constraintdef(oid) as definition, convalidated,
           condeferrable, condeferred
      into strict v_old_named
      from pg_constraint
      where conrelid = v_child and confrelid = v_parent and contype = 'f'
        and conkey = array[v_client_id_attnum]::smallint[]
        and confkey = array[v_id_parent_attnum]::smallint[];

    if v_old_named.conname <> v_desired_old_name then
      raise exception
        'client_source_identities tenant FK preflight: found a foreign key matching the old single-column client_id -> clients(id) shape named "%", not the expected "%". Refusing to drop a differently named constraint.',
        v_old_named.conname, v_desired_old_name;
    end if;
    if v_old_named.definition <> v_expected_old_def
       or not v_old_named.convalidated
       or v_old_named.condeferrable
       or v_old_named.condeferred then
      raise exception
        'client_source_identities tenant FK preflight: "%" exists but does not match the expected old definition (found: "%", validated=%, deferrable=%, deferred=%). Refusing to drop an unrecognized constraint.',
        v_desired_old_name, v_old_named.definition, v_old_named.convalidated,
        v_old_named.condeferrable, v_old_named.condeferred;
    end if;
    v_old_state := 'present_valid';
  else
    v_old_state := 'absent';
  end if;

  -- Classify the desired composite (user_id, client_id) -> clients(user_id,
  -- id) shape the same way. A matching name alone is never trusted; the
  -- full definition must match before this migration treats it as already
  -- fixed.
  select count(*) into v_new_shape_count
  from pg_constraint
  where conrelid = v_child and confrelid = v_parent and contype = 'f'
    and conkey = array[v_user_id_child_attnum, v_client_id_attnum]::smallint[]
    and confkey = array[v_user_id_parent_attnum, v_id_parent_attnum]::smallint[];

  if v_new_shape_count > 1 then
    raise exception
      'client_source_identities tenant FK preflight: found % foreign keys matching the desired composite (user_id, client_id) -> clients(user_id, id) shape; expected at most one.',
      v_new_shape_count;
  end if;

  if v_new_shape_count = 1 then
    select conname, pg_get_constraintdef(oid) as definition, convalidated,
           condeferrable, condeferred
      into strict v_new_named
      from pg_constraint
      where conrelid = v_child and confrelid = v_parent and contype = 'f'
        and conkey = array[v_user_id_child_attnum, v_client_id_attnum]::smallint[]
        and confkey = array[v_user_id_parent_attnum, v_id_parent_attnum]::smallint[];

    if v_new_named.conname <> v_desired_new_name then
      raise exception
        'client_source_identities tenant FK preflight: found a foreign key matching the desired composite (user_id, client_id) -> clients(user_id, id) shape named "%", not the expected "%". Refusing to treat it as already fixed.',
        v_new_named.conname, v_desired_new_name;
    end if;
    if v_new_named.definition <> v_expected_new_def
       or not v_new_named.convalidated
       or v_new_named.condeferrable
       or v_new_named.condeferred then
      raise exception
        'client_source_identities tenant FK preflight: "%" exists but does not match the required composite definition (found: "%", validated=%, deferrable=%, deferred=%). Refusing to trust it as valid merely because the name matches.',
        v_desired_new_name, v_new_named.definition, v_new_named.convalidated,
        v_new_named.condeferrable, v_new_named.condeferred;
    end if;
    v_new_state := 'present_valid';
  else
    v_new_state := 'absent';
  end if;

  if v_old_state = 'present_valid' and v_new_state = 'absent' then
    -- State A: current hosted-staging shape. Add the composite FK first
    -- (not valid, then validated), and only once that has succeeded, drop
    -- the exact old constraint this preflight just proved matches.
    execute format(
      'alter table %s add constraint %I foreign key (user_id, client_id) references %s(user_id, id) on update no action on delete cascade not valid',
      v_child, v_desired_new_name, v_parent
    );
    execute format(
      'alter table %s validate constraint %I', v_child, v_desired_new_name
    );
    execute format(
      'alter table %s drop constraint %I', v_child, v_desired_old_name
    );
  elsif v_old_state = 'absent' and v_new_state = 'present_valid' then
    -- State B: corrected fresh-install shape, or a previous successful run
    -- of this same migration. Nothing to add or drop.
    raise notice
      'client_source_identities tenant FK: desired composite constraint "%" already present and correct; nothing to do.',
      v_desired_new_name;
  else
    raise exception
      'client_source_identities tenant FK preflight: catalog state does not match either expected transition state (old_state=%, new_state=%). Refusing to guess; stopping without changing any constraint.',
      v_old_state, v_new_state;
  end if;
end
$catalog_transition$;

-- Refresh the Phase 0 unknown-FK gate: client_source_identities now
-- contributes two column-pair rows (user_id -> clients.user_id and
-- client_id -> clients.id) for its one composite FK, replacing the single
-- client_id -> clients.id row the old single-column FK produced.
create or replace function duewatch_ops.unknown_client_foreign_keys()
returns table(
  table_schema text,
  table_name text,
  column_name text,
  foreign_table_schema text,
  foreign_table_name text,
  foreign_column_name text,
  delete_rule text,
  update_rule text
) language sql security definer set search_path = pg_catalog, public as $$
  with relationships as (
    select
      child_ns.nspname::text as table_schema,
      child.relname::text as table_name,
      child_col.attname::text as column_name,
      parent_ns.nspname::text as foreign_table_schema,
      parent.relname::text as foreign_table_name,
      parent_col.attname::text as foreign_column_name,
      case fk.confdeltype
        when 'a' then 'NO ACTION'
        when 'r' then 'RESTRICT'
        when 'c' then 'CASCADE'
        when 'n' then 'SET NULL'
        when 'd' then 'SET DEFAULT'
      end::text as delete_rule,
      case fk.confupdtype
        when 'a' then 'NO ACTION'
        when 'r' then 'RESTRICT'
        when 'c' then 'CASCADE'
        when 'n' then 'SET NULL'
        when 'd' then 'SET DEFAULT'
      end::text as update_rule
    from pg_constraint fk
    join pg_class child on child.oid = fk.conrelid
    join pg_namespace child_ns on child_ns.oid = child.relnamespace
    join pg_class parent on parent.oid = fk.confrelid
    join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
    join lateral unnest(fk.conkey) with ordinality child_key(attnum, ord) on true
    join lateral unnest(fk.confkey) with ordinality parent_key(attnum, ord)
      on parent_key.ord = child_key.ord
    join pg_attribute child_col
      on child_col.attrelid = child.oid and child_col.attnum = child_key.attnum
    join pg_attribute parent_col
      on parent_col.attrelid = parent.oid and parent_col.attnum = parent_key.attnum
    where fk.contype = 'f'
      -- Phase 0 mutates client rows and invoice.client_id. Only foreign keys
      -- whose referenced table is clients/invoices can be affected by those
      -- operations; the separate auth.users ownership FKs are out of scope.
      and parent_ns.nspname = 'public'
      and parent.relname in ('clients', 'invoices')
  )
  select r.* from relationships r
  where (r.table_schema, r.table_name, r.column_name,
         r.foreign_table_schema, r.foreign_table_name, r.foreign_column_name,
         r.delete_rule, r.update_rule)
    not in (
      ('public','invoices','user_id','public','clients','user_id','SET NULL','NO ACTION'),
      ('public','invoices','client_id','public','clients','id','SET NULL','NO ACTION'),
      ('public','client_source_identities','user_id','public','clients','user_id','CASCADE','NO ACTION'),
      ('public','client_source_identities','client_id','public','clients','id','CASCADE','NO ACTION'),
      ('public','line_items','invoice_id','public','invoices','id','CASCADE','NO ACTION'),
      ('public','reminders','invoice_id','public','invoices','id','CASCADE','NO ACTION'),
      ('public','events','invoice_id','public','invoices','id','SET NULL','NO ACTION'),
      ('public','awaiting_signature','invoice_id','public','invoices','id','CASCADE','NO ACTION')
    )
$$;
revoke execute on function duewatch_ops.unknown_client_foreign_keys()
  from public, anon, authenticated;
grant execute on function duewatch_ops.unknown_client_foreign_keys()
  to service_role;

do $postconditions$
declare
  v_definition text;
begin
  select pg_get_constraintdef(oid) into v_definition
  from pg_constraint
  where conrelid = 'public.client_source_identities'::regclass
    and conname = 'client_source_identities_user_id_client_id_fkey'
    and contype = 'f';

  if v_definition is null
    or v_definition not like 'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id)%'
    or v_definition not like '%ON DELETE CASCADE%' then
    raise exception 'client_source_identities tenant constraint does not match the required definition';
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.client_source_identities'::regclass
      and conname = 'client_source_identities_client_id_fkey'
  ) then
    raise exception 'client_source_identities tenant migration left the superseded single-column FK in place';
  end if;

  if exists(select 1 from duewatch_ops.unknown_client_foreign_keys()) then
    raise exception 'client_source_identities tenant migration left an unknown client/invoice FK';
  end if;

  if (select execution_enabled
      from duewatch_ops.client_dedup_config where singleton) then
    raise exception 'Canonical dedup execution must remain disabled';
  end if;
end
$postconditions$;
