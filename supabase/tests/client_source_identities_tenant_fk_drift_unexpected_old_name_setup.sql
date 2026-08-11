-- Drift scenario: a foreign key matching the old single-column
-- client_id -> clients(id) shape exists, but under an unexpected name (the
-- expected name is absent). The forward migration must refuse to drop a
-- constraint it does not recognize by name, even though the shape matches.
-- Never committed — this transaction is rolled back by process exit after
-- the migration below fails.
begin;

alter table public.client_source_identities
  drop constraint client_source_identities_user_id_client_id_fkey;
alter table public.client_source_identities
  add constraint client_source_identities_unexpected_client_fk
  foreign key (client_id) references public.clients(id) on delete cascade;
