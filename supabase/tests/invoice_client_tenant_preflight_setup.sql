-- Prepares one deliberately invalid relationship inside an uncommitted
-- transaction. The correction migration must fail before changing schema.
-- The psql session closes after that expected failure, rolling this back.
begin;

alter table public.invoices drop constraint invoices_client_id_fkey;

insert into auth.users(id, email) values
  ('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'preflight-a@example.test'),
  ('ebbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'preflight-b@example.test');

insert into public.clients(id, user_id, name) values
  ('e1000000-0000-4000-8000-000000000001',
   'ebbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
   'Preflight Tenant B Client');

insert into public.invoices(
  id, user_id, client_id, inv_num, amount
) values (
  'e2000000-0000-4000-8000-000000000002',
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'e1000000-0000-4000-8000-000000000001',
  'PREFLIGHT-CROSS-TENANT',
  10
);
