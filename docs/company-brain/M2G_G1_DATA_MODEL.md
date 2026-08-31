# M2G-G1 Data Model

The migration `20260830055532_company_brain_durable_ingestion_g1.sql` adds thirteen tenant-owned tables.

| Table | Durable purpose |
| --- | --- |
| `company_brain_ingestion_jobs` | Idempotency key, content hash, attempt state, and retry evidence. |
| `company_brain_sources` | Stable source identity, current-version pointer, active/revoked state. |
| `company_brain_source_versions` | Immutable content hash, version number, job lineage, processing/current status. |
| `company_brain_artifacts` | Classified material linked to an exact source version. |
| `company_brain_claims` | Typed scoped claim; canonical financial truth is constrained to `false`. |
| `company_brain_claim_roots` | Exact root provenance and independent-evidence marker. |
| `company_brain_conflicts` | Scoped topic conflict, optimistic revision, resolution pointer. |
| `company_brain_conflict_members` | Tenant-safe claim membership in a conflict. |
| `company_brain_founder_decisions` | Append-only authenticated decision history, prior/new state, reason, provenance, supersession. |
| `company_brain_founder_decision_attempts` | Append-only accepted/stale attempt audit with expected and actual revisions. |
| `company_brain_authority_proposals` | Proposed/approved/rejected/revoked exact-scope authority state. |
| `company_brain_source_tombstones` | Persistent source revocation record. |
| `company_brain_snapshots` | Reproducible version/hash, source lineage, typed reference sets, revocation watermark. |

## Integrity rules

- Every table has `user_id`; all cross-table knowledge links use composite `(user_id, id)` foreign keys.
- Source hashes are tenant-unique, providing exact-content dedupe without claiming semantic equivalence.
- Stable source identity and monotonically increasing version number distinguish modifications.
- Claims link directly to a source version and artifact, and separately retain root links.
- Historical decisions are inserted, never destructively overwritten by browser grants.
- Conflict and authority revisions support optimistic locking.
- Snapshots are unique by tenant/version and by tenant/knowledge-version/hash.
- Source and decision relationships use restrictive or deferred constraints where cyclic references require a transaction boundary.

## Snapshot contract

Each persisted snapshot exposes tenant, snapshot version, knowledge version, schema version, hash, exact source-version IDs, approved policy references, unresolved conflicts, role/delegation references, authority references, active claim references, tombstone watermark, and creation time. This is sufficient for consumers to identify the Company Brain version they used.
