# M2G-G1 Evidence

## Result

The deterministic G1 durable loop passes in the repository implementation.

Realistic local Markdown/text/CSV material creates tenant-scoped jobs, stable sources, exact versions, artifacts, typed claims, root links, conflicts, and versioned snapshots. Ask DW and DW Intelligence retrieve typed snapshot context. Founder conflict decisions and exact-scope authority changes are authenticated, idempotent, optimistic, auditable, and revocable. Source revocation removes dependent knowledge from later snapshots while preserving lineage. Canonical financial truth remains untouched.

## Deterministic proof

- G0 + G1 focused tests: 66/66 passed.
- G1 behavioral durable-store tests: 29/29 passed.
- G1 migration/security structural tests: 10/10 passed.
- Full repository tests: 1,036/1,036 passed.
- Production build: passed; 1,998 modules transformed.
- Diff whitespace check: passed.
- Credential and scope scans: passed.

Test coverage includes cross-tenant reads/writes, foreign provenance, missing roots, retries, exact-content dedupe, modified versions, duplicate corroboration, four race cases, snapshot lineage, authenticated founder writes, stale decisions, authority non-escalation, exact-scope grants/revocation, R0 payment refetch, client scope, Ask DW provenance/conflict behavior, DW Intelligence typed context, and complete ingest-to-revocation flow.

## Financial-truth boundary

- Company Brain claim construction rejects canonical financial truth.
- The SQL column is constrained to `false`.
- The migration does not mutate invoices, payments, payment attempts, payouts, or bank transactions.
- Contextual material saying an invoice was paid routes Ask DW to the R0 authoritative financial refetch path.
- No locked R0 or DW Intelligence contract amendment is required.

## Honest limitations

- SQL was structurally verified but not applied because no isolated Postgres/Supabase runtime was available.
- The in-memory deterministic implementation models durable transaction behavior for tests; production ingestion-worker wiring is deferred.
- PDF parsing is deferred because the repository has no safe parser.
- Exact normalized-content dedupe is implemented; broader semantic dedupe is not claimed.
- Multi-user organization roles are not present; the current SQL founder boundary is the authenticated tenant owner.

G1 does not declare M2G complete and does not begin G2 or M2H.
