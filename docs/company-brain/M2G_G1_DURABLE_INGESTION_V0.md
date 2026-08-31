# M2G-G1 Durable Ingestion V0

## Boundary

This is a deterministic, tenant-scoped Company Brain ingestion substrate. It stores contextual company knowledge and authority records. It is not a financial ledger and cannot write canonical financial truth.

## Pipeline

1. An authenticated tenant-bound worker submits a local Markdown, text, or CSV file with a stable source identity and idempotency key.
2. Content is normalized and SHA-256 hashed.
3. The job is replayed if its key already completed; a reused key with different content fails closed.
4. Content already known to the tenant links to the existing source version and creates no new active knowledge.
5. New content creates or advances a stable source and an exact source version.
6. A deterministic extractor creates a classified artifact and typed claims for the controlled G1 formats.
7. Every claim links to the exact source version through root provenance.
8. Active claims rebuild deterministic conflict membership.
9. A reproducible snapshot records the knowledge version and exact source-version set.
10. Ask DW and DW Intelligence consume the typed snapshot through the existing G0 boundary.

## Safety behavior

- Source changes create distinguishable versions; earlier active claims are superseded.
- Extraction output can become active only if its source remains active and the prepared version is still current.
- Revocation writes a tombstone, revokes all versions, and invalidates dependent artifacts and claims while retaining history.
- Snapshot builders work from a copied prepared set, so freezing a snapshot cannot freeze or mutate persistence records.
- Unknown or cross-tenant provenance fails before snapshot creation.
- Repeated action approvals are not persisted as standing authority.
- Explicit authority is exact-scope, founder-decided, auditable, and revocable.

## Retrieval seam

The durable store supports deterministic filters for tenant, claim type, semantic scope, client/entity, active state, and exact source version. Conflict and authority state are carried in the snapshot. Effective-time fields exist in the SQL model for later temporal policy work, but G1 does not infer legal or temporal applicability.

No vector retrieval is present. If added later, it may only find candidates; deterministic tenant, scope, provenance, authority, and financial-truth filters must remain authoritative.

## Supported and deferred formats

- Supported: UTF-8 Markdown, plain text, and controlled CSV.
- Deferred: PDF text extraction because no safe parser existed in the repository.
- Out of scope: OCR, cloud storage, email, CRM, accounting, and payment-provider connectors.
