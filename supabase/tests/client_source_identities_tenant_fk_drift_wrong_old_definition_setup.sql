-- Drift scenario: the expected old constraint name exists, but with the
-- wrong delete behavior (ON DELETE RESTRICT instead of the real ON DELETE
-- CASCADE). The forward migration must refuse to drop a constraint whose
-- definition it cannot verify, even though the name matches. Never
-- committed — this transaction is rolled back by process exit after the
-- migration below fails.
begin;

alter table public.client_source_identities
  drop constraint client_source_identities_user_id_client_id_fkey;
alter table public.client_source_identities
  add constraint client_source_identities_client_id_fkey
  foreign key (client_id) references public.clients(id) on delete restrict;
