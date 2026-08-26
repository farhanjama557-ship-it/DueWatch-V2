# migrations_legacy — archived DueWatch migration history (READ-ONLY)

**Status:** archived, never executed by tooling. **Rebaseline date:** 2026-08-22. **Branch/PR:** `converge/legacy-live-baseline` (PR A).

## Why this archive exists

The active migration chain is now a single squashed canonical baseline:

```
supabase/migrations/20260822000000_canonical_baseline.sql
```

It was assembled verbatim from this archive (plus the canonical Autopilot
section, `supabase/convergence/sections/20260822000001_autopilot_canonical.sql`)
and is proven structurally equivalent to the **canonical intended
historical end-state** — schema.sql plus every migration below EXCEPT the
documented non-replay-safe `20260811000000`, whose intended effects are
already provided by the corrected `20260726000000` (which creates
`client_source_identities` with the composite tenant FK from the start)
and by `20260803021842`'s later refresh of the FK-allowlist function.
This is not a claim that the broken chronological chain itself ever ran
to completion. Proof: `supabase/convergence/checks/run_canonical_proofs.sh`
(PROOF 4) on every CI run.

## Why the chain was squashed instead of replayed

1. **Production had no migration ledger.** The hosted project's
   `supabase_migrations.schema_migrations` did not exist (verified live
   2026-08-22). Production was a legacy baseline requiring explicit
   convergence, not "N versions behind" of a trustworthy history.
2. **One historical migration is not chronologically replay-safe.**
   `20260811000000_client_source_identities_tenant_fk.sql` ends with an
   unknown-FK allowlist scan that does not know about the import tables
   created by the earlier-timestamped `20260803150000`, so a fresh
   chronological replay raises. This was independently reproduced on a clean
   empty local Postgres (documented in
   `scripts/ci/verify-payments-foundation-current-schema.sh`). Per repo
   policy, historical migrations are never edited to rewrite history —
   so a manifest-driven "skip" would have been required forever, and a
   documentation manifest does not control the Supabase CLI. Squashing was
   the honest architecture.
3. **The baseline is the same schema, machine-verified.** The equivalence
   proof compares every column, type, nullability, default, constraint,
   FK action, index, RLS flag, policy, grant, function, and trigger
   between the fresh baseline and this archive's applied end-state.

## File inventory

| File | Disposition in the baseline |
|---|---|
| `schema.sql` | included verbatim (bootstrap) |
| `20260726000000_canonical_clients.sql` | included verbatim |
| `20260803021842_enforce_invoice_client_tenant_ownership.sql` | included verbatim |
| `20260803150000_import_persistence_core.sql` | included verbatim |
| `20260810000000_client_source_identities_rls.sql` | included verbatim |
| `20260811000000_client_source_identities_tenant_fk.sql` | **not included** — documented non-replay-safe; its intended end-state (composite tenant FK on `client_source_identities`) is already created by the corrected `20260726000000`, which this archive preserves |
| `20260811083005_phase15b_import_table_privilege_baseline.sql` | included verbatim |
| `20260811092928_process_import_batch_hosted_compatibility.sql` | included verbatim |
| `20260813161329_autopilot_execution_claims.sql` | included verbatim |
| `20260814090000_awaiting_signature_pending_only_uniqueness.sql` | included verbatim (owns the pending-only uniqueness end-state) |
| `20260814100000_autopilot_execution_claims_canonical_receipt.sql` | included verbatim |
| `20260816120000_payments_foundation.sql` | included verbatim minus its own `begin;`/`commit;` pair (the whole baseline is one transaction; the pair spans the entire file, so removal is provably neutral and equivalence-verified) |

Two tables were never in any migration — `autopilot_settings` and
`autopilot_rules` were created directly in the hosted project. Their
live-verified DDL is codified in the baseline's autopilot canonical
section.

## Dormant limitation: the client-dedup unknown-FK gate

`duewatch_ops.unknown_client_foreign_keys()`'s FINAL definition (refreshed
by the archived `20260803021842`) is **not complete for the post-import
schema**: its allowlist predates the import tables and does not contain
`import_rows`' foreign-key references to `clients` and `invoices`. On the
canonical baseline state the function therefore returns rows
(`import_rows.client_id` / `import_rows.invoice_id`), and
`duewatch_ops.execute_client_dedup()` — which calls it as a blocking gate
— fails closed.

> Client dedup must not be enabled until import_rows reference behavior
> during client/invoice merge/delete is reviewed and proven. The current
> unknown-FK gate intentionally fails closed.

This is a documented dormant limitation of PR A, not a defect to fix by
blindly whitelisting the import_rows FK pairs. Regression-proven by
PROOF 15 in `supabase/convergence/checks/run_canonical_proofs.sh`.

## Rules

* **Never** move these files back into `supabase/migrations/`.
* **Never** edit them; they are the audit trail of what production history
  actually was. Regenerate the baseline after any accidental change with:
  `bash supabase/convergence/assemble_canonical_baseline.sh`
* The historical per-phase CI workflows (`.github/workflows/*-verify.yml`)
  reference this archive's files through `scripts/ci/*`; they trigger only
  on their dormant historical branches and are superseded by
  `canonical-baseline-verify.yml` for all future work.

## How legacy production converges

One-time, state-aware, fail-closed script (NOT a migration, never run by
tooling on fresh environments):
`supabase/convergence/20260822_legacy_live_to_canonical.sql` — see
`docs/PRODUCTION_CONVERGENCE_RUNBOOK.md`.
