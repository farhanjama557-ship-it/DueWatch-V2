# M2G-G2 Evidence

## Result

The deterministic repository-scope G2 flow passes. Durable G1 claims produce versioned, tenant-bound Company Graph nodes, edges, entity resolutions, provenance, ambiguity records, conflict links, roles/delegations, Ask DW answers, and DW Intelligence context.

## Validation evidence

- G0 + G1 + G2 focused tests: 129/129.
- G1 durable behavior tests: 34/34.
- G1 migration/security tests: 13/13.
- G2 graph behavior tests: 40/40.
- G2 migration/RLS/parser tests: 15/15.
- Full repository tests: 1,099/1,099.
- Production build: passed; 1,978 modules transformed.
- Diff, credential, and canonical-financial-mutation scans: passed.

The suite covers tenant collisions, same-name clients, exact IDs, aliases, ambiguous and unresolved references, person/client separation, historical aliases, duplicate documents, scope preservation, historical policy isolation, role/delegation boundaries, provenance requirements, cross-tenant edges, idempotent rebuilds, source changes, tenant-bound snapshots, revocation, derived-evidence independence, graph-grounded Ask DW, and typed DW Intelligence context.

The targeted pre-checkpoint hardening additionally proves real PostgreSQL AST parsing, automatic stale-graph rebuilds, database propagation from every invalidated Brain snapshot to its active graph versions, multi-root stable-key merges, conflicting stable-ID preservation, conflicted name-only downstream resolution, non-primary-root invalidation, exact normalized claim-root provenance triples, normalized same-tenant/same-version resolution candidates, cross-tenant/dangling/mismatched-root rejection, founder-decision request fingerprints, auditable mismatch rejections, server-authoritative decision state/evidence, durable Brain snapshot invalidation, and semantic client-reference integrity.

## Conflict and authority proof

The graph organizes the company 5% candidate, Atlas 2% exception, historical 10% rule, and founder-disabled instruction without choosing precedence. Confidence cannot resolve the conflict. Observed settlement responsibility and account-manager communication remain contextual and never create DW authority.

## Financial-truth proof

Graph constructors and SQL rows hard-code canonical financial truth and DW authority to false. The migration does not mutate invoices, payments, payment attempts, payouts, or bank transactions. No locked R0 or DW Intelligence contract amendment is required.

## Qualification

The G1 and G2 migrations have not been runtime-applied to an isolated Postgres/Supabase environment. Structural/RLS/trigger assertions are deterministic repository evidence, not deployment verification.

G2 does not declare M2G complete and does not start G3 or M2H.
