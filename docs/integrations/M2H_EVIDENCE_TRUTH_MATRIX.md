# M2H — evidence and truth matrix

## Evidence classes E0–E8 (not a ranking)

| Class | Means |
|---|---|
| E0 | hypothesis |
| E1 | official machine-readable schema confirms |
| E2 | official documentation states |
| E3 | schema and documentation agree |
| E4 | observed once in a provider sandbox |
| E5 | reproduced with a fresh independent fixture |
| E6 | documentation and empirical behaviour agree |
| E7 | multiple materially different providers support the rule |
| E8 | grounded in accounting/domain principle rather than one API |

**These are kinds of proof, not amounts of it.** `EVIDENCE_CLASS_IS_RANKED === false`, and
no comparison function exists, so no code can "upgrade" a claim by picking a bigger
number. Whether a field exists is a schema question; how a provider behaves when a
payment is deleted is not, and no schema will ever answer it.

Enforced: E4/E5/E6 assert somebody watched a real provider, so `recordEvidence` throws if
the environment is `MOCK` or `FIXTURE_REPLAY`. E1/E2/E3/E6 require a citation.

**Evidence is never authority.** `evidenceGrantsAuthority()` returns false, always, and
every record carries `grantsAuthority: false`.

## Contradiction markers

`NO_CONTRADICTION`, `DOC_VS_DOC_CONTRADICTION`, `SCHEMA_VS_DOC_CONTRADICTION`,
`DOC_VS_SANDBOX_CONTRADICTION`, `PROVIDER_VS_PROVIDER_DIFFERENCE`,
`SOURCE_STATE_DISAGREEMENT`, `UNRESOLVED`.

A real disagreement needs the **same dimension, same subject, different values**.

## Generalization G0–G5

`G0` provider implementation detail → `G1` provider capability → `G2` multi-provider
pattern → `G3` candidate canonical concept → `G4` candidate canonical invariant →
`G5` locked canonical rule.

`promoteGeneralization` moves **one level at a time** and refuses to skip. One provider
behaving a certain way is a fact about that provider, not a DueWatch rule.

## Freshness and invalidation

`FRESH | STALE | INVALIDATED | REFETCH_REQUIRED | SOURCE_UNAVAILABLE | UNKNOWN`.
**Only `FRESH` may govern.**

Three things kept apart:
- `SOURCE_UNAVAILABLE` is an *unknown*, not "no issues". An empty result from a working
  provider means nothing outstanding; an empty result because the call failed means we
  have no idea.
- `INVALIDATED` is not merely old — an event said this observation is wrong now.
- `REFETCH_REQUIRED` is an *obligation*, not a belief.

Invalidation is a **set**, because a deleted payment invalidates five things:

    PAYMENT_DELETED → dimensions: receipt, allocation, AR
                    → refetch: payment, invoice, allocations, customer_unapplied_value

An **unrecognised** mutation invalidates everything. We do not know what it touched, so
nothing is assumed intact — the opposite of the convenient default.

`REFUND_ISSUED` deliberately does **not** assert the invoice reopens. Whether a refund
reopens AR is provider- and policy-specific and unresearched; the honest output is
"re-read it".
