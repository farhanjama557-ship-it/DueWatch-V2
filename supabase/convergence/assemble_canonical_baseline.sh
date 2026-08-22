#!/usr/bin/env bash
#
# supabase/convergence/assemble_canonical_baseline.sh
#
# Generates supabase/migrations/20260822000000_canonical_baseline.sql by
# assembling the CI-PROVEN chronological chain verbatim:
#
#   schema.sql
#   + autopilot canonical section (sections/20260822000001_...)
#   + every historical migration EXCEPT the documented non-replay-safe
#     20260811000000 (same exception CI codifies for the old chain; its
#     end-state is already provided by the corrected 20260726000000).
#
# The generated baseline is a FRESH-DATABASE CONSTRUCTOR: every statement
# is deterministic on an empty database. The payments file's own
# `begin;`/`commit;` pair is stripped because the whole baseline is
# wrapped in one explicit transaction (a provably neutral edit: the pair
# spans the entire file, lines 8..793, so removing it changes nothing
# about what runs between).
#
# The generated file must NEVER be hand-edited: regenerate it instead.
# Equivalence between the baseline and the archived chain is proven by
# supabase/convergence/checks/run_canonical_proofs.sh on every run.
#
# Run from the repository root: bash supabase/convergence/assemble_canonical_baseline.sh

set -euo pipefail
cd "$(dirname "$0")/../.."

OUT="supabase/migrations/20260822000000_canonical_baseline.sql"

LEGACY="supabase/migrations_legacy"
if [ ! -d "$LEGACY" ]; then
  # Before archiving, the files still live in supabase/migrations.
  LEGACY="supabase/migrations"
fi

# schema.sql lives beside migrations before archiving, inside afterwards.
SCHEMA="supabase/schema.sql"
if [ ! -f "$SCHEMA" ]; then
  SCHEMA="$LEGACY/schema.sql"
fi

CHAIN=(
  "schema.sql"
  "20260726000000_canonical_clients.sql"
  "20260803021842_enforce_invoice_client_tenant_ownership.sql"
  "20260803150000_import_persistence_core.sql"
  "20260810000000_client_source_identities_rls.sql"
  "20260811083005_phase15b_import_table_privilege_baseline.sql"
  "20260811092928_process_import_batch_hosted_compatibility.sql"
  "20260813161329_autopilot_execution_claims.sql"
  "20260814090000_awaiting_signature_pending_only_uniqueness.sql"
  "20260814100000_autopilot_execution_claims_canonical_receipt.sql"
  "20260816120000_payments_foundation.sql"
)

{
  cat <<'HDR'
-- ============================================================================
-- DueWatch canonical baseline — the single active migration that constructs
-- the complete canonical pre-PR-B DueWatch database from an EMPTY Supabase
-- stack.
--
-- GENERATED FILE — do not edit by hand.
-- Regenerate with: bash supabase/convergence/assemble_canonical_baseline.sh
--
-- Provenance: assembled verbatim from the archived historical chain
-- (supabase/migrations_legacy/) plus the canonical Autopilot section
-- (supabase/convergence/sections/20260822000001_autopilot_canonical.sql).
-- The historical file 20260811000000_client_source_identities_tenant_fk.sql
-- is intentionally NOT part of this chain: it is the documented
-- non-replay-safe migration (its unknown-FK allowlist predates the import
-- tables), and its intended end-state is already created correctly by the
-- corrected 20260726000000. See migrations_legacy/README.md.
--
-- What this file is NOT:
--   * it does NOT converge a legacy production database — that is the
--     one-time, state-aware script supabase/convergence/
--     20260822_legacy_live_to_canonical.sql, which includes this baseline;
--   * it does NOT contain the event-origin architecture (PR B), Scheduled
--     Actions, or Promise-to-Pay.
--
-- Proofs (scripts/ci + supabase/convergence/checks):
--   * fresh `supabase db reset` constructs this schema and nothing else;
--   * the baseline is structurally equivalent to the CANONICAL INTENDED
--     HISTORICAL END-STATE (see below) under normalized structural
--     equivalence, ignoring catalog ids and ordering;
--   * legacy-like fixture + the convergence script reach the same state.
--
-- CANONICAL INTENDED HISTORICAL END-STATE means: the archived chain's
-- intended final schema — schema.sql plus every migration EXCEPT the
-- documented non-replay-safe 20260811000000, whose intended effect (the
-- composite tenant-safe FK on client_source_identities) is already
-- created from the start by the corrected 20260726000000, and whose
-- function-refresh is superseded by the later definition installed by
-- 20260803021842. It does NOT claim the broken chronological chain ever
-- ran to completion (it cannot — 20260811000000 raises when replayed
-- after the import tables exist).
-- ============================================================================

begin;
HDR

  for f in "${CHAIN[@]}"; do
    echo ""
    echo "-- ============================================================================"
    echo "-- [SOURCE: $f]"
    echo "-- ============================================================================"
    if [ "$f" = "schema.sql" ]; then
      cat "$SCHEMA"
    elif [ "$f" = "20260816120000_payments_foundation.sql" ]; then
      # Strip the file's own begin;/commit; pair (lines 1 and last of its
      # transaction wrapper) — the baseline is already one transaction.
      sed -e 's/^begin;$//' -e 's/^commit;$//' "$LEGACY/$f"
    else
      cat "$LEGACY/$f"
    fi
    if [ "$f" = "schema.sql" ]; then
      echo ""
      echo "-- ============================================================================"
      echo "-- [SOURCE: sections/20260822000001_autopilot_canonical.sql]"
      echo "-- ============================================================================"
      cat supabase/convergence/sections/20260822000001_autopilot_canonical.sql
    fi
  done

  echo ""
  echo "-- ============================================================================"
  echo "-- [SOURCE: sections/20260822000002_final_canonical_assertions.sql]"
  echo "-- ============================================================================"
  cat supabase/convergence/sections/20260822000002_final_canonical_assertions.sql
  echo ""
  echo "commit;"
} > "$OUT"

echo "Generated $OUT ($(wc -l < "$OUT") lines)"
