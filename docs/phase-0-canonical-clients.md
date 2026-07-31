# Phase 0: canonical client identity

This package is intentionally fail-closed. Applying the migration adds
identity metadata, provenance, audit tables, and operator functions, but it
does not merge or delete any client. The private execution switch defaults to
off and this change does not enable it.

`supabase/dedupe.sql` is legacy. Do not run or modify it for Phase 0.

## Schema

`clients.canonical_id` is the permanent identity. Existing clients are
backfilled with `canonical_id = id`, so current UUIDs remain stable. New
normalized columns are maintained by a trigger:

- `normalized_name`
- `normalized_email`
- `normalized_domain`
- `normalized_phone`
- `normalized_company`

`client_source_identities` stores `(user_id, source, external_id)` and JSON
provenance. The combination is unique, so imports must resolve the source ID
before creating a client. External IDs are trimmed but remain case-sensitive;
source names are lower-cased.

Operational state lives in:

- `client_dedup_runs`
- `client_merge_candidates`
- `client_merge_audit`
- private `duewatch_ops.client_dedup_config`

All public tables have RLS. Cleanup functions live in the unexposed
`duewatch_ops` schema. Data-API wrappers are callable only by `service_role`;
the service-role key must never be used in the browser.

## Matching rules

All comparisons are deterministic and scoped to one `user_id`.

| Rule | Classification | Executable |
|---|---|---:|
| exact source + external ID | exact/prevented at ingestion | yes |
| normalized email + exact normalized name or company | exact | yes |
| normalized full phone + exact normalized name or company | review required | no |
| normalized domain + exact normalized company | review required | no |
| email only | review required | no |
| name only | review required | no |
| full phone only | review required | no |
| domain only | review required | no |

There is no country-code inference, fuzzy matching, phonetic matching, or AI
classification. Empty values never corroborate a match.

## Invoice creation safeguard

The current invoice modal calls `resolve_or_create_client` rather than relying
on cached browser state followed by a direct client insert. The RPC:

1. verifies `auth.uid()` owns the requested user ID;
2. takes a transaction advisory lock for the normalized identity;
3. returns an unambiguous existing client;
4. rejects ambiguous identities; or
5. creates exactly one new client.

## Dry run

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only in the operator
environment, then run:

```sh
npm run clients:dedupe -- dry-run --user-id <user-uuid>
npm run clients:dedupe -- report --run-id <run-uuid>
```

The report separates exact and review-required candidates, skipped records,
and invoice counts. It does not include reminder bodies or service secrets.
A prepared run has `"data_changed": false`.

## Mandatory gates

Execution fails unless all four conditions are true:

1. `duewatch_ops.client_dedup_config.execution_enabled` is true.
2. The staging foreign-key verification passed and was attested for this run.
3. The transactional PostgreSQL integration suite passed and was attested.
4. The phrase is exactly `EXECUTE <run-uuid>`.

The migration leaves condition 1 false. There is deliberately no application
or npm command to enable it.

### Staging foreign-key verification

Run in staging:

```text
supabase/verification/phase0_foreign_keys.sql
```

It is a read-only transaction. It prints the full catalog map and raises if a
relationship is unknown or an expected relationship is missing. Save its
passing JSON, then attest the production dry-run metadata:

```sh
npm run clients:dedupe -- attest-fks --run-id <run-uuid> \
  --confirm "VERIFY FOREIGN KEYS <run-uuid>" \
  --evidence-json '{"environment":"staging","unknown_foreign_keys":[],"missing_foreign_keys":[]}'
```

Execution repeats the unknown-FK catalog check in the target database.

### Integration tests

Apply the schema and migration to disposable Supabase/PostgreSQL, then run:

```text
supabase/tests/canonical_clients_test.sql
```

The suite enables execution only inside its transaction and always rolls back.
It proves:

- execution is disabled by default;
- missing FK/test gates fail closed;
- a wrong confirmation phrase fails closed;
- phone matches remain review-required;
- duplicate prevention is serialized through the RPC;
- invoice, line-item, reminder, approval, activity, and evidence IDs/content
  survive a merge;
- repeated preparation is idempotent; and
- rollback restores the client and invoice pointer without changing history.

After a passing disposable run:

```sh
npm run clients:dedupe -- attest-tests --run-id <run-uuid> \
  --confirm "VERIFY INTEGRATION TESTS <run-uuid>" \
  --evidence-json '{"passed":true,"transaction_rolled_back":true,"suite":"canonical_clients_test.sql"}'
```

## Execution (documented, still disabled)

Even after both attestations, this fails while the private switch remains off:

```sh
npm run clients:dedupe -- execute --run-id <run-uuid> \
  --confirm "EXECUTE <run-uuid>"
```

When separately authorized in the future, execution updates only
`invoices.client_id`. Invoice UUIDs do not change, so verified line items,
reminders, `awaiting_signature` approvals, `events` activity, and
`events.evidence` remain on their existing invoice rows.

## Rollback

Before each merge, the audit row stores the full duplicate client, exact
invoice UUIDs, provenance mappings, and relationship counts. Rollback recreates
the original client UUID/canonical ID and moves only those recorded invoices:

```sh
npm run clients:dedupe -- rollback --run-id <run-uuid> \
  --confirm "ROLLBACK <run-uuid>"
```

Invoices created after execution remain with the canonical client.

## Unverified relationships

The repository schema does not define the production DDL for
`autopilot_settings` or `autopilot_rules`. It also has no separate `payments`,
`approvals`, or `evidence` tables; the verified equivalents are
`invoices.amount_paid`, `awaiting_signature`, and `events.evidence`.

The staging verification must be run against the actual current catalog. Any
additional relationship blocks execution until preservation and rollback
behavior are added and tested.
