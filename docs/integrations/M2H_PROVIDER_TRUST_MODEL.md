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

Never `balance > 0 → chase`. Truth **and** context **and** policy **and** freshness
**and** conflict state produce `ELIGIBLE | LIMITED | HOLD | BLOCKED | REVIEW_REQUIRED |
UNKNOWN` — and then G5 authority is a separate question, evaluated fresh at use.
`deriveCollectionEligibility` reports `authorityEvaluated: false` on every result.
