-- Ask DW M2D — hosted baseline reconciliation before reviewed catch-up.
-- MIGRATION-LEDGER BOOTSTRAP ORDER:
-- The active hosted database predates this repository's migration ledger.
-- This file intentionally carries a timestamp immediately BEFORE the first
-- tracked historical migration (20260726000000) so native Supabase
-- `db push --include-all` applies this verified-baseline shim first and then
-- records every real migration under its repository timestamp.
--
--
-- This migration is intentionally narrow. It does NOT install the later
-- canonical-client/import/payment/DW-Intelligence/M2C capabilities itself.
-- It only converts the verified old hosted baseline into a shape where those
-- reviewed authoritative migrations can be applied without guessing.
--
-- No financial value is invented:
--   * client phone/company/notes are added nullable with no backfill;
--   * no currency default is introduced;
--   * due_date becomes nullable rather than being synthesized;
--   * a legacy DATE last_reminder is preserved as midnight UTC when widened
--     to timestamptz.
--
-- No tenant rows are selected as an M2D proof artifact. The catalog preflight
-- below validates structure only.

begin;

set local lock_timeout = '5s';

do $m2d_catalog_preflight$
declare
  v_type text;
  v_nullable text;
  v_def text;
  v_count integer;
  v_user_att smallint;
  v_name_att smallint;
begin
  if to_regclass('public.clients') is null
     or to_regclass('public.invoices') is null then
    raise exception 'M2D baseline requires existing public.clients and public.invoices';
  end if;

  -- Existing live columns that this reconciliation relies on must have the
  -- exact broad type family we inspected. Unknown drift stops here.
  select udt_name into v_type
  from information_schema.columns
  where table_schema='public' and table_name='clients' and column_name='id';
  if v_type is distinct from 'uuid' then
    raise exception 'M2D unexpected clients.id type: %', v_type;
  end if;

  select udt_name into v_type
  from information_schema.columns
  where table_schema='public' and table_name='clients' and column_name='user_id';
  if v_type is distinct from 'uuid' then
    raise exception 'M2D unexpected clients.user_id type: %', v_type;
  end if;

  select udt_name into v_type
  from information_schema.columns
  where table_schema='public' and table_name='clients' and column_name='name';
  if v_type is distinct from 'text' then
    raise exception 'M2D unexpected clients.name type: %', v_type;
  end if;

  -- If these compatibility columns already exist, trust them only when they
  -- have the expected text type. Otherwise the ALTER ADD below creates them.
  for v_def in select unnest(array['phone','company','notes'])
  loop
    select udt_name into v_type
    from information_schema.columns
    where table_schema='public' and table_name='clients' and column_name=v_def;
    if v_type is not null and v_type <> 'text' then
      raise exception 'M2D unexpected clients.% type: %', v_def, v_type;
    end if;
  end loop;

  select udt_name, is_nullable into v_type, v_nullable
  from information_schema.columns
  where table_schema='public' and table_name='invoices' and column_name='client_id';
  if v_type is distinct from 'uuid' then
    raise exception 'M2D unexpected invoices.client_id type: %', v_type;
  end if;

  select udt_name, is_nullable into v_type, v_nullable
  from information_schema.columns
  where table_schema='public' and table_name='invoices' and column_name='due_date';
  if v_type is distinct from 'date' then
    raise exception 'M2D unexpected invoices.due_date type: %', v_type;
  end if;

  select udt_name into v_type
  from information_schema.columns
  where table_schema='public' and table_name='invoices' and column_name='last_reminder';
  if v_type not in ('date','timestamptz') then
    raise exception 'M2D unexpected invoices.last_reminder type: %', v_type;
  end if;

  -- Legacy production had UNIQUE(user_id,name). The current canonical
  -- resolver must be able to represent two distinct customers with the same
  -- display name. Accept either the exact known legacy constraint or no such
  -- constraint; refuse any ambiguous/differently-named equivalent.
  select attnum into strict v_user_att
  from pg_attribute
  where attrelid='public.clients'::regclass and attname='user_id';
  select attnum into strict v_name_att
  from pg_attribute
  where attrelid='public.clients'::regclass and attname='name';

  select count(*) into v_count
  from pg_constraint
  where conrelid='public.clients'::regclass
    and contype='u'
    and conkey=array[v_user_att,v_name_att]::smallint[];

  if v_count > 1 then
    raise exception 'M2D found multiple UNIQUE(user_id,name) constraints; refusing to guess';
  end if;

  if v_count = 1 then
    select conname || ':' || pg_get_constraintdef(oid)
    into v_def
    from pg_constraint
    where conrelid='public.clients'::regclass
      and contype='u'
      and conkey=array[v_user_att,v_name_att]::smallint[];

    if v_def <> 'clients_user_id_name_key:UNIQUE (user_id, name)' then
      raise exception 'M2D unrecognized client same-name uniqueness constraint: %', v_def;
    end if;
  end if;
end
$m2d_catalog_preflight$;

-- Historical canonical-client code expects these fields. Existing hosted
-- address data stays in addr; address is not phone/company/notes, so no
-- semantic backfill is attempted.
alter table public.clients add column if not exists phone text;
alter table public.clients add column if not exists company text;
alter table public.clients add column if not exists notes text;

-- The legacy constraint prevents distinct same-name customers from being
-- represented. It is dropped only after the exact catalog preflight above.
alter table public.clients
  drop constraint if exists clients_user_id_name_key;

-- Current import persistence intentionally permits a missing due date, and
-- the tenant-safe client FK installed later uses ON DELETE SET NULL.
alter table public.invoices alter column due_date drop not null;
alter table public.invoices alter column client_id drop not null;

-- Current browser reminder code writes a full ISO timestamp. Preserve legacy
-- DATE values deterministically as midnight UTC when widening the type.
do $m2d_last_reminder$
declare
  v_type text;
begin
  select udt_name into v_type
  from information_schema.columns
  where table_schema='public' and table_name='invoices' and column_name='last_reminder';

  if v_type = 'date' then
    alter table public.invoices
      alter column last_reminder type timestamptz
      using (last_reminder::timestamp at time zone 'UTC');
  elsif v_type = 'timestamptz' then
    null; -- already reconciled
  else
    raise exception 'M2D last_reminder drifted during reconciliation: %', v_type;
  end if;
end
$m2d_last_reminder$;

do $m2d_postconditions$
declare
  v_type text;
  v_nullable text;
begin
  foreach v_type in array array['phone','company','notes']
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='clients'
        and column_name=v_type and udt_name='text' and is_nullable='YES'
    ) then
      raise exception 'M2D client compatibility column % is not nullable text', v_type;
    end if;
  end loop;

  if exists (
    select 1 from pg_constraint
    where conrelid='public.clients'::regclass
      and conname='clients_user_id_name_key'
  ) then
    raise exception 'M2D legacy clients_user_id_name_key survived';
  end if;

  select is_nullable into v_nullable
  from information_schema.columns
  where table_schema='public' and table_name='invoices' and column_name='due_date';
  if v_nullable <> 'YES' then
    raise exception 'M2D invoices.due_date must be nullable';
  end if;

  select is_nullable into v_nullable
  from information_schema.columns
  where table_schema='public' and table_name='invoices' and column_name='client_id';
  if v_nullable <> 'YES' then
    raise exception 'M2D invoices.client_id must be nullable';
  end if;

  select udt_name into v_type
  from information_schema.columns
  where table_schema='public' and table_name='invoices' and column_name='last_reminder';
  if v_type <> 'timestamptz' then
    raise exception 'M2D invoices.last_reminder must be timestamptz after reconciliation';
  end if;
end
$m2d_postconditions$;

commit;
