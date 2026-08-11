-- TEST ONLY: emulate the exact pre-PR-33 client_source_identities FK state
-- inside a transaction on a disposable local database. The caller applies
-- the approved PR #33 forward migration and Phase 1.5B migration, captures
-- a schema fingerprint, and then rolls this entire path back.
-- Never run this file against hosted staging or production.

begin;

do $preflight$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.client_source_identities'::regclass
      and conname = 'client_source_identities_user_id_client_id_fkey'
      and contype = 'f'
      and convalidated
      and not condeferrable
      and not condeferred
      and pg_get_constraintdef(oid) =
        'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id) ON DELETE CASCADE'
  ) then
    raise exception 'Forward-path setup requires the exact reviewed composite source-identity FK';
  end if;

  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.client_source_identities'::regclass
      and conname = 'client_source_identities_client_id_fkey'
  ) then
    raise exception 'Forward-path setup found an unexpected legacy FK before emulation';
  end if;
end
$preflight$;

alter table public.client_source_identities
  drop constraint client_source_identities_user_id_client_id_fkey;

alter table public.client_source_identities
  add constraint client_source_identities_client_id_fkey
  foreign key (client_id) references public.clients(id) on delete cascade;

do $postcondition$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.client_source_identities'::regclass
      and conname = 'client_source_identities_client_id_fkey'
      and contype = 'f'
      and convalidated
      and not condeferrable
      and not condeferred
      and pg_get_constraintdef(oid) =
        'FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE'
  ) then
    raise exception 'Failed to emulate the exact pre-PR-33 source-identity FK';
  end if;
end
$postcondition$;
