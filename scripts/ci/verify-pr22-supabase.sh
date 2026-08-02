#!/usr/bin/env bash
# Test-only PR #22 verification against a disposable local Supabase stack.

set -uo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-./pr22-verify-artifact}"
mkdir -p "$ARTIFACT_DIR"
FK_WARNING="WARNING: LOCAL REPOSITORY-SCHEMA SMOKE CHECK ONLY. THIS IS NOT STAGING AND DOES NOT SATISFY LIVE SCHEMA-DRIFT VERIFICATION."
overall_status=0

section() {
  echo ""
  echo "=== $1 ==="
}

if [ -z "${DB_URL:-}" ]; then
  echo "DB_URL is not set" >&2
  exit 2
fi

section "Applying repository schema"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/schema.sql \
  > "$ARTIFACT_DIR/01_schema_apply.log" 2>&1
schema_exit=$?
echo "schema.sql exit code: $schema_exit" | tee -a "$ARTIFACT_DIR/01_schema_apply.log"
[ "$schema_exit" -eq 0 ] || overall_status=1

section "Seeding disposable pre-migration fixtures"
psql "$DB_URL" -v ON_ERROR_STOP=1 -X <<'SQL' \
  > "$ARTIFACT_DIR/02_pre_migration_seed.log" 2>&1
do $preconditions$
begin
  if to_regclass('public.client_source_identities') is not null then
    raise exception 'Expected client_source_identities to be absent before migration';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients'
      and column_name = 'canonical_id'
  ) then
    raise exception 'Expected clients.canonical_id to be absent before migration';
  end if;
end
$preconditions$;

insert into auth.users(id, email) values
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddd4', 'phase0-backfill-d@example.test'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5', 'phase0-backfill-e@example.test');

insert into public.clients(id, user_id, name, email, phone, company, created_at)
values
  ('d1000000-0000-4000-8000-000000000001',
   'dddddddd-dddd-4ddd-8ddd-ddddddddddd4', 'Backfill Client',
   ' BACKFILL@EXAMPLE.TEST ', '+1 (212) 555-0111', 'Backfill Company',
   '2025-01-01 00:00:00+00'),
  ('d1000000-0000-4000-8000-000000000002',
   'dddddddd-dddd-4ddd-8ddd-ddddddddddd4', 'backfill-client',
   'backfill@example.test', '1 212 555 0111', 'backfill company',
   '2025-01-02 00:00:00+00'),
  ('e1000000-0000-4000-8000-000000000001',
   'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5', 'Backfill Client',
   'backfill@example.test', '12125550111', 'Backfill Company',
   '2025-01-03 00:00:00+00');
SQL
preseed_exit=$?
echo "pre-migration seed exit code: $preseed_exit" | tee -a "$ARTIFACT_DIR/02_pre_migration_seed.log"
[ "$preseed_exit" -eq 0 ] || overall_status=1

section "Applying PR #22 migration"
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260726000000_canonical_clients.sql \
  > "$ARTIFACT_DIR/03_migration_apply.log" 2>&1
migration_exit=$?
echo "migration exit code: $migration_exit" | tee -a "$ARTIFACT_DIR/03_migration_apply.log"
[ "$migration_exit" -eq 0 ] || overall_status=1

if [ "$schema_exit" -ne 0 ] || [ "$preseed_exit" -ne 0 ] || [ "$migration_exit" -ne 0 ]; then
  echo "Schema, pre-migration seed, or migration failed; skipping downstream tests." >&2
  echo "$overall_status" > "$ARTIFACT_DIR/OVERALL_EXIT_CODE"
  echo "schema_exit=$schema_exit preseed_exit=$preseed_exit migration_exit=$migration_exit" \
    >> "$ARTIFACT_DIR/EXIT_CODE_SUMMARY.txt"
  exit "$overall_status"
fi

section "Verifying migration backfill and identity boundaries"
psql "$DB_URL" -v ON_ERROR_STOP=1 -X <<'SQL' \
  > "$ARTIFACT_DIR/04_migration_backfill.log" 2>&1
do $backfill$
declare
  tenant_d constant uuid := 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';
  tenant_e constant uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5';
begin
  if (select count(*) from public.clients where user_id in (tenant_d, tenant_e)) <> 3 then
    raise exception 'Migration changed the pre-existing client row count';
  end if;
  if exists (
    select 1 from public.clients
    where user_id in (tenant_d, tenant_e)
      and (canonical_id <> id or normalized_name is null
        or normalized_email <> 'backfill@example.test'
        or normalized_phone <> '12125550111'
        or normalized_company <> 'backfill company')
  ) then
    raise exception 'Migration did not backfill canonical/normalized identity fields';
  end if;
  if (select count(*) from public.client_source_identities
      where user_id in (tenant_d, tenant_e) and source = 'duewatch') <> 3
    or exists (
      select 1 from public.clients c
      where c.user_id in (tenant_d, tenant_e)
        and not exists (
          select 1 from public.client_source_identities si
          where si.user_id = c.user_id and si.client_id = c.id
            and si.source = 'duewatch' and si.external_id = c.id::text
        )
    ) then
    raise exception 'Migration did not preserve every legacy client as provenance';
  end if;
  if not exists (
    select 1 from pg_indexes where schemaname = 'public'
      and indexname = 'clients_canonical_id_uidx'
  ) then
    raise exception 'Expected canonical client unique index is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.client_source_identities'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (user_id, source, external_id)'
  ) then
    raise exception 'Expected tenant/source/external-ID unique constraint is missing';
  end if;
  if (select execution_enabled from duewatch_ops.client_dedup_config where singleton) then
    raise exception 'Execution switch was enabled by migration';
  end if;
end
$backfill$;

insert into public.client_source_identities(user_id, client_id, source, external_id)
values
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
   'd1000000-0000-4000-8000-000000000001', 'import', 'ext_case'),
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
   'd1000000-0000-4000-8000-000000000002', 'import', 'EXT_CASE'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
   'e1000000-0000-4000-8000-000000000001', 'import', 'ext_case');

do $boundaries$
begin
  if (select count(*) from public.client_source_identities
      where source = 'import' and external_id in ('ext_case', 'EXT_CASE')) <> 3 then
    raise exception 'Tenant or case-sensitive external-ID provenance collapsed';
  end if;
end
$boundaries$;

delete from auth.users where id in (
  'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5'
);
SQL
backfill_exit=$?
echo "migration backfill exit code: $backfill_exit" | tee -a "$ARTIFACT_DIR/04_migration_backfill.log"
[ "$backfill_exit" -eq 0 ] || overall_status=1

psql "$DB_URL" -v ON_ERROR_STOP=1 -X <<'SQL' \
  > "$ARTIFACT_DIR/05_pre_fixture_cleanup.log" 2>&1
do $cleanup$
begin
  if exists(select 1 from auth.users where id in (
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd4'::uuid,
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5'::uuid))
    or exists(select 1 from public.clients where user_id in (
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd4'::uuid,
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5'::uuid))
    or exists(select 1 from public.client_source_identities where user_id in (
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd4'::uuid,
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5'::uuid)) then
    raise exception 'Pre-migration fixtures were not fully cleaned up';
  end if;
end
$cleanup$;
SQL
precleanup_exit=$?
echo "pre-migration fixture cleanup exit code: $precleanup_exit" \
  | tee -a "$ARTIFACT_DIR/05_pre_fixture_cleanup.log"
[ "$precleanup_exit" -eq 0 ] || overall_status=1

section "Running grouped transactional integration tests"
authenticated_clients_select_before_test=$(psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -X -t -A -c "select has_table_privilege('authenticated', 'public.clients', 'SELECT')::text;")
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/canonical_clients_test.sql \
  > "$ARTIFACT_DIR/06_integration_test.log" 2>&1
integration_exit=$?
echo "integration test exit code: $integration_exit" | tee -a "$ARTIFACT_DIR/06_integration_test.log"
[ "$integration_exit" -eq 0 ] || overall_status=1

integration_relationships_exit=1
tenant_isolation_exit=1
idempotency_exit=1
grep -q 'TEST GROUP PASS: integration_relationships' "$ARTIFACT_DIR/06_integration_test.log" \
  && integration_relationships_exit=0
grep -q 'TEST GROUP PASS: tenant_isolation' "$ARTIFACT_DIR/06_integration_test.log" \
  && tenant_isolation_exit=0
grep -q 'TEST GROUP PASS: resolver_idempotency' "$ARTIFACT_DIR/06_integration_test.log" \
  && idempotency_exit=0
if [ "$integration_relationships_exit" -ne 0 ] \
   || [ "$tenant_isolation_exit" -ne 0 ] \
   || [ "$idempotency_exit" -ne 0 ]; then
  overall_status=1
fi

section "Rollback verification"
{
  echo "The SQL integration suite runs in one transaction and ends with rollback."
  echo "The following checks run in a fresh connection."
} > "$ARTIFACT_DIR/07_rollback_evidence.log"

leftover_summary=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -X -t -A -F',' <<'SQL'
select
  (select count(*) from auth.users where id in (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'::uuid,
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'::uuid
  ) or email = 'phase0-test@example.test'),
  (select count(*) from public.clients where user_id in (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'::uuid,
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'::uuid
  ) or email = 'billing@example.test'),
  (select count(*) from public.client_source_identities where user_id in (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'::uuid,
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'::uuid)),
  (select count(*) from public.client_dedup_runs where user_id in (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'::uuid,
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'::uuid)),
  (select count(*) from public.client_merge_candidates where user_id in (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'::uuid,
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'::uuid)),
  (select count(*) from public.client_merge_audit where user_id in (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'::uuid,
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'::uuid)),
  (select execution_enabled::text from duewatch_ops.client_dedup_config where singleton),
  has_table_privilege('authenticated', 'public.clients', 'SELECT')::text;
SQL
)
rollback_query_exit=$?
IFS=',' read -r leftover_users leftover_clients leftover_sources leftover_runs leftover_candidates leftover_audit exec_enabled_after authenticated_clients_select_after_test <<< "$leftover_summary"
test_clients_grant_rolled_back=1
if [ "${authenticated_clients_select_after_test:-unknown}" \
     != "${authenticated_clients_select_before_test:-unknown}" ]; then
  test_clients_grant_rolled_back=0
fi
rollback_clean=1
if [ "$rollback_query_exit" -ne 0 ] \
   || [ "${leftover_users:-1}" != "0" ] \
   || [ "${leftover_clients:-1}" != "0" ] \
   || [ "${leftover_sources:-1}" != "0" ] \
   || [ "${leftover_runs:-1}" != "0" ] \
   || [ "${leftover_candidates:-1}" != "0" ] \
   || [ "${leftover_audit:-1}" != "0" ] \
   || [ "${exec_enabled_after:-true}" != "false" ] \
   || [ "$test_clients_grant_rolled_back" -ne 1 ]; then
  rollback_clean=0
  overall_status=1
fi
{
  echo "leftover_users=${leftover_users:-?}"
  echo "leftover_clients=${leftover_clients:-?}"
  echo "leftover_source_identities=${leftover_sources:-?}"
  echo "leftover_runs=${leftover_runs:-?}"
  echo "leftover_candidates=${leftover_candidates:-?}"
  echo "leftover_audit=${leftover_audit:-?}"
  echo "execution_enabled_after_test=${exec_enabled_after:-?}"
  echo "authenticated_clients_select_before_test=${authenticated_clients_select_before_test:-?}"
  echo "authenticated_clients_select_after_test=${authenticated_clients_select_after_test:-?}"
  echo "test_clients_grant_rolled_back=$test_clients_grant_rolled_back"
  echo "rollback_clean=$rollback_clean"
} >> "$ARTIFACT_DIR/07_rollback_evidence.log"

section "Confirming legacy dedupe SQL remains untouched"
git diff --exit-code -- supabase/dedupe.sql \
  > "$ARTIFACT_DIR/08_legacy_dedupe_unchanged.log" 2>&1
legacy_dedupe_exit=$?
if [ "$legacy_dedupe_exit" -eq 0 ]; then
  echo "PASS: supabase/dedupe.sql has no working-tree changes." \
    >> "$ARTIFACT_DIR/08_legacy_dedupe_unchanged.log"
else
  overall_status=1
fi

section "Repository-schema FK smoke check (NOT staging verification)"
{
  echo "$FK_WARNING"
  echo "This disposable database contains only repository schema and migrations."
  echo "It cannot prove compatibility with a hosted staging schema."
} > "$ARTIFACT_DIR/09_fk_smoke_check.log"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/verification/phase0_foreign_keys.sql \
  >> "$ARTIFACT_DIR/09_fk_smoke_check.log" 2>&1
fk_exit=$?
echo "FK smoke check exit code: $fk_exit" >> "$ARTIFACT_DIR/09_fk_smoke_check.log"
echo "$FK_WARNING" >> "$ARTIFACT_DIR/09_fk_smoke_check.log"
[ "$fk_exit" -eq 0 ] || overall_status=1

echo "$overall_status" > "$ARTIFACT_DIR/OVERALL_EXIT_CODE"
echo "schema_exit=$schema_exit preseed_exit=$preseed_exit migration_exit=$migration_exit backfill_exit=$backfill_exit precleanup_exit=$precleanup_exit integration_exit=$integration_exit integration_relationships_exit=$integration_relationships_exit tenant_isolation_exit=$tenant_isolation_exit idempotency_exit=$idempotency_exit rollback_clean=$rollback_clean authenticated_clients_select_before_test=${authenticated_clients_select_before_test:-unknown} authenticated_clients_select_after_test=${authenticated_clients_select_after_test:-unknown} test_clients_grant_rolled_back=$test_clients_grant_rolled_back execution_enabled_after_test=${exec_enabled_after:-unknown} legacy_dedupe_exit=$legacy_dedupe_exit fk_exit=$fk_exit" \
  >> "$ARTIFACT_DIR/EXIT_CODE_SUMMARY.txt"

exit "$overall_status"
