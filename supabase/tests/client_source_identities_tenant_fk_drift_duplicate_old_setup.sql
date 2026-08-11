-- Drift scenario: two foreign keys matching the old single-column
-- client_id -> clients(id) shape exist simultaneously (under different
-- names). The forward migration must refuse to guess which one to drop
-- and fail closed before touching any constraint. Never committed — this
-- transaction is rolled back by process exit after the migration below
-- fails.
begin;

alter table public.client_source_identities
  drop constraint client_source_identities_user_id_client_id_fkey;
alter table public.client_source_identities
  add constraint client_source_identities_client_id_fkey
  foreign key (client_id) references public.clients(id) on delete cascade;
alter table public.client_source_identities
  add constraint client_source_identities_client_id_fkey_dup
  foreign key (client_id) references public.clients(id) on delete cascade;
