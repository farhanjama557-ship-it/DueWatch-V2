# DueWatch — Production Convergence Runbook

**Status: DOCUMENTATION ONLY. This runbook has NOT been executed against production.**
**It is executed only after PR A (`converge/legacy-live-baseline`) is reviewed and merged, and only by the founder or an operator they explicitly authorize.**

Purpose: move the legacy production database (verified live state, 2026-08-22) to the canonical baseline state (`supabase/migrations/20260822000000_canonical_baseline.sql`) and bootstrap a trustworthy Supabase migration ledger, with every step rehearsed locally first.

---

## 0. Ground rules

* **Never** run the canonical baseline SQL directly against production. The one-time convergence is performed ONLY by `supabase/convergence/20260822_legacy_live_to_canonical.sql` (state-aware, fail-closed, rehearsed).
* **Never** execute anything from `supabase/migrations_legacy/`.
* The canonical baseline SQL itself is never executed against production: convergence reaches the same state (PROOF 3 in CI), and the ledger records the version as applied afterwards.
* Every command below that touches production is marked **[PROD]**. Everything else runs on disposable local infrastructure.
* Pinned Supabase CLI version for the entire window: **2.109.1** (the version the no-ledger rehearsal was observed with).

## 1. Preconditions (all must be true before the window opens)

1. PR A merged to main; CI `canonical-baseline-verify` green on main.
2. Supabase CLI **2.109.1** installed locally: `supabase --version`.
3. psql client available (any recent version).
4. **[PROD]** A verified backup / restore point exists for the production project — restore has been TESTED, not assumed. This is the only destructive recovery path.
5. **[PROD]** The live database matches the verified legacy baseline EXACTLY: the convergence preflight enforces a full structural fingerprint (exact public-schema inventory, columns, constraints, indexes, policies, RLS flags, and function definitions — not just the 10 table names; no `duewatch_ops`, import, claims, or payments objects, and no extra or drifted objects of any kind). If the fingerprint refuses, STOP: do not weaken the fingerprint; re-verify live and re-derive it first.
6. A maintenance-window decision has been made (the convergence holds brief locks; the baseline is one transaction; the run is minutes, not hours, on this data size).

## 2. Local rehearsal (mandatory, immediately before the window)

Re-run everything on a disposable stack from the merged main:

```bash
supabase start
ARTIFACT_DIR=./canonical-proofs-artifact \
  bash supabase/convergence/checks/run_canonical_proofs.sh
ARTIFACT_DIR=./canonical-proofs-artifact \
  bash supabase/convergence/checks/run_ledger_rehearsal.sh
```

Expected: `=== ALL CANONICAL PROOFS PASSED ===` and `=== LEDGER REHEARSAL PASSED (pinned CLI: 2.109.1) ===`.

### Observed no-ledger rehearsal result (2026-08-22, CLI 2.109.1)

* With NO `supabase_migrations.schema_migrations` present, `supabase migration repair <version> --status applied --db-url <url>` **safely initializes the metadata schema/table itself** and records the version — the manual-initialization fallback in the rehearsal script did not need to run.
* After repair, `supabase migration list --db-url <url>` shows local/remote agreement (no Required/Pending entries).
* `supabase db push --dry-run --db-url <url>` reports the database is up to date — zero pending migrations.
* Full transcript: CI artifact `canonical-baseline-verification → ledger_rehearsal.log`.

## 3. Production window

### 3.1 Capture pre-state **[PROD]**

```bash
# Full schema capture for the post-run comparison (use your project ref + creds)
# e.g. via the dashboard SQL editor or:
pg_dump "$PROD_DB_URL" --schema-only --no-owner --no-privileges > prod_schema_before.sql
```

Also record: `select version();` (the Postgres major version matters for default-privilege cosmetics — see §5 notes).

### 3.2 Execute the EXACT rehearsed convergence script **[PROD]**

```bash
psql "$PROD_DB_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/convergence/20260822_legacy_live_to_canonical.sql
```

* Expected on the verified legacy state: the preflight NOTICE ("verified legacy baseline fingerprint matched exactly"), the baseline's one transaction ending with "final canonical assertions: all passed (inside the mutation transaction, before commit)", then the informational PHASE 2 checks, exit 0.
* Any failure: either before any mutation (preflight) or inside the baseline's single transaction — including the FINAL canonical assertions, which run immediately before commit. Nothing partial remains. Go to §4.
* A SECOND invocation after a successful convergence is EXPECTED to fail closed ("already-mutated state") without changing anything — this is a one-time tool by contract, not a bug.

### 3.3 Canonical postcondition spot-checks **[PROD]**

```sql
-- composite tenant FK present and validated
select pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.invoices'::regclass
  and conname = 'invoices_user_id_client_id_fkey';
-- legacy three-column unique GONE...
select conname from pg_constraint
where conrelid = 'public.awaiting_signature'::regclass
  and conname = 'awaiting_signature_user_id_invoice_id_status_key';  -- expect 0 rows
-- ...and pending-only index PRESENT
select indexname from pg_indexes
where schemaname = 'public' and tablename = 'awaiting_signature';
-- era objects exist
select to_regclass('public.autopilot_execution_claims') as claims,
       to_regclass('public.payments') as payments,
       to_regclass('public.payment_allocations') as allocations;
-- canonical policies exist (policies are NOT relations — use pg_policies)
select tablename, policyname from pg_policies
where schemaname = 'public'
  and (tablename, policyname) in (
    ('payments', 'payments_select_own'),
    ('autopilot_settings', 'autopilot_settings_own'),
    ('autopilot_rules', 'autopilot_rules_own')
  );
```

(The rollback-protected success gates are the FINAL canonical assertions inlined inside the baseline's transaction, immediately before its commit — a failure there rolls the entire convergence back. The convergence script's PHASE 2 and the queries above are informational post-commit confirmations only.)

### 3.4 Structural equivalence against the rehearsal artifact **[PROD + local]**

```bash
psql "$PROD_DB_URL" -X -q -t -A -F $'\t' \
  -f supabase/convergence/checks/canonical_snapshot_queries.sql | LC_ALL=C sort > prod_snapshot.txt
diff prod_snapshot.txt canonical-proofs-artifact/snapshot_fresh_1.txt
```

Expected: empty diff, **with one documented cosmetic caveat** — default-privilege grants (MAINTAIN/TRUNCATE/REFERENCES/TRIGGER to anon/authenticated/service_role on `public` tables) exist only where tables were created under platform default privileges. If production's Postgres major version differs from the CI stack's (17.6 at rehearsal time), these default-grant rows may differ cosmetically between the two sides. Every security-relevant grant in the baseline is explicit and identical regardless. If any NON-grant difference appears: STOP, do not repair the ledger, restore if needed.

### 3.5 Repair the migration ledger (ONLY after 3.4 passes) **[PROD]**

```bash
# Timestamp-only version form — exactly as rehearsed:
supabase migration repair 20260822000000 --status applied --db-url "$PROD_DB_URL"

supabase migration list --db-url "$PROD_DB_URL"   # require local/remote agreement
supabase db push --dry-run --db-url "$PROD_DB_URL" # require ZERO pending
```

From this moment, `supabase db push` is the only sanctioned path for schema changes; dashboard/manual SQL on application schemas is banned going forward.

## 4. Failure handling

* **Failure before/during 3.2:** nothing partial (preflight runs before mutation; the baseline is one transaction). Fix the cause, re-rehearse, re-open the window.
* **Failure after a COMMITTED convergence (3.3/3.4):** default recovery is a TESTED FORWARD-FIX migration committed as a normal post-baseline migration — never improvised reverse drops. Destructive rollback = restore the §1.4 backup only, explicitly decided by the founder.
* **Edge/Vercel/cron are OUT OF SCOPE for this window** and may be independently reverted at any time; they are not touched by this runbook.

## 5. Post-convergence (separate, deliberate steps — NOT part of this window)

1. Deploy the current-main Edge Functions (they depend on the now-present claims/payments schema).
2. Establish the scheduler cron.
3. Frontend deploy.
4. PR B (event proof integrity + scheduler secret) as a normal post-baseline migration + app change.

NOTE — client dedup stays disabled after this window: the unknown-FK gate
(`duewatch_ops.unknown_client_foreign_keys()`) intentionally fails closed
on the canonical state because the `import_rows` FK references to
clients/invoices are not in its allowlist. Client dedup must not be
enabled until import_rows reference behavior during client/invoice
merge/delete is reviewed and proven.

## Observed environment facts (for the record)

| Fact | Value |
|---|---|
| Rehearsal CLI | 2.109.1 |
| Rehearsal Postgres | 17.6 |
| repair self-initializes missing metadata | YES (observed; fallback unused) |
| Fresh-chain proofs | 15/15 PASS (2026-08-22, incl. fingerprint/ACL/dedup-gate proofs) |
| Payments/claims/awaiting suites | PASS (canonical + CI-bootstrap paths) |
| Production Postgres major | NOT VERIFIED (check in 3.1) |
