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

### Primitive vs composite

**A caller may assert a primitive class; a composite class must be earned.**

| | Classes | Rule |
|---|---|---|
| Primitive | E0, E1, E2, E4 | assertable directly — each names one kind of proof the caller can supply |
| Composite | E3, **E5**, E6, E7, E8 | `composeEvidence()` only; `recordEvidence()` refuses them outright |

**E5 is composite.** "Independently reproduced" is a statement about *two observations*,
not a label: it requires two `E4` records for the **same provider** and the **same
proposition** with **distinct `captureId`**. The same record twice, a copy of it, or two
records dressed up from one capture are all one observation. Reproduction is
provider-specific — another provider behaving similarly is E7, not a reproduction.

### Proposition identity — what is being proved

Every record carries an explicit `propositionKey`: a deterministic, provider-neutral
`lower_snake_case` identifier such as `payment_receipt_is_not_allocation` or
`webhook_delivery_may_repeat`.

    propositionKey  WHAT is being proved   (provider-neutral)
    provider        WHERE it was observed
    captureId       WHICH observation saw it

**Every composite requires its components to share one proposition, by exact equality.**
No similarity, no embeddings, no fuzzy matching, no model judgement. Without this,
composition checked class and provider count while ignoring subject matter — so a schema
fact about invoice balances and a doc fact about webhook retries composed into E3, and
two providers supporting two unrelated things composed into E7.

A key naming its own provider is refused (compared by token, not substring, so a provider
called `p` does not collide with the word `proposition`): the key says *what* is proved,
the provider field says *where* it was seen.

- **E3** requires an E1 *and* an E2 component — not one arbitrary citation labelled E3.
- **E6** requires an E2 component *and* a real sandbox component (E4 or E5).
- **E7** requires components covering **two materially distinct providers**. Two records
  about the same provider are one provider, whatever class each carries, and a list of
  provider *names* with no evidence records behind it earns nothing.
- **E8** requires a **typed** artifact from `createDomainSupportArtifact()`, which
  validates `artifactId`, `propositionKey`, `domainCategory`, `citation` and `recordedAt`
  — and whose proposition must match the components'. An earlier version accepted any
  truthy `domainSupport`, so `'trust me'` minted E8; the previous report calling E8
  unissuable was **wrong**. The contract now exists and **CP1 ships no instance**, so E8
  is genuinely unissuable here — asserted by a test rather than claimed in prose.

Composed records **retain their components**, their `propositionKey`, their `providers`
and their `captureIds`, so "which two providers?" and "which two captures?" have answers
rather than labels. Each record also carries a deterministic `evidenceId` — provenance
consistency, not authentication.

**What this contract cannot do:** a pure JavaScript object cannot authenticate its
external origin. It proves shape, identity, proposition consistency and composition
requirements — not that a record truly came from Intuit. That is the same honest limit G8
carries for receipts; establishing external provenance belongs to CP2+ provider
experiments and the CP6 runtime lifecycle, and no signature or hash is invented to fake it. Composition adds structure, never altitude: no rank, no score, no
`>= E6`.

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

`promoteGeneralization` moves **one level at a time** and refuses to skip — and it
**cannot produce G5 at all**. One-step promotion was still a staircase: five calls walked
G0→G5, so provider research could mint a LOCKED canonical rule by looping. Locking is a
deliberate system-closure act that CP1 does not own, so:

    GENERIC PROVIDER RESEARCH CAN PRODUCE AT MOST G4_CANDIDATE_CANONICAL_INVARIANT

`MAX_GENERIC_GENERALIZATION === G4`. G5 remains vocabulary for a later closure gate, with
no function able to mint it and **no `systemClosure: true` flag** — a boolean any caller
can set is the same defect wearing a longer name.

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
