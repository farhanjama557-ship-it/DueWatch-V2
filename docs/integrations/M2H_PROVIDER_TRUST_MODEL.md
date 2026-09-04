# M2H — provider trust model

## The rule

**Ownership is claim-level and truth-dimension-specific.** Never "QuickBooks wins".

A provider is where an observation came from. It is not a licence to speak for a
dimension of financial truth. `ownerMaySpeakTo(owner, dimension)` is the necessary
condition; freshness and conflict state still apply on top of it.

| Owner | May speak to |
|---|---|
| `LEDGER_SOURCE` | T1 invoice/AR, T4 allocation |
| `PAYMENT_PROCESSOR` | T2 attempt, T3 receipt, T5 processor settlement |
| `BANK_RECONCILIATION_SOURCE` | T6 bank/ledger reconciliation |
| `INVOICE_ORIGIN_SOURCE` | T1 invoice/AR |
| `CONTRACT_SOURCE`, `CRM_SOURCE`, `COMMUNICATION_SOURCE`, `DUEWATCH_DERIVED` | **no money dimension** |

An email saying "we paid yesterday" is `COMMUNICATION_SOURCE` evidence. It moves no ledger.

## The six dimensions stay apart

    payment ATTEMPT ≠ payment RECEIPT ≠ invoice ALLOCATION
                    ≠ processor SETTLEMENT ≠ bank RECONCILIATION

Collapsing any pair is how a founder chases a customer who paid, or stops chasing one
who did not. `classifyDisagreement` therefore returns `NO_CONTRADICTION` when two
observations sit in different dimensions — "Stripe says succeeded" and "QuickBooks says
$1,000 outstanding" are both true while allocation is pending.

## Provider capability ≠ G5 authority

Six axes, never collapsed into one boolean: `canRead`, `canTechnicallyWrite`,
`supportedInProviderApi`, `supportedByDuewatchAdapter`, `allowedByCurrentScopes`, and —
**not stored here at all** — `authorizedByG5`. A capability record that cached a
permission would be wrong the moment a grant was revoked. Any authority-shaped field
passed to `describeProviderCapability` throws.

    Gmail scope permits sending  ≠  DueWatch may send
    Stripe permits refunds       ≠  DueWatch may refund
    QuickBooks token can edit    ≠  DueWatch may edit the books

## The admission tuple

A provider claim is admitted only on the **full connection tuple**:

    expected tenant + expected provider + expected provider account
              matched against
    observation tenant + observation provider + observation provider account

Two of three is not enough: **provider account ids are not globally unique across
providers**, so `acct-4815` at one provider is a different thing entirely from `acct-4815`
at another. Mismatches produce distinct typed outcomes — `REJECTED_TENANT`,
`REJECTED_PROVIDER`, `REJECTED_PROVIDER_ACCOUNT` — and a missing expected provider fails
closed with its own diagnosis rather than skipping the check.

The expected provider comes from the **connection context the caller holds**. It is never
inferred from the observation's object type, external id, payload, source owner or
proposition — inferring it from the thing being checked would make the check circular.

*Connection identity, honestly:* CP1 has no persistence, so the tuple is passed in rather
than looked up. Binding it to a durable `connectionId` with an OAuth lifecycle is **CP6**
work, and nothing here pretends that record exists.

## Local constructor provenance — the systematic rule

> **A public field is not provenance.**

`kind`, `rawHash`, `evidenceId`, `state: 'FRESH'` and `admitted: true` are all data a
caller can type or copy. None of them decides whether an object is real. Eight
module-private `WeakSet`/`WeakMap` registries do, across five modules:

| Object | Proven by |
|---|---|
| provider observation | produced by `createProviderObservation` |
| interpretation | produced by `interpretObservation`, **bound to that exact observation** |
| freshness result | returned by `resolveFreshness`, **bound to that exact observation** |
| claim result | returned by `admitProviderClaim` (admitted **and** rejected) |
| evidence record / domain artifact | as documented in the evidence matrix |

A spread copy is a different object and fails every one. `governingClaims` considers only
registered results and **reports** unrecognised ones as `untrustedInputs` rather than
silently dropping them.

**What this proves:** this exact object passed the constructor or resolver that owns it,
*in this process*. **Not** that the provider sent anything, that a source was really
unreachable, that `invalidatedAt` came from a trusted lifecycle, or that the clock was
authoritative.

**Process-bound, and this matters for CP6:** WeakSet membership does not survive
serialisation. When CP6 rehydrates observations, freshness or claims from durable storage
it will need its own verification boundary at the rehydration point — this mechanism
cannot cross a process edge.

## Replay is connection-scoped, and settlement requires a read

Every delivered event must carry `tenantId`, `provider` and `providerAccountId`
**explicitly**; there is no fallback to the expected values, because defaulting a missing
identity to what you were hoping for is the opposite of failing closed. Scope is validated
**before** duplicate tracking, invalidation, refetch accumulation or sequence movement, so
a foreign event leaves no mark.

A refetch obligation clears only when a target was **actually re-read successfully**.
Calling `settle()` proves nothing: with no successes, or an unavailable source, the
obligation stands and `converged` is `false`; a partial refetch clears only what it
refreshed. The old version returned `converged: true` simply because it had been called,
modelling *"we intended to refetch"* as *"we now know the truth"*.

## Observation ≠ interpretation

Raw observations are immutable **structured JSON snapshots** — not exact HTTP wire bytes
and not verbatim request bodies; key order and byte formatting are not preserved, and the
hash is over the canonical structural form. Interpretations reference them and may be
replaced.

*Future requirement, recorded not assumed:* exact request-body capture for webhook
signature verification needs the bytes as received and belongs to the runtime/lifecycle
checkpoint (CP6). Our understanding of a provider *will* be wrong at least once, and when it is
the fix must not require re-fetching history we can no longer obtain.

Worked example: a QuickBooks `Payment` with `TotalAmt = 0` linked to a CreditMemo and an
Invoice. Read as *cash received* it marks an invoice paid that nobody paid. Read as a
*provider-generated credit allocation* it is correct. Same bytes; `reinterpret()` changes
the reading and leaves the bytes alone.

## Collection eligibility is derived

Never `balance > 0 → chase`. The public provider-driven path is closed:

    constructed observation → constructed interpretation → resolved freshness
      → admitted claim → governing T1 selection → collection decision

`deriveCollectionEligibility` accepts only a locally registered `governingClaims()`
selection for canonical AR balance. A plain `{ value: { balance } }`, a handwritten
`{ state: 'FRESH' }`, or a selection-shaped object cannot substitute for that path.
`preferFresher` applies the same rule: both the observation and the freshness result must
be constructed locally, and the freshness result must be bound to that exact observation.

Decision-sensitive context is explicit tri-state data. `true` and `false` are known facts;
`null` is unknown. Credit and unapplied value likewise use a non-negative number when
known and `null` when unknown. Missing dispute, payment-in-flight, credit, unapplied value,
conflict or attribution knowledge never becomes its favourable value. Source health is
not a parallel caller boolean: only an explicitly available, resolved freshness result in
the governing selection can produce a fresh ledger. Omitted source availability resolves
to `UNKNOWN`.

Operating policy is a provider-neutral input with `ALLOWED | BLOCKED | UNKNOWN`. CP1
validates that this input is explicit; it does not invent Company Brain policy evaluation.
`UNKNOWN` fails closed. Only a positive fresh T1 balance, complete known-safe context and
`ALLOWED` policy produce `ELIGIBLE`; every other combination produces a conservative
existing outcome.

G5 authority is still a separate question, evaluated fresh at use.
`deriveCollectionEligibility` reports `authorityEvaluated: false` on every result.
Repository-wide inspection found no consumer treating the eligibility object itself as an
authenticated decision token, so CP1 does not add a decorative output registry. If a
future runtime trusts a rehydrated decision token, that runtime must establish provenance
at its own boundary rather than trusting the public `outcome` field.

All WeakSet/WeakMap guarantees here are local and process-bound. They prove constructor
and exact-object relationships, not that a provider was reachable or that the inputs came
from an external system. Durable rehydration and external-origin verification remain CP6.
