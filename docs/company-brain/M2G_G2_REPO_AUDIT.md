# M2G-G2 Repository Audit

Date: 2026-08-30
Branch: `m2g/company-brain-bootstrap-g2`
G1 checkpoint and G2 base: `ab6db44b84f05a47f002fd6bce21dfe2451bc6ea`

## Pre-G2 gate

The complete G1 diff was reviewed before G2 began. It contained only the durable Company Brain implementation, controlled fixtures, migration, tests, and required evidence artifacts. The G1 migration retained explicit grants, tenant-bound RLS, composite tenant foreign keys, hardened RPC boundaries, and no financial-ledger mutation.

The reviewed G1 tree passed:

- G1 focused suite: 66/66.
- Full repository suite: 1,036/1,036.
- Production build: 1,998 modules transformed.
- Migration structural/RLS checks.
- Diff whitespace check after removing two Markdown hard-break spaces.

G1 was committed as `M2G G1 durable company brain ingestion`, and G2 was branched from that exact commit.

## Existing primitives reused

- G1 sources, source versions, artifacts, claims, conflicts, roots, tombstones, and deterministic snapshots remain the graph input.
- G0 authority and financial-truth boundaries remain authoritative.
- The graph uses normalized Postgres tables and tenant-composite foreign keys rather than adding a graph database.
- Browser access remains read-only and tenant-bound; a future internal worker owns graph rebuild transactions.

## Scope findings

- No vector or embedding layer was needed.
- No precedence engine was introduced. Graph structure preserves conflicts and applicability scope but does not choose a winning policy.
- No Company Brain product UI changed.
- No live integration or production/provider path was added.
- No R0 financial table or canonical-money writer changed.

## Runtime qualification

Neither the G1 migration nor the G2 migration was applied to an isolated Postgres/Supabase runtime. Both have deterministic structural/RLS checks only. They are not deployment-verified and must not be deployed without isolated runtime migration, RLS, trigger, and worker-transaction tests.
